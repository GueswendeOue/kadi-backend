"use strict";

const PREVIEW_REPOSITORY_METHODS = Object.freeze([
  "createPreview",
  "getPreview",
  "findPreviewByIdempotencyKey",
  "setPreviewStatus",
  "createTemporaryRender",
  "getTemporaryRender",
  "findRenderByIdempotencyKey",
  "updateTemporaryRender",
  "createGenerationQuote",
  "getGenerationQuote",
  "findQuoteByIdempotencyKey",
  "setGenerationQuoteStatus",
  "invalidateDocumentArtifacts",
]);

const ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const KEY_PATTERN = /^[A-Za-z0-9:_.-]{1,200}$/;
const PREVIEW_STATUSES = Object.freeze(["ACTIVE", "INVALIDATED"]);
const RENDER_STATUSES = Object.freeze(["CREATED", "INSPECTED", "INVALIDATED", "EXPIRED", "DELETED"]);
const QUOTE_STATUSES = Object.freeze(["ACTIVE", "EXPIRED", "INVALIDATED", "CONSUMED"]);

function ok(value, extra = {}) {
  return { ok: true, value, ...extra };
}

function fail(error) {
  return { ok: false, error };
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function validId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function validKey(value) {
  return typeof value === "string" && KEY_PATTERN.test(value);
}

function assertV1PreviewRepository(repository) {
  if (!repository || typeof repository !== "object") throw new TypeError("PREVIEW_REPOSITORY_REQUIRED");
  for (const method of PREVIEW_REPOSITORY_METHODS) {
    if (typeof repository[method] !== "function") throw new TypeError(`PREVIEW_REPOSITORY_METHOD_REQUIRED:${method}`);
  }
  return repository;
}

function createInMemoryV1PreviewRepository({ failpoint = async () => {} } = {}) {
  if (typeof failpoint !== "function") throw new TypeError("PREVIEW_REPOSITORY_FAILPOINT_INVALID");
  const previews = new Map();
  const renders = new Map();
  const quotes = new Map();
  const idempotency = new Map();
  let writeQueue = Promise.resolve();

  async function serialized(write) {
    const previous = writeQueue;
    let release;
    writeQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await write();
    } finally {
      release();
    }
  }

  function replay(key, operation) {
    const existing = idempotency.get(key);
    if (!existing) return null;
    if (existing.operation !== operation) return fail("ARTIFACT_IDEMPOTENCY_CONFLICT");
    const source = operation === "preview" ? previews : operation === "render" ? renders : quotes;
    return ok(clone(source.get(existing.id)), { duplicate: true });
  }

  async function createRecord({ map, operation, record, idempotencyKey, idField }) {
    if (!validKey(idempotencyKey) || !validId(record?.[idField])) return fail("ARTIFACT_CREATE_INPUT_INVALID");
    const repeated = replay(idempotencyKey, operation);
    if (repeated) return repeated;
    if (map.has(record[idField])) return fail("ARTIFACT_ALREADY_EXISTS");
    await failpoint(`before_${operation}_commit`, clone(record));
    const storedRecord = { ...clone(record), revision: record.revision ?? 1 };
    map.set(record[idField], storedRecord);
    idempotency.set(idempotencyKey, { operation, id: record[idField] });
    return ok(clone(storedRecord));
  }

  async function createPreview({ preview, idempotencyKey }) {
    return serialized(async () => {
      if (!PREVIEW_STATUSES.includes(preview?.status)) return fail("PREVIEW_STATUS_INVALID");
      const repeated = replay(idempotencyKey, "preview");
      if (repeated) return repeated;
      const active = [...previews.values()].find((entry) =>
        entry.document_id === preview.document_id && entry.document_version === preview.document_version && entry.status === "ACTIVE"
      );
      if (active) return fail("PREVIEW_ACTIVE_VERSION_CONFLICT");
      return createRecord({ map: previews, operation: "preview", record: preview, idempotencyKey, idField: "preview_id" });
    });
  }

  async function getPreview({ previewId }) {
    if (!validId(previewId)) return fail("PREVIEW_ID_INVALID");
    return previews.has(previewId) ? ok(clone(previews.get(previewId))) : fail("PREVIEW_NOT_FOUND");
  }

  async function findPreviewByIdempotencyKey(key) {
    if (!validKey(key)) return fail("ARTIFACT_IDEMPOTENCY_KEY_INVALID");
    const repeated = replay(key, "preview");
    return repeated || ok(null);
  }

  async function setPreviewStatus({ previewId, status }) {
    if (!validId(previewId) || !PREVIEW_STATUSES.includes(status)) return fail("PREVIEW_STATUS_UPDATE_INVALID");
    const record = previews.get(previewId);
    if (!record) return fail("PREVIEW_NOT_FOUND");
    record.status = status;
    record.revision += 1;
    return ok(clone(record));
  }

  async function createTemporaryRender({ render, idempotencyKey }) {
    return serialized(async () => {
      if (!RENDER_STATUSES.includes(render?.status)) return fail("TEMPORARY_RENDER_STATUS_INVALID");
      return createRecord({ map: renders, operation: "render", record: render, idempotencyKey, idField: "render_id" });
    });
  }

  async function getTemporaryRender({ renderId }) {
    if (!validId(renderId)) return fail("TEMPORARY_RENDER_ID_INVALID");
    return renders.has(renderId) ? ok(clone(renders.get(renderId))) : fail("TEMPORARY_RENDER_NOT_FOUND");
  }

  async function findRenderByIdempotencyKey(key) {
    if (!validKey(key)) return fail("ARTIFACT_IDEMPOTENCY_KEY_INVALID");
    const repeated = replay(key, "render");
    return repeated || ok(null);
  }

  async function updateTemporaryRender({ renderId, expectedStatus, changes }) {
    if (!validId(renderId) || !RENDER_STATUSES.includes(changes?.status)) return fail("TEMPORARY_RENDER_UPDATE_INVALID");
    const record = renders.get(renderId);
    if (!record) return fail("TEMPORARY_RENDER_NOT_FOUND");
    if (record.status !== expectedStatus) return fail("TEMPORARY_RENDER_STATUS_CONFLICT");
    Object.assign(record, clone(changes));
    record.revision += 1;
    return ok(clone(record));
  }

  async function createGenerationQuote({ quote, idempotencyKey }) {
    return serialized(async () => {
      if (!QUOTE_STATUSES.includes(quote?.status)) return fail("GENERATION_QUOTE_STATUS_INVALID");
      const repeated = replay(idempotencyKey, "quote");
      if (repeated) return repeated;
      const active = [...quotes.values()].find((entry) =>
        entry.document_id === quote.document_id && entry.document_version === quote.document_version && entry.status === "ACTIVE"
      );
      if (active) return fail("GENERATION_QUOTE_ACTIVE_VERSION_CONFLICT");
      return createRecord({ map: quotes, operation: "quote", record: quote, idempotencyKey, idField: "quote_id" });
    });
  }

  async function getGenerationQuote({ quoteId }) {
    if (!validId(quoteId)) return fail("GENERATION_QUOTE_ID_INVALID");
    return quotes.has(quoteId) ? ok(clone(quotes.get(quoteId))) : fail("GENERATION_QUOTE_NOT_FOUND");
  }

  async function findQuoteByIdempotencyKey(key) {
    if (!validKey(key)) return fail("ARTIFACT_IDEMPOTENCY_KEY_INVALID");
    const repeated = replay(key, "quote");
    return repeated || ok(null);
  }

  async function setGenerationQuoteStatus({ quoteId, status }) {
    if (!validId(quoteId) || !QUOTE_STATUSES.includes(status)) return fail("GENERATION_QUOTE_STATUS_UPDATE_INVALID");
    const record = quotes.get(quoteId);
    if (!record) return fail("GENERATION_QUOTE_NOT_FOUND");
    record.status = status;
    record.revision += 1;
    return ok(clone(record));
  }

  async function invalidateDocumentArtifacts({ documentId, exceptVersion = null }) {
    if (!validId(documentId)) return fail("DOCUMENT_ID_INVALID");
    for (const preview of previews.values()) {
      if (preview.document_id === documentId && preview.document_version !== exceptVersion && preview.status === "ACTIVE") {
        preview.status = "INVALIDATED";
        preview.revision += 1;
      }
    }
    for (const render of renders.values()) {
      if (render.document_id === documentId && render.document_version !== exceptVersion && ["CREATED", "INSPECTED"].includes(render.status)) {
        render.status = "INVALIDATED";
        render.revision += 1;
      }
    }
    for (const quote of quotes.values()) {
      if (quote.document_id === documentId && quote.document_version !== exceptVersion && quote.status === "ACTIVE") {
        quote.status = "INVALIDATED";
        quote.revision += 1;
      }
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

module.exports = {
  PREVIEW_REPOSITORY_METHODS,
  PREVIEW_STATUSES,
  QUOTE_STATUSES,
  RENDER_STATUSES,
  assertV1PreviewRepository,
  createInMemoryV1PreviewRepository,
};
