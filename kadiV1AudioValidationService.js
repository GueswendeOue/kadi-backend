"use strict";

const crypto = require("node:crypto");
const { checksumAudio, validateAudioContract } = require("./kadiV1AudioContracts");
const { assertTemporaryAudioStore } = require("./kadiV1TemporaryAudioStore");

const AUDIO_EVENTS = new Set(["audio_received", "audio_validation_succeeded", "audio_validation_failed", "temporary_audio_expired"]);

function sniffAudioMime(buffer) {
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WAVE") return "audio/wav";
  if (buffer.length >= 36 && buffer.subarray(0, 4).toString("ascii") === "OggS" && buffer.includes(Buffer.from("OpusHead"))) return "audio/ogg";
  return null;
}

function inspectWav(buffer) {
  if (buffer.length < 44) throw new Error("AUDIO_UNREADABLE");
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  const dataIndex = buffer.indexOf(Buffer.from("data"));
  if (!channels || !sampleRate || !bitsPerSample || dataIndex < 0 || dataIndex + 8 > buffer.length) throw new Error("AUDIO_UNREADABLE");
  const dataSize = buffer.readUInt32LE(dataIndex + 4);
  const duration = dataSize / (sampleRate * channels * (bitsPerSample / 8));
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("AUDIO_UNREADABLE");
  return { duration_seconds: duration };
}

function inspectOggOpus(buffer) {
  let offset = 0;
  let lastGranule = 0n;
  while (offset + 27 <= buffer.length) {
    if (buffer.subarray(offset, offset + 4).toString("ascii") !== "OggS") throw new Error("AUDIO_UNREADABLE");
    const segmentCount = buffer[offset + 26];
    if (offset + 27 + segmentCount > buffer.length) throw new Error("AUDIO_UNREADABLE");
    let bodyLength = 0;
    for (let index = 0; index < segmentCount; index += 1) bodyLength += buffer[offset + 27 + index];
    const pageLength = 27 + segmentCount + bodyLength;
    if (offset + pageLength > buffer.length) throw new Error("AUDIO_UNREADABLE");
    const granule = buffer.readBigUInt64LE(offset + 6);
    if (granule > lastGranule) lastGranule = granule;
    offset += pageLength;
  }
  const duration = Number(lastGranule) / 48_000;
  if (offset !== buffer.length || !Number.isFinite(duration) || duration <= 0) throw new Error("AUDIO_UNREADABLE");
  return { duration_seconds: duration };
}

function defaultAudioInspector(buffer, mimeType) {
  if (mimeType === "audio/wav") return inspectWav(buffer);
  if (mimeType === "audio/ogg") return inspectOggOpus(buffer);
  throw new Error("AUDIO_MIME_TYPE_INVALID");
}

function safeEmitter(logger) {
  const sink = typeof logger === "function" ? logger : () => {};
  return (event, details = {}) => {
    if (!AUDIO_EVENTS.has(event)) return;
    const safe = Object.freeze({
      correlation_id: typeof details.correlation_id === "string" ? crypto.createHash("sha256").update(details.correlation_id).digest("hex").slice(0, 16) : null,
      checksum_short: typeof details.checksum === "string" ? details.checksum.slice(0, 12) : null,
      mime_type: typeof details.mime_type === "string" ? details.mime_type.slice(0, 40) : null,
      byte_size: Number.isSafeInteger(details.byte_size) ? details.byte_size : null,
      duration_seconds: Number.isFinite(details.duration_seconds) ? Math.round(details.duration_seconds * 10) / 10 : null,
      error_code: typeof details.error_code === "string" ? details.error_code.slice(0, 80) : null,
    });
    try { sink(event, safe); } catch { /* logging is non-authoritative */ }
  };
}

