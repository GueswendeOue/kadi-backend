"use strict";

const crypto = require("node:crypto");
const { checksumAudio, validateAudioContract } = require("./kadiV1AudioContracts");
const { defaultAudioInspector } = require("./kadiV1AudioValidationService");
const { assertTemporaryAudioStore } = require("./kadiV1TemporaryAudioStore");
const { KADI_VOICE_STYLE, prepareTextForSpeech } = require("./kadiV1VoicePolicyEngine");

const VOICE_EXECUTION_POLICIES = Object.freeze(["PRIMARY_ONLY", "CONTROLLED_FALLBACK", "SHADOW_COMPARE"]);
const VOICE_PROVIDER_METHODS = Object.freeze(["synthesize", "getProviderHealth"]);
const TTS_EVENTS = new Set(["tts_started", "tts_succeeded", "tts_failed", "welcome_voice_sent"]);

class VoiceProviderError extends Error {
  constructor(code) {
    super(code);
    this.name = "VoiceProviderError";
    this.code = code;
    this.recoverable = true;
    this.user_message = "Le vocal n’est pas disponible pour le moment. Le message écrit reste accessible.";
  }
}

function createVoiceProvider({ name, synthesize, getProviderHealth = async () => ({ available: true }) } = {}) {
  if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]{1,39}$/.test(name)) throw new TypeError("VOICE_PROVIDER_NAME_INVALID");
  if (typeof synthesize !== "function" || typeof getProviderHealth !== "function") throw new TypeError("VOICE_PROVIDER_METHOD_REQUIRED");
  return Object.freeze({ name, synthesize, getProviderHealth });
}

function assertVoiceProvider(provider) {
  if (!provider || typeof provider !== "object" || typeof provider.name !== "string") throw new TypeError("VOICE_PROVIDER_REQUIRED");
  for (const method of VOICE_PROVIDER_METHODS) if (typeof provider[method] !== "function") throw new TypeError(`VOICE_PROVIDER_METHOD_REQUIRED:${method}`);
  return provider;
}

function safeEmitter(logger) {
  const sink = typeof logger === "function" ? logger : () => {};
  return (event, details = {}) => {
    if (!TTS_EVENTS.has(event)) return;
    const safe = Object.freeze({
      correlation_id: typeof details.correlation_id === "string" ? crypto.createHash("sha256").update(details.correlation_id).digest("hex").slice(0, 16) : null,
      provider: typeof details.provider === "string" ? details.provider.slice(0, 40) : null,
      policy: VOICE_EXECUTION_POLICIES.includes(details.policy) ? details.policy : null,
      mime_type: typeof details.mime_type === "string" ? details.mime_type.slice(0, 40) : null,
      duration_seconds: Number.isFinite(details.duration_seconds) ? Math.round(details.duration_seconds * 10) / 10 : null,
      error_code: typeof details.error_code === "string" ? details.error_code.slice(0, 80) : null,
    });
    try { sink(event, safe); } catch { /* observability is non-authoritative */ }
  };
}

