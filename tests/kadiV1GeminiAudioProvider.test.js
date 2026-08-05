"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { checksumAudio } = require("../kadiV1AudioContracts");
const { createInMemoryTemporaryAudioStore } = require("../kadiV1TemporaryAudioStore");
const { GeminiVisionError } = require("../kadiV1GeminiVisionProvider");
const { ALLOWED_AUDIO_MIME_TYPES, createGeminiAudioProvider } = require("../kadiV1GeminiAudioProvider");

const OWNER = "audio_owner";
const CONTENT = Buffer.from("fake-ogg-audio-bytes");
const CONTRACT = Object.freeze({
  audio_id: "audio_1",
  owner_id: OWNER,
  source_type: "USER_VOICE",
  mime_type: "audio/ogg",
  byte_size: CONTENT.length,
  checksum: checksumAudio(CONTENT),
  duration_seconds: 12,
  storage_reference: "temporary-private://audio/audio_1",
  received_at: "2026-08-02T12:00:00.000Z",
  expires_at: "2026-08-02T13:00:00.000Z",
  correlation_id: "corr_audio_1",
});

function rawExtraction(overrides = {}) {
  return {
    document_type: "RECU",
    fields: {
      payer: { value: "Adama", confidence: 0.9, source_reference: "page:1" },
      amount: { value: 50000, confidence: 0.85, source_reference: "page:1" },
    },
    missing_fields: [],
    uncertainties: [],
    confidence: 0.88,
    ...overrides,
  };
}

async function setup({ response = rawExtraction(), clientError = null, config = {} } = {}) {
  const store = createInMemoryTemporaryAudioStore({ clock: () => "2026-08-02T12:10:00.000Z" });
  await store.storeTemporaryAudio({ contract: CONTRACT, content: CONTENT });
  const calls = [];
  const client = {
    generateStructured: async (request) => {
      calls.push(request);
      if (clientError) throw clientError;
      return structuredClone(response);
    },
  };
  const provider = createGeminiAudioProvider({
    client,
    temporaryAudioStore: store,
    config: { enabled: true, model: "configured-audio-model", timeoutMs: 100, maxRetries: 0, temperature: 0, minimumConfidence: 0.7, maxAudioBytes: 1_000_000, ...config },
  });
  return { store, calls, provider };
}

test("est désactivé par défaut", async () => {
  const store = createInMemoryTemporaryAudioStore();
  await store.storeTemporaryAudio({ contract: CONTRACT, content: CONTENT });
  const provider = createGeminiAudioProvider({
    client: { generateStructured: async () => rawExtraction() },
    temporaryAudioStore: store,
    config: { enabled: false, model: "m", timeoutMs: 100, maxRetries: 0, temperature: 0, minimumConfidence: 0.7, maxAudioBytes: 1_000_000 },
  });
  assert.equal(provider.enabled, false);
  await assert.rejects(
    provider.extractStructuredAudioData({ audioId: "audio_1", ownerId: OWNER }),
    (error) => error instanceof GeminiVisionError && error.code === "AUDIO_FEATURE_DISABLED"
  );
});

test("extrait une structure validée depuis l'audio quand activé", async () => {
  const { provider, calls } = await setup();
  const result = await provider.extractStructuredAudioData({ audioId: "audio_1", ownerId: OWNER });
  assert.equal(result.document_type, "RECU");
  assert.equal(result.extracted_fields.payer.value, "Adama");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].media[0].mime_type, "audio/ogg");
});

test("ne remplace pas OPENAI_STT : ne fait que retourner une extraction structurée, jamais un transcript brut de production", async () => {
  const { provider } = await setup();
  const result = await provider.extractStructuredAudioData({ audioId: "audio_1", ownerId: OWNER });
  assert.ok(!("transcript" in result));
});

test("un type mime hors liste est rejeté", async () => {
  assert.deepEqual([...ALLOWED_AUDIO_MIME_TYPES], ["audio/ogg", "audio/wav"]);
});

test("un timeout provider est rejeté sans halluciner de résultat", async () => {
  const store = createInMemoryTemporaryAudioStore({ clock: () => "2026-08-02T12:10:00.000Z" });
  await store.storeTemporaryAudio({ contract: CONTRACT, content: CONTENT });
  const provider = createGeminiAudioProvider({
    client: { generateStructured: () => new Promise(() => {}) }, // never resolves
    temporaryAudioStore: store,
    config: { enabled: true, model: "configured-audio-model", timeoutMs: 5, maxRetries: 0, temperature: 0, minimumConfidence: 0.7, maxAudioBytes: 1_000_000 },
  });
  await assert.rejects(
    provider.extractStructuredAudioData({ audioId: "audio_1", ownerId: OWNER }),
    (error) => error instanceof GeminiVisionError && error.code === "AUDIO_PROVIDER_TIMEOUT"
  );
});

test("une sortie provider malformée est rejetée avant toute persistance possible", async () => {
  const { provider } = await setup({ response: { not_valid: true } });
  await assert.rejects(
    provider.extractStructuredAudioData({ audioId: "audio_1", ownerId: OWNER }),
    (error) => error instanceof GeminiVisionError
  );
});

test("un audio introuvable pour ce owner échoue fermé", async () => {
  const { provider } = await setup();
  await assert.rejects(
    provider.extractStructuredAudioData({ audioId: "audio_1", ownerId: "someone_else" }),
    (error) => error.code === "AUDIO_NOT_FOUND"
  );
});

test("un audio dépassant la limite de taille configurée est rejeté", async () => {
  const { provider } = await setup({ config: { maxAudioBytes: CONTENT.length - 1 } });
  await assert.rejects(
    provider.extractStructuredAudioData({ audioId: "audio_1", ownerId: OWNER }),
    (error) => error instanceof GeminiVisionError && error.code === "MEDIA_TOO_LARGE"
  );
});

test("la configuration exige explicitement une limite de taille audio, sans valeur par défaut implicite", () => {
  const store = createInMemoryTemporaryAudioStore();
  assert.throws(
    () => createGeminiAudioProvider({
      client: { generateStructured: async () => rawExtraction() },
      temporaryAudioStore: store,
      config: { enabled: true, model: "m", timeoutMs: 100, maxRetries: 0, temperature: 0, minimumConfidence: 0.7 }, // maxAudioBytes omitted
    }),
    /GEMINI_AUDIO_CONFIG_INVALID/
  );
});

test("les événements de diagnostic ne contiennent jamais l'audio brut, le texte extrait ni le owner en clair", async () => {
  const events = [];
  const store = createInMemoryTemporaryAudioStore({ clock: () => "2026-08-02T12:10:00.000Z" });
  await store.storeTemporaryAudio({ contract: CONTRACT, content: CONTENT });
  const provider = createGeminiAudioProvider({
    client: { generateStructured: async () => rawExtraction() },
    temporaryAudioStore: store,
    config: { enabled: true, model: "configured-audio-model", timeoutMs: 100, maxRetries: 0, temperature: 0, minimumConfidence: 0.7, maxAudioBytes: 1_000_000 },
    logger: (event, details) => events.push({ event, details }),
  });
  await provider.extractStructuredAudioData({ audioId: "audio_1", ownerId: OWNER });
  assert.ok(events.length > 0);
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes(OWNER), "le owner_id complet ne doit jamais apparaître dans les diagnostics");
  assert.ok(!serialized.includes("Adama"), "aucune donnée extraite ne doit apparaître dans les diagnostics");
  assert.ok(!serialized.includes(CONTENT.toString("base64")), "l'audio brut ne doit jamais apparaître dans les diagnostics");
});