function createAudioValidationService({ temporaryAudioStore, config, clock = () => new Date().toISOString(), idFactory = () => `audio_${crypto.randomUUID().replaceAll("-", "")}`, audioInspector = defaultAudioInspector, logger = null } = {}) {
  assertTemporaryAudioStore(temporaryAudioStore);
  const limits = { maxBytes: config?.maxBytes, maxDurationSeconds: config?.maxDurationSeconds, retentionMs: config?.retentionMs };
  if (Object.values(limits).some((value) => !Number.isFinite(value) || value <= 0)) throw new TypeError("AUDIO_LIMITS_INVALID");
  if (typeof audioInspector !== "function") throw new TypeError("AUDIO_INSPECTOR_REQUIRED");
  const emit = safeEmitter(logger);

  async function ingest({ ownerId, file, locale = null, correlationId }) {
    if (![ownerId, correlationId].every((value) => typeof value === "string" && /^[A-Za-z0-9:_-]{1,200}$/.test(value))) {
      return { ok: false, error: "AUDIO_OWNERSHIP_CONTEXT_INVALID" };
    }
    emit("audio_received", { correlation_id: correlationId });
    try {
      if (!Buffer.isBuffer(file?.buffer) || file.buffer.length === 0) throw Object.assign(new Error(), { code: "AUDIO_EMPTY" });
      if (file.buffer.length > limits.maxBytes) throw Object.assign(new Error(), { code: "AUDIO_TOO_LARGE" });
      const sniffed = sniffAudioMime(file.buffer);
      if (!sniffed || sniffed !== file.mime_type) throw Object.assign(new Error(), { code: "AUDIO_CONTENT_TYPE_MISMATCH" });
      let inspected;
      try { inspected = await audioInspector(file.buffer, sniffed); } catch { throw Object.assign(new Error(), { code: "AUDIO_UNREADABLE" }); }
      if (!Number.isFinite(inspected?.duration_seconds) || inspected.duration_seconds <= 0) throw Object.assign(new Error(), { code: "AUDIO_UNREADABLE" });
      if (inspected.duration_seconds > limits.maxDurationSeconds) throw Object.assign(new Error(), { code: "AUDIO_DURATION_EXCEEDED" });
      const receivedAt = new Date(clock()).toISOString();
      const audioId = idFactory();
      const checksum = checksumAudio(file.buffer);
      const contract = {
        audio_id: audioId,
        owner_id: ownerId,
        source_type: "USER_VOICE",
        mime_type: sniffed,
        byte_size: file.buffer.length,
        checksum,
        duration_seconds: inspected.duration_seconds,
        storage_reference: `temporary-private://audio/input/${audioId}`,
        received_at: receivedAt,
        expires_at: new Date(Date.parse(receivedAt) + limits.retentionMs).toISOString(),
        locale,
        correlation_id: correlationId,
      };
      const checked = validateAudioContract(contract);
      if (!checked.ok) throw Object.assign(new Error(), { code: checked.error });
      const stored = await temporaryAudioStore.storeTemporaryAudio({ contract: checked.value, content: file.buffer });
      if (!stored.ok) throw Object.assign(new Error(), { code: stored.error });
      emit("audio_validation_succeeded", { correlation_id: correlationId, checksum, mime_type: sniffed, byte_size: file.buffer.length, duration_seconds: inspected.duration_seconds });
      return { ok: true, value: checked.value };
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "AUDIO_VALIDATION_FAILED";
      emit("audio_validation_failed", { correlation_id: correlationId, error_code: code });
      return { ok: false, error: code };
    }
  }

  async function expire({ ownerId, audioId, correlationId }) {
    const result = await temporaryAudioStore.expireTemporaryAudio({ ownerId, audioId });
    if (result.ok) emit("temporary_audio_expired", { correlation_id: correlationId });
    return result;
  }

  return Object.freeze({ ingest, expire, purgeTemporaryAudio: temporaryAudioStore.purgeTemporaryAudio });
}

module.exports = { AUDIO_EVENTS, createAudioValidationService, defaultAudioInspector, sniffAudioMime };
