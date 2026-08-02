"use strict";

const crypto = require("node:crypto");
const sharp = require("sharp");
const { PDFDocument } = require("pdf-lib");
const { assertTemporaryMediaStore } = require("./kadiV1TemporaryMediaStore");
const { checksumBuffer, validateMediaInput } = require("./kadiV1MediaContracts");

const MEDIA_EVENTS = new Set([
  "media_received", "media_validation_succeeded", "media_validation_failed",
  "temporary_media_expired",
]);
const EXTENSIONS = Object.freeze({
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "application/pdf": ["pdf"],
});

function safeEmitter(logger) {
  const sink = typeof logger === "function" ? logger : () => {};
  return (event, details) => {
    if (!MEDIA_EVENTS.has(event)) return;
    const safe = {
      correlation_id: typeof details.correlation_id === "string" ? crypto.createHash("sha256").update(details.correlation_id).digest("hex").slice(0, 16) : null,
      checksum_short: typeof details.checksum === "string" ? details.checksum.slice(0, 12) : null,
      mime_type: typeof details.mime_type === "string" ? details.mime_type.slice(0, 100) : null,
      byte_size: Number.isSafeInteger(details.byte_size) ? details.byte_size : null,
      page_count: Number.isSafeInteger(details.page_count) ? details.page_count : null,
      error_code: typeof details.error_code === "string" ? details.error_code.slice(0, 80) : null,
    };
    try { sink(event, Object.freeze(safe)); } catch { /* logging cannot alter validation */ }
  };
}

