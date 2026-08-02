"use strict";

const crypto = require("node:crypto");
const { assertTemporaryAudioStore } = require("./kadiV1TemporaryAudioStore");

const STT_POLICIES = Object.freeze(["PRIMARY_ONLY", "CONTROLLED_FALLBACK", "SHADOW_COMPARE"]);
const STT_EVENTS = new Set(["transcription_started", "transcription_succeeded", "transcription_failed"]);
const PROVIDER_METHODS = Object.freeze(["transcribeAudio", "getProviderHealth"]);
const RESULT_KEYS = new Set(["transcript", "detected_locale", "confidence", "uncertain_segments", "duration_seconds", "provider_metadata"]);
const SEGMENT_KEYS = new Set(["start_seconds", "end_seconds", "candidate_text", "reason", "confidence"]);
const METADATA_KEYS = new Set(["provider", "model", "request_ref", "latency_ms"]);

class SpeechToTextError extends Error {
  constructor(code, userMessage = "Je n’ai pas bien compris ce vocal. Renvoyez-le ou écrivez votre demande.") {
    super(code);
    this.name = "SpeechToTextError";
    this.code = code;
    this.recoverable = true;
    this.user_message = userMessage;
  }
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function onlyKeys(value, keys) {
  try { return Object.keys(value).every((key) => keys.has(key)); } catch { return false; }
}

function createSpeechToTextProvider({ name, transcribeAudio, getProviderHealth = async () => ({ available: true }) } = {}) {
  if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]{1,39}$/.test(name)) throw new TypeError("STT_PROVIDER_NAME_INVALID");
  if (typeof transcribeAudio !== "function" || typeof getProviderHealth !== "function") throw new TypeError("STT_PROVIDER_METHOD_REQUIRED");
  return Object.freeze({ name, transcribeAudio, getProviderHealth });
}

function assertSpeechToTextProvider(provider) {
  if (!provider || typeof provider !== "object" || typeof provider.name !== "string") throw new TypeError("STT_PROVIDER_REQUIRED");
  for (const method of PROVIDER_METHODS) if (typeof provider[method] !== "function") throw new TypeError(`STT_PROVIDER_METHOD_REQUIRED:${method}`);
  return provider;
}

function createOpenAISpeechToTextProvider({ transcribe, model } = {}) {
  if (typeof transcribe !== "function") throw new TypeError("OPENAI_TRANSCRIBE_ADAPTER_REQUIRED");
  if (typeof model !== "string" || !model.trim()) throw new TypeError("OPENAI_TRANSCRIPTION_MODEL_REQUIRED");
  return createSpeechToTextProvider({
    name: "OPENAI_STT",
    transcribeAudio: async ({ buffer, mime_type, locale }) => {
      const raw = await transcribe(buffer, { mimeType: mime_type, localeHint: locale, model });
      return {
        transcript: raw?.text,
        detected_locale: raw?.localeHint || locale || null,
        confidence: raw?.confidence ?? null,
        uncertain_segments: raw?.uncertainSegments || [],
        provider_metadata: { provider: "OPENAI_STT", model },
      };
    },
  });
}

function createGeminiSpeechToTextProvider({ transcribe, model } = {}) {
  if (typeof transcribe !== "function") throw new TypeError("GEMINI_TRANSCRIBE_ADAPTER_REQUIRED");
  if (typeof model !== "string" || !model.trim()) throw new TypeError("GEMINI_TRANSCRIPTION_MODEL_REQUIRED");
  return createSpeechToTextProvider({
    name: "GEMINI_STT",
    transcribeAudio: async (input) => ({ ...(await transcribe(input)), provider_metadata: { provider: "GEMINI_STT", model } }),
  });
}