function createConfiguredVoiceProvider({ name, synthesizeAudio, temporaryAudioStore, config, clock = () => new Date().toISOString(), idFactory = () => `audio_${crypto.randomUUID().replaceAll("-", "")}`, audioInspector = defaultAudioInspector } = {}) {
  if (typeof synthesizeAudio !== "function") throw new TypeError("VOICE_SYNTHESIS_ADAPTER_REQUIRED");
  if (typeof audioInspector !== "function") throw new TypeError("VOICE_AUDIO_INSPECTOR_REQUIRED");
  assertTemporaryAudioStore(temporaryAudioStore);
  const settings = {
    enabled: config?.enabled === true,
    model: config?.model,
    voice: config?.voice,
    outputFormat: config?.outputFormat,
    retentionMs: config?.retentionMs,
    maxBytes: config?.maxBytes,
    maxDurationSeconds: config?.maxDurationSeconds,
  };
  if (typeof settings.model !== "string" || !settings.model.trim() || settings.model.length > 120 || /secret|token|api[_-]?key|bearer/i.test(settings.model) || typeof settings.voice !== "string" || !settings.voice.trim() || settings.voice.length > 120 || /secret|token|api[_-]?key|bearer/i.test(settings.voice) || !["audio/ogg", "audio/wav"].includes(settings.outputFormat) || !Number.isSafeInteger(settings.retentionMs) || settings.retentionMs < 1 || !Number.isSafeInteger(settings.maxBytes) || settings.maxBytes < 1 || !Number.isFinite(settings.maxDurationSeconds) || settings.maxDurationSeconds <= 0) {
    throw new TypeError("VOICE_PROVIDER_CONFIG_INVALID");
  }

  return createVoiceProvider({
    name,
    getProviderHealth: async () => ({ available: settings.enabled }),
    async synthesize({ validated_text, speech_text, canonical_text_checksum, owner_id, locale, voice_style, output_format, correlation_id }) {
      if (!settings.enabled) throw new VoiceProviderError("VOICE_PROVIDER_DISABLED");
      if (typeof validated_text !== "string" || !validated_text.trim() || typeof speech_text !== "string" || !speech_text.trim() || crypto.createHash("sha256").update(validated_text).digest("hex") !== canonical_text_checksum) {
        throw new VoiceProviderError("VOICE_CANONICAL_TEXT_MISMATCH");
      }
      if (output_format !== settings.outputFormat || voice_style?.id !== KADI_VOICE_STYLE.id) throw new VoiceProviderError("VOICE_REQUEST_INVALID");
      const raw = await synthesizeAudio({ text: speech_text, locale, voiceStyle: voice_style, outputFormat: output_format, model: settings.model, voice: settings.voice });
      if (!Buffer.isBuffer(raw?.buffer) || raw.buffer.length === 0 || raw.buffer.length > settings.maxBytes || raw.mime_type !== output_format || !Number.isFinite(raw.duration_seconds) || raw.duration_seconds <= 0 || raw.duration_seconds > settings.maxDurationSeconds) {
        throw new VoiceProviderError("VOICE_OUTPUT_INVALID");
      }
      let inspected;
      try { inspected = await audioInspector(raw.buffer, raw.mime_type); } catch { throw new VoiceProviderError("VOICE_OUTPUT_UNREADABLE"); }
      if (!Number.isFinite(inspected?.duration_seconds) || Math.abs(inspected.duration_seconds - raw.duration_seconds) > 0.25) {
        throw new VoiceProviderError("VOICE_OUTPUT_DURATION_MISMATCH");
      }
      const receivedAt = new Date(clock()).toISOString();
      const audioId = idFactory();
      const contract = {
        audio_id: audioId,
        owner_id,
        source_type: "GENERATED_VOICE",
        mime_type: raw.mime_type,
        byte_size: raw.buffer.length,
        checksum: checksumAudio(raw.buffer),
        duration_seconds: raw.duration_seconds,
        storage_reference: `temporary-private://audio/output/${audioId}`,
        received_at: receivedAt,
        expires_at: new Date(Date.parse(receivedAt) + settings.retentionMs).toISOString(),
        locale,
        correlation_id,
        canonical_text_checksum,
      };
      const checked = validateAudioContract(contract);
      if (!checked.ok) throw new VoiceProviderError(checked.error);
      const stored = await temporaryAudioStore.storeTemporaryAudio({ contract: checked.value, content: raw.buffer });
      if (!stored.ok) throw new VoiceProviderError(stored.error);
      return Object.freeze({
        audio_reference: checked.value.storage_reference,
        audio_id: checked.value.audio_id,
        mime_type: checked.value.mime_type,
        duration_seconds: checked.value.duration_seconds,
        checksum: checked.value.checksum,
        canonical_text_checksum,
        provider_metadata: Object.freeze({ provider: name, model: settings.model }),
        validated_text_present: typeof validated_text === "string" && validated_text.length > 0,
      });
    },
  });
}

function createOpenAIVoiceProvider(options = {}) {
  return createConfiguredVoiceProvider({ ...options, name: "OPENAI_VOICE" });
}

function createGeminiVoiceProvider(options = {}) {
  return createConfiguredVoiceProvider({ ...options, name: "GEMINI_VOICE" });
}

function validateVoiceOutput(output, providerName, expectedTextChecksum) {
  if (!output || typeof output !== "object" || output.provider_metadata?.provider !== providerName || output.canonical_text_checksum !== expectedTextChecksum || output.validated_text_present !== true || typeof output.audio_reference !== "string" || !output.audio_reference.startsWith("temporary-private://audio/") || typeof output.checksum !== "string" || !/^[a-f0-9]{64}$/.test(output.checksum)) {
    throw new VoiceProviderError("VOICE_OUTPUT_INVALID");
  }
  return output;
}

