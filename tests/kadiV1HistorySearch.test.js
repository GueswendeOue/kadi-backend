"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createDocumentDomain } = require("../kadiV1DocumentDomain");
const { createInMemoryV1DocumentRepository } = require("../kadiV1DocumentRepository");
const { createInMemoryV1HistoryRepository } = require("../kadiV1HistoryRepository");
const { createV1HistoryService, MAX_PAGE_SIZE } = require("../kadiV1HistoryService");
const { createDeferredPrivateFileAccess } = require("../kadiV1PrivateFileAccess");
const { createLegacyHistoryAdapter } = require("../kadiV1LegacyHistoryAdapter");
const { createSupabaseV1HistoryRepository } = require("../kadiV1SupabaseHistoryRepository");

const OWNER = "owner_primary";
const OTHER = "owner_other";
const clock = () => "2026-08-02T10:20:30.000Z";

function snapshot({ id, type = "FACTURE", client = "Client Exemple", total = 1000 } = {}) {
  const domain = createDocumentDomain({ clock });
  const input = type === "DECHARGE"
    ? { document_id: id, document_type: type, currency: "XOF", discharge: { giver: "Remettant", receiver: client, subject: { type: "MONEY", amount: total }, reason: "Remise documentée" } }
    : type === "RECU"
      ? { document_id: id, document_type: type, currency: "XOF", client: { name: client }, receipt: { payer: client, beneficiary: "Entreprise", amount: total, reason: "Paiement reçu" } }
      : { document_id: id, document_type: type, currency: "XOF", client: { name: client }, items: [{ item_id: `${id}:item`, description: "Service conseil", quantity_millis: 1000, unit_price: total }] };
  const result = domain.createDocument(input);
  assert.equal(result.ok, true);
  return result.value;
}

function bundle({ id, owner = OWNER, type = "FACTURE", client, total, updated = "2026-08-02T10:00:00.000Z", status = "COLLECTING", final = false, delivery = null, classification = "V1_NATIVE" }) {
  const current = snapshot({ id, type, client, total });
  return {
    classification,
    owner_wa_id: owner,
    document: { document_id: id, document_type: type, status, active_version: 1, currency: "XOF", issued_at: null, document_number: null, updated_at: updated },
    current_snapshot: { ...current, status, total: total ?? current.total },
    versions: [{ version: 1, created_at: updated }],
    events: [{ event_type: "DOCUMENT_CREATED", from_state: null, to_state: "COLLECTING", document_version: 1, occurred_at: updated, metadata: { private: "hidden" } }],
    preview: null,
    generation_quote: null,
    final_file: final ? { final_file_id: `${id}:file`, document_id: id, document_version: 1, page_count: 1, mime_type: "application/pdf", storage_ref: "private/path", checksum: "a".repeat(64) } : null,
    delivery,
    recharge_resume: null,
  };
}

function setup(seed = []) {
  const historyRepository = createInMemoryV1HistoryRepository({ bundles: seed });
  const documentRepository = createInMemoryV1DocumentRepository();
  const logs = [];
  const service = createV1HistoryService({ historyRepository, documentRepository, clock, idFactory: () => "doc_duplicate", logger: (name, data) => logs.push({ name, data }) });
  return { service, historyRepository, documentRepository, logs };
}

test("listRecentDocuments is owner-scoped and ordered stably", async () => {
  const { service } = setup([
    bundle({ id: "doc_old", updated: "2026-08-01T10:00:00.000Z" }),
    bundle({ id: "doc_new", updated: "2026-08-02T10:00:00.000Z" }),
    bundle({ id: "doc_foreign", owner: OTHER, updated: "2026-08-03T10:00:00.000Z" }),
  ]);
  const result = await service.listRecentDocuments({ ownerWaId: OWNER });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.documents.map((row) => row.document_id), ["doc_new", "doc_old"]);
});

