"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createKadiV1ProductionMediaResolver,
} = require("../kadiV1ProductionMediaResolver");
const {
  createKadiV1ProductionComposition,
  inspectKadiV1ProductionCapabilities,
} = require("../kadiV1ProductionComposition");

const OWNER = "22670000000";
const CORRELATION = "meta:abcdef1234567890";

function makeResolver(overrides = {}) {
  const calls = [];
  const whatsappApi = {
    getMediaInfo: async (mediaId) => {
      calls.push(["info", mediaId]);
      return {
        id: mediaId,
        url: `https://media.example.test/${mediaId}`,
        mime_type: overrides.mimeType || "audio/ogg",
        file_size: overrides.buffer?.length || 5,
      };
    },
    downloadMediaToBuffer: async (url) => {
      calls.push(["download", url]);
      return overrides.buffer || Buffer.from("audio");
    },
  };
  const audioValidationService = {
    ingest: async (input) => {
      calls.push(["audio_ingest", input]);
      return {
        ok: true,
        value: { audio_id: "audio_private_1" },
      };
    },
    expire: async (input) => {
      calls.push(["audio_expire", input]);
      return { ok: true, value: { status: "EXPIRED" } };
    },
  };
  const speechToTextService = {
    transcribe: async (input) => {
      calls.push(["transcribe", input]);
      return {
        transcript: "Prépare une facture",
        confidence: 0.91,
        uncertain_segments: [],
      };
    },
  };
  const mediaValidationService = {
    ingest: async (input) => {
      calls.push(["media_ingest", input]);
      return {
        ok: true,
        value: {
          media_id: "media_private_1",
          owner_ref: OWNER,
          source_type: input.sourceType,
          mime_type: input.files[0].mime_type,
          byte_size: input.files[0].buffer.length,
          checksum: "a".repeat(64),
          page_count: 1,
          correlation_id: CORRELATION,
          storage_reference:
            "temporary-private://vision/media_private_1",
          received_at: "2026-08-03T20:00:00.000Z",
          expires_at: "2026-08-03T21:00:00.000Z",
        },
      };
    },
  };

  return {
    calls,
    resolver: createKadiV1ProductionMediaResolver({
      whatsappApi: overrides.whatsappApi || whatsappApi,
      audioValidationService:
        overrides.audioValidationService ||
        audioValidationService,
      speechToTextService:
        overrides.speechToTextService ||
        speechToTextService,
      mediaValidationService:
        overrides.mediaValidationService ||
        mediaValidationService,
    }),
  };
}

test("construction is side-effect free and validates every port", () => {
  let externalCalls = 0;
  const resolver = createKadiV1ProductionMediaResolver({
    whatsappApi: {
      getMediaInfo: async () => { externalCalls += 1; },
      downloadMediaToBuffer: async () => { externalCalls += 1; },
    },
    audioValidationService: {
      ingest: async () => { externalCalls += 1; },
      expire: async () => { externalCalls += 1; },
    },
    speechToTextService: {
      transcribe: async () => { externalCalls += 1; },
    },
    mediaValidationService: {
      ingest: async () => { externalCalls += 1; },
    },
  });
  assert.equal(typeof resolver.resolveAudio, "function");
  assert.equal(typeof resolver.resolveImage, "function");
  assert.equal(typeof resolver.resolvePdf, "function");
  assert.equal(externalCalls, 0);
  assert.throws(
    () => createKadiV1ProductionMediaResolver({}),
    /KADI_V1_WHATSAPP_MEDIA_API_REQUIRED/
  );
});

