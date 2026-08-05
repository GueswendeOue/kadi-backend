"use strict";

const crypto = require("node:crypto");
const { DOCUMENT_EVENTS, createDocumentDomain } = require("./kadiV1DocumentDomain");
const { assertV1DocumentRepository } = require("./kadiV1DocumentRepository");
const { assertV1PreviewRepository } = require("./kadiV1PreviewRepository");

const ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const KEY_PATTERN = /^[A-Za-z0-9:_.-]{1,180}$/;

function ok(value, extra = {}) {
  return { ok: true, value, ...extra };
}

function fail(error) {
  return { ok: false, error };
}

function validId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function validOwner(value) {
  return typeof value === "string" && /^\d{8,20}$/.test(value);
}

function validKey(value) {
  return typeof value === "string" && KEY_PATTERN.test(value);
}

function defaultIdFactory(kind, key) {
  return `${kind}:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

function freezeClone(value) {
  const clone = structuredClone(value);
  function freeze(entry) {
    if (entry && typeof entry === "object" && !Object.isFrozen(entry)) {
      Object.freeze(entry);
      for (const child of Object.values(entry)) freeze(child);
    }
    return entry;
  }
  return freeze(clone);
}

function buildPreviewData(document) {
  const common = {
    document_type: document.document_type,
    version: document.version,
    issuer: document.issuer_profile_id ? { profile_id: document.issuer_profile_id } : null,
    client: null,
    payer: null,
    beneficiary: null,
    receipt_format: null,
    content: null,
    items: [],
    taxes: null,
    discount: null,
    subtotal: null,
    total: null,
    reason: null,
    observations: null,
    issued_at: document.issued_at ?? null,
    document_number: document.document_number ?? null,
    missing_fields: [...(document.missing_fields || [])],
    uncertainties: structuredClone(document.uncertainties || []),
    actions: ["Modifier", "Préparer le PDF", "Enregistrer pour plus tard"],
  };
  if (["FACTURE", "DEVIS"].includes(document.document_type)) {
    common.client = document.client ? structuredClone(document.client) : null;
    common.items = document.items.map((item) => ({
      item_id: item.item_id,
      description: item.description,
      quantity_millis: item.quantity_millis,
      unit: item.unit,
      unit_price: item.unit_price,
      line_total: item.line_total,
    }));
    common.taxes = document.taxes;
    common.discount = document.discount;
    common.subtotal = document.subtotal;
    common.total = document.total;
    common.observations = document.notes;
  } else if (document.document_type === "RECU") {
    common.payer = document.receipt?.payer ?? null;
    common.beneficiary = document.receipt?.beneficiary ?? null;
    common.content = document.receipt ? {
      amount: document.receipt.amount,
      currency: document.currency,
      payment_method: document.receipt.payment_method ?? null,
      reference: document.receipt.reference ?? null,
    } : null;
    common.total = document.receipt?.amount ?? null;
    common.reason = document.receipt?.reason ?? null;
    common.observations = document.notes;
    common.receipt_format = document.options?.receipt_format ?? null;
  } else if (document.document_type === "DECHARGE") {
    common.issuer = document.discharge?.giver ?? common.issuer;
    common.beneficiary = document.discharge?.receiver ?? null;
    common.content = document.discharge?.subject ? {
      type: document.discharge.subject.type,
      amount: document.discharge.subject.type === "MONEY" ? document.discharge.subject.amount : null,
      currency: document.discharge.subject.type === "MONEY" ? document.currency : null,
      description: document.discharge.subject.description ?? null,
      quantity: document.discharge.quantity ?? null,
    } : null;
    common.total = document.discharge?.subject?.type === "MONEY" ? document.discharge.subject.amount : null;
    common.reason = document.discharge?.reason ?? null;
    common.observations = document.discharge?.observations ?? null;
  }
  return freezeClone(common);
}

function createPreviewService({
  documentRepository,
  previewRepository,
  domain = createDocumentDomain(),
  clock = () => new Date().toISOString(),
  idFactory = defaultIdFactory,
} = {}) {
  const documents = assertV1DocumentRepository(documentRepository);
  const artifacts = assertV1PreviewRepository(previewRepository);
  if (!domain || typeof domain.transitionDocument !== "function") throw new TypeError("DOCUMENT_DOMAIN_REQUIRED");
  if (typeof clock !== "function" || typeof idFactory !== "function") throw new TypeError("PREVIEW_DEPENDENCY_INVALID");

  async function loadVerified({ documentId, ownerWaId, expectedVersion = null }) {
    if (!validId(documentId) || !validOwner(ownerWaId)) return fail("DOCUMENT_LOOKUP_INVALID");
    const loaded = await documents.getDocumentById({ documentId, ownerWaId });
    if (!loaded.ok) return loaded;
    if (expectedVersion != null && loaded.value.version !== expectedVersion) return fail("DOCUMENT_VERSION_CONFLICT");
    if (loaded.value.status !== "VERIFIED") return fail("DOCUMENT_PREVIEW_STATE_INVALID");
    return loaded;
  }

  async function buildStructuredPreview(command) {
    const loaded = await loadVerified(command);
    return loaded.ok ? ok(buildPreviewData(loaded.value)) : loaded;
  }

  async function persistPreview(command) {
    if (!validKey(command?.idempotencyKey)) return fail("PREVIEW_IDEMPOTENCY_KEY_INVALID");
    const replay = await artifacts.findPreviewByIdempotencyKey(command.idempotencyKey);
    if (!replay.ok) return replay;
    if (replay.value) return ok(replay.value, { duplicate: true });
    const loaded = await loadVerified(command);
    if (!loaded.ok) return loaded;
    const previewId = idFactory("preview", command.idempotencyKey);
    if (!validId(previewId)) return fail("PREVIEW_ID_INVALID");
    const createdAt = clock();
    if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) return fail("PREVIEW_CLOCK_INVALID");
    const preview = freezeClone({
      preview_id: previewId,
      document_id: loaded.value.document_id,
      owner_wa_id: command.ownerWaId,
      document_version: loaded.value.version,
      preview_version: 1,
      status: "ACTIVE",
      structured_preview: buildPreviewData(loaded.value),
      created_at: new Date(createdAt).toISOString(),
      invalidated_at: null,
    });
    const stored = await artifacts.createPreview({ preview, idempotencyKey: command.idempotencyKey });
    if (!stored.ok) return stored;
    const transitioned = domain.transitionDocument(loaded.value, DOCUMENT_EVENTS.PREPARE_PREVIEW, {
      preview: { preview_id: previewId, preview_version: 1 },
    });
    if (!transitioned.ok) {
      await artifacts.setPreviewStatus({ previewId, status: "INVALIDATED" });
      return transitioned;
    }
    const persisted = await documents.persistTransition({
      document: transitioned.value,
      ownerWaId: command.ownerWaId,
      expectedVersion: loaded.value.version,
      fromState: loaded.value.status,
      eventType: "STRUCTURED_PREVIEW_CREATED",
      idempotencyKey: `${command.idempotencyKey}:document`,
    });
    if (!persisted.ok) {
      await artifacts.setPreviewStatus({ previewId, status: "INVALIDATED" });
      return persisted;
    }
    return ok(stored.value, { document: persisted.value });
  }

  async function getPreview({ previewId, ownerWaId }) {
    if (!validOwner(ownerWaId)) return fail("DOCUMENT_OWNER_INVALID");
    const found = await artifacts.getPreview({ previewId });
    if (!found.ok) return found;
    if (found.value.owner_wa_id !== ownerWaId) return fail("PREVIEW_NOT_FOUND");
    if (found.value.status !== "ACTIVE") return fail("PREVIEW_NOT_ACTIVE");
    const current = await documents.getDocumentById({ documentId: found.value.document_id, ownerWaId });
    if (!current.ok) return current;
    if (current.value.version !== found.value.document_version) {
      await artifacts.invalidateDocumentArtifacts({
        documentId: found.value.document_id,
        exceptVersion: current.value.version,
      });
      return fail("PREVIEW_DOCUMENT_VERSION_STALE");
    }
    return found;
  }

  async function invalidatePreview({ previewId, ownerWaId }) {
    const found = await artifacts.getPreview({ previewId });
    if (!found.ok || found.value.owner_wa_id !== ownerWaId) return fail("PREVIEW_NOT_FOUND");
    const invalidated = await artifacts.setPreviewStatus({ previewId, status: "INVALIDATED" });
    if (!invalidated.ok) return invalidated;
    await artifacts.invalidateDocumentArtifacts({ documentId: found.value.document_id, exceptVersion: null });
    return invalidated;
  }

  return Object.freeze({ buildStructuredPreview, getPreview, invalidatePreview, persistPreview });
}

module.exports = { buildPreviewData, createPreviewService };