test("history list distinguishes a proforma from a final invoice, never for other document types", async () => {
  const proformaBundle = bundle({ id: "doc_proforma", type: "FACTURE" });
  proformaBundle.current_snapshot = { ...proformaBundle.current_snapshot, options: { invoice_kind: "PROFORMA" } };
  const finalBundle = bundle({ id: "doc_final", type: "FACTURE" });
  finalBundle.current_snapshot = { ...finalBundle.current_snapshot, options: { invoice_kind: "FINAL" } };
  const devisBundle = bundle({ id: "doc_devis", type: "FACTURE" });
  const { service } = setup([proformaBundle, finalBundle, devisBundle]);
  const result = await service.listRecentDocuments({ ownerWaId: OWNER });
  assert.equal(result.ok, true);
  const byId = Object.fromEntries(result.value.documents.map((row) => [row.document_id, row]));
  assert.equal(byId.doc_proforma.invoice_kind, "PROFORMA");
  assert.equal(byId.doc_final.invoice_kind, "FINAL");
  assert.equal(byId.doc_devis.invoice_kind, null);
  assert.equal(byId.doc_proforma.document_type, "FACTURE", "document_type itself never changes for a proforma");

  const recuBundle = bundle({ id: "doc_recu", type: "RECU" });
  const { service: recuService } = setup([recuBundle]);
  const recuResult = await recuService.listRecentDocuments({ ownerWaId: OWNER });
  assert.equal(recuResult.value.documents[0].invoice_kind, null, "invoice_kind never applies outside FACTURE");
});

test("stable cursor paginates without duplicates", async () => {
  const { service } = setup([
    bundle({ id: "doc_c", updated: "2026-08-02T10:00:00.000Z" }),
    bundle({ id: "doc_b", updated: "2026-08-02T10:00:00.000Z" }),
    bundle({ id: "doc_a", updated: "2026-08-02T10:00:00.000Z" }),
  ]);
  const first = await service.listRecentDocuments({ ownerWaId: OWNER, limit: 2 });
  const second = await service.listRecentDocuments({ ownerWaId: OWNER, limit: 2, cursor: first.value.next_cursor });
  assert.deepEqual(first.value.documents.map((row) => row.document_id), ["doc_c", "doc_b"]);
  assert.deepEqual(second.value.documents.map((row) => row.document_id), ["doc_a"]);
});

test("search supports deterministic filters without AI", async () => {
  const { service } = setup([
    bundle({ id: "doc_invoice", type: "FACTURE", client: "Atelier Local", total: 5000 }),
    bundle({ id: "doc_quote", type: "DEVIS", client: "Autre Client", total: 9000 }),
  ]);
  const result = await service.searchDocuments({ ownerWaId: OWNER, filters: { document_type: "FACTURE", counterparty: "atelier", min_total: 4000, max_total: 6000, text: "conseil", has_final_file: false } });
  assert.deepEqual(result.value.documents.map((row) => row.document_id), ["doc_invoice"]);
});

test("search rejects unknown filters, invalid ranges, cursors and oversized pages", async () => {
  const { service } = setup([]);
  assert.equal((await service.searchDocuments({ ownerWaId: OWNER, filters: { surprise: true } })).error, "HISTORY_FILTER_UNKNOWN");
  assert.equal((await service.searchDocuments({ ownerWaId: OWNER, filters: { min_total: 2, max_total: 1 } })).error, "HISTORY_AMOUNT_RANGE_INVALID");
  assert.equal((await service.searchDocuments({ ownerWaId: OWNER, cursor: "invalid" })).error, "HISTORY_CURSOR_INVALID");
  assert.equal((await service.searchDocuments({ ownerWaId: OWNER, limit: MAX_PAGE_SIZE + 1 })).error, "HISTORY_LIMIT_INVALID");
});

test("page maximum is configurable within the hard safety ceiling", async () => {
  const historyRepository = createInMemoryV1HistoryRepository();
  const documentRepository = createInMemoryV1DocumentRepository();
  const service = createV1HistoryService({ historyRepository, documentRepository, maxPageSize: 3 });
  assert.equal((await service.listRecentDocuments({ ownerWaId: OWNER, limit: 4 })).error, "HISTORY_LIMIT_INVALID");
  assert.throws(() => createV1HistoryService({ historyRepository, documentRepository, maxPageSize: MAX_PAGE_SIZE + 1 }), /HISTORY_MAX_PAGE_SIZE_INVALID/);
});

