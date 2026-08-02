"use strict";

const crypto = require("node:crypto");
const { PDFDocument } = require("pdf-lib");
const { assertGenerationLifecycleRepository } = require("./kadiV1GenerationLifecycleRepository");
const { createExistingPdfTemporaryRenderer } = require("./kadiV1TemporaryRenderService");

const PDF_MIME = "application/pdf";
const ok = (value, extra = {}) => ({ ok: true, value, ...extra });
const fail = (error) => ({ ok: false, error });
const valid = (value) => typeof value === "string" && /^[A-Za-z0-9:_.-]{1,200}$/.test(value);

function createInMemoryFinalFileStorage() {
  const staging = new Map();
  const promoted = new Map();
  return Object.freeze({
    async putStaging({ generationAttemptId, buffer }) {
      if (!valid(generationAttemptId) || !Buffer.isBuffer(buffer) || buffer.length === 0) return fail("FINAL_STAGING_INPUT_INVALID");
      const ref = `private-generation:${generationAttemptId}`;
      staging.set(ref, Buffer.from(buffer));
      return ok({ storage_ref: ref, publicly_accessible: false });
    },
    async readStaging(ref) { return staging.has(ref) ? ok(Buffer.from(staging.get(ref))) : fail("FINAL_STAGING_NOT_FOUND"); },
    async deleteStaging(ref) { staging.delete(ref); return ok(true); },
    async promote({ stagingRef, finalFileId }) {
      const ref = `private-final:${finalFileId}`;
      if (promoted.has(ref)) return ok({ storage_ref: ref, publicly_accessible: false }, { duplicate: true });
      if (!staging.has(stagingRef)) return fail("FINAL_STAGING_NOT_FOUND");
      promoted.set(ref, Buffer.from(staging.get(stagingRef)));
      staging.delete(stagingRef);
      return ok({ storage_ref: ref, publicly_accessible: false });
    },
    async readFinal(ref) { return promoted.has(ref) ? ok(Buffer.from(promoted.get(ref))) : fail("FINAL_FILE_BYTES_NOT_FOUND"); },
  });
}

function createExistingPdfFinalRenderer(options = {}) {
  return createExistingPdfTemporaryRenderer(options);
}

function createFinalGenerationService({ repository, storage, renderer, clock = () => new Date().toISOString(), idFactory } = {}) {
  const store = assertGenerationLifecycleRepository(repository);
  if (typeof renderer?.render !== "function") throw new TypeError("FINAL_RENDERER_REQUIRED");
  for (const method of ["putStaging", "readStaging", "deleteStaging", "promote", "readFinal"]) {
    if (typeof storage?.[method] !== "function") throw new TypeError(`FINAL_STORAGE_METHOD_REQUIRED:${method}`);
  }
  const makeId = idFactory || ((kind, key) => `${kind}:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}`);

  async function generatePrivate({ generationAttemptId, preview, expectedPageCount }) {
    const attempt = await store.getGenerationAttempt({ generationAttemptId });
    if (!attempt.ok || attempt.value.status !== "STARTED") return fail("GENERATION_ATTEMPT_NOT_GENERATABLE");
    let rendered;
    try { rendered = await renderer.render({ preview }); } catch { return fail("FINAL_RENDER_FAILED"); }
    if (!rendered.ok) return rendered;
    const buffer = rendered.value?.buffer;
    if (rendered.value?.mime_type !== PDF_MIME || !Buffer.isBuffer(buffer) || buffer.length === 0) return fail("FINAL_PDF_INVALID");
    let pageCount;
    try { pageCount = (await PDFDocument.load(buffer, { updateMetadata: false })).getPageCount(); } catch { return fail("FINAL_PDF_CORRUPT"); }
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) return fail("FINAL_PDF_PAGE_COUNT_INVALID");
    if (pageCount !== expectedPageCount) return fail("FINAL_PDF_PAGE_COUNT_MISMATCH");
    let staged;
    try { staged = await storage.putStaging({ generationAttemptId, buffer, mimeType: PDF_MIME }); } catch { return fail("FINAL_STORAGE_FAILED"); }
    if (!staged.ok || staged.value.publicly_accessible !== false) return fail("FINAL_STORAGE_NOT_PRIVATE");
    const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
    return store.updateGenerationAttempt({
      generationAttemptId, expectedStatus: "STARTED",
      changes: { status: "PDF_VALIDATED", staging_ref: staged.value.storage_ref, checksum, page_count: pageCount, byte_size: buffer.length, validated_at: new Date(clock()).toISOString() },
    });
  }

  async function discardPrivate({ generationAttemptId }) {
    const attempt = await store.getGenerationAttempt({ generationAttemptId });
    if (attempt.ok && attempt.value.staging_ref) await storage.deleteStaging(attempt.value.staging_ref);
    return ok(true);
  }

  async function markCaptured({ generationAttemptId, reservationId }) {
    const attempt = await store.getGenerationAttempt({ generationAttemptId });
    if (!attempt.ok) return attempt;
    if (["CAPTURED", "PROMOTED"].includes(attempt.value.status)) return ok(attempt.value, { duplicate: true });
    return store.updateGenerationAttempt({ generationAttemptId, expectedStatus: "PDF_VALIDATED", changes: { status: "CAPTURED", reservation_id: reservationId, captured_at: new Date(clock()).toISOString() } });
  }

  async function promoteFinal({ generationAttemptId, documentId, documentVersion, idempotencyKey }) {
    const attempt = await store.getGenerationAttempt({ generationAttemptId });
    if (!attempt.ok || !["CAPTURED", "PROMOTED"].includes(attempt.value.status)) return fail("GENERATION_ATTEMPT_NOT_PROMOTABLE");
    const finalFileId = makeId("final", generationAttemptId);
    const existing = await store.getFinalFile({ finalFileId });
    if (existing.ok) return ok(existing.value, { duplicate: true });
    let promoted;
    try { promoted = await storage.promote({ stagingRef: attempt.value.staging_ref, finalFileId }); } catch { return fail("FINAL_FILE_PROMOTION_FAILED"); }
    if (!promoted.ok || promoted.value.publicly_accessible !== false) return fail("FINAL_FILE_PROMOTION_FAILED");
    const finalFile = {
      final_file_id: finalFileId, document_id: documentId, document_version: documentVersion,
      generation_attempt_id: generationAttemptId, storage_ref: promoted.value.storage_ref,
      checksum: attempt.value.checksum, page_count: attempt.value.page_count,
      mime_type: PDF_MIME, generated_at: new Date(clock()).toISOString(), immutable: true,
    };
    const stored = await store.promoteFinalFile({ finalFile, idempotencyKey });
    if (!stored.ok) return stored;
    if (attempt.value.status === "CAPTURED") await store.updateGenerationAttempt({ generationAttemptId, expectedStatus: "CAPTURED", changes: { status: "PROMOTED", final_file_id: finalFileId, promoted_at: finalFile.generated_at } });
    return stored;
  }

  return Object.freeze({ generatePrivate, discardPrivate, markCaptured, promoteFinal });
}

module.exports = { createExistingPdfFinalRenderer, createFinalGenerationService, createInMemoryFinalFileStorage };