function sniffMime(buffer) {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function extensionOf(filename) {
  if (filename == null) return null;
  if (typeof filename !== "string" || filename.length > 255) return "INVALID";
  const match = filename.toLowerCase().match(/\.([a-z0-9]{1,10})$/);
  return match?.[1] || null;
}

async function defaultImageInspector(buffer) {
  const metadata = await sharp(buffer, { failOn: "error" }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("MEDIA_IMAGE_EMPTY");
  return { width: metadata.width, height: metadata.height };
}

async function defaultPdfInspector(buffer) {
  const document = await PDFDocument.load(buffer, { ignoreEncryption: false, updateMetadata: false });
  const pageCount = document.getPageCount();
  if (pageCount < 1) throw new Error("MEDIA_PDF_EMPTY");
  return { page_count: pageCount };
}

function createMediaValidationService({
  temporaryMediaStore,
  config,
  clock = () => new Date().toISOString(),
  idFactory = () => `media_${crypto.randomUUID().replaceAll("-", "")}`,
  imageInspector = defaultImageInspector,
  pdfInspector = defaultPdfInspector,
  logger = null,
} = {}) {
  assertTemporaryMediaStore(temporaryMediaStore);
  const limits = {
    maxImageBytes: config?.maxImageBytes,
    maxPdfBytes: config?.maxPdfBytes,
    maxPages: config?.maxPages,
    retentionMs: config?.retentionMs,
  };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)) throw new TypeError("MEDIA_LIMITS_INVALID");
  if (typeof imageInspector !== "function" || typeof pdfInspector !== "function") throw new TypeError("MEDIA_INSPECTOR_INVALID");
  const emit = safeEmitter(logger);

  async function ingest({ ownerRef, sourceType, files, correlationId }) {
    if (typeof ownerRef !== "string" || !/^[A-Za-z0-9:_-]{1,200}$/.test(ownerRef) ||
        typeof correlationId !== "string" || !/^[A-Za-z0-9:_-]{1,200}$/.test(correlationId)) {
      return { ok: false, error: "MEDIA_OWNERSHIP_CONTEXT_INVALID" };
    }
    if (!Array.isArray(files) || files.length === 0 || (sourceType !== "MULTI_IMAGE" && files.length !== 1)) {
      return { ok: false, error: "MEDIA_FILES_INVALID" };
    }
    if (sourceType === "MULTI_IMAGE" && files.length > limits.maxPages) return { ok: false, error: "MEDIA_PAGE_LIMIT_EXCEEDED" };
    emit("media_received", { correlation_id: correlationId });
    try {
      const inspected = [];
      for (const file of files) {
        if (!Buffer.isBuffer(file?.buffer) || file.buffer.length === 0) throw Object.assign(new Error(), { code: "MEDIA_EMPTY" });
        const sniffed = sniffMime(file.buffer);
        if (!sniffed || sniffed !== file.mime_type) throw Object.assign(new Error(), { code: "MEDIA_CONTENT_TYPE_MISMATCH" });
        const allowedExtensions = EXTENSIONS[sniffed];
        const extension = extensionOf(file.filename);
        if (extension === "INVALID" || (extension && !allowedExtensions.includes(extension))) throw Object.assign(new Error(), { code: "MEDIA_EXTENSION_MISMATCH" });
        if (sourceType === "PDF" && sniffed !== "application/pdf") throw Object.assign(new Error(), { code: "MEDIA_SOURCE_MIME_MISMATCH" });
        if (sourceType !== "PDF" && sniffed === "application/pdf") throw Object.assign(new Error(), { code: "MEDIA_SOURCE_MIME_MISMATCH" });
        if (sniffed === "application/pdf") {
          if (file.buffer.length > limits.maxPdfBytes) throw Object.assign(new Error(), { code: "MEDIA_TOO_LARGE" });
          if (/\/Encrypt\b/.test(file.buffer.toString("latin1"))) throw Object.assign(new Error(), { code: "MEDIA_PDF_ENCRYPTED" });
          let result;
          try { result = await pdfInspector(file.buffer); } catch { throw Object.assign(new Error(), { code: "MEDIA_PDF_UNREADABLE" }); }
          if (!Number.isSafeInteger(result.page_count) || result.page_count < 1) throw Object.assign(new Error(), { code: "MEDIA_PDF_UNREADABLE" });
          if (result.page_count > limits.maxPages) throw Object.assign(new Error(), { code: "MEDIA_PAGE_LIMIT_EXCEEDED" });
          inspected.push({ ...file, page_count: result.page_count });
        } else {
          if (file.buffer.length > limits.maxImageBytes) throw Object.assign(new Error(), { code: "MEDIA_TOO_LARGE" });
          try { await imageInspector(file.buffer); } catch { throw Object.assign(new Error(), { code: "MEDIA_IMAGE_UNREADABLE" }); }
          inspected.push({ ...file, page_count: 1 });
        }
      }
      if (sourceType === "MULTI_IMAGE" && new Set(inspected.map((file) => file.mime_type)).size !== 1) {
        throw Object.assign(new Error(), { code: "MEDIA_MULTI_MIME_MISMATCH" });
      }
      const buffers = inspected.map((file) => file.buffer);
      const combined = Buffer.concat(buffers);
      const byteSizeLimit = sourceType === "PDF" ? limits.maxPdfBytes : limits.maxImageBytes * limits.maxPages;
      if (combined.length > byteSizeLimit) throw Object.assign(new Error(), { code: "MEDIA_TOO_LARGE" });
      const receivedAt = new Date(clock()).toISOString();
      const mediaId = idFactory();
      const checksum = checksumBuffer(combined);
      const contract = {
        media_id: mediaId,
        owner_ref: ownerRef,
        source_type: sourceType,
        mime_type: inspected[0].mime_type,
        byte_size: combined.length,
        checksum,
        page_count: inspected.reduce((sum, file) => sum + file.page_count, 0),
        correlation_id: correlationId,
        storage_reference: `temporary-private://vision/${mediaId}`,
        received_at: receivedAt,
        expires_at: new Date(Date.parse(receivedAt) + limits.retentionMs).toISOString(),
      };
      const checked = validateMediaInput(contract);
      if (!checked.ok) throw Object.assign(new Error(), { code: checked.error });
      const stored = await temporaryMediaStore.storeTemporaryMedia({ contract: checked.value, content: sourceType === "MULTI_IMAGE" ? buffers : buffers[0] });
      if (!stored.ok) throw Object.assign(new Error(), { code: stored.error });
      emit("media_validation_succeeded", { correlation_id: correlationId, checksum, mime_type: contract.mime_type, byte_size: contract.byte_size, page_count: contract.page_count });
      return { ok: true, value: checked.value };
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "MEDIA_VALIDATION_FAILED";
      emit("media_validation_failed", { correlation_id: correlationId, error_code: code });
      return { ok: false, error: code };
    }
  }

  async function expire({ ownerRef, mediaId, correlationId }) {
    const result = await temporaryMediaStore.expireTemporaryMedia({ ownerRef, mediaId });
    if (result.ok) emit("temporary_media_expired", { correlation_id: correlationId });
    return result;
  }

  return Object.freeze({ ingest, expire, purgeTemporaryMedia: temporaryMediaStore.purgeTemporaryMedia });
}

module.exports = { MEDIA_EVENTS, createMediaValidationService, defaultImageInspector, defaultPdfInspector, sniffMime };
