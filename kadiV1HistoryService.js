"use strict";

const crypto = require("node:crypto");
const { DOCUMENT_EVENTS, DOCUMENT_STATES } = require("./kadiV1DocumentStateMachine");
const { DOCUMENT_TYPES, createDocumentDomain } = require("./kadiV1DocumentDomain");
const { assertV1HistoryRepository } = require("./kadiV1HistoryRepository");

const ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9:_.-]{1,180}$/;
const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 10;
const SAFE_EVENT_TYPES = new Set(["DOCUMENT_CREATED", ...Object.values(DOCUMENT_EVENTS)]);
const MUTABLE_STATES = new Set([
  "COLLECTING", "INCOMPLETE", "READY_FOR_REVIEW", "VERIFIED", "PREVIEW_READY",
  "COST_CALCULATED", "AWAITING_GENERATION_CONFIRMATION", "RECHARGE_REQUIRED", "RECOVERABLE_FAILURE",
]);
const CANCELLABLE_STATES = new Set([
  "COLLECTING", "INCOMPLETE", "READY_FOR_REVIEW", "VERIFIED", "PREVIEW_READY",
  "COST_CALCULATED", "AWAITING_GENERATION_CONFIRMATION", "RECHARGE_REQUIRED", "RECOVERABLE_FAILURE",
]);

function fail(error) { return { ok: false, error }; }
function ok(value, extra = {}) { return { ok: true, value, ...extra }; }
function clone(value) { return value == null ? value : structuredClone(value); }
function validId(value) { return typeof value === "string" && ID_PATTERN.test(value); }
function validDate(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }

function encodeCursor(document) {
  return Buffer.from(JSON.stringify({ u: document.updated_at, d: document.document_id })).toString("base64url");
}

function decodeCursor(value) {
  if (value == null) return ok(null);
  if (typeof value !== "string" || value.length > 500) return fail("HISTORY_CURSOR_INVALID");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!validDate(parsed?.u) || !validId(parsed?.d) || Object.keys(parsed).length !== 2) throw new Error();
    return ok({ updated_at: new Date(parsed.u).toISOString(), document_id: parsed.d });
  } catch {
    return fail("HISTORY_CURSOR_INVALID");
  }
}

function counterparty(snapshot) {
  if (snapshot.document_type === "DECHARGE") return snapshot.discharge?.receiver || null;
  if (snapshot.document_type === "RECU") return snapshot.receipt?.payer || snapshot.client?.name || null;
  return snapshot.client?.name || snapshot.client?.display_name || null;
}

function actionsFor(bundle) {
  const status = bundle.document.status;
  const trustedArtifacts = bundle.classification !== "LEGACY_UNKNOWN";
  const actions = ["VIEW"];
  if (MUTABLE_STATES.has(status)) actions.push("CONTINUE_DRAFT");
  if (trustedArtifacts && bundle.final_file) actions.push("DOWNLOAD");
  if ((bundle.classification || "V1_NATIVE") === "V1_NATIVE") actions.push("DUPLICATE");
  if (trustedArtifacts && bundle.final_file && bundle.delivery?.status === "RECOVERABLE_FAILURE") actions.push("RETRY_DELIVERY");
  if (CANCELLABLE_STATES.has(status)) actions.push("CANCEL");
  return actions;
}

function listProjection(bundle) {
  const document = bundle.document;
  const snapshot = bundle.current_snapshot;
  return {
    document_id: document.document_id,
    document_type: document.document_type,
    document_number: document.document_number || null,
    status: document.status,
    counterparty: counterparty(snapshot),
    total: snapshot.total ?? null,
    currency: document.currency,
    issued_at: document.issued_at || null,
    updated_at: document.updated_at,
    version: document.active_version,
    has_final_file: bundle.classification !== "LEGACY_UNKNOWN" && Boolean(bundle.final_file),
    actions: actionsFor(bundle),
    classification: bundle.classification || "V1_NATIVE",
  };
}

function normalizeFilters(filters = {}) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return fail("HISTORY_FILTERS_INVALID");
  const allowed = new Set(["document_type", "document_number", "counterparty", "from", "to", "status", "min_total", "max_total", "text", "has_final_file"]);
  if (Object.keys(filters).some((key) => !allowed.has(key))) return fail("HISTORY_FILTER_UNKNOWN");
  if (filters.document_type && !DOCUMENT_TYPES.includes(filters.document_type)) return fail("HISTORY_DOCUMENT_TYPE_INVALID");
  if (filters.status && !DOCUMENT_STATES.includes(filters.status)) return fail("HISTORY_DOCUMENT_STATUS_INVALID");
  if (filters.from && !validDate(filters.from)) return fail("HISTORY_DATE_INVALID");
  if (filters.to && !validDate(filters.to)) return fail("HISTORY_DATE_INVALID");
  if (filters.from && filters.to && Date.parse(filters.from) > Date.parse(filters.to)) return fail("HISTORY_DATE_RANGE_INVALID");
  for (const field of ["min_total", "max_total"]) {
    if (filters[field] != null && (!Number.isSafeInteger(filters[field]) || filters[field] < 0)) return fail("HISTORY_AMOUNT_INVALID");
  }
  if (filters.min_total != null && filters.max_total != null && filters.min_total > filters.max_total) return fail("HISTORY_AMOUNT_RANGE_INVALID");
  for (const field of ["document_number", "counterparty", "text"]) {
    if (filters[field] != null && (typeof filters[field] !== "string" || !filters[field].trim() || filters[field].length > 200)) return fail("HISTORY_TEXT_FILTER_INVALID");
  }
  if (filters.has_final_file != null && typeof filters.has_final_file !== "boolean") return fail("HISTORY_FINAL_FILE_FILTER_INVALID");
  return ok(clone(filters));
}

