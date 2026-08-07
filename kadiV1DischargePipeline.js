"use strict";

const crypto = require("node:crypto");
const { DOCUMENT_EVENTS, createDocumentDomain } = require("./kadiV1DocumentDomain");
const { assertV1DocumentRepository } = require("./kadiV1DocumentRepository");
const { validateBrainResult } = require("./kadiV1BrainContracts");
const {
  DISCHARGE_CONTENT_TYPES,
  getMissingFields: policyMissingFields,
  normalizeOptions,
  normalizeParty,
  normalizeReason,
  normalizeTransferredContent,
  validateForReview,
} = require("./kadiV1DischargePolicy");

const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9:_.-]{1,200}$/;
const RESERVED_BRAIN_FIELDS = new Set(["date_read", "document_number_read", "total_read"]);
const INAPPLICABLE_BRAIN_FIELDS = new Set([
  "client", "beneficiary", "payer", "items", "options", "taxes", "discount",
  "payment_terms", "payment_method", "reference",
]);
const TECHNICAL_USER_TERMS = /\b(?:flow|payload|session|endpoint|openai|gemini|ocr)\b/i;

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

function validIdempotencyKey(value) {
  return typeof value === "string" && IDEMPOTENCY_PATTERN.test(value);
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

function reviewActions(status) {
  if (["COLLECTING", "INCOMPLETE"].includes(status)) return ["Modifier", "Continuer", "Annuler"];
  if (status === "READY_FOR_REVIEW") return ["Modifier", "Confirmer les informations", "Annuler"];
  if (status === "VERIFIED") return ["Modifier", "Continuer", "Annuler"];
  if (status === "CANCELLED") return ["Consulter"];
  return ["Consulter", "Annuler"];
}

function targetedQuestion(document) {
  const uncertain = document.uncertainties?.[0]?.field;
  const missing = uncertain || document.missing_fields?.[0];
  const questions = {
    giver: "Qui remet la somme, le bien ou le document ?",
    receiver: "Qui reçoit la somme, le bien ou le document ?",
    recipient: "Qui reçoit la somme, le bien ou le document ?",
    transferred_content_type: "Qu'est-ce qui est remis ?",
    subject: "Qu'est-ce qui est remis ?",
    amount: "Quel est le montant exact remis ?",
    currency: "Dans quelle devise le montant est-il remis ?",
    description: "Pouvez-vous décrire précisément ce qui est remis ?",
    quantity: "Quelle est la quantité exacte remise ?",
    reason: "Quel est le motif de cette remise ?",
  };
  return questions[missing] || "Quelle information souhaitez-vous préciser ?";
}

function createDischargePipeline({
  repository,
  domain = createDocumentDomain(),
  idFactory = defaultIdFactory,
} = {}) {
  const storage = assertV1DocumentRepository(repository);
  if (!domain || typeof domain.createDocument !== "function" || typeof domain.modifyDocument !== "function") {
    throw new TypeError("DOCUMENT_DOMAIN_REQUIRED");
  }
  if (typeof idFactory !== "function") throw new TypeError("DOCUMENT_ID_FACTORY_REQUIRED");

  function decorate(document, { missingFields, uncertainties }) {
    return domain.restoreDocument({
      ...document,
      missing_fields: uniqueStrings(missingFields),
      uncertainties: structuredClone(uncertainties || []),
    });
  }

  function refreshContext(document, { resolvedFields = [], missingFields, uncertainties } = {}) {
    const resolved = new Set(resolvedFields);
    const remainingUncertainties = (uncertainties ?? document.uncertainties ?? [])
      .filter((entry) => !resolved.has(entry.field));
    const extractionMissing = (missingFields ?? document.missing_fields ?? [])
      .filter((field) => !resolved.has(field));
    return decorate(document, {
      missingFields: [...policyMissingFields(document), ...extractionMissing],
      uncertainties: remainingUncertainties,
    });
  }

  async function replayFor({ documentId, ownerWaId, idempotencyKey }) {
    const replay = await storage.findByIdempotencyKey(idempotencyKey);
    if (!replay.ok) return replay;
    if (!replay.value) return ok(null);
    if (documentId && replay.value.document_id !== documentId) return fail("DOCUMENT_IDEMPOTENCY_CONFLICT");
    const loaded = await storage.getDocumentById({ documentId: replay.value.document_id, ownerWaId });
    return loaded.ok ? ok(loaded.value, { duplicate: true }) : loaded;
  }

  async function loadMutation(command) {
    if (!validOwner(command?.ownerWaId) || !validIdentifier(command?.documentId)) {
      return fail("DOCUMENT_COMMAND_IDENTITY_INVALID");
    }
    if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) {
      return fail("DOCUMENT_EXPECTED_VERSION_INVALID");
    }
    if (!validIdempotencyKey(command.idempotencyKey)) return fail("DOCUMENT_IDEMPOTENCY_KEY_INVALID");
    const replay = await replayFor(command);
    if (!replay.ok || replay.value) return replay;
    const loaded = await storage.getDocumentById({ documentId: command.documentId, ownerWaId: command.ownerWaId });
    if (!loaded.ok) return loaded;
    if (loaded.value.version !== command.expectedVersion) return fail("DOCUMENT_VERSION_CONFLICT");
    if (loaded.value.document_type !== "DECHARGE") return fail("DOCUMENT_TYPE_UNSUPPORTED");
    return ok(loaded.value);
  }

  async function persistModifiedLoaded(document, command, eventType, patch, resolvedFields = [], context = {}) {
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

  // GENERATION_CONFIRMATION-001 R1: see the identical comment on
  // kadiV1SharedDocumentPipeline.js's persistStateTransition — same
  // opt-in, same reused `loaded.value.status` read, same reliance on
  // storage.persistTransition's atomic fromState check as the final
  // TOCTOU backstop. Only cancelDischarge's caller ever sets
  // command.expectedState; verifyDischarge never does.
  async function persistTransition(command, event, eventType) {
    const loaded = await loadMutation(command);
    if (!loaded.ok || loaded.duplicate) return loaded;
    if (command.expectedState != null && loaded.value.status !== command.expectedState) {
      return fail("DOCUMENT_CANCEL_STATE_MISMATCH");
    }
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

  async function createDischargeDraft({ ownerWaId, currency = "XOF", idempotencyKey }) {
    if (!validOwner(ownerWaId) || !validIdempotencyKey(idempotencyKey)) return fail("DISCHARGE_CREATE_INPUT_INVALID");
    const replay = await replayFor({ ownerWaId, idempotencyKey });
    if (!replay.ok || replay.value) return replay;
    const documentId = idFactory("document", idempotencyKey);
    if (!validIdentifier(documentId)) return fail("DOCUMENT_ID_INVALID");
    const created = domain.createDocument({
      document_id: documentId,
      document_type: "DECHARGE",
      issuer_profile_id: null,
      currency,
      discharge: null,
      notes: null,
    });
    if (!created.ok) return created;
    const contextual = refreshContext(created.value);
    if (!contextual.ok) return contextual;
    return storage.createDocument({ document: contextual.value, ownerWaId, idempotencyKey });
  }

  async function setIssuerOrGiver(command) {
    const loaded = await loadMutation(command);
    if (!loaded.ok || loaded.duplicate) return loaded;
    const giver = normalizeParty(command.giver);
    if (!giver.ok) return giver;
    if (command.issuerProfileId != null && !validIdentifier(command.issuerProfileId)) {
      return fail("DOCUMENT_ISSUER_INVALID");
    }
    return persistModifiedLoaded(loaded.value, command, "DISCHARGE_GIVER_SET", {
      ...(command.issuerProfileId == null ? {} : { issuer_profile_id: command.issuerProfileId }),
      discharge: { ...loaded.value.discharge, giver: giver.value },
    }, ["giver", "issuer"]);
  }

  async function setRecipient(command) {
    const loaded = await loadMutation(command);
    if (!loaded.ok || loaded.duplicate) return loaded;
    const recipient = normalizeParty(command.recipient);
    if (!recipient.ok) return recipient;
    return persistModifiedLoaded(loaded.value, command, "DISCHARGE_RECIPIENT_SET", {
      discharge: { ...loaded.value.discharge, receiver: recipient.value },
    }, ["receiver", "recipient"]);
  }

  async function setTransferredContent(command) {
    const loaded = await loadMutation(command);
    if (!loaded.ok || loaded.duplicate) return loaded;
    const content = normalizeTransferredContent(command.content);
    if (!content.ok) return content;
    return persistModifiedLoaded(loaded.value, command, "DISCHARGE_CONTENT_SET", {
      ...(content.value.type === "MONEY" ? { currency: content.value.currency } : {}),
      discharge: {
        ...loaded.value.discharge,
        subject: {
          type: content.value.type,
          description: content.value.description,
          amount: content.value.amount,
        },
        quantity: content.value.quantity,
      },
    }, ["subject", "amount", "currency", "description", "quantity", "transferred_content_type"]);
  }

  async function setReason(command) {
    const loaded = await loadMutation(command);
    if (!loaded.ok || loaded.duplicate) return loaded;
    const reason = normalizeReason(command.reason);
    if (!reason.ok) return reason;
    return persistModifiedLoaded(loaded.value, command, "DISCHARGE_REASON_SET", {
      discharge: { ...loaded.value.discharge, reason: reason.value },
    }, ["reason"]);
  }

  async function setOptions(command) {
    const loaded = await loadMutation(command);
    if (!loaded.ok || loaded.duplicate) return loaded;
    const options = normalizeOptions(command.options);
    if (!options.ok) return options;
    return persistModifiedLoaded(loaded.value, command, "DISCHARGE_OPTIONS_SET", {
      discharge: { ...loaded.value.discharge, observations: options.value.observations },
    }, ["notes", "observations"]);
  }

  function subjectFromBrain(value) {
    if (typeof value === "string") return ok({ type: null, description: value });
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail("BRAIN_DISCHARGE_SUBJECT_INVALID");
    const type = typeof value.type === "string" ? value.type.toUpperCase() : null;
    if (type != null && !DISCHARGE_CONTENT_TYPES.includes(type)) return fail("BRAIN_DISCHARGE_SUBJECT_INVALID");
    const description = value.label ?? value.value ?? value.name ?? null;
    if (description != null && typeof description !== "string") return fail("BRAIN_DISCHARGE_SUBJECT_INVALID");
    return ok({ type, description });
  }

  function mapBrainExtraction(document, result) {
    const confirmed = Object.fromEntries(
      Object.entries(result.extracted_fields).filter(([, candidate]) => candidate.status === "CONFIRMED")
    );
    if (Object.keys(confirmed).some((field) => RESERVED_BRAIN_FIELDS.has(field))) {
      return fail("BRAIN_AUTHORITY_FIELD_FORBIDDEN");
    }
    if (Object.keys(confirmed).some((field) => INAPPLICABLE_BRAIN_FIELDS.has(field))) {
      return fail("BRAIN_FIELD_NOT_APPLICABLE");
    }

    const discharge = structuredClone(document.discharge);
    const resolved = [];
    if (confirmed.giver) { discharge.giver = confirmed.giver.value; resolved.push("giver"); }
    if (confirmed.receiver) { discharge.receiver = confirmed.receiver.value; resolved.push("receiver", "recipient"); }
    if (confirmed.reason) { discharge.reason = confirmed.reason.value; resolved.push("reason"); }
    if (confirmed.notes) { discharge.observations = confirmed.notes.value; resolved.push("notes", "observations"); }

    let subjectType = discharge.subject?.type || null;
    let description = discharge.subject?.description || null;
    let amount = discharge.subject?.amount ?? null;
    if (confirmed.subject) {
      const subject = subjectFromBrain(confirmed.subject.value);
      if (!subject.ok) return subject;
      subjectType = subject.value.type;
      description = subject.value.description;
      if (subjectType !== "MONEY") amount = null;
      resolved.push("subject", "transferred_content_type", "description");
    }
    if (confirmed.amount) {
      if (subjectType !== "MONEY") return fail("BRAIN_AMOUNT_WITHOUT_MONEY_TYPE");
      if (!Number.isSafeInteger(confirmed.amount.value) || confirmed.amount.value <= 0) {
        return fail("DISCHARGE_AMOUNT_INVALID");
      }
      amount = confirmed.amount.value;
      resolved.push("amount");
    }
    if (subjectType) discharge.subject = { type: subjectType, description, amount };

    const patch = { discharge };
    if (confirmed.currency) {
      if (subjectType !== "MONEY") return fail("BRAIN_CURRENCY_WITHOUT_MONEY_TYPE");
      patch.currency = confirmed.currency.value;
      resolved.push("currency");
    }
    return ok({ patch, resolved });
  }

  async function applyBrainExtraction(command) {
    const loaded = await loadMutation(command);
    if (!loaded.ok || loaded.duplicate) return loaded;
    const validated = validateBrainResult(command.brainResult);
    if (!validated.ok) return fail("BRAIN_RESULT_NOT_VALIDATED");
    if (validated.value.document_type && validated.value.document_type !== "DECHARGE") {
      return fail("BRAIN_DOCUMENT_TYPE_MISMATCH");
    }
    if (validated.value.user_facing_message_draft && TECHNICAL_USER_TERMS.test(validated.value.user_facing_message_draft)) {
      return fail("BRAIN_QUESTION_UNSAFE");
    }
    const mapped = mapBrainExtraction(loaded.value, validated.value);
    if (!mapped.ok) return mapped;
    const persisted = await persistModifiedLoaded(
      loaded.value,
      command,
      "DISCHARGE_BRAIN_EXTRACTION_APPLIED",
      mapped.value.patch,
      mapped.value.resolved,
      {
        missingFields: validated.value.missing_fields,
        uncertainties: validated.value.uncertainties,
      }
    );
    if (!persisted.ok) return persisted;
    const needsQuestion = persisted.value.uncertainties.length > 0 || persisted.value.missing_fields.length > 0;
    return ok(persisted.value, {
      duplicate: persisted.duplicate === true,
      question: needsQuestion
        ? validated.value.user_facing_message_draft || targetedQuestion(persisted.value)
        : null,
      ready_for_review: false,
    });
  }

  async function getMissingFields({ documentId, ownerWaId }) {
    if (!validIdentifier(documentId) || !validOwner(ownerWaId)) return fail("DOCUMENT_LOOKUP_INVALID");
    const loaded = await storage.getDocumentById({ documentId, ownerWaId });
    if (!loaded.ok) return loaded;
    if (loaded.value.document_type !== "DECHARGE") return fail("DOCUMENT_TYPE_UNSUPPORTED");
    return ok(uniqueStrings([...policyMissingFields(loaded.value), ...(loaded.value.missing_fields || [])]));
  }

  async function markReadyForReview(command) {
    const loaded = await loadMutation(command);
    if (!loaded.ok || loaded.duplicate) return loaded;
    if ((loaded.value.uncertainties || []).length > 0) return fail("DOCUMENT_UNCERTAINTIES_UNRESOLVED");
    const policy = validateForReview(loaded.value);
    if (!policy.ok) return policy;
    const transitioned = domain.transitionDocument(loaded.value, DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW);
    if (!transitioned.ok) return transitioned;
    return storage.persistTransition({
      document: transitioned.value,
      ownerWaId: command.ownerWaId,
      expectedVersion: command.expectedVersion,
      fromState: loaded.value.status,
      eventType: "MARK_READY_FOR_REVIEW",
      idempotencyKey: command.idempotencyKey,
    });
  }

  const verifyDischarge = (command) => persistTransition(command, DOCUMENT_EVENTS.VERIFY, "DISCHARGE_VERIFIED");

  async function reopenForCorrection(command) {
    const loaded = await loadMutation(command);
    if (!loaded.ok || loaded.duplicate) return loaded;
    if (loaded.value.status !== "VERIFIED") return fail("DOCUMENT_REOPEN_STATE_INVALID");
    return persistModifiedLoaded(loaded.value, command, "DISCHARGE_REOPENED", {
      discharge: loaded.value.discharge,
    });
  }

  async function buildReviewModel({ documentId, ownerWaId }) {
    if (!validIdentifier(documentId) || !validOwner(ownerWaId)) return fail("DOCUMENT_LOOKUP_INVALID");
    const loaded = await storage.getDocumentById({ documentId, ownerWaId });
    if (!loaded.ok) return loaded;
    if (loaded.value.document_type !== "DECHARGE") return fail("DOCUMENT_TYPE_UNSUPPORTED");
    const document = loaded.value;
    const subject = document.discharge.subject;
    return ok(Object.freeze({
      document_type: "DECHARGE",
      giver: document.discharge.giver,
      recipient: document.discharge.receiver,
      transferred_content: subject ? { type: subject.type } : null,
      amount: subject?.type === "MONEY" ? subject.amount : null,
      currency: subject?.type === "MONEY" ? document.currency : null,
      description: subject?.description || null,
      quantity: document.discharge.quantity,
      reason: document.discharge.reason,
      observations: document.discharge.observations,
      uncertainties: document.uncertainties || [],
      missing_fields: uniqueStrings([...policyMissingFields(document), ...(document.missing_fields || [])]),
      version: document.version,
      actions: reviewActions(document.status),
    }));
  }

  const cancelDischarge = (command) => persistTransition(command, DOCUMENT_EVENTS.CANCEL, "DISCHARGE_CANCELLED");

  return Object.freeze({
    applyBrainExtraction,
    buildReviewModel,
    cancelDischarge,
    createDischargeDraft,
    getMissingFields,
    markReadyForReview,
    reopenForCorrection,
    setIssuerOrGiver,
    setOptions,
    setReason,
    setRecipient,
    setTransferredContent,
    verifyDischarge,
  });
}

module.exports = {
  createDischargePipeline,
};
