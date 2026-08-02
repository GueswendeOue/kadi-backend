"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createInMemoryTemporaryAudioStore } = require("../kadiV1TemporaryAudioStore");
const { createVoicePolicyEngine, detectSensitiveContent, prepareTextForSpeech, KADI_VOICE_STYLE } = require("../kadiV1VoicePolicyEngine");
const { createOpenAIVoiceProvider, createGeminiVoiceProvider, createVoiceResponseEngine, createWelcomeVoiceEngine } = require("../kadiV1VoiceProviders");
const { createInMemoryOnboardingRepository } = require("../kadiV1OnboardingRepository");
const { WELCOME_TEXT, createKadiV1OnboardingService, createWelcomeVoiceRequester } = require("../kadiV1WelcomeService");

const NOW = "2026-08-02T12:00:00.000Z";
const WA_ID = "22670000001";

function audio() {
  const opusHead = Buffer.concat([Buffer.from("OpusHead"), Buffer.alloc(11)]);
  function page(granule, body) {
    const header = Buffer.alloc(28);
    header.write("OggS", 0);
    header.writeBigUInt64LE(BigInt(granule), 6);
    header[26] = 1;
    header[27] = body.length;
    return Buffer.concat([header, body]);
  }
  return { buffer: Buffer.concat([page(0, opusHead), page(192_000, Buffer.from([0]))]), mime_type: "audio/ogg", duration_seconds: 4 };
}

function configuredProvider({ store, name = "OPENAI", synthesizeAudio = async () => audio(), id = "generated_audio" } = {}) {
  const options = {
    temporaryAudioStore: store,
    synthesizeAudio,
    clock: () => NOW,
    idFactory: () => id,
    config: { enabled: true, model: "configured-voice-model", voice: "configured-voice", outputFormat: "audio/ogg", retentionMs: 60_000, maxBytes: 100_000, maxDurationSeconds: 60 },
  };
  return name === "GEMINI" ? createGeminiVoiceProvider(options) : createOpenAIVoiceProvider(options);
}

function request(overrides = {}) {
  return {
    owner_id: WA_ID,
    validated_text: "Votre document fera 2 pages et coûtera 2 crédits.",
    locale: "fr-BF",
    output_format: "audio/ogg",
    correlation_id: "corr_voice",
    idempotency_key: "voice:test:v1",
    policy_input: { voice_response_mode: "VOICE_WHEN_HELPFUL", provider_available: true, message_complexity: "COMPLEX", last_input_modality: "TEXT" },
    ...overrides,
  };
}

test("Voice Policy Engine deterministically covers all preference modes", () => {
  const engine = createVoicePolicyEngine({ featureEnabled: true });
  const base = { validated_text: "Explication utile", provider_available: true, message_complexity: "COMPLEX", last_input_modality: "TEXT" };
  assert.equal(engine.evaluate({ ...base, voice_response_mode: "TEXT_ONLY" }).decision, "TEXT_ONLY");
  assert.equal(engine.evaluate({ ...base, voice_response_mode: "TEXT_AND_VOICE" }).decision, "TEXT_AND_VOICE");
  assert.equal(engine.evaluate({ ...base, voice_response_mode: "VOICE_WHEN_HELPFUL" }).decision, "TEXT_AND_VOICE");
  assert.equal(engine.default_mode, "VOICE_WHEN_HELPFUL");
});

test("explicit request, incoming vocal, onboarding, short message and provider availability follow policy", () => {
  const engine = createVoicePolicyEngine({ featureEnabled: true });
  const base = { validated_text: "Bonjour", voice_response_mode: "VOICE_WHEN_HELPFUL", provider_available: true, message_complexity: "SIMPLE", last_input_modality: "TEXT" };
  assert.equal(engine.evaluate({ ...base, explicit_voice_request: true }).decision, "TEXT_AND_VOICE");
  assert.equal(engine.evaluate({ ...base, last_input_modality: "VOICE" }).decision, "TEXT_AND_VOICE");
  assert.equal(engine.evaluate({ ...base, journey_step: "ONBOARDING_INITIAL" }).decision, "TEXT_AND_VOICE");
  assert.equal(engine.evaluate({ ...base, journey_step: "SHORT_CONFIRMATION" }).decision, "TEXT_ONLY");
  assert.equal(engine.evaluate({ ...base, provider_available: false }).decision, "TEXT_ONLY");
});

