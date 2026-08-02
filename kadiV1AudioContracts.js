"use strict";

const crypto = require("node:crypto");

const AUDIO_MIME_TYPES = Object.freeze(["audio/ogg", "audio/wav"]);
const AUDIO_SOURCE_TYPES = Object.freeze(["USER_VOICE", "GENERATED_VOICE"]);
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const PRIVATE_REFERENCE_PATTERN = /^temporary-private:\/\/audio\/[A-Za-z0-9/_:.-]{1,220}$/;

function checksumAudio(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("AUDIO_BUFFER_REQUIRED");
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function validateAudioContract(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "AUDIO_CONTRACT_INVALID" };
  const allowed = new Set([
    "audio_id", "owner_id", "source_type", "mime_type", "byte_size", "checksum",
    "duration_seconds", "storage_reference", "received_at", "expires_at", "locale",
    "correlation_id", "canonical_text_checksum",
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return { ok: false, error: "AUDIO_CONTRACT_FIELD_FORBIDDEN" };
  if (![raw.audio_id, raw.owner_id, raw.correlation_id].every((value) => typeof value === "string" && ID_PATTERN.test(value))) {
    return { ok: false, error: "AUDIO_ID_INVALID" };
  }
  if (!AUDIO_SOURCE_TYPES.includes(raw.source_type)) return { ok: false, error: "AUDIO_SOURCE_TYPE_INVALID" };
  if (!AUDIO_MIME_TYPES.includes(raw.mime_type)) return { ok: false, error: "AUDIO_MIME_TYPE_INVALID" };
  if (!Number.isSafeInteger(raw.byte_size) || raw.byte_size < 1) return { ok: false, error: "AUDIO_BYTE_SIZE_INVALID" };
  if (!CHECKSUM_PATTERN.test(raw.checksum || "")) return { ok: false, error: "AUDIO_CHECKSUM_INVALID" };
  if (!Number.isFinite(raw.duration_seconds) || raw.duration_seconds <= 0) return { ok: false, error: "AUDIO_DURATION_INVALID" };
  if (!PRIVATE_REFERENCE_PATTERN.test(raw.storage_reference || "")) return { ok: false, error: "AUDIO_STORAGE_REFERENCE_INVALID" };
  if (!Number.isFinite(Date.parse(raw.received_at)) || !Number.isFinite(Date.parse(raw.expires_at)) || Date.parse(raw.expires_at) <= Date.parse(raw.received_at)) {
    return { ok: false, error: "AUDIO_RETENTION_INVALID" };
  }
  if (raw.locale != null && (typeof raw.locale !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z]{2})?$/.test(raw.locale))) {
    return { ok: false, error: "AUDIO_LOCALE_INVALID" };
  }
  if (raw.canonical_text_checksum != null && !CHECKSUM_PATTERN.test(raw.canonical_text_checksum)) {
    return { ok: false, error: "AUDIO_TEXT_CHECKSUM_INVALID" };
  }
  return { ok: true, value: Object.freeze(structuredClone(raw)) };
}

module.exports = { AUDIO_MIME_TYPES, AUDIO_SOURCE_TYPES, checksumAudio, validateAudioContract };
