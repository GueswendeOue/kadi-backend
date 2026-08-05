"use strict";

// Experimental Gemini direct-audio-understanding adapter for
// KADI_GEMINI_AUDIO_V1_ENABLED (disabled by default). This skips the
// transcribe-then-extract two-step (kadiV1SpeechToText.js +
// kadiV1Brain.js/OPENAI) and asks Gemini to go straight from audio to
// structured extraction, the same way kadiV1GeminiVisionProvider.js already
// does for images/PDFs. It reuses that module's validated normalization
// (normalizeStructuredExtraction) instead of re-implementing field/item
// validation a third time.
//
// Not wired into kadiV1ProductionBootstrap.js or the live speech pipeline in
// this mission: the existing OPENAI_STT route stays exactly as-is.

const crypto = require("node:crypto");
const { GeminiVisionError, normalizeStructuredExtraction } = require("./kadiV1GeminiVisionProvider");
const { assertTemporaryAudioStore } = require("./kadiV1TemporaryAudioStore");

// Not wrapped via kadiV1BrainProviders.createBrainProvider: kadiV1Brain's
// BRAIN_MODALITIES is TEXT/TRANSCRIPTION/IMAGE/DOCUMENT only (deliberately
// left untouched by this branch — see architecture doc). AUDIO direct
// understanding is exposed as its own method instead of pretending to be
// pluggable into a modality that does not exist yet.

// Matches kadiV1AudioContracts.js AUDIO_MIME_TYPES exactly — the temporary
// audio store never contains anything outside that set, so this list is
// kept identical rather than inventing a broader one that could never be hit.
const ALLOWED_AUDIO_MIME_TYPES = Object.freeze(["audio/ogg", "audio/wav"]);
const AUDIO_EVENTS = new Set(["audio_analysis_started", "audio_analysis_succeeded", "audio_analysis_failed"]);

function safeEmitter(logger) {
  const sink = typeof logger === "function" ? logger : () => {};
  return (event, details = {}) => {
    if (!AUDIO_EVENTS.has(event)) return;
    const safe = Object.freeze({
      correlation_id: typeof details.correlation_id === "string" ? crypto.createHash("sha256").update(details.correlation_id).digest("hex").slice(0, 16) : null,
      mime_type: typeof details.mime_type === "string" ? details.mime_type.slice(0, 100) : null,
      duration_seconds: Number.isFinite(details.duration_seconds) ? details.duration_seconds : null,
      error_code: typeof details.error_code === "string" ? details.error_code.slice(0, 80) : null,
    });
    try { sink(event, safe); } catch { /* observability is non-authoritative */ }
  };
}

function createGeminiAudioProvider({ client, temporaryAudioStore, config, logger = null } = {}) {
  if (!client || typeof client.generateStructured !== "function") throw new TypeError("GEMINI_AUDIO_CLIENT_REQUIRED");
  assertTemporaryAudioStore(temporaryAudioStore);
  const settings = {
    enabled: config?.enabled === true,
    model: config?.model,
    timeoutMs: config?.timeoutMs,
    maxRetries: config?.maxRetries,
    temperature: config?.temperature,
    minimumConfidence: config?.minimumConfidence ?? 0.7,
    maxAudioBytes: config?.maxAudioBytes,
  };
  if (typeof settings.model !== "string" || !settings.model.trim() || settings.model.length > 120 || /token|secret|api[_-]?key|bearer/i.test(settings.model) ||
      !Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs < 1 ||
      !Number.isSafeInteger(settings.maxRetries) || settings.maxRetries < 0 || settings.maxRetries > 3 ||
      !Number.isFinite(settings.temperature) || settings.temperature < 0 || settings.temperature > 1 ||
      !Number.isFinite(settings.minimumConfidence) || settings.minimumConfidence < 0 || settings.minimumConfidence > 1 ||
      !Number.isSafeInteger(settings.maxAudioBytes) || settings.maxAudioBytes < 1) {
    throw new TypeError("GEMINI_AUDIO_CONFIG_INVALID");
  }
  const emit = safeEmitter(logger);
  const prompt = [
    "Écoute ce message vocal administratif et retourne uniquement un objet JSON.",
    "Schéma: {document_type, fields, missing_fields, uncertainties, confidence, multiple_documents}.",
    "Chaque champ de fields contient {value,status,confidence,source_reference}; source_reference suit page:1 pour l'audio.",
    "N'invente jamais une valeur non entendue clairement; marque-la incertaine ou absente.",
  ].join(" ");

  async function callClient(mimeType, buffer) {
    let lastError;
    for (let attempt = 0; attempt <= settings.maxRetries; attempt += 1) {
      let timeout;
      try {
        return await Promise.race([
          client.generateStructured({ model: settings.model, prompt, media: [{ mime_type: mimeType, buffer }], temperature: settings.temperature }),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new GeminiVisionError("AUDIO_PROVIDER_TIMEOUT")), settings.timeoutMs); }),
        ]);
      } catch (error) {
        lastError = error;
        if (error instanceof GeminiVisionError && error.code === "AUDIO_PROVIDER_TIMEOUT") break;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof GeminiVisionError ? lastError : new GeminiVisionError("AUDIO_PROVIDER_FAILED");
  }

  async function extractStructuredAudioData({ audioId, ownerId }) {
    if (!settings.enabled) throw new GeminiVisionError("AUDIO_FEATURE_DISABLED");
    const stored = await temporaryAudioStore.getTemporaryAudio({ audioId, ownerId });
    if (!stored.ok) throw new GeminiVisionError(stored.error);
    const contract = stored.value.contract;
    if (!ALLOWED_AUDIO_MIME_TYPES.includes(contract.mime_type)) throw new GeminiVisionError("MEDIA_MIME_TYPE_INVALID");
    const buffer = Buffer.isBuffer(stored.value.content) ? stored.value.content : Buffer.from(stored.value.content);
    if (buffer.length > settings.maxAudioBytes) throw new GeminiVisionError("MEDIA_TOO_LARGE");
    emit("audio_analysis_started", { correlation_id: contract.correlation_id, mime_type: contract.mime_type, duration_seconds: contract.duration_seconds });
    try {
      const raw = await callClient(contract.mime_type, buffer);
      const normalized = normalizeStructuredExtraction(raw, { model: settings.model, minimumConfidence: settings.minimumConfidence });
      emit("audio_analysis_succeeded", { correlation_id: contract.correlation_id, mime_type: contract.mime_type, duration_seconds: contract.duration_seconds });
      return normalized;
    } catch (error) {
      const controlled = error instanceof GeminiVisionError ? error : new GeminiVisionError("AUDIO_RESULT_INVALID");
      emit("audio_analysis_failed", { correlation_id: contract.correlation_id, mime_type: contract.mime_type, error_code: controlled.code });
      throw controlled;
    }
  }

  return Object.freeze({ name: "GEMINI_AUDIO", extractStructuredAudioData, enabled: settings.enabled });
}

module.exports = {
  ALLOWED_AUDIO_MIME_TYPES,
  createGeminiAudioProvider,
};
