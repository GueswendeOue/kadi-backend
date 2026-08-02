"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createKadiBrain } = require("../kadiV1Brain");
const { checksumAudio } = require("../kadiV1AudioContracts");
const { createInMemoryTemporaryAudioStore } = require("../kadiV1TemporaryAudioStore");
const {
  SpeechToTextError,
  createOpenAISpeechToTextProvider,
  createSpeechToTextProvider,
  createSpeechToTextService,
  createVoiceInputPipeline,
} = require("../kadiV1SpeechToText");

const CONTENT = Buffer.from("synthetic-audio");
const CONTRACT = Object.freeze({
  audio_id: "audio_stt", owner_id: "owner_stt", source_type: "USER_VOICE", mime_type: "audio/ogg",
  byte_size: CONTENT.length, checksum: checksumAudio(CONTENT), duration_seconds: 4,
  storage_reference: "temporary-private://audio/input/audio_stt", received_at: "2026-08-02T12:00:00.000Z",
  expires_at: "2026-08-02T13:00:00.000Z", locale: "fr-BF", correlation_id: "corr_stt",
});

async function setupStore() {
  const store = createInMemoryTemporaryAudioStore({ clock: () => "2026-08-02T12:10:00.000Z" });
  await store.storeTemporaryAudio({ contract: CONTRACT, content: CONTENT });
  return store;
}

function provider(name, implementation) {
  return createSpeechToTextProvider({ name, transcribeAudio: implementation });
}

function normal(providerName = "PRIMARY_STT", extra = {}) {
  return { transcript: "Prépare une facture pour Awa", detected_locale: "fr-BF", confidence: 0.94, uncertain_segments: [], provider_metadata: { provider: providerName, model: "configured-model" }, ...extra };
}

test("normalizes a successful transcription without exposing provider internals", async () => {
  const store = await setupStore();
  const service = createSpeechToTextService({ temporaryAudioStore: store, primaryProvider: provider("PRIMARY_STT", async () => normal()) });
  const result = await service.transcribe({ audioId: CONTRACT.audio_id, ownerId: CONTRACT.owner_id });
  assert.equal(result.transcript, "Prépare une facture pour Awa");
  assert.equal(result.duration_seconds, 4);
  assert.equal(result.provider_metadata.provider, "PRIMARY_STT");
});

test("keeps uncertain segments and rejects malformed provider output", async () => {
  const store = await setupStore();
  const uncertain = createSpeechToTextService({ temporaryAudioStore: store, primaryProvider: provider("PRIMARY_STT", async () => normal("PRIMARY_STT", { uncertain_segments: [{ start_seconds: 1, end_seconds: 2, candidate_text: "quinze mille", reason: "LOW_AUDIO_CLARITY", confidence: 0.4 }] })) });
  assert.equal((await uncertain.transcribe({ audioId: CONTRACT.audio_id, ownerId: CONTRACT.owner_id })).uncertain_segments.length, 1);
  const invalid = createSpeechToTextService({ temporaryAudioStore: store, primaryProvider: provider("PRIMARY_STT", async () => ({ transcript: "x", secret_dump: "forbidden" })) });
  await assert.rejects(invalid.transcribe({ audioId: CONTRACT.audio_id, ownerId: CONTRACT.owner_id }), (error) => error.code === "TRANSCRIPTION_RESULT_INVALID");
});

test("low global confidence becomes an explicit uncertainty", async () => {
  const store = await setupStore();
  const service = createSpeechToTextService({ temporaryAudioStore: store, primaryProvider: provider("PRIMARY_STT", async () => normal("PRIMARY_STT", { confidence: 0.2 })) });
  const result = await service.transcribe({ audioId: CONTRACT.audio_id, ownerId: CONTRACT.owner_id });
  assert.equal(result.uncertain_segments[0].reason, "LOW_TRANSCRIPTION_CONFIDENCE");
});

test("provider failure is recoverable and controlled fallback is explicit", async () => {
  const store = await setupStore();
  const failing = provider("PRIMARY_STT", async () => { throw new Error("synthetic"); });
  const noFallback = createSpeechToTextService({ temporaryAudioStore: store, primaryProvider: failing });
  await assert.rejects(noFallback.transcribe({ audioId: CONTRACT.audio_id, ownerId: CONTRACT.owner_id }), (error) => error instanceof SpeechToTextError && error.recoverable);
  const fallback = provider("FALLBACK_STT", async () => normal("FALLBACK_STT"));
  const controlled = createSpeechToTextService({ temporaryAudioStore: store, primaryProvider: failing, fallbackProvider: fallback, policy: "CONTROLLED_FALLBACK" });
  assert.equal((await controlled.transcribe({ audioId: CONTRACT.audio_id, ownerId: CONTRACT.owner_id })).provider_metadata.provider, "FALLBACK_STT");
});