function createVoiceResponseEngine({ voicePolicyEngine, temporaryAudioStore, primaryProvider, fallbackProvider = null, shadowProvider = null, policy = "PRIMARY_ONLY", logger = null, maxSpeechCharacters = 1_200 } = {}) {
  if (!voicePolicyEngine || typeof voicePolicyEngine.evaluate !== "function") throw new TypeError("VOICE_POLICY_ENGINE_REQUIRED");
  assertTemporaryAudioStore(temporaryAudioStore);
  const primary = assertVoiceProvider(primaryProvider);
  const fallback = fallbackProvider == null ? null : assertVoiceProvider(fallbackProvider);
  const shadow = shadowProvider == null ? null : assertVoiceProvider(shadowProvider);
  if (!VOICE_EXECUTION_POLICIES.includes(policy)) throw new TypeError("VOICE_EXECUTION_POLICY_INVALID");
  const emit = safeEmitter(logger);
  const completed = new Map();

  async function invoke(provider, request, prepared, role) {
    emit("tts_started", { correlation_id: request.correlation_id, provider: provider.name, policy });
    try {
      const output = validateVoiceOutput(await provider.synthesize({
        validated_text: prepared.canonical_text,
        speech_text: prepared.speech_text,
        canonical_text_checksum: prepared.canonical_text_checksum,
        owner_id: request.owner_id,
        locale: request.locale || "fr-BF",
        voice_style: request.voice_style || KADI_VOICE_STYLE,
        output_format: request.output_format,
        correlation_id: request.correlation_id,
      }), provider.name, prepared.canonical_text_checksum);
      emit("tts_succeeded", { correlation_id: request.correlation_id, provider: provider.name, policy, mime_type: output.mime_type, duration_seconds: output.duration_seconds });
      if (role === "shadow") await temporaryAudioStore.expireTemporaryAudio({ audioId: output.audio_id, ownerId: request.owner_id });
      return output;
    } catch (error) {
      const controlled = error instanceof VoiceProviderError ? error : new VoiceProviderError("VOICE_PROVIDER_FAILED");
      emit("tts_failed", { correlation_id: request.correlation_id, provider: provider.name, policy, error_code: controlled.code });
      throw controlled;
    }
  }

  async function generate(request) {
    if (typeof request?.idempotency_key !== "string" || !/^[A-Za-z0-9:_.-]{1,200}$/.test(request.idempotency_key)) throw new VoiceProviderError("VOICE_IDEMPOTENCY_KEY_INVALID");
    const existing = completed.get(request.idempotency_key);
    if (existing) return { ...existing, duplicate: true };
    const policyResult = voicePolicyEngine.evaluate({ ...request.policy_input, validated_text: request.validated_text });
    if (policyResult.decision === "TEXT_ONLY") return Object.freeze({ decision: "TEXT_ONLY", reason: policyResult.reason, audio: null, duplicate: false });
    const preparedResult = prepareTextForSpeech(request.validated_text, { maxCharacters: maxSpeechCharacters });
    if (!preparedResult.ok) return Object.freeze({ decision: "TEXT_ONLY", reason: preparedResult.error, audio: null, duplicate: false });
    let output;
    try {
      try {
        output = await invoke(primary, request, preparedResult.value, "primary");
      } catch (error) {
        if (policy !== "CONTROLLED_FALLBACK" || !fallback || fallback.name === primary.name) throw error;
        output = await invoke(fallback, request, preparedResult.value, "controlled_fallback");
      }
    } catch (error) {
      const code = error instanceof VoiceProviderError ? error.code : "VOICE_PROVIDER_FAILED";
      return Object.freeze({ decision: "TEXT_ONLY", reason: code, audio: null, duplicate: false, non_blocking: true, wallet_debit: false });
    }
    if (policy === "SHADOW_COMPARE" && shadow && shadow.name !== primary.name) {
      try { await invoke(shadow, request, preparedResult.value, "shadow"); } catch { /* shadow is non-blocking */ }
    }
    const result = Object.freeze({ decision: "TEXT_AND_VOICE", reason: policyResult.reason, audio: output, duplicate: false, wallet_debit: false });
    completed.set(request.idempotency_key, result);
    return result;
  }

  return Object.freeze({ generate, policy });
}

function createWelcomeVoiceEngine({ voiceResponseEngine, providerAvailable = true, logger = null } = {}) {
  if (!voiceResponseEngine || typeof voiceResponseEngine.generate !== "function") throw new TypeError("VOICE_RESPONSE_ENGINE_REQUIRED");
  const emit = safeEmitter(logger);
  return Object.freeze({
    async request({ waId, validatedText, locale, idempotencyKey }) {
      const result = await voiceResponseEngine.generate({
        owner_id: waId,
        validated_text: validatedText,
        locale,
        output_format: "audio/ogg",
        correlation_id: idempotencyKey,
        idempotency_key: idempotencyKey,
        policy_input: { voice_response_mode: "VOICE_WHEN_HELPFUL", provider_available: providerAvailable, journey_step: "ONBOARDING_INITIAL", message_complexity: "SIMPLE", last_input_modality: "TEXT" },
      });
      if (result.non_blocking === true) throw new VoiceProviderError(result.reason);
      if (result.decision === "TEXT_AND_VOICE") emit("welcome_voice_sent", { correlation_id: idempotencyKey, provider: result.audio.provider_metadata.provider, mime_type: result.audio.mime_type, duration_seconds: result.audio.duration_seconds });
      return { accepted: result.decision === "TEXT_AND_VOICE", duplicate: result.duplicate, audio: result.audio || null };
    },
  });
}

module.exports = {
  VOICE_EXECUTION_POLICIES,
  VoiceProviderError,
  assertVoiceProvider,
  createGeminiVoiceProvider,
  createOpenAIVoiceProvider,
  createVoiceProvider,
  createVoiceResponseEngine,
  createWelcomeVoiceEngine,
};
