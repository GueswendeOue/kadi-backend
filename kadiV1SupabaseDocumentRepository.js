"use strict";

const { restoreDocumentSnapshot } = require("./kadiV1DocumentDomain");
const { assertV1DocumentRepository, normalizeMetadata } = require("./kadiV1DocumentRepository");

function ok(value, extra = {}) {
  return { ok: true, value, ...extra };
}

function fail(error) {
  return { ok: false, error };
}

function mapError(error, fallback) {
  const text = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`;
  if (/KADI_V1_VERSION_CONFLICT/i.test(text)) return "DOCUMENT_VERSION_CONFLICT";
  if (/KADI_V1_STATE_CONFLICT/i.test(text)) return "DOCUMENT_STATE_CONFLICT";
  if (/KADI_V1_IDEMPOTENCY_CONFLICT/i.test(text)) return "DOCUMENT_IDEMPOTENCY_CONFLICT";
  if (/KADI_V1_NOT_FOUND/i.test(text)) return "DOCUMENT_NOT_FOUND";
  if (/duplicate key|unique constraint/i.test(text)) return "DOCUMENT_ALREADY_EXISTS";
  return fallback;
}

function rpcValue(data) {
  return Array.isArray(data) ? data[0] : data;
}

function createSupabaseV1DocumentRepository(client) {
  if (!client || typeof client.from !== "function" || typeof client.rpc !== "function") {
    throw new TypeError("SUPABASE_CLIENT_REQUIRED");
  }

  async function createDocument({ document, ownerWaId, idempotencyKey, legacyReference = null, metadata = {} }) {
    const safeMetadata = normalizeMetadata(metadata);
    if (!safeMetadata.ok) return safeMetadata;
    if (document?.issued_at != null || document?.document_number != null) return fail("DOCUMENT_SERVER_FIELD_FORBIDDEN");
    const { data, error } = await client.rpc("kadi_v1_create_document", {
      p_document: {
        document_id: document?.document_id,
        document_type: document?.document_type,
        status: document?.status,
        version: document?.version,
        issuer_profile_id: document?.issuer_profile_id ?? null,
        currency: document?.currency,
        issued_at: null,
        document_number: null,
      },
      p_owner_wa_id: ownerWaId,
      p_snapshot: document,
      p_items: document?.items || [],
      p_event_type: "DOCUMENT_CREATED",
      p_idempotency_key: idempotencyKey,
      p_legacy_source: legacyReference?.source || null,
      p_legacy_id: legacyReference?.id || null,
      p_metadata: safeMetadata.value,
    });
    if (error) return fail(mapError(error, "DOCUMENT_CREATE_FAILED"));
    return ok(document, { duplicate: rpcValue(data)?.duplicate === true });
  }

  async function getDocumentById({ documentId, ownerWaId }) {
    const { data: row, error: rowError } = await client
      .from("kadi_v1_documents")
      .select("*")
      .eq("document_id", documentId)
      .eq("owner_wa_id", ownerWaId)
      .maybeSingle();
    if (rowError || !row) return fail("DOCUMENT_NOT_FOUND");
    const { data: version, error: versionError } = await client
      .from("kadi_v1_document_versions")
      .select("snapshot")
      .eq("document_id", documentId)
      .eq("version", row.active_version)
      .single();
    if (versionError || !version) return fail("DOCUMENT_SNAPSHOT_INVALID");
    const { data: eventRows, error: eventError } = await client
      .from("kadi_v1_document_events")
      .select("event_type,from_state,to_state,document_version,occurred_at")
      .eq("document_id", documentId)
      .order("event_id", { ascending: true });
    if (eventError) return fail("DOCUMENT_EVENTS_LOAD_FAILED");
    const restored = restoreDocumentSnapshot({
      ...version.snapshot,
      status: row.status,
      version: row.active_version,
      issuer_profile_id: row.issuer_profile_id,
      currency: row.currency,
      issued_at: row.issued_at,
      document_number: row.document_number,
      preview: row.preview,
      generation_quote: row.generation_quote,
      generation_cost: row.generation_cost,
      generated_file: row.generated_file,
      recoverable_failure: row.recoverable_failure,
      cancelled_at: row.cancelled_at,
      events: (eventRows || []).map((event) => ({
        type: event.event_type,
        from_state: event.from_state,
        to_state: event.to_state,
        version: event.document_version,
        occurred_at: event.occurred_at,
      })),
    });
    return restored.ok ? restored : fail("DOCUMENT_SNAPSHOT_INVALID");
  }

  async function persistTransition({
    document,
    ownerWaId,
    expectedVersion,
    fromState,
    eventType,
    idempotencyKey,
    metadata = {},
  }) {
    const safeMetadata = normalizeMetadata(metadata);
    if (!safeMetadata.ok) return safeMetadata;
    const rpcName = document?.status === "GENERATED" && document?.generated_file
      ? "kadi_v1_persist_generated_transition"
      : "kadi_v1_persist_transition";
    const { data, error } = await client.rpc(rpcName, {
      p_document_id: document?.document_id,
      p_owner_wa_id: ownerWaId,
      p_expected_version: expectedVersion,
      p_new_snapshot: document,
      p_items: document?.items || [],
      p_event_type: eventType,
      p_from_state: fromState,
      p_to_state: document?.status,
      p_idempotency_key: idempotencyKey,
      p_event_metadata: safeMetadata.value,
    });
    if (error) return fail(mapError(error, "DOCUMENT_PERSIST_FAILED"));
    const result = rpcValue(data) || {};
    const restored = restoreDocumentSnapshot({
      ...document,
      issued_at: result.issued_at ?? document.issued_at,
    });
    return restored.ok ? ok(restored.value, { duplicate: result.duplicate === true }) : restored;
  }

  async function saveNewVersion(command) {
    if (!command?.document || command.document.version !== command.expectedVersion + 1) {
      return fail("DOCUMENT_NEW_VERSION_REQUIRED");
    }
    return persistTransition(command);
  }

  async function appendDomainEvent({
    documentId,
    ownerWaId,
    eventType,
    fromState,
    toState,
    idempotencyKey,
    metadata = {},
  }) {
    const safeMetadata = normalizeMetadata(metadata);
    if (!safeMetadata.ok) return safeMetadata;
    const { data, error } = await client.rpc("kadi_v1_append_domain_event", {
      p_document_id: documentId,
      p_owner_wa_id: ownerWaId,
      p_event_type: eventType,
      p_from_state: fromState,
      p_to_state: toState,
      p_idempotency_key: idempotencyKey,
      p_event_metadata: safeMetadata.value,
    });
    if (error) return fail(mapError(error, "DOCUMENT_EVENT_APPEND_FAILED"));
    return ok(rpcValue(data), { duplicate: rpcValue(data)?.duplicate === true });
  }

  async function findByIdempotencyKey(idempotencyKey) {
    const { data, error } = await client
      .from("kadi_v1_idempotency_records")
      .select("idempotency_key,operation_type,document_id,document_version,event_id,created_at")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    return error ? fail("DOCUMENT_IDEMPOTENCY_LOOKUP_FAILED") : ok(data || null);
  }

  async function listVersions({ documentId, ownerWaId }) {
    const { data: owner, error: ownerError } = await client
      .from("kadi_v1_documents")
      .select("document_id")
      .eq("document_id", documentId)
      .eq("owner_wa_id", ownerWaId)
      .maybeSingle();
    if (ownerError || !owner) return fail("DOCUMENT_NOT_FOUND");
    const { data, error } = await client
      .from("kadi_v1_document_versions")
      .select("version,snapshot,created_at")
      .eq("document_id", documentId)
      .order("version", { ascending: true });
    return error ? fail("DOCUMENT_VERSIONS_LOAD_FAILED") : ok(data || []);
  }

  return Object.freeze(assertV1DocumentRepository({
    appendDomainEvent,
    createDocument,
    findByIdempotencyKey,
    getDocumentById,
    listVersions,
    persistTransition,
    saveNewVersion,
  }));
}

module.exports = { createSupabaseV1DocumentRepository, mapError };