test("result actions reflect state and available final file", async () => {
  const { service } = setup([
    bundle({ id: "doc_draft", status: "INCOMPLETE" }),
    bundle({ id: "doc_delivered", status: "DELIVERED", final: true }),
    bundle({ id: "doc_retry", status: "RECOVERABLE_FAILURE", final: true, delivery: { status: "RECOVERABLE_FAILURE", attempt_count: 1 } }),
  ]);
  const rows = (await service.listRecentDocuments({ ownerWaId: OWNER })).value.documents;
  const byId = Object.fromEntries(rows.map((row) => [row.document_id, row.actions]));
  assert.deepEqual(byId.doc_draft, ["VIEW", "CONTINUE_DRAFT", "DUPLICATE", "CANCEL"]);
  assert.deepEqual(byId.doc_delivered, ["VIEW", "DOWNLOAD", "DUPLICATE"]);
  assert.equal(byId.doc_retry.includes("RETRY_DELIVERY"), true);
});

test("a still IN_PROGRESS delivery also exposes RETRY_DELIVERY (lets the user trigger a stale-claim check), unlike a plain DELIVERED or PENDING one", async () => {
  const { service } = setup([
    bundle({ id: "doc_in_progress", status: "RECOVERABLE_FAILURE", final: true, delivery: { status: "IN_PROGRESS", attempt_count: 1 } }),
    bundle({ id: "doc_pending", status: "AWAITING_GENERATION_CONFIRMATION", final: false, delivery: { status: "PENDING", attempt_count: 0 } }),
  ]);
  const rows = (await service.listRecentDocuments({ ownerWaId: OWNER })).value.documents;
  const byId = Object.fromEntries(rows.map((row) => [row.document_id, row.actions]));
  assert.equal(byId.doc_in_progress.includes("RETRY_DELIVERY"), true);
  assert.equal(byId.doc_pending.includes("RETRY_DELIVERY"), false);
});

test("document details classify a confirmed delivery failure and an outcome-unknown one distinctly, without ever exposing the raw error code", async () => {
  const confirmed = bundle({ id: "doc_confirmed", status: "RECOVERABLE_FAILURE", final: true, delivery: { status: "RECOVERABLE_FAILURE", attempt_count: 1, last_error_code: "DELIVERY_PROVIDER_FAILED" } });
  const unknown = bundle({ id: "doc_unknown", status: "RECOVERABLE_FAILURE", final: true, delivery: { status: "RECOVERABLE_FAILURE", attempt_count: 1, last_error_code: "DELIVERY_OUTCOME_UNKNOWN" } });
  const inProgress = bundle({ id: "doc_in_flight", status: "GENERATED", final: true, delivery: { status: "IN_PROGRESS", attempt_count: 1 } });
  const { service } = setup([confirmed, unknown, inProgress]);
  const confirmedDetails = await service.getDocumentDetails({ ownerWaId: OWNER, documentId: "doc_confirmed" });
  const unknownDetails = await service.getDocumentDetails({ ownerWaId: OWNER, documentId: "doc_unknown" });
  const inProgressDetails = await service.getDocumentDetails({ ownerWaId: OWNER, documentId: "doc_in_flight" });
  assert.equal(confirmedDetails.value.delivery.outcome, "CONFIRMED_FAILURE");
  assert.equal(unknownDetails.value.delivery.outcome, "OUTCOME_UNKNOWN");
  assert.equal(inProgressDetails.value.delivery.outcome, "IN_PROGRESS");
  const serialized = JSON.stringify([confirmedDetails, unknownDetails, inProgressDetails]);
  assert.doesNotMatch(serialized, /DELIVERY_PROVIDER_FAILED|DELIVERY_OUTCOME_UNKNOWN/, "the raw last_error_code value itself must never leak into the response — outcome is a closed-set classification, not the raw code");
});

test("details expose safe business state but not private file internals or event metadata", async () => {
  const source = bundle({ id: "doc_safe", final: true });
  source.preview = { preview_id: "preview_1", status: "ACTIVE", structured_preview: { total: 1000 } };
  source.generation_quote = { quote_id: "quote_1", status: "ACTIVE", total_credits: 1 };
  const { service } = setup([source]);
  const result = await service.getDocumentDetails({ ownerWaId: OWNER, documentId: "doc_safe" });
  const serialized = JSON.stringify(result.value);
  assert.equal(result.ok, true);
  assert.equal(serialized.includes("private/path"), false);
  assert.equal(serialized.includes("checksum"), false);
  assert.equal(serialized.includes("hidden"), false);
  assert.equal(result.value.preview.preview_id, "preview_1");
});

