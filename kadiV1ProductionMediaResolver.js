"use strict";

const OWNER_PATTERN = /^\d{8,20}$/;
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const AUDIO_MIME_TYPES = new Set(["audio/ogg", "audio/wav"]);
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function ok(value) {
  return { ok: true, value };
}

function failResult(error) {
  return { ok: false, error };
}

function assertMethods(target, methods, name) {
  if (!target || typeof target !== "object") {
    throw new TypeError(`${name}_REQUIRED`);
  }
  for (const method of methods) {
    if (typeof target[method] !== "function") {
      throw new TypeError(`${name}_METHOD_REQUIRED:${method}`);
    }
  }
  return target;
}

function mediaIdFor(message, key) {
  const value = message?.[key]?.id;
  return typeof value === "string" && ID_PATTERN.test(value)
    ? value
    : null;
}

function safeMime(value) {
  return typeof value === "string"
    ? value.trim().toLowerCase().split(";")[0]
    : "";
}

function extensionFor(mimeType) {
  return ({
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "application/pdf": "pdf",
  })[mimeType] || "bin";
}

function safeFilename(value, mimeType, fallback) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (
    raw &&
    raw.length <= 255 &&
    !/[\\/\x00-\x1f]/.test(raw)
  ) {
    return raw;
  }
  return `${fallback}.${extensionFor(mimeType)}`;
}

function normalizeMetaInfo(info, mediaId) {
  if (!info || typeof info !== "object") {
    return failResult("KADI_V1_META_MEDIA_INFO_INVALID");
  }
  if (info.id != null && String(info.id) !== mediaId) {
    return failResult("KADI_V1_META_MEDIA_ID_MISMATCH");
  }
  if (typeof info.url !== "string" || !/^https:\/\//i.test(info.url)) {
    return failResult("KADI_V1_META_MEDIA_URL_INVALID");
  }
  const mimeType = safeMime(info.mime_type);
  if (!mimeType) {
    return failResult("KADI_V1_META_MEDIA_MIME_MISSING");
  }
  return ok({
    url: info.url,
    mime_type: mimeType,
    file_size: Number.isSafeInteger(info.file_size)
      ? info.file_size
      : null,
  });
}

function normalizeServiceResult(result, fallbackError) {
  if (!result || typeof result !== "object") {
    return failResult(fallbackError);
  }
  if (typeof result.ok === "boolean") return result;
  return ok(result);
}

