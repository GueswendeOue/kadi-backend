"use strict";

const crypto = require("node:crypto");
const { DOCUMENT_EVENTS, DOCUMENT_STATES } = require("./kadiV1DocumentStateMachine");
const { DOCUMENT_TYPES, createDocumentDomain } = require("./kadiV1DocumentDomain");
const { assertV1HistoryRepository } = require("./kadiV1HistoryRepository");
const { canonicalFinalFilename } = require("./kadiV1FinalFilename");

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
  if (trustedArtifacts && bundle.final_file && ["RECOVERABLE_FAILURE", "IN_PROGRESS"].includes(bundle.delivery?.status)) actions.push("RETRY_DELIVERY");
  if (CANCELLABLE_STATES.has(status)) actions.push("CANCEL");
  return actions;
}

// Internal-only classification used to pick the right presentation branch
// (kadiV1ProductionPresenter.js) — never the raw last_error_code itself,
// which is never sent to the user as text. Both CONFIRMED_FAILURE and
// OUTCOME_UNKNOWN share the same RECOVERABLE_FAILURE database status;
// last_error_code is the only thing that tells them apart.
function deliveryOutcomeFor(delivery) {
  if (!delivery) return null;
  if (delivery.status === "RECOVERABLE_FAILURE") {
    return delivery.last_error_code === "DELIVERY_OUTCOME_UNKNOWN" ? "OUTCOME_UNKNOWN" : "CONFIRMED_FAILURE";
  }
  if (delivery.status === "IN_PROGRESS") return "IN_PROGRESS";
  return null;
}

function listProjection(bundle) {
  const document = bundle.document;
  const snapshot = bundle.current_snapshot;
  return {
    document_id: document.document_id,
    document_type: document.document_type,
    // invoice_kind never changes document_type — see kadiV1PreviewService.js/
    // kadiV1TemporaryRenderService.js for the same distinction applied to
    // the rendered PDF title; without this, a proforma was indistinguishable
    // from a final invoice in the history list.
    invoice_kind: document.document_type === "FACTURE" ? (snapshot.options?.invoice_kind ?? null) : null,
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

// HISTORY-CONTRACT-001 (R1 independent review): the real HISTORY_SEARCH
// Flow's date_from/date_to text fields submit a bare calendar date
// ("2026-04-01"), never a full timestamp. Both history repositories
// (kadiV1HistoryRepository.js's in-memory reference, and the
// kadi_v1_search_owned_documents Supabase RPC — see
// supabase/migrations/20260803022258_add_kadi_v1_history_search.sql)
// compare `to` as an inclusive upper bound against a real timestamp
// (issued_at/updated_at) with `<=`. A bare date parses as that day's exact
// midnight, so `to: "2026-04-01"` silently excluded every document from
// the rest of that day — a document updated at 10:00 on the very day the
// owner asked to search through. `from` needs no such adjustment: a bare
// date already parses to that day's midnight, which is exactly the
// inclusive lower bound a calendar-day range needs.
//
// Burkina Faso (Africa/Ouagadougou) has no DST and sits at a fixed UTC+0
// offset — already the documented product convention elsewhere (see
// index.js "Burkina = UTC", kadiReengagementWorker.js "Burkina = UTC+0",
// and issued_at_timezone: "Africa/Ouagadougou" recorded alongside UTC
// issued_at values in kadiInvoiceFlowCompletion.js/kadiInvoiceFlowEndpoint.js).
// Treating a bare calendar date as a UTC calendar day reuses that existing
// assumption rather than inventing a new timezone policy.
//
// A `to` that already carries a time component (a full ISO timestamp) is
// left completely untouched — this is an existing part of the history
// service's contract (see tests/kadiV1HistorySearch.test.js) and must
// never be reinterpreted as a calendar date.
//
// This is the single point both repository implementations pass through
// (kadiV1HistoryRepository.js's in-memory reference receives the already-
// expanded value and needs no change of its own; the Supabase RPC
// receives an unambiguous UTC-suffixed timestamp it casts correctly
// regardless of session timezone) — no repository-specific or SQL change
// required, and no Supabase migration.
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function endOfCalendarDayUtc(dateOnly) {
  return `${dateOnly}T23:59:59.999Z`;
}

function normalizeFilters(filters = {}) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return fail("HISTORY_FILTERS_INVALID");
  const allowed = new Set(["document_type", "document_number", "counterparty", "from", "to", "status", "min_total", "max_total", "text", "has_final_file"]);
  if (Object.keys(filters).some((key) => !allowed.has(key))) return fail("HISTORY_FILTER_UNKNOWN");
  if (filters.document_type && !DOCUMENT_TYPES.includes(filters.document_type)) return fail("HISTORY_DOCUMENT_TYPE_INVALID");
  if (filters.status && !DOCUMENT_STATES.includes(filters.status)) return fail("HISTORY_DOCUMENT_STATUS_INVALID");
  if (filters.from && !validDate(filters.from)) return fail("HISTORY_DATE_INVALID");
  if (filters.to && !validDate(filters.to)) return fail("HISTORY_DATE_INVALID");
  const normalized = clone(filters);
  if (typeof normalized.to === "string" && DATE_ONLY_PATTERN.test(normalized.to)) {
    normalized.to = endOfCalendarDayUtc(normalized.to);
  }
  if (filters.from && filters.to && Date.parse(filters.from) > Date.parse(normalized.to)) return fail("HISTORY_DATE_RANGE_INVALID");
  for (const field of ["min_total", "max_total"]) {
    if (filters[field] != null && (!Number.isSafeInteger(filters[field]) || filters[field] < 0)) return fail("HISTORY_AMOUNT_INVALID");
  }
  if (filters.min_total != null && filters.max_total != null && filters.min_total > filters.max_total) return fail("HISTORY_AMOUNT_RANGE_INVALID");
  for (const field of ["document_number", "counterparty", "text"]) {
    if (filters[field] != null && (typeof filters[field] !== "string" || !filters[field].trim() || filters[field].length > 200)) return fail("HISTORY_TEXT_FILTER_INVALID");
  }
  if (filters.has_final_file != null && typeof filters.has_final_file !== "boolean") return fail("HISTORY_FINAL_FILE_FILTER_INVALID");
  return ok(normalized);
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
      final_file: bundle.classification !== "LEGACY_UNKNOWN" && bundle.final_file ? safeFinalFile(bundle.final_file, bundle.document, bundle.current_snapshot) : null,
      delivery: bundle.delivery ? { status: bundle.delivery.status, attempt_count: bundle.delivery.attempt_count ?? 0, outcome: deliveryOutcomeFor(bundle.delivery) } : null,
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

  // The canonical filename is always recomputed here from the same three
  // fields (document_type/invoice_kind/document_number) that
  // kadiV1ProductionInfrastructure.js's WhatsApp delivery provider uses —
  // never stored redundantly on the final-file row itself, so the two can
  // never drift apart.
  function safeFinalFile(file, document, snapshot) {
    return {
      final_file_id: file.final_file_id,
      document_id: file.document_id,
      document_version: file.document_version,
      page_count: file.page_count,
      mime_type: file.mime_type,
      filename: canonicalFinalFilename({
        document_type: document?.document_type,
        invoice_kind: document?.document_type === "FACTURE" ? (snapshot?.options?.invoice_kind ?? null) : null,
        document_number: document?.document_number ?? null,
      }),
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
      ? ok(safeFinalFile(found.value.final_file, found.value.document, found.value.current_snapshot))
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
