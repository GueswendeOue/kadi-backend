"use strict";

const crypto = require("node:crypto");
const {
  DOCUMENT_EVENTS,
  createDocumentDomain,
} = require("./kadiV1DocumentDomain");
const { assertV1DocumentRepository } = require("./kadiV1DocumentRepository");
const { validateBrainResult } = require("./kadiV1BrainContracts");
const {
  SHARED_DOCUMENT_TYPES,
  createSharedDocumentPolicies,
  normalizeClient,
  normalizeOptions,
} = require("./kadiV1SharedDocumentPolicies");

const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const RESERVED_BRAIN_FIELDS = new Set(["date_read", "document_number_read", "total_read"]);
const TECHNICAL_USER_TERMS = /\b(?:flow|payload|session|endpoint|openai|gemini|ocr)\b/i;
const VALID_INVOICE_KINDS = new Set(["FINAL", "PROFORMA"]);
const OPERATION_PREFIXES = Object.freeze({
  createDraft: "create_draft:",
  applyBrainExtraction: "brain_extraction:",
  setIssuer: "set_issuer:",
  setInvoiceKind: "set_invoice_kind:",
  setClientOrPayer: "set_party:",
  addContent: "add_content:",
  updateContent: "update_content:",
  removeContent: "remove_content:",
  setOptions: "set_options:",
  markReadyForReview: "mark_ready:",
  verifyDocument: "verify:",
  reopenForCorrection: "reopen:",
  cancelDocument: "cancel:",
});

function ok(value, extra = {}) {
  return { ok: true, value, ...extra };
}

function fail(error) {
  return { ok: false, error };
}