function createV1HistoryService({ historyRepository, documentRepository, clock = () => new Date().toISOString(), idFactory, logger = () => {}, maxPageSize = MAX_PAGE_SIZE }) {
  assertV1HistoryRepository(historyRepository);
  if (!documentRepository || typeof documentRepository.createDocument !== "function") throw new TypeError("DOCUMENT_REPOSITORY_REQUIRED");
  if (typeof logger !== "function") throw new TypeError("HISTORY_LOGGER_INVALID");
  if (!Number.isSafeInteger(maxPageSize) || maxPageSize < 1 || maxPageSize > MAX_PAGE_SIZE) throw new TypeError("HISTORY_MAX_PAGE_SIZE_INVALID");
  const domain = createDocumentDomain({ clock });
  const makeId = idFactory || ((ownerWaId, idempotencyKey) =>
    `doc_${crypto.createHash("sha256").update(`${ownerWaId}:${idempotencyKey}`).digest("hex").slice(0, 32)}`);

  async function searchDocuments({ ownerWaId, filters = {}, cursor = null, limit = DEFAULT_PAGE_SIZE, direction = "DESC", correlationId = null }) {
    if (!validId(ownerWaId)) return fail("HISTORY_OWNER_INVALID");
    if (correlationId != null && !validId(correlationId)) return fail("HISTORY_CORRELATION_ID_INVALID");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxPageSize) return fail("HISTORY_LIMIT_INVALID");
    if (!["ASC", "DESC"].includes(direction)) return fail("HISTORY_DIRECTION_INVALID");
    const safeFilters = normalizeFilters(filters);
    if (!safeFilters.ok) return safeFilters;
    const decoded = decodeCursor(cursor);
    if (!decoded.ok) return decoded;
    const started = Date.now();
    const result = await historyRepository.searchOwnedDocuments({ ownerWaId, filters: safeFilters.value, cursor: decoded.value, limit, direction });
    if (!result.ok) return result;
    const values = result.value.map(listProjection);
    const nextCursor = result.has_more && result.value.length ? encodeCursor(result.value.at(-1).document) : null;
    try {
      logger("history_search_completed", {
        correlation_id: correlationId,
        owner_hash: crypto.createHash("sha256").update(ownerWaId).digest("hex").slice(0, 12),
        filter_types: Object.keys(safeFilters.value), result_count: values.length, duration_ms: Date.now() - started,
      });
    } catch {
      // Observability must never change a user-visible history result.
    }
    return ok({ documents: values, next_cursor: nextCursor });
  }

  async function listRecentDocuments({ ownerWaId, cursor = null, limit = DEFAULT_PAGE_SIZE, correlationId = null }) {
    return searchDocuments({ ownerWaId, cursor, limit, direction: "DESC", correlationId });
  }

  async function ownedBundle(ownerWaId, documentId) {
    if (!validId(ownerWaId) || !validId(documentId)) return fail("HISTORY_LOOKUP_INVALID");
    return historyRepository.getOwnedDocumentBundle({ ownerWaId, documentId });
  }

  async function getDocumentHistory({ ownerWaId, documentId }) {
    const found = await ownedBundle(ownerWaId, documentId);
    if (!found.ok) return found;
    return ok((found.value.events || []).filter((event) => SAFE_EVENT_TYPES.has(event.event_type)).map((event) => ({
      event_type: event.event_type,
      from_state: event.from_state ?? null,
      to_state: event.to_state ?? null,
      document_version: event.document_version,
      occurred_at: event.occurred_at,
    })));
  }

  async function getDocumentDetails({ ownerWaId, documentId }) {
    const found = await ownedBundle(ownerWaId, documentId);
    if (!found.ok) return found;
    const bundle = found.value;
    const history = await getDocumentHistory({ ownerWaId, documentId });
    return ok({
      summary: listProjection(bundle),
      current_version: bundle.document.active_version,
      document: safeDocumentSnapshot(bundle.current_snapshot),
      events: history.value,
      preview: bundle.preview?.status === "ACTIVE" ? clone(bundle.preview) : null,
      generation_quote: bundle.generation_quote?.status === "ACTIVE" ? clone(bundle.generation_quote) : null,
      final_file: bundle.classification !== "LEGACY_UNKNOWN" && bundle.final_file ? safeFinalFile(bundle.final_file) : null,
      delivery: bundle.delivery ? { status: bundle.delivery.status, attempt_count: bundle.delivery.attempt_count ?? 0 } : null,
      recharge_resume: bundle.recharge_resume ? { status: bundle.recharge_resume.resume_status } : null,
    });
  }

  async function listDocumentVersions({ ownerWaId, documentId }) {
    const found = await ownedBundle(ownerWaId, documentId);
    if (!found.ok) return found;
    const finalVersion = found.value.final_file?.document_version;
    return ok((found.value.versions || []).slice().sort((a, b) => a.version - b.version).map((entry) => ({
      version: entry.version,
      created_at: entry.created_at || null,
      classification: entry.version === finalVersion ? "FINAL" : entry.version === 1 ? "DRAFT" : "CORRECTION",
      has_final_file: entry.version === finalVersion,
    })));
  }

  function safeFinalFile(file) {
    return {
      final_file_id: file.final_file_id,
      document_id: file.document_id,
      document_version: file.document_version,
      page_count: file.page_count,
      mime_type: file.mime_type,
      access: "TEMPORARY_ACCESS_REQUIRED",
    };
  }

  function safeDocumentSnapshot(snapshot) {
    const safe = clone(snapshot);
    for (const field of ["events", "preview", "generation_quote", "generation_cost", "generated_file", "recoverable_failure"]) delete safe[field];
    return safe;
  }

  async function getFinalFileReference({ ownerWaId, documentId }) {
    const found = await ownedBundle(ownerWaId, documentId);
    if (!found.ok) return found;
    return found.value.classification !== "LEGACY_UNKNOWN" && found.value.final_file
      ? ok(safeFinalFile(found.value.final_file))
      : fail("FINAL_FILE_NOT_FOUND");
  }

  function duplicateInput(snapshot, documentId) {
    const common = { document_id: documentId, document_type: snapshot.document_type, issuer_profile_id: snapshot.issuer_profile_id, currency: snapshot.currency };
    if (snapshot.document_type === "DECHARGE") return { ...common, discharge: clone(snapshot.discharge), notes: snapshot.notes };
    return {
      ...common, client: clone(snapshot.client), items: (snapshot.items || []).map((item, index) => ({ ...clone(item), item_id: `${documentId}:item:${index + 1}` })),
      options: clone(snapshot.options), notes: snapshot.notes, payment_terms: snapshot.payment_terms,
      discount_amount: snapshot.discount_amount, tax_rate_basis_points: snapshot.tax_rate_basis_points,
      receipt: clone(snapshot.receipt),
    };
  }

  async function duplicateAsDraft({ ownerWaId, documentId, idempotencyKey }) {
    if (!validId(ownerWaId) || !validId(documentId) || typeof idempotencyKey !== "string" || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) return fail("HISTORY_DUPLICATE_INPUT_INVALID");
    const repeated = await historyRepository.findDuplicateByIdempotencyKey({ ownerWaId, idempotencyKey });
    if (!repeated.ok) return repeated;
    if (repeated.value) return ok({ document_id: repeated.value.new_document_id }, { duplicate: true });
    const found = await ownedBundle(ownerWaId, documentId);
    if (!found.ok) return found;
    if ((found.value.classification || "V1_NATIVE") !== "V1_NATIVE") return fail("LEGACY_DUPLICATION_REQUIRES_MIGRATION");
    const newDocumentId = makeId(ownerWaId, idempotencyKey);
    if (!validId(newDocumentId) || newDocumentId === documentId) return fail("HISTORY_DUPLICATE_ID_INVALID");
    const created = domain.createDocument(duplicateInput(found.value.current_snapshot, newDocumentId));
    if (!created.ok) return created;
    const persisted = await documentRepository.createDocument({
      document: created.value, ownerWaId, idempotencyKey: `duplicate:${idempotencyKey}`, metadata: { source: "HISTORY_DUPLICATE" },
    });
    if (!persisted.ok) return persisted;
    const remembered = await historyRepository.rememberDuplicate({ ownerWaId, idempotencyKey, sourceDocumentId: documentId, newDocumentId });
    if (!remembered.ok) return remembered;
    return ok({ document_id: newDocumentId, status: "COLLECTING", version: 1 }, { duplicate: persisted.duplicate === true });
  }

  return Object.freeze({ listRecentDocuments, searchDocuments, getDocumentHistory, getDocumentDetails, listDocumentVersions, getFinalFileReference, duplicateAsDraft });
}

module.exports = { MAX_PAGE_SIZE, SAFE_EVENT_TYPES, createV1HistoryService, decodeCursor, encodeCursor };
