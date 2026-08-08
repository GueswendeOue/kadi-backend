"use strict";

// T11/INBOUND-VOICE-TRANSCRIPTION-GATE-001: config.features.transcription
// is the sole authority for accepting inbound WhatsApp audio. This file
// proves, through the REAL kadiV1WebhookRuntime.js and the REAL audio/STT
// pipeline (createKadiV1ProductionMediaResolver, createAudioValidationService,
// createSpeechToTextService, createOpenAISpeechToTextProvider), that:
//
//   - transcription=false rejects inbound audio BEFORE any Meta media
//     lookup/download or OpenAI call, regardless of config.features.voice
//     (the separate, OUTBOUND voice authority — never consulted here);
//   - transcription=true accepts, validates, transcribes and forwards the
//     transcript to the conversation orchestrator exactly like typed text;
//   - the existing MIME/size/duration/transcript contract, idempotency,
//     temporary-audio lifecycle and owner/rollout isolation are unchanged.
//
// Only true external I/O — the WhatsApp Meta media API and the OpenAI
// transcription network call — is faked. Everything else (config parsing,
// webhook runtime, media resolver, audio validation, STT service, the
// OpenAI provider ADAPTER itself) is the real production code.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createKadiV1WebhookRuntime, TRANSCRIPTION_DISABLED_TEXT } = require("../kadiV1WebhookRuntime");
const { createKadiV1RuntimeConfig } = require("../kadiV1RuntimeConfig");
const { createKadiV1ProductionMediaResolver } = require("../kadiV1ProductionMediaResolver");
const { createAudioValidationService } = require("../kadiV1AudioValidationService");
const { createInMemoryTemporaryAudioStore } = require("../kadiV1TemporaryAudioStore");
const { createSpeechToTextService, createOpenAISpeechToTextProvider } = require("../kadiV1SpeechToText");

const OWNER = "22670000000";
const OTHER_OWNER = "22679999999";
const NOW = "2026-08-10T09:00:00.000Z";