test("sensitive data is detected and never read automatically", () => {
  const engine = createVoicePolicyEngine({ featureEnabled: true });
  const text = "Mon IFU est 123456789 et mon code est 123456.";
  assert.equal(detectSensitiveContent(text).sensitive, true);
  assert.equal(engine.evaluate({ validated_text: text, voice_response_mode: "TEXT_AND_VOICE", provider_available: true }).decision, "TEXT_ONLY");
  assert.equal(prepareTextForSpeech(text).error, "SENSITIVE_TEXT_BLOCKED");
});

test("oral text preparation preserves meaning and pronounces amounts and credits", () => {
  const amount = prepareTextForSpeech("Le total est de 15 000 FCFA et coûte 2 crédits.");
  assert.equal(amount.ok, true);
  assert.match(amount.value.speech_text, /quinze mille francs CFA/);
  assert.match(amount.value.speech_text, /deux crédits/);
  const multiplication = prepareTextForSpeech("25 000 × 2");
  assert.match(multiplication.value.speech_text, /deux articles à vingt cinq mille francs chacun/);
  assert.equal(amount.value.canonical_text, "Le total est de 15 000 FCFA et coûte 2 crédits.");
});

test("configured provider requires canonical text and stores private generated audio", async () => {
  const store = createInMemoryTemporaryAudioStore({ clock: () => NOW });
  let providerInput;
  const primary = configuredProvider({ store, synthesizeAudio: async (input) => { providerInput = input; return audio(); } });
  const engine = createVoiceResponseEngine({ voicePolicyEngine: createVoicePolicyEngine({ featureEnabled: true }), temporaryAudioStore: store, primaryProvider: primary });
  const result = await engine.generate(request());
  assert.equal(result.decision, "TEXT_AND_VOICE");
  assert.equal(result.wallet_debit, false);
  assert.equal(providerInput.voiceStyle.id, KADI_VOICE_STYLE.id);
  assert.match(providerInput.text, /deux pages/);
  assert.match(providerInput.text, /deux crédits/);
  assert.match(result.audio.audio_reference, /^temporary-private:\/\/audio\/output\//);
  assert.equal((await store.getTemporaryAudio({ audioId: result.audio.audio_id, ownerId: WA_ID })).ok, true);
});

test("controlled fallback is explicit and shadow output is never returned", async () => {
  const store = createInMemoryTemporaryAudioStore({ clock: () => NOW });
  const failing = configuredProvider({ store, synthesizeAudio: async () => { throw new Error("synthetic"); } });
  const fallback = configuredProvider({ store, name: "GEMINI", id: "fallback_audio" });
  const controlled = createVoiceResponseEngine({ voicePolicyEngine: createVoicePolicyEngine({ featureEnabled: true }), temporaryAudioStore: store, primaryProvider: failing, fallbackProvider: fallback, policy: "CONTROLLED_FALLBACK" });
  assert.equal((await controlled.generate(request())).audio.provider_metadata.provider, "GEMINI_VOICE");
  const primary = configuredProvider({ store, id: "primary_audio" });
  const shadow = configuredProvider({ store, name: "GEMINI", id: "shadow_audio" });
  const compared = createVoiceResponseEngine({ voicePolicyEngine: createVoicePolicyEngine({ featureEnabled: true }), temporaryAudioStore: store, primaryProvider: primary, shadowProvider: shadow, policy: "SHADOW_COMPARE" });
  const result = await compared.generate(request({ idempotency_key: "voice:shadow:v1" }));
  assert.equal(result.audio.provider_metadata.provider, "OPENAI_VOICE");
  assert.equal((await store.getTemporaryAudio({ audioId: "shadow_audio", ownerId: WA_ID })).error, "AUDIO_EXPIRED");
});

test("TTS failure falls back to canonical text without blocking or debit", async () => {
  const store = createInMemoryTemporaryAudioStore({ clock: () => NOW });
  const failing = configuredProvider({ store, synthesizeAudio: async () => { throw new Error("synthetic"); } });
  const engine = createVoiceResponseEngine({ voicePolicyEngine: createVoicePolicyEngine({ featureEnabled: true }), temporaryAudioStore: store, primaryProvider: failing });
  const result = await engine.generate(request());
  assert.deepEqual(result, { decision: "TEXT_ONLY", reason: "VOICE_PROVIDER_FAILED", audio: null, duplicate: false, non_blocking: true, wallet_debit: false });
});

test("welcome text precedes voice attempt, credits are already granted and voice is idempotent", async () => {
  const store = createInMemoryTemporaryAudioStore({ clock: () => NOW });
  let calls = 0;
  const provider = configuredProvider({ store, synthesizeAudio: async () => { calls += 1; return audio(); } });
  const voiceEngine = createVoiceResponseEngine({ voicePolicyEngine: createVoicePolicyEngine({ featureEnabled: true }), temporaryAudioStore: store, primaryProvider: provider });
  const welcomeVoice = createWelcomeVoiceEngine({ voiceResponseEngine: voiceEngine });
  const repo = createInMemoryOnboardingRepository({ clock: () => NOW });
  const onboarding = createKadiV1OnboardingService({ repository: repo, voiceRequester: createWelcomeVoiceRequester({ requestVoice: welcomeVoice.request }) });
  const result = await onboarding.onboardNewUser({ waId: WA_ID });
  assert.equal(result.welcome.text, WELCOME_TEXT);
  assert.equal(result.welcome.voice.accepted, true);
  assert.equal(repo.inspect().balances[WA_ID], 5);
  assert.ok(repo.inspect().events.findIndex((entry) => entry.event_type === "WELCOME_TEXT_READY") < repo.inspect().events.findIndex((entry) => entry.event_type === "WELCOME_VOICE_REQUESTED"));
  const replay = await welcomeVoice.request({ waId: WA_ID, validatedText: WELCOME_TEXT, locale: "fr-BF", idempotencyKey: `welcome_voice:${WA_ID}:v1` });
  assert.equal(replay.duplicate, true);
  assert.equal(calls, 1);
  assert.equal(repo.inspect().ledger.length, 1);
});

test("welcome TTS failure is non-blocking and retry never grants a second bonus", async () => {
  const store = createInMemoryTemporaryAudioStore({ clock: () => NOW });
  let fail = true;
  const provider = configuredProvider({ store, synthesizeAudio: async () => { if (fail) throw new Error("synthetic"); return audio(); } });
  const voiceEngine = createVoiceResponseEngine({ voicePolicyEngine: createVoicePolicyEngine({ featureEnabled: true }), temporaryAudioStore: store, primaryProvider: provider });
  const repo = createInMemoryOnboardingRepository({ clock: () => NOW });
  const welcomeVoice = createWelcomeVoiceEngine({ voiceResponseEngine: voiceEngine });
  const onboarding = createKadiV1OnboardingService({ repository: repo, voiceRequester: createWelcomeVoiceRequester({ requestVoice: welcomeVoice.request }) });
  const first = await onboarding.onboardNewUser({ waId: WA_ID });
  assert.equal(first.ok, true);
  assert.equal(first.welcome.voice.non_blocking, true);
  fail = false;
  assert.equal((await onboarding.retryWelcomeVoice({ waId: WA_ID })).ok, true);
  assert.equal(repo.inspect().balances[WA_ID], 5);
  assert.equal(repo.inspect().ledger.length, 1);
});

test("voice logs contain no canonical text, audio, owner or private reference", async () => {
  const logs = [];
  const store = createInMemoryTemporaryAudioStore({ clock: () => NOW });
  const provider = configuredProvider({ store });
  const engine = createVoiceResponseEngine({ voicePolicyEngine: createVoicePolicyEngine({ featureEnabled: true }), temporaryAudioStore: store, primaryProvider: provider, logger: (event, details) => logs.push({ event, details }) });
  await engine.generate(request({ validated_text: "Explication confidentielle sans identifiant." }));
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /confidentielle|22670000001|temporary-private|OggS/);
});

test("voice core has no webhook, wallet, Meta, PDF or provider SDK dependency", () => {
  for (const file of ["kadiV1VoicePolicyEngine.js", "kadiV1VoiceProviders.js", "kadiV1AudioValidationService.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.doesNotMatch(source, /require\([^\n]*(openai|gemini|whatsapp|wallet|pdf|supabase|index)/i, file);
    assert.doesNotMatch(source, /\/webhook|\/data_exchange|debitCredits|sendMessage|generatePdf/i, file);
  }
});