function validIdentifier(value) {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function validOwner(value) {
  return typeof value === "string" && /^\d{8,20}$/.test(value);
}

function validateIdempotencyKey(value, operation) {
  return typeof value === "string" &&
    value.startsWith(OPERATION_PREFIXES[operation]) &&
    /^[A-Za-z0-9:_.-]{1,200}$/.test(value);
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function defaultIdFactory(kind, idempotencyKey = null) {
  if (typeof idempotencyKey === "string" && idempotencyKey.length > 0) {
    const digest = crypto.createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
    return `${kind}:${digest}`;
  }
  return `${kind}:${crypto.randomUUID()}`;
}

function actionsForStatus(status) {
  if (["COLLECTING", "INCOMPLETE"].includes(status)) return ["Modifier", "Continuer", "Annuler"];
  if (status === "READY_FOR_REVIEW") return ["Modifier", "Confirmer les informations", "Annuler"];
  if (status === "VERIFIED") return ["Modifier", "Continuer", "Annuler"];
  if (status === "CANCELLED") return ["Consulter"];
  return ["Consulter", "Annuler"];
}

function createSharedDocumentPipeline({
  repository,
  domain = createDocumentDomain(),
  policies = createSharedDocumentPolicies(),
  idFactory = defaultIdFactory,
} = {}) {
  const storage = assertV1DocumentRepository(repository);
  if (!domain || typeof domain.createDocument !== "function" || typeof domain.modifyDocument !== "function") {
    throw new TypeError("DOCUMENT_DOMAIN_REQUIRED");
  }
  if (typeof idFactory !== "function") throw new TypeError("DOCUMENT_ID_FACTORY_REQUIRED");
  for (const type of SHARED_DOCUMENT_TYPES) {
    if (!policies?.[type] || typeof policies[type].getMissingFields !== "function") {
      throw new TypeError(`DOCUMENT_POLICY_REQUIRED:${type}`);
    }
  }

  function decorate(document, { missingFields, uncertainties }) {
    return domain.restoreDocument({
      ...document,
      missing_fields: uniqueStrings(missingFields),
      uncertainties: structuredClone(uncertainties || []),
    });
  }

  function policyMissing(document) {
    return policies[document.document_type].getMissingFields(document);
  }

  function refreshContext(document, { resolvedFields = [], missingFields, uncertainties } = {}) {
    const resolved = new Set(resolvedFields);
    const remainingUncertainties = (uncertainties ?? document.uncertainties ?? [])
      .filter((entry) => !resolved.has(entry.field));
    const extractionMissing = (missingFields ?? document.missing_fields ?? [])
      .filter((field) => !resolved.has(field));
    return decorate(document, {
      missingFields: [...policyMissing(document), ...extractionMissing],
      uncertainties: remainingUncertainties,
    });
  }

  async function replayFor({ documentId, ownerWaId, idempotencyKey }) {
    const replay = await storage.findByIdempotencyKey(idempotencyKey);
    if (!replay.ok) return replay;
    if (!replay.value) return ok(null);
    if (documentId && replay.value.document_id !== documentId) return fail("DOCUMENT_IDEMPOTENCY_CONFLICT");
    const loaded = await storage.getDocumentById({
      documentId: replay.value.document_id,
      ownerWaId,
    });
    return loaded.ok ? ok(loaded.value, { duplicate: true }) : loaded;
  }

  async function loadMutation(command, operation) {
    if (!validOwner(command?.ownerWaId) || !validIdentifier(command?.documentId)) {
      return fail("DOCUMENT_COMMAND_IDENTITY_INVALID");
    }
    if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) {
      return fail("DOCUMENT_EXPECTED_VERSION_INVALID");
    }
    if (!validateIdempotencyKey(command.idempotencyKey, operation)) {
      return fail("DOCUMENT_IDEMPOTENCY_KEY_INVALID");
    }
    const replay = await replayFor(command);
    if (!replay.ok || replay.value) return replay;
    const loaded = await storage.getDocumentById({ documentId: command.documentId, ownerWaId: command.ownerWaId });
    if (!loaded.ok) return loaded;
    if (loaded.value.version !== command.expectedVersion) return fail("DOCUMENT_VERSION_CONFLICT");
    if (!SHARED_DOCUMENT_TYPES.includes(loaded.value.document_type)) return fail("DOCUMENT_TYPE_UNSUPPORTED");
    return ok(loaded.value);
  }

  async function persistModified(command, operation, eventType, patch, context = {}) {
    const loaded = await loadMutation(command, operation);
    if (!loaded.ok || loaded.duplicate) return loaded;
    const modified = domain.modifyDocument(loaded.value, patch);
    if (!modified.ok) return modified;
    const contextual = refreshContext(modified.value, context);
    if (!contextual.ok) return contextual;
    return storage.saveNewVersion({
      document: contextual.value,
      ownerWaId: command.ownerWaId,
      expectedVersion: command.expectedVersion,
      fromState: loaded.value.status,
      eventType,
      idempotencyKey: command.idempotencyKey,
    });
  }

  async function persistStateTransition(command, operation, event, eventType) {
    const loaded = await loadMutation(command, operation);
    if (!loaded.ok || loaded.duplicate) return loaded;
    const transitioned = domain.transitionDocument(loaded.value, event);
    if (!transitioned.ok) return transitioned;
    return storage.persistTransition({
      document: transitioned.value,
      ownerWaId: command.ownerWaId,
      expectedVersion: command.expectedVersion,
      fromState: loaded.value.status,
      eventType,
      idempotencyKey: command.idempotencyKey,
    });
  }

  async function createDraft({ ownerWaId, documentType, currency = "XOF", issuerProfileId = null, idempotencyKey }) {
    if (!validOwner(ownerWaId) || !SHARED_DOCUMENT_TYPES.includes(documentType)) return fail("DOCUMENT_CREATE_INPUT_INVALID");
    if (!validateIdempotencyKey(idempotencyKey, "createDraft")) return fail("DOCUMENT_IDEMPOTENCY_KEY_INVALID");
    const replay = await replayFor({ ownerWaId, idempotencyKey });
    if (!replay.ok || replay.value) return replay;
    const documentId = idFactory("document", idempotencyKey);
    if (!validIdentifier(documentId)) return fail("DOCUMENT_ID_INVALID");
    const created = domain.createDocument({
      document_id: documentId,
      document_type: documentType,
      issuer_profile_id: issuerProfileId,
      currency,
      client: null,
      items: [],
      options: {},
      receipt: null,
      discount_amount: 0,
      tax_rate_basis_points: 0,
    });
    if (!created.ok) return created;
    const contextual = refreshContext(created.value);
    if (!contextual.ok) return contextual;
    return storage.createDocument({
      document: contextual.value,
      ownerWaId,
      idempotencyKey,
    });
  }

  async function setIssuer(command) {
    if (!validIdentifier(command?.issuerProfileId)) return fail("DOCUMENT_ISSUER_INVALID");
    return persistModified(command, "setIssuer", "ISSUER_SET", {
      issuer_profile_id: command.issuerProfileId,
    }, { resolvedFields: ["issuer"] });
  }

  async function setInvoiceKind(command) {
    const loaded = await loadMutation(command, "setInvoiceKind");
    if (!loaded.ok || loaded.duplicate) return loaded;
    if (loaded.value.document_type !== "FACTURE") return fail("DOCUMENT_INVOICE_KIND_NOT_APPLICABLE");
    if (!VALID_INVOICE_KINDS.has(command.invoiceKind)) return fail("DOCUMENT_INVOICE_KIND_INVALID");
    const options = { ...(loaded.value.options || {}), invoice_kind: command.invoiceKind };
    return persistModifiedLoaded(loaded.value, command, "INVOICE_KIND_SET", { options }, ["invoice_kind"]);
  }

  async function setClientOrPayer(command) {
    const loaded = await loadMutation(command, "setClientOrPayer");
    if (!loaded.ok || loaded.duplicate) return loaded;
    if (["FACTURE", "DEVIS"].includes(loaded.value.document_type)) {
      const client = normalizeClient(command.party);
      if (!client.ok) return client;
      return persistModifiedLoaded(loaded.value, command, "CLIENT_SET", { client: client.value }, ["client"]);
    }
    if (!command.party || Object.keys(command.party).some((key) => !["payer", "beneficiary"].includes(key))) {
      return fail("DOCUMENT_RECEIPT_PARTY_INVALID");
    }
    const receipt = policies.RECU.normalizeContent(command.party, { partial: true });
    if (!receipt.ok || (!Object.hasOwn(receipt.value, "payer") && !Object.hasOwn(receipt.value, "beneficiary"))) {
      return fail("DOCUMENT_RECEIPT_PARTY_INVALID");
    }
    return persistModifiedLoaded(loaded.value, command, "RECEIPT_PARTY_SET", {
      receipt: { ...(loaded.value.receipt || {}), ...receipt.value },
    }, ["payer", "beneficiary"]);
  }

  async function persistModifiedLoaded(document, command, eventType, patch, resolvedFields, context = {}) {
    const modified = domain.modifyDocument(document, patch);
    if (!modified.ok) return modified;
    const contextual = refreshContext(modified.value, { ...context, resolvedFields });
    if (!contextual.ok) return contextual;
    return storage.saveNewVersion({
      document: contextual.value,
      ownerWaId: command.ownerWaId,
      expectedVersion: command.expectedVersion,
      fromState: document.status,
      eventType,
      idempotencyKey: command.idempotencyKey,
    });
  }

  async function addContent(command) {
    const loaded = await loadMutation(command, "addContent");
    if (!loaded.ok || loaded.duplicate) return loaded;
    const policy = policies[loaded.value.document_type];
    const content = policy.normalizeContent(
      loaded.value.document_type === "RECU"
        ? { ...(loaded.value.receipt || {}), ...(command.content || {}) }
        : command.content
    );
    if (!content.ok) return content;
    if (loaded.value.document_type === "RECU") {
      return persistModifiedLoaded(loaded.value, command, "RECEIPT_CONTENT_SET", {
        receipt: { ...(loaded.value.receipt || {}), ...content.value },
      }, ["payer", "beneficiary", "amount", "reason", "payment_method", "reference"]);
    }
    const itemId = idFactory("item", command.idempotencyKey);
    if (!validIdentifier(itemId)) return fail("DOCUMENT_ITEM_ID_INVALID");
    return persistModifiedLoaded(loaded.value, command, "CONTENT_ADDED", {
      items: [...loaded.value.items, { item_id: itemId, ...content.value }],
    }, ["items"]);
  }

  async function updateContent(command) {
    const loaded = await loadMutation(command, "updateContent");
    if (!loaded.ok || loaded.duplicate) return loaded;
    const policy = policies[loaded.value.document_type];
    const content = policy.normalizeContent(command.content, { partial: true });
    if (!content.ok) return content;
    if (loaded.value.document_type === "RECU") {
      return persistModifiedLoaded(loaded.value, command, "RECEIPT_CONTENT_UPDATED", {
        receipt: { ...(loaded.value.receipt || {}), ...content.value },
      }, Object.keys(content.value));
    }
    if (!validIdentifier(command.itemId)) return fail("DOCUMENT_ITEM_ID_INVALID");
    const index = loaded.value.items.findIndex((item) => item.item_id === command.itemId);
    if (index < 0) return fail("DOCUMENT_ITEM_NOT_FOUND");
    const items = loaded.value.items.map((item, position) => position === index ? { ...item, ...content.value } : item);
    return persistModifiedLoaded(loaded.value, command, "CONTENT_UPDATED", { items }, ["items"]);
  }

  async function removeContent(command) {
    const loaded = await loadMutation(command, "removeContent");
    if (!loaded.ok || loaded.duplicate) return loaded;
    if (loaded.value.document_type === "RECU") return fail("DOCUMENT_RECEIPT_REMOVE_FORBIDDEN");
    if (!validIdentifier(command.itemId)) return fail("DOCUMENT_ITEM_ID_INVALID");
    if (!loaded.value.items.some((item) => item.item_id === command.itemId)) return fail("DOCUMENT_ITEM_NOT_FOUND");
    return persistModifiedLoaded(loaded.value, command, "CONTENT_REMOVED", {
      items: loaded.value.items.filter((item) => item.item_id !== command.itemId),
    }, ["items"]);
  }

  async function setOptions(command) {
    const loaded = await loadMutation(command, "setOptions");
    if (!loaded.ok || loaded.duplicate) return loaded;
    const options = normalizeOptions(loaded.value.document_type, command.options);
    if (!options.ok) return options;
    if (loaded.value.document_type === "RECU") {
      return persistModifiedLoaded(loaded.value, command, "OPTIONS_SET", {
        receipt: { ...(loaded.value.receipt || {}), ...options.value.receipt },
      }, ["payment_method", "reference"]);
    }
    const patch = { ...options.value };
    if (patch.options) patch.options = { ...(loaded.value.options || {}), ...patch.options };
    return persistModifiedLoaded(loaded.value, command, "OPTIONS_SET", patch, ["options", "taxes", "discount", "notes", "payment_terms", "validity"]);
  }

  function brainPatch(document, result, idempotencyKey) {
    const confirmed = Object.fromEntries(
      Object.entries(result.extracted_fields).filter(([, candidate]) => candidate.status === "CONFIRMED")
    );
    if (Object.keys(confirmed).some((field) => RESERVED_BRAIN_FIELDS.has(field))) {
      return fail("BRAIN_AUTHORITY_FIELD_FORBIDDEN");
    }
    const patch = {};
    const resolved = [];
    if (confirmed.currency) { patch.currency = confirmed.currency.value; resolved.push("currency"); }
    if (confirmed.client && ["FACTURE", "DEVIS"].includes(document.document_type)) {
      const client = normalizeClient(confirmed.client.value);
      if (!client.ok) return client;
      patch.client = client.value;
      resolved.push("client");
    }
    if (confirmed.items && ["FACTURE", "DEVIS"].includes(document.document_type)) {
      const items = [];
      for (const rawItem of confirmed.items.value) {
        const normalized = policies[document.document_type].normalizeContent({
          description: rawItem.description ?? rawItem.label,
          quantity: rawItem.quantity,
          unit: rawItem.unit,
          unit_price: rawItem.unit_price,
        });
        if (!normalized.ok) return normalized;
        const itemId = idFactory("item", `${idempotencyKey}:${items.length}`);
        if (!validIdentifier(itemId)) return fail("DOCUMENT_ITEM_ID_INVALID");
        items.push({ item_id: itemId, ...normalized.value });
      }
      patch.items = items;
      resolved.push("items");
    }
    if (confirmed.options && ["FACTURE", "DEVIS"].includes(document.document_type)) {
      const options = normalizeOptions(document.document_type, { options: confirmed.options.value });
      if (!options.ok) return options;
      patch.options = { ...(document.options || {}), ...options.value.options };
      resolved.push("options");
    }
    if (confirmed.discount && ["FACTURE", "DEVIS"].includes(document.document_type)) {
      if (!Number.isSafeInteger(confirmed.discount.value)) return fail("DOCUMENT_DISCOUNT_INVALID");
      patch.discount_amount = confirmed.discount.value;
      resolved.push("discount");
    }
    if (confirmed.taxes && ["FACTURE", "DEVIS"].includes(document.document_type)) {
      const rate = typeof confirmed.taxes.value === "number"
        ? confirmed.taxes.value
        : confirmed.taxes.value?.rate;
      const basisPoints = rate * 100;
      if (!Number.isFinite(rate) || rate < 0 || rate > 100 || !Number.isSafeInteger(basisPoints)) {
        return fail("DOCUMENT_TAX_RATE_INVALID");
      }
      patch.tax_rate_basis_points = basisPoints;
      resolved.push("taxes");
    }
    for (const field of ["notes", "payment_terms"]) {
      if (confirmed[field]) { patch[field] = confirmed[field].value; resolved.push(field); }
    }
    if (document.document_type === "RECU") {
      const receipt = { ...(document.receipt || {}) };
      for (const field of ["payer", "beneficiary", "amount", "reason", "payment_method", "reference"]) {
        if (confirmed[field]) { receipt[field] = confirmed[field].value; resolved.push(field); }
      }
      if (resolved.some((field) => ["payer", "beneficiary", "amount", "reason", "payment_method", "reference"].includes(field))) {
        const normalized = policies.RECU.normalizeContent(receipt, { partial: true });
        if (!normalized.ok) return normalized;
        patch.receipt = normalized.value;
      }
    }
    return ok({ patch, resolved });
  }

  async function applyBrainExtraction(command) {
    const loaded = await loadMutation(command, "applyBrainExtraction");
    if (!loaded.ok || loaded.duplicate) return loaded;
    const validated = validateBrainResult(command.brainResult);
    if (!validated.ok) return fail("BRAIN_RESULT_NOT_VALIDATED");
    if (validated.value.document_type && validated.value.document_type !== loaded.value.document_type) {
      return fail("BRAIN_DOCUMENT_TYPE_MISMATCH");
    }
    const mapped = brainPatch(loaded.value, validated.value, command.idempotencyKey);
    if (!mapped.ok) return mapped;
    if (validated.value.user_facing_message_draft && TECHNICAL_USER_TERMS.test(validated.value.user_facing_message_draft)) {
      return fail("BRAIN_QUESTION_UNSAFE");
    }
    const patch = Object.keys(mapped.value.patch).length > 0
      ? mapped.value.patch
      : { notes: loaded.value.notes };
    const persisted = await persistModifiedLoaded(loaded.value, command, "BRAIN_EXTRACTION_APPLIED", patch, mapped.value.resolved, {
      missingFields: validated.value.missing_fields,
      uncertainties: validated.value.uncertainties,
    });
    if (!persisted.ok) return persisted;
    return ok(persisted.value, {
      duplicate: persisted.duplicate === true,
      question: validated.value.uncertainties.length > 0 || persisted.value.missing_fields.length > 0
        ? validated.value.user_facing_message_draft || null
        : null,
      ready_for_review: false,
    });
  }

  async function getMissingFields({ documentId, ownerWaId }) {
    if (!validIdentifier(documentId) || !validOwner(ownerWaId)) return fail("DOCUMENT_LOOKUP_INVALID");
    const loaded = await storage.getDocumentById({ documentId, ownerWaId });
    if (!loaded.ok) return loaded;
    return ok(uniqueStrings([...policyMissing(loaded.value), ...(loaded.value.missing_fields || [])]));
  }

  async function markReadyForReview(command) {
    const loaded = await loadMutation(command, "markReadyForReview");
    if (!loaded.ok || loaded.duplicate) return loaded;
    const missing = uniqueStrings([...policyMissing(loaded.value), ...(loaded.value.missing_fields || [])]);
    if (missing.length > 0) return fail("DOCUMENT_INFORMATION_MISSING");
    if ((loaded.value.uncertainties || []).length > 0) return fail("DOCUMENT_UNCERTAINTIES_UNRESOLVED");
    return persistStateTransition(command, "markReadyForReview", DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW, "MARK_READY_FOR_REVIEW");
  }

  const verifyDocument = (command) => persistStateTransition(
    command, "verifyDocument", DOCUMENT_EVENTS.VERIFY, "DOCUMENT_VERIFIED"
  );

  async function reopenForCorrection(command) {
    const loaded = await loadMutation(command, "reopenForCorrection");
    if (!loaded.ok || loaded.duplicate) return loaded;
    if (loaded.value.status !== "VERIFIED") return fail("DOCUMENT_REOPEN_STATE_INVALID");
    const patch = loaded.value.document_type === "RECU"
      ? { receipt: loaded.value.receipt }
      : { client: loaded.value.client };
    return persistModifiedLoaded(loaded.value, command, "DOCUMENT_REOPENED", patch, []);
  }

  async function buildReviewModel({ documentId, ownerWaId }) {
    if (!validIdentifier(documentId) || !validOwner(ownerWaId)) return fail("DOCUMENT_LOOKUP_INVALID");
    const loaded = await storage.getDocumentById({ documentId, ownerWaId });
    if (!loaded.ok) return loaded;
    const document = loaded.value;
    const receipt = document.document_type === "RECU" ? document.receipt : null;
    return ok(Object.freeze({
      document_type: document.document_type,
      issuer: { profile_id: document.issuer_profile_id, beneficiary: receipt?.beneficiary || null },
      client_or_payer: document.document_type === "RECU" ? receipt?.payer || null : document.client,
      content: document.document_type === "RECU"
        ? { amount: receipt?.amount || null, reason: receipt?.reason || null }
        : document.items,
      options: document.document_type === "RECU"
        ? { payment_method: receipt?.payment_method || null, reference: receipt?.reference || null }
        : document.options,
      subtotal: document.subtotal,
      taxes: document.taxes,
      discount: document.discount,
      total: document.total,
      uncertainties: document.uncertainties || [],
      missing_fields: uniqueStrings([...policyMissing(document), ...(document.missing_fields || [])]),
      version: document.version,
      actions: actionsForStatus(document.status),
    }));
  }

  const cancelDocument = (command) => persistStateTransition(
    command, "cancelDocument", DOCUMENT_EVENTS.CANCEL, "DOCUMENT_CANCELLED"
  );

  return Object.freeze({
    addContent,
    applyBrainExtraction,
    buildReviewModel,
    cancelDocument,
    createDraft,
    getMissingFields,
    markReadyForReview,
    removeContent,
    reopenForCorrection,
    setClientOrPayer,
    setInvoiceKind,
    setIssuer,
    setOptions,
    updateContent,
    verifyDocument,
  });
}

module.exports = {
  OPERATION_PREFIXES,
  createSharedDocumentPipeline,
};