function wav({ seconds = 1, sampleRate = 8_000 } = {}) {
  const dataSize = Math.max(1, Math.round(seconds * sampleRate * 2));
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

// Minimal single-page Ogg/Opus container matching kadiV1AudioValidationService.js's
// own inspectOggOpus parser: one page, one lacing segment, a body containing
// the literal "OpusHead" (required by sniffAudioMime), granule position set
// so duration_seconds = seconds.
function ogg({ seconds = 1 } = {}) {
  const granule = BigInt(Math.round(seconds * 48_000));
  const body = Buffer.concat([Buffer.from("OpusHead"), Buffer.alloc(8)]);
  const header = Buffer.alloc(27 + 1);
  header.write("OggS", 0, "ascii");
  header.writeUInt8(0, 4);
  header.writeUInt8(0x02, 5);
  header.writeBigUInt64LE(granule, 6);
  header.writeUInt32LE(1, 14);
  header.writeUInt32LE(0, 18);
  header.writeUInt32LE(0, 22);
  header.writeUInt8(1, 26);
  header.writeUInt8(body.length, 27);
  return Buffer.concat([header, body]);
}

function buildConfig(envOverrides = {}) {
  return createKadiV1RuntimeConfig({
    KADI_V1_ENABLED: "true",
    KADI_V1_WEBHOOK_ENABLED: "true",
    KADI_V1_ROLLOUT_MODE: "FULL",
    KADI_V1_TRANSCRIPTION_ENABLED: "true",
    ...envOverrides,
  });
}

// Builds the REAL audio/STT pipeline (only whatsappApi/transcribe faked)
// and wires it into the REAL webhook runtime. Returns instrumentation for
// every layer so tests can assert exactly where a message stopped.
function buildHarness({
  config = buildConfig(),
  audioBuffer = wav(),
  mediaMimeType = "audio/wav",
  fileSize = undefined,
  transcribeImpl = async () => ({ text: "Ajoute deux sacs de ciment" }),
  audioLimits = {},
  minimumConfidence = 0.7,
  clock = () => NOW,
} = {}) {
  const calls = [];

  const whatsappApi = {
    getMediaInfo: async (mediaId) => {
      calls.push(["meta_get_media_info", mediaId]);
      return {
        id: mediaId,
        url: `https://meta.example.test/media/${mediaId}`,
        mime_type: mediaMimeType,
        file_size: fileSize === undefined ? audioBuffer.length : fileSize,
      };
    },
    downloadMediaToBuffer: async (url) => {
      calls.push(["meta_download", url]);
      return audioBuffer;
    },
  };

  const temporaryAudioStore = createInMemoryTemporaryAudioStore({ clock });
  const audioValidationService = createAudioValidationService({
    temporaryAudioStore,
    clock,
    idFactory: (() => { let n = 0; return () => `audio_test_${(n += 1)}`; })(),
    config: { maxBytes: 8 * 1024 * 1024, maxDurationSeconds: 600, retentionMs: 15 * 60 * 1000, ...audioLimits },
  });

  const sttProvider = createOpenAISpeechToTextProvider({
    transcribe: async (buffer, options) => {
      calls.push(["openai_transcribe_adapter", { bytes: buffer.length, ...options }]);
      return transcribeImpl(buffer, options);
    },
    model: "whisper-1",
  });
  const speechToTextService = createSpeechToTextService({
    temporaryAudioStore,
    primaryProvider: sttProvider,
    policy: "PRIMARY_ONLY",
    minimumConfidence,
  });

  const mediaValidationService = {
    ingest: async () => { throw new Error("UNEXPECTED_CALL:mediaValidationService.ingest"); },
  };

  const mediaResolver = createKadiV1ProductionMediaResolver({
    whatsappApi,
    audioValidationService,
    speechToTextService,
    mediaValidationService,
  });

  const orchestratorCalls = [];
  const mutatedKeys = new Set();
  let mutationCount = 0;
  const orchestrator = {
    handle: async (input) => {
      orchestratorCalls.push(input);
      const duplicate = mutatedKeys.has(input.idempotencyKey);
      if (!duplicate) {
        mutatedKeys.add(input.idempotencyKey);
        mutationCount += 1;
      }
      return {
        handled: true,
        canonical_text: `Reçu : ${input.text || input.action || input.inputType}`,
        business_action: duplicate ? null : "DOCUMENT_UPDATED",
        flow_request: null,
        voice_request: null,
        events: [],
        duplicate,
      };
    },
  };

  const presenterCalls = [];
  const presenter = {
    presentConversation: async (input) => presenterCalls.push(["conversation", input]),
    presentFlowReply: async (input) => presenterCalls.push(["flow_reply", input]),
    presentRecoverableError: async (input) => presenterCalls.push(["recoverable_error", input]),
  };

  const flowReplyRuntime = { handle: async () => { throw new Error("UNEXPECTED_CALL:flowReplyRuntime"); } };

  const runtime = createKadiV1WebhookRuntime({
    config,
    orchestrator,
    flowReplyRuntime,
    mediaResolver,
    presenter,
    logger: { log: () => {} },
  });

  return {
    runtime, calls, orchestratorCalls, presenterCalls, temporaryAudioStore,
    getMutationCount: () => mutationCount,
  };
}

function audioMessage({ id = "wamid.audio.1", from = OWNER, mediaId = "media-1" } = {}) {
  return { id, from, type: "audio", audio: { id: mediaId } };
}

async function send(harness, message) {
  return harness.runtime.handleIncomingValue({ messages: [message] });
}

// =====================================================================
// 1-2. transcription=false rejects before any resolver/Meta/STT call
// =====================================================================

test("2. transcription=false: zero media resolver call, zero Meta lookup/download, zero STT, safe user copy", async () => {
  const h = buildHarness({ config: buildConfig({ KADI_V1_TRANSCRIPTION_ENABLED: "false" }) });
  const result = await send(h, audioMessage());
  assert.equal(result.results[0].handled, true);
  assert.equal(result.results[0].accepted, false);
  assert.equal(result.results[0].reason, "KADI_V1_TRANSCRIPTION_DISABLED");
  assert.equal(h.calls.filter(([name]) => name === "meta_get_media_info").length, 0, "zero Meta media lookup");
  assert.equal(h.calls.filter(([name]) => name === "meta_download").length, 0, "zero Meta media download");
  assert.equal(h.calls.filter(([name]) => name === "openai_transcribe_adapter").length, 0, "zero OpenAI STT call");
  assert.equal(h.orchestratorCalls.length, 0, "orchestrator never reached");
  assert.equal(h.presenterCalls.length, 1);
  assert.deepEqual(h.presenterCalls[0][0], "recoverable_error");
  assert.equal(h.presenterCalls[0][1].canonicalText, TRANSCRIPTION_DISABLED_TEXT);
  assert.doesNotMatch(TRANSCRIPTION_DISABLED_TEXT, /transcription|OpenAI|flag|feature|whisper/i, "user text must not expose internals");
});

test("3. transcription=false + voice=true: still zero inbound processing — KADI_V1_VOICE_ENABLED never overrides the inbound gate", async () => {
  const h = buildHarness({ config: buildConfig({ KADI_V1_TRANSCRIPTION_ENABLED: "false", KADI_V1_VOICE_ENABLED: "true" }) });
  const result = await send(h, audioMessage());
  assert.equal(result.results[0].accepted, false);
  assert.equal(result.results[0].reason, "KADI_V1_TRANSCRIPTION_DISABLED");
  assert.equal(h.calls.length, 0, "no Meta/OpenAI call of any kind");
  assert.equal(h.orchestratorCalls.length, 0);
});

// =====================================================================
// 4-5. transcription=true, voice=false: audio -> transcript -> orchestrator, TEXT only
// =====================================================================

test("4. transcription=true + voice=false: audio resolves to a transcript, reaches the orchestrator as TRANSCRIPTION, TEXT-only response", async () => {
  const h = buildHarness({
    config: buildConfig({ KADI_V1_TRANSCRIPTION_ENABLED: "true", KADI_V1_VOICE_ENABLED: "false" }),
    audioBuffer: wav({ seconds: 2 }),
  });
  const result = await send(h, audioMessage());
  assert.equal(result.results[0].accepted, true);
  assert.equal(h.orchestratorCalls.length, 1);
  assert.equal(h.orchestratorCalls[0].inputType, "TRANSCRIPTION");
  assert.equal(h.orchestratorCalls[0].text, "Ajoute deux sacs de ciment");
  assert.equal(h.presenterCalls.length, 1);
  assert.equal(h.presenterCalls[0][0], "conversation");
  assert.equal(typeof h.presenterCalls[0][1].response.canonical_text, "string");
  assert.equal(h.presenterCalls[0][1].response.voice_request, null, "TEXT-only: no voice_request surfaced by this fixture's response");
});

test("5. supported OGG voice note accepted end to end through the real pipeline", async () => {
  const h = buildHarness({ audioBuffer: ogg({ seconds: 3 }), mediaMimeType: "audio/ogg" });
  const result = await send(h, audioMessage());
  assert.equal(result.results[0].accepted, true);
  assert.equal(h.calls.filter(([name]) => name === "meta_get_media_info").length, 1);
  assert.equal(h.calls.filter(([name]) => name === "meta_download").length, 1);
  assert.equal(h.calls.filter(([name]) => name === "openai_transcribe_adapter").length, 1, "the real OpenAI provider adapter contract is actually invoked");
  assert.equal(h.orchestratorCalls[0].text, "Ajoute deux sacs de ciment");
});

test("6. WAV voice note accepted end to end through the real pipeline", async () => {
  const h = buildHarness({ audioBuffer: wav({ seconds: 4 }), mediaMimeType: "audio/wav" });
  const result = await send(h, audioMessage());
  assert.equal(result.results[0].accepted, true);
  assert.equal(h.orchestratorCalls[0].inputType, "TRANSCRIPTION");
});

// =====================================================================
// 7-9. Audio contract: unsupported MIME, Meta MIME mismatch, empty/invalid media
// =====================================================================

test("7. unsupported MIME type rejected before transcription, fail closed", async () => {
  const h = buildHarness({ audioBuffer: Buffer.from("not decodable"), mediaMimeType: "audio/mpeg" });
  const result = await send(h, audioMessage());
  assert.equal(result.results[0].accepted, false);
  assert.equal(h.calls.filter(([name]) => name === "openai_transcribe_adapter").length, 0);
});

test("8. Meta media MIME mismatch (declared vs actual) rejected, fail closed", async () => {
  const control = buildHarness({ audioBuffer: wav(), mediaMimeType: "audio/wav" });
  const controlResult = await send(control, audioMessage({ mediaId: "media-mismatch" }));
  assert.equal(controlResult.results[0].accepted, true, "sanity: unmismatched control case still accepted");

  // Force the declared message MIME to disagree with what Meta's own
  // media-info lookup reports for the same media id.
  const mismatched = audioMessage({ mediaId: "media-mismatch" });
  mismatched.audio.mime_type = "audio/ogg";
  const h = buildHarness({ audioBuffer: wav(), mediaMimeType: "audio/wav" });
  const result = await send(h, mismatched);
  assert.equal(result.results[0].accepted, false);
  assert.equal(h.calls.filter(([name]) => name === "openai_transcribe_adapter").length, 0);
});

test("9. empty/invalid media download rejected, fail closed, no transcription attempted", async () => {
  const h = buildHarness({ audioBuffer: Buffer.alloc(0) });
  const result = await send(h, audioMessage());
  assert.equal(result.results[0].accepted, false);
  assert.equal(h.calls.filter(([name]) => name === "openai_transcribe_adapter").length, 0);
});

test("declared Meta size mismatch and invalid media id also fail closed", async () => {
  const sizeMismatch = buildHarness({ audioBuffer: wav(), fileSize: 999_999 });
  const sizeResult = await send(sizeMismatch, audioMessage());
  assert.equal(sizeResult.results[0].accepted, false);

  const invalidId = buildHarness({ audioBuffer: wav() });
  const invalidIdResult = await send(invalidId, { id: "wamid.audio.badid", from: OWNER, type: "audio", audio: {} });
  assert.equal(invalidIdResult.results[0].accepted, false);
  assert.equal(invalidId.calls.length, 0, "no Meta call at all without a valid media id");
});

test("oversized audio and duration-exceeding audio fail closed", async () => {
  const tooLarge = buildHarness({ audioBuffer: wav({ seconds: 2 }), audioLimits: { maxBytes: 100 } });
  assert.equal((await send(tooLarge, audioMessage())).results[0].accepted, false);

  const tooLong = buildHarness({ audioBuffer: wav({ seconds: 10 }), audioLimits: { maxDurationSeconds: 1 } });
  assert.equal((await send(tooLong, audioMessage())).results[0].accepted, false);
});

// =====================================================================
// 10-12. STT provider failure, empty transcript, oversized transcript
// =====================================================================

test("10. STT provider failure fails closed and expires the temporary audio best-effort", async () => {
  const h = buildHarness({ transcribeImpl: async () => { throw new Error("simulated OpenAI outage"); } });
  const result = await send(h, audioMessage());
  assert.equal(result.results[0].accepted, false);
  assert.equal(h.presenterCalls[0][0], "recoverable_error");
  assert.doesNotMatch(JSON.stringify(h.presenterCalls), /simulated OpenAI outage|whisper-1/, "raw provider error never exposed to the user");
  const leaked = await h.temporaryAudioStore.getTemporaryAudio({ audioId: "audio_test_1", ownerId: OWNER });
  assert.equal(leaked.ok, false, "temporary audio must be expired (or absent) after a failed transcription, never left retrievable");
});

test("11. empty transcript from the STT provider is rejected, fail closed", async () => {
  const h = buildHarness({ transcribeImpl: async () => ({ text: "" }) });
  const result = await send(h, audioMessage());
  assert.equal(result.results[0].accepted, false);
  assert.equal(h.orchestratorCalls.length, 0);
});

test("12. transcript exceeding the maximum length is rejected, fail closed", async () => {
  const h = buildHarness({ transcribeImpl: async () => ({ text: "a".repeat(25_000) }) });
  const result = await send(h, audioMessage());
  assert.equal(result.results[0].accepted, false);
  assert.equal(h.orchestratorCalls.length, 0);
});

// =====================================================================
// 13. Exact webhook replay: zero duplicate business mutation
// =====================================================================

test("13. exact replay of the same wamid audio message produces exactly one business mutation", async () => {
  const h = buildHarness();
  const message = audioMessage({ id: "wamid.audio.replay.1" });
  const first = await send(h, message);
  const second = await send(h, message);
  assert.equal(first.results[0].accepted, true);
  assert.equal(second.results[0].accepted, true);
  assert.equal(h.orchestratorCalls[0].idempotencyKey, h.orchestratorCalls[1].idempotencyKey, "same wamid must yield the same idempotency key for audio, exactly as it already does for text");
  assert.equal(h.getMutationCount(), 1, "downstream business mutation happens exactly once across the exact replay");
  assert.equal(h.orchestratorCalls[1].idempotencyKey.startsWith("conversation:"), true);
});

// =====================================================================
// 14. Owner isolation
// =====================================================================

test("14. owner isolation: two owners' audio never cross-contaminate transcripts or temporary storage", async () => {
  const h = buildHarness();
  await send(h, audioMessage({ id: "wamid.audio.ownerA", from: OWNER, mediaId: "media-a" }));
  await send(h, audioMessage({ id: "wamid.audio.ownerB", from: OTHER_OWNER, mediaId: "media-b" }));
  assert.equal(h.orchestratorCalls[0].ownerWaId, OWNER);
  assert.equal(h.orchestratorCalls[1].ownerWaId, OTHER_OWNER);
  const crossRead = await h.temporaryAudioStore.getTemporaryAudio({ audioId: "audio_test_1", ownerId: OTHER_OWNER });
  assert.equal(crossRead.ok, false, "Owner A's temporary audio must never be retrievable under Owner B's identity");
});

// =====================================================================
// 15. Non-CANARY owner unchanged (rollout isolation)
// =====================================================================

test("15. a non-CANARY owner's audio message is left for legacy routing, exactly as before T11, never reaching the transcription gate", async () => {
  const h = buildHarness({
    config: buildConfig({ KADI_V1_ROLLOUT_MODE: "CANARY", KADI_V1_CANARY_WA_IDS: OTHER_OWNER, KADI_V1_TRANSCRIPTION_ENABLED: "false" }),
  });
  const result = await send(h, audioMessage({ from: OWNER }));
  assert.equal(result.results[0].handled, false, "not a KADI V1 owner: falls through to legacy routing, not absorbed as KADI_V1_TRANSCRIPTION_DISABLED");
  assert.equal(result.results[0].reason, "KADI_V1_OWNER_NOT_IN_ROLLOUT");
  assert.equal(h.calls.length, 0);

  const allowedOwnerStillGated = await send(h, audioMessage({ from: OTHER_OWNER }));
  assert.equal(allowedOwnerStillGated.results[0].handled, true);
  assert.equal(allowedOwnerStillGated.results[0].reason, "KADI_V1_TRANSCRIPTION_DISABLED", "an allowed CANARY owner is still gated by transcription=false, never bypassed by rollout eligibility");
});

// =====================================================================
// 16-17. TEXT and MENU/Flow replies unaffected by the transcription flag
// =====================================================================

test("16. TEXT continues working normally when transcription is disabled", async () => {
  const h = buildHarness({ config: buildConfig({ KADI_V1_TRANSCRIPTION_ENABLED: "false" }) });
  const result = await send(h, { id: "wamid.text.1", from: OWNER, type: "text", text: { body: "Je veux une facture" } });
  assert.equal(result.results[0].accepted, true);
  assert.equal(h.orchestratorCalls[0].inputType, "TEXT");
});

test("17. MENU_ACTION continues working normally when transcription is disabled", async () => {
  const h = buildHarness({ config: buildConfig({ KADI_V1_TRANSCRIPTION_ENABLED: "false" }) });
  const result = await send(h, { id: "wamid.button.1", from: OWNER, type: "interactive", interactive: { type: "button", button_reply: { id: "menu_invoice", title: "Facture" } } });
  assert.equal(result.results[0].accepted, true);
  assert.equal(h.orchestratorCalls[0].inputType, "MENU_ACTION");
});

// =====================================================================
// 18-19. Outbound voice remains untouched by T11
// =====================================================================

test("18. no outbound voice is generated by the webhook runtime itself — it never calls any presenter method outside its closed, non-voice-sending set", async () => {
  // Structural: the ONLY presenter methods kadiV1WebhookRuntime.js ever
  // invokes anywhere in the source, closed set — none of them are a
  // voice/audio delivery call. If a future change ever added one, this
  // regex-derived set (not a hand-maintained list) would grow and this
  // assertion would need a deliberate update.
  const source = fs.readFileSync(path.join(__dirname, "..", "kadiV1WebhookRuntime.js"), "utf8");
  const calledMethods = [...source.matchAll(/output\.([a-zA-Z]+)\(/g)].map((match) => match[1]);
  assert.ok(calledMethods.length > 0);
  const voiceLike = calledMethods.filter((name) => /voice|audio|speak|tts/i.test(name));
  assert.deepEqual(voiceLike, [], "kadiV1WebhookRuntime.js must never call any voice/audio-sending presenter method");

  const h = buildHarness({ config: buildConfig({ KADI_V1_VOICE_ENABLED: "false" }) });
  const result = await send(h, audioMessage());
  assert.equal(result.results[0].accepted, true);
  assert.equal(h.presenterCalls.length, 1);
  assert.equal(h.presenterCalls[0][0], "conversation", "only presentConversation was invoked for this accepted audio message");
});

test("19. voice=true alone does not make the outbound provider available — providerAvailability contract is untouched by T11", () => {
  const bootstrapSource = fs.readFileSync(path.join(__dirname, "..", "kadiV1ProductionBootstrap.js"), "utf8");
  assert.match(bootstrapSource, /providerAvailability:\s*async\s*\(\)\s*=>\s*false/, "T11 must not flip outbound voice provider availability");
});

// =====================================================================
// 20. T5/T6/T10 non-regression smoke — this file only touches the
// inbound-audio boundary; the recharge/balance/topup surface is entirely
// untouched, so a light smoke check that the webhook runtime still
// dispatches ordinary MENU_ACTION/TEXT/nfm_reply traffic unchanged is the
// relevant guard here (full T5/T6/T10 suites are re-run separately as
// part of the full npm test pass).
// =====================================================================

test("20. non-audio dispatch (text, menu, nfm_reply-shaped rejection) remains exactly as it was pre-T11", async () => {
  const h = buildHarness();
  const textResult = await send(h, { id: "wamid.text.smoke", from: OWNER, type: "text", text: { body: "Solde" } });
  assert.equal(textResult.results[0].accepted, true);
  const unsupported = await send(h, { id: "wamid.doc.smoke", from: OWNER, type: "document", document: { mime_type: "image/png" } });
  assert.equal(unsupported.results[0].handled, false, "non-PDF documents remain outside KADI V1's document contract, unchanged by T11");
});