test("audio is downloaded, validated, transcribed and expired", async () => {
  const buffer = Buffer.from("audio");
  const { resolver, calls } = makeResolver({ buffer });
  const result = await resolver.resolveAudio({
    ownerWaId: OWNER,
    message: {
      type: "audio",
      audio: { id: "meta_audio_1", mime_type: "audio/ogg" },
    },
    correlationId: CORRELATION,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.text, "Prépare une facture");
  assert.equal(result.value.confidence, 0.91);
  assert.equal(
    calls.map(([name]) => name).join(","),
    "info,download,audio_ingest,transcribe,audio_expire"
  );
  assert.equal(calls[2][1].ownerId, OWNER);
  assert.equal(calls[3][1].audioId, "audio_private_1");
});

test("image becomes a private validated media contract without calling Gemini", async () => {
  const buffer = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  const { resolver, calls } = makeResolver({
    buffer,
    mimeType: "image/jpeg",
  });
  const result = await resolver.resolveImage({
    ownerWaId: OWNER,
    message: {
      type: "image",
      image: { id: "meta_image_1", mime_type: "image/jpeg" },
    },
    correlationId: CORRELATION,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.media.media_id, "media_private_1");
  const ingest = calls.find(([name]) => name === "media_ingest")[1];
  assert.equal(ingest.sourceType, "IMAGE");
  assert.equal(ingest.ownerRef, OWNER);
  assert.equal(
    calls.some(([name]) => name === "transcribe"),
    false
  );
});

test("PDF keeps its filename and enters the document media path", async () => {
  const buffer = Buffer.from("%PDF-example");
  const { resolver, calls } = makeResolver({
    buffer,
    mimeType: "application/pdf",
  });
  const result = await resolver.resolvePdf({
    ownerWaId: OWNER,
    message: {
      type: "document",
      document: {
        id: "meta_pdf_1",
        mime_type: "application/pdf",
        filename: "facture-source.pdf",
      },
    },
    correlationId: CORRELATION,
  });
  assert.equal(result.ok, true);
  const ingest = calls.find(([name]) => name === "media_ingest")[1];
  assert.equal(ingest.sourceType, "PDF");
  assert.equal(ingest.files[0].filename, "facture-source.pdf");
});

test("Meta MIME mismatch and download failure stay recoverable", async () => {
  const mismatch = makeResolver({ mimeType: "image/png" }).resolver;
  const mismatchResult = await mismatch.resolveImage({
    ownerWaId: OWNER,
    message: {
      image: { id: "meta_image_2", mime_type: "image/jpeg" },
    },
    correlationId: CORRELATION,
  });
  assert.deepEqual(mismatchResult, {
    ok: false,
    error: "KADI_V1_META_MEDIA_MIME_MISMATCH",
  });

  const failed = makeResolver({
    whatsappApi: {
      getMediaInfo: async () => {
        throw new Error("private Meta details");
      },
      downloadMediaToBuffer: async () => Buffer.from("x"),
    },
  }).resolver;
  const failedResult = await failed.resolveAudio({
    ownerWaId: OWNER,
    message: { audio: { id: "meta_audio_2" } },
    correlationId: CORRELATION,
  });
  assert.deepEqual(failedResult, {
    ok: false,
    error: "KADI_V1_META_MEDIA_DOWNLOAD_FAILED",
  });
});

test("production composition derives media resolver without boot I/O", () => {
  let externalCalls = 0;
  const config = {
    enabled: true,
    features: {
      webhook: true,
      brain: true,
      vision: true,
      transcription: true,
    },
    rollout: {
      valid: true,
      mode: "CANARY",
      canary_wa_ids: [OWNER],
    },
    flowIds: {},
  };
  const components = {
    orchestrator: { handle: async () => ({}) },
    flowReplyRuntime: { handle: async () => ({}) },
    presenter: {
      presentConversation: async () => {},
      presentFlowReply: async () => {},
      presentRecoverableError: async () => {},
      presentDeliveryFailureWithRetry: async () => {},
      presentDeliveryOutcomeUnknownWithRetry: async () => {},
      presentDeliveryRetryCancelled: async () => {},
      presentDeliveryInProgress: async () => {},
      presentDeliveryRetryOutcome: async () => {},
    },
    deliveryRetryRuntime: { handle: async () => ({ ok: true, value: {} }) },
  };
  const dependencies = {
    whatsappApi: {
      getMediaInfo: async () => { externalCalls += 1; },
      downloadMediaToBuffer: async () => { externalCalls += 1; },
    },
    audioValidationService: {
      ingest: async () => { externalCalls += 1; },
      expire: async () => { externalCalls += 1; },
    },
    speechToTextService: {
      transcribe: async () => { externalCalls += 1; },
    },
    mediaValidationService: {
      ingest: async () => { externalCalls += 1; },
    },
  };

  const composition = createKadiV1ProductionComposition({
    config,
    components,
    dependencies,
    logger: null,
  });

  assert.equal(composition.readiness.ready, true);
  assert.equal(
    typeof composition.components.mediaResolver.resolveAudio,
    "function"
  );
  assert.equal(externalCalls, 0);
});

test("capability report fails closed without concrete boot composition", () => {
  const report = inspectKadiV1ProductionCapabilities();
  assert.equal(report.ready, false);
  assert.deepEqual(report.missing_capabilities, [
    "orchestrator",
    "flowReplyRuntime",
    "mediaResolver",
    "presenter",
    "deliveryRetryRuntime",
  ]);
});

test("capability report accepts concrete READY boot evidence", () => {
  const report = inspectKadiV1ProductionCapabilities({
    readiness: {
      ready: true,
      active: true,
      state: "READY",
      required_ports: {
        orchestrator: true,
        flowReplyRuntime: true,
        mediaResolver: true,
        presenter: true,
      },
      missing_ports: [],
      missing_capabilities: [],
    },
  });

  assert.equal(report.ready, true);
  assert.deepEqual(report.missing_capabilities, []);
});
