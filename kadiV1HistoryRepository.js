"use strict";

const HISTORY_REPOSITORY_METHODS = Object.freeze([
  "searchOwnedDocuments",
  "getOwnedDocumentBundle",
  "findDuplicateByIdempotencyKey",
  "rememberDuplicate",
]);

const ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function assertV1HistoryRepository(repository) {
  if (!repository || typeof repository !== "object") throw new TypeError("HISTORY_REPOSITORY_REQUIRED");
  for (const method of HISTORY_REPOSITORY_METHODS) {
    if (typeof repository[method] !== "function") throw new TypeError(`HISTORY_REPOSITORY_METHOD_REQUIRED:${method}`);
  }
  return repository;
}

function createInMemoryV1HistoryRepository({ bundles = [] } = {}) {
  const documents = new Map();
  const duplicates = new Map();
  for (const input of bundles) {
    const bundle = clone(input);
    if (!ID_PATTERN.test(bundle?.document?.document_id || "") || !ID_PATTERN.test(bundle?.owner_wa_id || "")) {
      throw new TypeError("HISTORY_SEED_INVALID");
    }
    documents.set(bundle.document.document_id, bundle);
  }

  async function searchOwnedDocuments({ ownerWaId, filters = {}, cursor = null, limit, direction = "DESC" }) {
    let rows = [...documents.values()].filter((entry) => entry.owner_wa_id === ownerWaId);
    const normalizedText = typeof filters.text === "string" ? filters.text.trim().toLocaleLowerCase("fr") : null;
    rows = rows.filter((entry) => {
      const document = entry.document;
      const snapshot = entry.current_snapshot || {};
      const counterparty = snapshot.client?.name || snapshot.receipt?.payer || snapshot.discharge?.receiver || null;
      const description = document.document_type === "DECHARGE"
        ? snapshot.discharge?.reason
        : (snapshot.items || []).map((item) => item.description).join(" ");
      if (filters.document_type && document.document_type !== filters.document_type) return false;
      if (filters.status && document.status !== filters.status) return false;
      if (filters.document_number && document.document_number !== filters.document_number) return false;
      if (filters.counterparty && !`${counterparty || ""}`.toLocaleLowerCase("fr").includes(filters.counterparty.toLocaleLowerCase("fr"))) return false;
      if (filters.from && new Date(document.issued_at || document.updated_at) < new Date(filters.from)) return false;
      if (filters.to && new Date(document.issued_at || document.updated_at) > new Date(filters.to)) return false;
      if (filters.min_total != null && snapshot.total < filters.min_total) return false;
      if (filters.max_total != null && snapshot.total > filters.max_total) return false;
      if (filters.has_final_file != null && Boolean(entry.final_file) !== filters.has_final_file) return false;
      if (normalizedText && !`${description || ""} ${counterparty || ""}`.toLocaleLowerCase("fr").includes(normalizedText)) return false;
      return true;
    });
    const multiplier = direction === "ASC" ? 1 : -1;
    rows.sort((left, right) => multiplier * (
      left.document.updated_at.localeCompare(right.document.updated_at) ||
      left.document.document_id.localeCompare(right.document.document_id)
    ));
    if (cursor) {
      rows = rows.filter((entry) => multiplier * (
        entry.document.updated_at.localeCompare(cursor.updated_at) ||
        entry.document.document_id.localeCompare(cursor.document_id)
      ) > 0);
    }
    const page = rows.slice(0, limit);
    return { ok: true, value: page.map(clone), has_more: rows.length > limit };
  }

  async function getOwnedDocumentBundle({ ownerWaId, documentId }) {
    const bundle = documents.get(documentId);
    return bundle?.owner_wa_id === ownerWaId
      ? { ok: true, value: clone(bundle) }
      : { ok: false, error: "DOCUMENT_NOT_FOUND" };
  }

  async function findDuplicateByIdempotencyKey({ ownerWaId, idempotencyKey }) {
    return { ok: true, value: clone(duplicates.get(`${ownerWaId}:${idempotencyKey}`) || null) };
  }

  async function rememberDuplicate({ ownerWaId, idempotencyKey, sourceDocumentId, newDocumentId }) {
    const key = `${ownerWaId}:${idempotencyKey}`;
    const existing = duplicates.get(key);
    if (existing && (existing.source_document_id !== sourceDocumentId || existing.new_document_id !== newDocumentId)) {
      return { ok: false, error: "HISTORY_IDEMPOTENCY_CONFLICT" };
    }
    const value = existing || { source_document_id: sourceDocumentId, new_document_id: newDocumentId };
    duplicates.set(key, value);
    return { ok: true, value: clone(value), duplicate: Boolean(existing) };
  }

  return Object.freeze(assertV1HistoryRepository({
    searchOwnedDocuments,
    getOwnedDocumentBundle,
    findDuplicateByIdempotencyKey,
    rememberDuplicate,
  }));
}

module.exports = { HISTORY_REPOSITORY_METHODS, assertV1HistoryRepository, createInMemoryV1HistoryRepository };