function createKadiV1ProductionMediaResolver({
  whatsappApi,
  audioValidationService,
  speechToTextService,
  mediaValidationService,
} = {}) {
  const meta = assertMethods(
    whatsappApi,
    ["getMediaInfo", "downloadMediaToBuffer"],
    "KADI_V1_WHATSAPP_MEDIA_API"
  );
  const audioValidation = assertMethods(
    audioValidationService,
    ["ingest", "expire"],
    "KADI_V1_AUDIO_VALIDATION_SERVICE"
  );
  const speech = assertMethods(
    speechToTextService,
    ["transcribe"],
    "KADI_V1_SPEECH_TO_TEXT_SERVICE"
  );
  const mediaValidation = assertMethods(
    mediaValidationService,
    ["ingest"],
    "KADI_V1_MEDIA_VALIDATION_SERVICE"
  );

  async function loadMetaMedia({ mediaId, messageMime }) {
    let info;
    let buffer;
    try {
      info = await meta.getMediaInfo(mediaId);
      const normalized = normalizeMetaInfo(info, mediaId);
      if (!normalized.ok) return normalized;
      const declaredMime = safeMime(messageMime);
      if (
        declaredMime &&
        declaredMime !== normalized.value.mime_type
      ) {
        return failResult("KADI_V1_META_MEDIA_MIME_MISMATCH");
      }
      buffer = await meta.downloadMediaToBuffer(normalized.value.url);
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return failResult("KADI_V1_META_MEDIA_DOWNLOAD_INVALID");
      }
      if (
        normalized.value.file_size != null &&
        normalized.value.file_size !== buffer.length
      ) {
        return failResult("KADI_V1_META_MEDIA_SIZE_MISMATCH");
      }
      return ok({
        buffer,
        mime_type: normalized.value.mime_type,
      });
    } catch {
      return failResult("KADI_V1_META_MEDIA_DOWNLOAD_FAILED");
    }
  }

  async function resolveAudio({
    ownerWaId,
    message,
    correlationId,
  } = {}) {
    if (
      !OWNER_PATTERN.test(ownerWaId || "") ||
      !ID_PATTERN.test(correlationId || "")
    ) {
      return failResult("KADI_V1_AUDIO_CONTEXT_INVALID");
    }
    const mediaId = mediaIdFor(message, "audio");
    if (!mediaId) return failResult("KADI_V1_AUDIO_MEDIA_ID_INVALID");

    const loaded = await loadMetaMedia({
      mediaId,
      messageMime: message?.audio?.mime_type,
    });
    if (!loaded.ok) return loaded;
    if (!AUDIO_MIME_TYPES.has(loaded.value.mime_type)) {
      return failResult("KADI_V1_AUDIO_MIME_UNSUPPORTED");
    }

    const ingested = normalizeServiceResult(
      await audioValidation.ingest({
        ownerId: ownerWaId,
        file: {
          buffer: loaded.value.buffer,
          mime_type: loaded.value.mime_type,
          filename: safeFilename(
            message?.audio?.filename,
            loaded.value.mime_type,
            "voice"
          ),
        },
        locale: null,
        correlationId,
      }),
      "KADI_V1_AUDIO_VALIDATION_FAILED"
    );
    if (!ingested.ok) return failResult(ingested.error);

    const audioId = ingested.value?.audio_id;
    if (!ID_PATTERN.test(audioId || "")) {
      return failResult("KADI_V1_AUDIO_CONTRACT_INVALID");
    }

    try {
      const transcription = normalizeServiceResult(
        await speech.transcribe({
          audioId,
          ownerId: ownerWaId,
        }),
        "KADI_V1_AUDIO_TRANSCRIPTION_FAILED"
      );
      if (!transcription.ok) {
        return failResult(transcription.error);
      }
      const value = transcription.value;
      const text = String(value?.transcript || "").trim();
      if (!text || text.length > 4000) {
        return failResult("KADI_V1_AUDIO_TRANSCRIPTION_INVALID");
      }
      return ok(Object.freeze({
        text,
        confidence:
          Number.isFinite(value?.confidence)
            ? value.confidence
            : null,
        requires_confirmation:
          Array.isArray(value?.uncertain_segments) &&
          value.uncertain_segments.length > 0,
      }));
    } catch (error) {
      return failResult(
        typeof error?.code === "string"
          ? error.code
          : "KADI_V1_AUDIO_TRANSCRIPTION_FAILED"
      );
    } finally {
      try {
        await audioValidation.expire({
          ownerId: ownerWaId,
          audioId,
          correlationId,
        });
      } catch {
        // Expiration is best effort and cannot alter the user result.
      }
    }
  }

  async function resolveVisual({
    ownerWaId,
    message,
    correlationId,
    kind,
  }) {
    if (
      !OWNER_PATTERN.test(ownerWaId || "") ||
      !ID_PATTERN.test(correlationId || "")
    ) {
      return failResult("KADI_V1_MEDIA_CONTEXT_INVALID");
    }

    const mediaId = mediaIdFor(message, kind);
    if (!mediaId) return failResult("KADI_V1_MEDIA_ID_INVALID");

    const declaredMime = message?.[kind]?.mime_type;
    const loaded = await loadMetaMedia({
      mediaId,
      messageMime: declaredMime,
    });
    if (!loaded.ok) return loaded;

    const sourceType = kind === "document" ? "PDF" : "IMAGE";
    if (
      sourceType === "PDF" &&
      loaded.value.mime_type !== "application/pdf"
    ) {
      return failResult("KADI_V1_PDF_MIME_UNSUPPORTED");
    }
    if (
      sourceType === "IMAGE" &&
      !IMAGE_MIME_TYPES.has(loaded.value.mime_type)
    ) {
      return failResult("KADI_V1_IMAGE_MIME_UNSUPPORTED");
    }

    const ingested = normalizeServiceResult(
      await mediaValidation.ingest({
        ownerRef: ownerWaId,
        sourceType,
        files: [{
          buffer: loaded.value.buffer,
          mime_type: loaded.value.mime_type,
          filename: safeFilename(
            message?.[kind]?.filename,
            loaded.value.mime_type,
            sourceType === "PDF" ? "document" : "image"
          ),
        }],
        correlationId,
      }),
      "KADI_V1_MEDIA_VALIDATION_FAILED"
    );
    if (!ingested.ok) return failResult(ingested.error);
    if (
      !ingested.value ||
      typeof ingested.value !== "object" ||
      !ID_PATTERN.test(ingested.value.media_id || "")
    ) {
      return failResult("KADI_V1_MEDIA_CONTRACT_INVALID");
    }
    return ok(Object.freeze({
      media: Object.freeze(structuredClone(ingested.value)),
    }));
  }

  const resolveImage = (input) =>
    resolveVisual({ ...input, kind: "image" });

  const resolvePdf = (input) =>
    resolveVisual({ ...input, kind: "document" });

  return Object.freeze({
    resolveAudio,
    resolveImage,
    resolvePdf,
  });
}

module.exports = {
  createKadiV1ProductionMediaResolver,
  normalizeMetaInfo,
};