test("foreign owners receive fail-closed not-found responses", async () => {
  const { service } = setup([bundle({ id: "doc_private" })]);
  assert.equal((await service.getDocumentDetails({ ownerWaId: OTHER, documentId: "doc_private" })).error, "DOCUMENT_NOT_FOUND");
  assert.equal((await service.getDocumentHistory({ ownerWaId: OTHER, documentId: "doc_private" })).error, "DOCUMENT_NOT_FOUND");
  assert.equal((await service.getFinalFileReference({ ownerWaId: OTHER, documentId: "doc_private" })).error, "DOCUMENT_NOT_FOUND");
});

test("history allowlist removes internal event types and metadata", async () => {
  const source = bundle({ id: "doc_events" });
  source.events.push({ event_type: "INTERNAL_STORAGE_PROMOTED", metadata: { storage_ref: "secret" }, document_version: 1, occurred_at: clock() });
  const { service } = setup([source]);
  const result = await service.getDocumentHistory({ ownerWaId: OWNER, documentId: "doc_events" });
  assert.deepEqual(result.value.map((event) => event.event_type), ["DOCUMENT_CREATED"]);
  assert.equal(JSON.stringify(result.value).includes("metadata"), false);
});

test("version list is ordered and binds FINAL to the final file version", async () => {
  const source = bundle({ id: "doc_versions", final: true });
  source.versions = [{ version: 3 }, { version: 1 }, { version: 2 }];
  source.final_file.document_version = 3;
  const { service } = setup([source]);
  const result = await service.listDocumentVersions({ ownerWaId: OWNER, documentId: "doc_versions" });
  assert.deepEqual(result.value.map((entry) => [entry.version, entry.classification]), [[1, "DRAFT"], [2, "CORRECTION"], [3, "FINAL"]]);
});

test("final-file reference is opaque and requires future temporary access", async () => {
  const { service } = setup([bundle({ id: "doc_file", final: true })]);
  const result = await service.getFinalFileReference({ ownerWaId: OWNER, documentId: "doc_file" });
  assert.deepEqual(Object.keys(result.value).sort(), ["access", "document_id", "document_version", "filename", "final_file_id", "mime_type", "page_count"].sort());
  assert.equal(result.value.access, "TEMPORARY_ACCESS_REQUIRED");
  assert.equal((await createDeferredPrivateFileAccess().createTemporaryAccess()).error, "FINAL_FILE_ACCESS_NOT_CONFIGURED");
});

test("final-file reference exposes the same canonical filename used for WhatsApp delivery", async () => {
  const source = bundle({ id: "doc_named", final: true });
  source.document.document_number = "FA-20260806190633-A0EAC605";
  const { service } = setup([source]);
  const result = await service.getFinalFileReference({ ownerWaId: OWNER, documentId: "doc_named" });
  assert.equal(result.value.filename, "facture_FA-20260806190633-A0EAC605.pdf");
});

test("final-file reference filename distinguishes a proforma", async () => {
  const source = bundle({ id: "doc_proforma", final: true });
  source.document.document_number = "FA-20260806190633-A0EAC605";
  source.current_snapshot.options = { invoice_kind: "PROFORMA" };
  const { service } = setup([source]);
  const result = await service.getFinalFileReference({ ownerWaId: OWNER, documentId: "doc_proforma" });
  assert.equal(result.value.filename, "facture-proforma_FA-20260806190633-A0EAC605.pdf");
});

test("duplicate creates a clean version-1 draft and preserves source", async () => {
  const source = bundle({ id: "doc_source", status: "DELIVERED", final: true });
  source.current_snapshot.document_number = "FAC-X";
  source.current_snapshot.issued_at = clock();
  source.current_snapshot.preview = { secret: true };
  source.current_snapshot.generated_file = source.final_file;
  const { service, documentRepository } = setup([source]);
  const result = await service.duplicateAsDraft({ ownerWaId: OWNER, documentId: "doc_source", idempotencyKey: "duplicate_request_1" });
  assert.equal(result.ok, true);
  const stored = await documentRepository.getDocumentById({ ownerWaId: OWNER, documentId: "doc_duplicate" });
  assert.equal(stored.value.status, "COLLECTING");
  assert.equal(stored.value.version, 1);
  assert.equal(stored.value.document_number, null);
  assert.equal(stored.value.issued_at, null);
  assert.equal(stored.value.preview, null);
  assert.equal(stored.value.generated_file, null);
  assert.equal(source.current_snapshot.document_number, "FAC-X");
});

