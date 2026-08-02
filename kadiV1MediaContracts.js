"use strict";

const crypto = require("node:crypto");

const MEDIA_SOURCE_TYPES = Object.freeze(["IMAGE", "PDF", "DOCUMENT_IMAGE", "MULTI_IMAGE"]);
const ALLOWED_MEDIA_MIME_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const PRIVATE_REFERENCE_PATTERN = /^temporary-private:\/\/[A-Za-z0-9/_:.-]{1,240}$/;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

function ok(value) { return { ok: true, value }; }
function fail(error) { return { ok: false, error }; }
function validDate(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function validId(value) { return typeof value === "string" && ID_PATTERN.test(value); }

function checksumBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("MEDIA_BUFFER_REQUIRED");
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function validateMediaInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("MEDIA_INPUT_INVALID");
  const allowed = new Set([
    "media_id", "owner_ref", "source_type", "mime_type", "byte_size", "checksum",
    "page_count", "correlation_id", "storage_reference", "received_at", "expires_at",
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return fail("MEDIA_INPUT_FIELD_FORBIDDEN");
  if (!validId(raw.media_id) || !validId(raw.owner_ref) || !validId(raw.correlation_id)) return fail("MEDIA_INPUT_ID_INVALID");
  if (!MEDIA_SOURCE_TYPES.includes(raw.source_type)) return fail("MEDIA_SOURCE_TYPE_INVALID");
  if (!ALLOWED_MEDIA_MIME_TYPES.includes(raw.mime_type)) return fail("MEDIA_MIME_TYPE_INVALID");
  if (!Number.isSafeInteger(raw.byte_size) || raw.byte_size < 1) return fail("MEDIA_BYTE_SIZE_INVALID");
  if (!CHECKSUM_PATTERN.test(raw.checksum || "")) return fail("MEDIA_CHECKSUM_INVALID");
  if (!Number.isSafeInteger(raw.page_count) || raw.page_count < 1) return fail("MEDIA_PAGE_COUNT_INVALID");
  if (!PRIVATE_REFERENCE_PATTERN.test(raw.storage_reference || "")) return fail("MEDIA_STORAGE_REFERENCE_INVALID");
  if (!validDate(raw.received_at) || !validDate(raw.expires_at) || Date.parse(raw.expires_at) <= Date.parse(raw.received_at)) {
    return fail("MEDIA_RETENTION_INVALID");
  }
  if (raw.source_type === "PDF" && raw.mime_type !== "application/pdf") return fail("MEDIA_SOURCE_MIME_MISMATCH");
  if (raw.source_type !== "PDF" && raw.mime_type === "application/pdf") return fail("MEDIA_SOURCE_MIME_MISMATCH");
  return ok(Object.freeze(structuredClone(raw)));
}

module.exports = {
  ALLOWED_MEDIA_MIME_TYPES,
  MEDIA_SOURCE_TYPES,
  checksumBuffer,
  validateMediaInput,
};