function normalizeTranscriptionResult(raw, { provider, durationSeconds, minimumConfidence = 0.7 }) {
  if (!isRecord(raw) || !onlyKeys(raw, RESULT_KEYS)) throw new SpeechToTextError("TRANSCRIPTION_RESULT_INVALID");
  const transcript = typeof raw.transcript === "string" ? raw.transcript.replace(/\s+/g, " ").trim() : "";
  if (!transcript || transcript.length > 20_000) throw new SpeechToTextError("TRANSCRIPTION_TEXT_INVALID");
  if (raw.detected_locale != null && (typeof raw.detected_locale !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z]{2})?$/.test(raw.detected_locale))) {
    throw new SpeechToTextError("TRANSCRIPTION_LOCALE_INVALID");
  }
  if (raw.confidence != null && (!Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1)) {
    throw new SpeechToTextError("TRANSCRIPTION_CONFIDENCE_INVALID");
  }
  if (!Array.isArray(raw.uncertain_segments) || raw.uncertain_segments.length > 50) throw new SpeechToTextError("TRANSCRIPTION_SEGMENTS_INVALID");
  const uncertainSegments = raw.uncertain_segments.map((segment) => {
    if (!isRecord(segment) || !onlyKeys(segment, SEGMENT_KEYS) || !Number.isFinite(segment.start_seconds) || !Number.isFinite(segment.end_seconds) || segment.start_seconds < 0 || segment.end_seconds <= segment.start_seconds || segment.end_seconds > durationSeconds || typeof segment.reason !== "string" || !segment.reason.trim() || segment.reason.length > 200 || (segment.confidence != null && (!Number.isFinite(segment.confidence) || segment.confidence < 0 || segment.confidence > 1))) {
      throw new SpeechToTextError("TRANSCRIPTION_SEGMENTS_INVALID");
    }
    return {
      start_seconds: segment.start_seconds,
      end_seconds: segment.end_seconds,
      candidate_text: typeof segment.candidate_text === "string" ? segment.candidate_text.slice(0, 300) : null,
      reason: segment.reason.slice(0, 200),
      confidence: segment.confidence ?? null,
    };
  });
  if (raw.confidence != null && raw.confidence < minimumConfidence && uncertainSegments.length === 0) {
    uncertainSegments.push({ start_seconds: 0, end_seconds: durationSeconds, candidate_text: null, reason: "LOW_TRANSCRIPTION_CONFIDENCE", confidence: raw.confidence });
  }
  if (!isRecord(raw.provider_metadata) || !onlyKeys(raw.provider_metadata, METADATA_KEYS) || raw.provider_metadata.provider !== provider || (raw.provider_metadata.model != null && (typeof raw.provider_metadata.model !== "string" || raw.provider_metadata.model.length > 120 || /secret|token|api[_-]?key|bearer/i.test(raw.provider_metadata.model)))) {
    throw new SpeechToTextError("TRANSCRIPTION_PROVENANCE_INVALID");
  }
  return Object.freeze({
    transcript,
    detected_locale: raw.detected_locale || null,
    confidence: raw.confidence ?? null,
    uncertain_segments: Object.freeze(uncertainSegments.map(Object.freeze)),
    duration_seconds: durationSeconds,
    provider_metadata: Object.freeze(structuredClone(raw.provider_metadata)),
  });
}

function safeEmitter(logger) {
  const sink = typeof logger === "function" ? logger : () => {};
  return (event, details = {}) => {
    if (!STT_EVENTS.has(event)) return;
    const safe = Object.freeze({
      correlation_id: typeof details.correlation_id === "string" ? crypto.createHash("sha256").update(details.correlation_id).digest("hex").slice(0, 16) : null,
      provider: typeof details.provider === "string" ? details.provider.slice(0, 40) : null,
      policy: STT_POLICIES.includes(details.policy) ? details.policy : null,
      uncertainty_count: Number.isSafeInteger(details.uncertainty_count) ? details.uncertainty_count : null,
      error_code: typeof details.error_code === "string" ? details.error_code.slice(0, 80) : null,
    });
    try { sink(event, safe); } catch { /* logging cannot alter transcription */ }
  };
}