test("duplicate is idempotent and rejects legacy records", async () => {
  const { service } = setup([bundle({ id: "doc_source" }), bundle({ id: "legacy", classification: "LEGACY_READ_ONLY" })]);
  const first = await service.duplicateAsDraft({ ownerWaId: OWNER, documentId: "doc_source", idempotencyKey: "duplicate_request_2" });
  const replay = await service.duplicateAsDraft({ ownerWaId: OWNER, documentId: "doc_source", idempotencyKey: "duplicate_request_2" });
  assert.equal(first.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal((await service.duplicateAsDraft({ ownerWaId: OWNER, documentId: "legacy", idempotencyKey: "legacy_request" })).error, "LEGACY_DUPLICATION_REQUIRES_MIGRATION");
});

test("logs contain only correlation, owner hash, filter names, count and duration", async () => {
  const { service, logs } = setup([bundle({ id: "doc_log", client: "Private Person" })]);
  await service.searchDocuments({ ownerWaId: OWNER, filters: { counterparty: "Private Person" }, correlationId: "corr_safe" });
  assert.deepEqual(Object.keys(logs[0].data).sort(), ["correlation_id", "duration_ms", "filter_types", "owner_hash", "result_count"]);
  assert.equal(JSON.stringify(logs).includes(OWNER), false);
  assert.equal(JSON.stringify(logs).includes("Private Person"), false);
  assert.equal((await service.searchDocuments({ ownerWaId: OWNER, correlationId: "private name" })).error, "HISTORY_CORRELATION_ID_INVALID");
});

test("legacy adapter is read-only and classifies ambiguous records fail-closed", async () => {
  const adapter = createLegacyHistoryAdapter({ listOwnedLegacyDocuments: async () => [{ id: "a" }, { id: "b", classification: "LEGACY_READ_ONLY" }], getOwnedLegacyDocument: async () => ({ id: "a" }) });
  assert.deepEqual((await adapter.list({ ownerWaId: OWNER })).map((row) => row.classification), ["LEGACY_UNKNOWN", "LEGACY_READ_ONLY"]);
  assert.equal((await adapter.get({ ownerWaId: OWNER, documentId: "a" })).classification, "LEGACY_UNKNOWN");
  assert.equal("save" in adapter, false);
});

test("ambiguous legacy artifacts never become downloadable", async () => {
  const source = bundle({ id: "legacy_unknown_file", classification: "LEGACY_UNKNOWN", final: true });
  const { service } = setup([source]);
  const listed = await service.listRecentDocuments({ ownerWaId: OWNER });
  assert.equal(listed.value.documents[0].has_final_file, false);
  assert.equal(listed.value.documents[0].actions.includes("DOWNLOAD"), false);
  assert.equal((await service.getFinalFileReference({ ownerWaId: OWNER, documentId: "legacy_unknown_file" })).error, "FINAL_FILE_NOT_FOUND");
});

test("Supabase adapter always passes owner to owner-scoped RPCs", async () => {
  const calls = [];
  const client = {
    rpc: async (name, args) => { calls.push({ name, args }); return name.includes("search") ? { data: [], error: null } : { data: { document: {} }, error: null }; },
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
  };
  const repository = createSupabaseV1HistoryRepository(client);
  await repository.searchOwnedDocuments({ ownerWaId: OWNER, filters: {}, limit: 10, direction: "DESC" });
  await repository.getOwnedDocumentBundle({ ownerWaId: OWNER, documentId: "doc_1" });
  assert.equal(calls.every((call) => call.args.p_owner_wa_id === OWNER), true);
});

test("history migration is additive, owner-first and never exposes private file storage", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "20260802_zz_add_kadi_v1_history_search.sql"), "utf8");
  assert.match(sql, /create table if not exists public\.kadi_v1_history_duplicates/i);
  assert.match(sql, /where d\.owner_wa_id = p_owner_wa_id/i);
  assert.match(sql, /to_jsonb\(ff\) - 'storage_ref' - 'checksum'/i);
  assert.doesNotMatch(sql, /drop\s+(table|column)|truncate|delete\s+from/i);
});

test("history core has no Meta, AI, wallet, PDF generation or payment dependency", () => {
  const files = ["kadiV1HistoryService.js", "kadiV1HistoryRepository.js", "kadiV1SupabaseHistoryRepository.js"];
  const source = files.map((file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8")).join("\n");
  assert.doesNotMatch(source, /require\([^\n]*(whatsapp|openai|gemini|wallet|payment|pdfkit)|supabaseUrl|access_token/i);
});
