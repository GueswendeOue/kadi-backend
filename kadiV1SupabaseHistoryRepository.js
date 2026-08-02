"use strict";

const { assertV1HistoryRepository } = require("./kadiV1HistoryRepository");

function ok(value, extra = {}) { return { ok: true, value, ...extra }; }
function fail(error) { return { ok: false, error }; }

function createSupabaseV1HistoryRepository(client) {
  if (!client || typeof client.rpc !== "function" || typeof client.from !== "function") {
    throw new TypeError("SUPABASE_CLIENT_REQUIRED");
  }

  async function searchOwnedDocuments({ ownerWaId, filters, cursor, limit, direction }) {
    const { data, error } = await client.rpc("kadi_v1_search_owned_documents", {
      p_owner_wa_id: ownerWaId,
      p_filters: filters,
      p_cursor_updated_at: cursor?.updated_at || null,
      p_cursor_document_id: cursor?.document_id || null,
      p_limit: limit + 1,
      p_direction: direction,
    });
    if (error) return fail("HISTORY_SEARCH_FAILED");
    const rows = Array.isArray(data) ? data : [];
    return ok(rows.slice(0, limit).map((entry) => entry.bundle), { has_more: rows.length > limit });
  }

  async function getOwnedDocumentBundle({ ownerWaId, documentId }) {
    const { data, error } = await client.rpc("kadi_v1_get_owned_document_history_bundle", {
      p_owner_wa_id: ownerWaId,
      p_document_id: documentId,
    });
    if (error || data == null) return fail("DOCUMENT_NOT_FOUND");
    return ok(data);
  }

  async function findDuplicateByIdempotencyKey({ ownerWaId, idempotencyKey }) {
    const { data, error } = await client
      .from("kadi_v1_history_duplicates")
      .select("source_document_id,new_document_id")
      .eq("owner_wa_id", ownerWaId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    return error ? fail("HISTORY_DUPLICATE_LOOKUP_FAILED") : ok(data || null);
  }

  async function rememberDuplicate({ ownerWaId, idempotencyKey, sourceDocumentId, newDocumentId }) {
    const { data, error } = await client.rpc("kadi_v1_remember_history_duplicate", {
      p_owner_wa_id: ownerWaId,
      p_idempotency_key: idempotencyKey,
      p_source_document_id: sourceDocumentId,
      p_new_document_id: newDocumentId,
    });
    return error ? fail("HISTORY_IDEMPOTENCY_CONFLICT") : ok(data);
  }

  return Object.freeze(assertV1HistoryRepository({ searchOwnedDocuments, getOwnedDocumentBundle, findDuplicateByIdempotencyKey, rememberDuplicate }));
}

module.exports = { createSupabaseV1HistoryRepository };