function createSpeechToTextService({ temporaryAudioStore, primaryProvider, fallbackProvider = null, shadowProvider = null, policy = "PRIMARY_ONLY", minimumConfidence = 0.7, logger = null } = {}) {
  assertTemporaryAudioStore(temporaryAudioStore);
  const primary = assertSpeechToTextProvider(primaryProvider);
  const fallback = fallbackProvider == null ? null : assertSpeechToTextProvider(fallbackProvider);
  const shadow = shadowProvider == null ? null : assertSpeechToTextProvider(shadowProvider);
  if (!STT_POLICIES.includes(policy)) throw new TypeError("STT_POLICY_INVALID");
  if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) throw new TypeError("STT_CONFIDENCE_THRESHOLD_INVALID");
  const emit = safeEmitter(logger);

  async function invoke(provider, stored) {
    const contract = stored.contract;
    emit("transcription_started", { correlation_id: contract.correlation_id, provider: provider.name, policy });
    try {
      const raw = await provider.transcribeAudio({ buffer: Buffer.from(stored.content), mime_type: contract.mime_type, locale: contract.locale, duration_seconds: contract.duration_seconds, correlation_id: contract.correlation_id });
      const normalized = normalizeTranscriptionResult(raw, { provider: provider.name, durationSeconds: contract.duration_seconds, minimumConfidence });
      emit("transcription_succeeded", { correlation_id: contract.correlation_id, provider: provider.name, policy, uncertainty_count: normalized.uncertain_segments.length });
      return normalized;
    } catch (error) {
      const controlled = error instanceof SpeechToTextError ? error : new SpeechToTextError("TRANSCRIPTION_PROVIDER_FAILED");
      emit("transcription_failed", { correlation_id: contract.correlation_id, provider: provider.name, policy, error_code: controlled.code });
      throw controlled;
    }
  }

  async function transcribe({ audioId, ownerId }) {
    const stored = await temporaryAudioStore.getTemporaryAudio({ audioId, ownerId });
    if (!stored.ok) throw new SpeechToTextError(stored.error);
    let result;
    try {
      result = await invoke(primary, stored.value);
    } catch (error) {
      if (policy !== "CONTROLLED_FALLBACK" || !fallback || fallback.name === primary.name) throw error;
      result = await invoke(fallback, stored.value);
    }
    if (policy === "SHADOW_COMPARE" && shadow && shadow.name !== primary.name) {
      try { await invoke(shadow, stored.value); } catch { /* shadow is non-blocking */ }
    }
    return result;
  }

  return Object.freeze({ transcribe, getProviderHealth: () => primary.getProviderHealth(), policy });
}

function createVoiceInputPipeline({ speechToTextService, brain } = {}) {
  if (!speechToTextService || typeof speechToTextService.transcribe !== "function") throw new TypeError("STT_SERVICE_REQUIRED");
  if (!brain || typeof brain.understand !== "function") throw new TypeError("KADI_BRAIN_REQUIRED");
  return Object.freeze({
    async process({ audioId, ownerId, requestId, conversationContext = {}, documentTypeHint = null, collectedData = {} }) {
      const transcription = await speechToTextService.transcribe({ audioId, ownerId });
      const brainResult = await brain.understand({
        request_id: requestId,
        modality: "TRANSCRIPTION",
        transcription: transcription.transcript,
        conversation_context: { ...conversationContext, transcription_uncertain: transcription.uncertain_segments.length > 0 },
        document_type_hint: documentTypeHint,
        collected_data: collectedData,
      });
      return Object.freeze({
        transcription,
        brain_result: brainResult,
        requires_confirmation: transcription.uncertain_segments.length > 0,
        targeted_question: transcription.uncertain_segments.length > 0 ? "Je n’ai pas bien entendu une partie du vocal. Pouvez-vous la préciser ?" : null,
      });
    },
  });
}

module.exports = {
  STT_POLICIES,
  SpeechToTextError,
  assertSpeechToTextProvider,
  createGeminiSpeechToTextProvider,
  createOpenAISpeechToTextProvider,
  createSpeechToTextProvider,
  createSpeechToTextService,
  createVoiceInputPipeline,
  normalizeTranscriptionResult,
};