test("shadow transcription is non-blocking and never changes the primary result", async () => {
  const store = await setupStore();
  let shadowCalls = 0;
  const service = createSpeechToTextService({
    temporaryAudioStore: store,
    primaryProvider: provider("PRIMARY_STT", async () => normal()),
    shadowProvider: provider("SHADOW_STT", async () => { shadowCalls += 1; throw new Error("synthetic"); }),
    policy: "SHADOW_COMPARE",
  });
  const result = await service.transcribe({ audioId: CONTRACT.audio_id, ownerId: CONTRACT.owner_id });
  assert.equal(result.provider_metadata.provider, "PRIMARY_STT");
  assert.equal(shadowCalls, 1);
});

test("validated transcription enters Kadi Brain as TRANSCRIPTION without persistence", async () => {
  const store = await setupStore();
  const stt = createSpeechToTextService({ temporaryAudioStore: store, primaryProvider: provider("PRIMARY_STT", async () => normal("PRIMARY_STT", { uncertain_segments: [{ start_seconds: 1, end_seconds: 2, reason: "AMBIGUOUS_PRICE", confidence: 0.3 }] })) });
  let brainRequest;
  const voiceBrainProvider = {
    name: "VOICE_BRAIN",
    understand: async (request) => {
      brainRequest = request;
      return {
        intent: "CREATE_DOCUMENT", document_type: "FACTURE", extracted_fields: {}, missing_fields: [], uncertainties: [],
        confidence: 0.9, suggested_next_action: "CONTINUE_COLLECTION", user_facing_message_draft: null,
        provider_metadata: { provider: "VOICE_BRAIN", model: "simulated" },
      };
    },
  };
  const brain = createKadiBrain({ providers: { voice: voiceBrainProvider }, primaryByModality: { TEXT: "VOICE_BRAIN", TRANSCRIPTION: "VOICE_BRAIN", IMAGE: "VOICE_BRAIN", DOCUMENT: "VOICE_BRAIN" } });
  const pipeline = createVoiceInputPipeline({ speechToTextService: stt, brain });
  const result = await pipeline.process({ audioId: CONTRACT.audio_id, ownerId: CONTRACT.owner_id, requestId: "brain_audio" });
  assert.equal(brainRequest.modality, "TRANSCRIPTION");
  assert.equal(brainRequest.transcription, normal().transcript);
  assert.equal(result.requires_confirmation, true);
  assert.equal(result.brain_result.document_type, "FACTURE");
  assert.match(result.targeted_question, /préciser/);
  assert.equal("persisted_document" in result, false);
});

test("OpenAI adapter reuses an injected transcription function and configured model", async () => {
  let received;
  const adapter = createOpenAISpeechToTextProvider({ model: "configured-stt-model", transcribe: async (buffer, options) => { received = { buffer, options }; return { text: "Facture pour Awa", localeHint: "fr-BF" }; } });
  const result = await adapter.transcribeAudio({ buffer: CONTENT, mime_type: "audio/ogg", locale: "fr-BF" });
  assert.equal(received.options.model, "configured-stt-model");
  assert.equal(result.provider_metadata.model, "configured-stt-model");
});

test("STT logs contain no transcript, owner, private reference or provider error", async () => {
  const store = await setupStore();
  const logs = [];
  const service = createSpeechToTextService({ temporaryAudioStore: store, primaryProvider: provider("PRIMARY_STT", async () => normal()), logger: (event, details) => logs.push({ event, details }) });
  await service.transcribe({ audioId: CONTRACT.audio_id, ownerId: CONTRACT.owner_id });
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /Prépare une facture|owner_stt|temporary-private|synthetic-audio/);
});

test("new STT core has no webhook, wallet, PDF, Meta or provider SDK dependency", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "kadiV1SpeechToText.js"), "utf8");
  assert.doesNotMatch(source, /require\([^\n]*(openai|gemini|whatsapp|wallet|pdf|supabase|index)/i);
  assert.doesNotMatch(source, /\/webhook|\/data_exchange|debit|generatePdf|sendMessage/i);
});
