"use strict";

const { assertV1PreviewRepository } = require("./kadiV1PreviewRepository");

function ok(value, extra = {}) {
  return { ok: true, value, ...extra };
}

function fail(error) {
  return { ok: false, error };
}

function createSupabaseV1PreviewRepository(client) {
  if (!client || typeof client.from !== "function") throw new TypeError("SUPABASE_CLIENT_REQUIRED");

  async function findByKey(table, idempotencyKey) {
    const { data, error } = await client.from(table).select("*").eq("idempotency_key", idempotencyKey).maybeSingle();
    return error ? fail("ARTIFACT_IDEMPOTENCY_LOOKUP_FAILED") : ok(data || null);
  }

  async function insertIdempotent(table, record, idempotencyKey, conflictError) {
    const replay = await findByKey(table, idempotencyKey);
    if (!replay.ok || replay.value) return replay.ok ? ok(replay.value, { duplicate: true }) : replay;
    const { data, error } = await client.from(table).insert({ ...record, idempotency_key: idempotencyKey }).select("*").single();
    if (!error) return ok(data);
    const raced = await findByKey(table, idempotencyKey);
    return raced.ok && raced.value ? ok(raced.value, { duplicate: true }) : fail(conflictError);
  }

  const createPreview = ({ preview, idempotencyKey }) =>
    insertIdempotent("kadi_v1_document_previews", preview, idempotencyKey, "PREVIEW_CREATE_FAILED");
  const findPreviewByIdempotencyKey = (key) => findByKey("kadi_v1_document_previews", key);
  const createTemporaryRender = ({ render, idempotencyKey }) =>
    insertIdempotent("kadi_v1_temporary_renders", render, idempotencyKey, "TEMPORARY_RENDER_CREATE_FAILED");
  const findRenderByIdempotencyKey = (key) => findByKey("kadi_v1_temporary_renders", key);
  const createGenerationQuote = ({ quote, idempotencyKey }) =>
    insertIdempotent("kadi_v1_generation_quotes", quote, idempotencyKey, "GENERATION_QUOTE_CREATE_FAILED");
  const findQuoteByIdempotencyKey = (key) => findByKey("kadi_v1_generation_quotes", key);

  async function getOne(table, field, value, missingError) {
    const { data, error } = await client.from(table).select("*").eq(field, value).maybeSingle();
    return error || !data ? fail(missingError) : ok(data);
  }

  const getPreview = ({ previewId }) => getOne("kadi_v1_document_previews", "preview_id", previewId, "PREVIEW_NOT_FOUND");
  const getTemporaryRender = ({ renderId }) => getOne("kadi_v1_temporary_renders", "render_id", renderId, "TEMPORARY_RENDER_NOT_FOUND");
  const getGenerationQuote = ({ quoteId }) => getOne("kadi_v1_generation_quotes", "quote_id", quoteId, "GENERATION_QUOTE_NOT_FOUND");

  async function updateOne(table, field, id, changes, missingError, expectedStatus = null) {
    const current = await getOne(table, field, id, missingError);
    if (!current.ok) return current;
    let query = client.from(table)
      .update({ ...changes, revision: current.value.revision + 1 })
      .eq(field, id)
      .eq("revision", current.value.revision);
    if (expectedStatus != null) query = query.eq("status", expectedStatus);
    const { data, error } = await query.select("*").maybeSingle();
    return error || !data ? fail(missingError) : ok(data);
  }

  const setPreviewStatus = ({ previewId, status }) => updateOne(
    "kadi_v1_document_previews", "preview_id", previewId,
    { status, invalidated_at: status === "INVALIDATED" ? new Date().toISOString() : null }, "PREVIEW_NOT_FOUND"
  );
  const updateTemporaryRender = ({ renderId, expectedStatus, changes }) => updateOne(
    "kadi_v1_temporary_renders", "render_id", renderId, changes,
    "TEMPORARY_RENDER_STATUS_CONFLICT", expectedStatus
  );
  const setGenerationQuoteStatus = ({ quoteId, status }) => updateOne(
    "kadi_v1_generation_quotes", "quote_id", quoteId, { status }, "GENERATION_QUOTE_NOT_FOUND"
  );

  async function invalidateDocumentArtifacts({ documentId, exceptVersion = null }) {
    const targets = [
      ["kadi_v1_document_previews", ["ACTIVE"]],
      ["kadi_v1_temporary_renders", ["CREATED", "INSPECTED"]],
      ["kadi_v1_generation_quotes", ["ACTIVE"]],
    ];
    for (const [table, statuses] of targets) {
      let query = client.from(table).update({ status: "INVALIDATED" }).eq("document_id", documentId).in("status", statuses);
      if (exceptVersion != null) query = query.neq("document_version", exceptVersion);
      const { error } = await query;
      if (error) return fail("ARTIFACT_INVALIDATION_FAILED");
    }
    return ok(true);
  }

  return Object.freeze(assertV1PreviewRepository({
    createGenerationQuote,
    createPreview,
    createTemporaryRender,
    findPreviewByIdempotencyKey,
    findQuoteByIdempotencyKey,
    findRenderByIdempotencyKey,
    getGenerationQuote,
    getPreview,
    getTemporaryRender,
    invalidateDocumentArtifacts,
    setGenerationQuoteStatus,
    setPreviewStatus,
    updateTemporaryRender,
  }));
}

module.exports = { createSupabaseV1PreviewRepository };
