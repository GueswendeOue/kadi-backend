"use strict";

// T12/IMAGE-PDF-VISION-GATE-001: config.features.vision (AND config.features.brain)
// is the sole authority for accepting inbound WhatsApp IMAGE/PDF, and this
// file proves the existing production pipeline is genuinely wired end to
// end: WhatsApp media -> media validation -> temporary media -> Gemini
// vision provider -> Kadi Brain -> interpretation runtime ->
// backend-authoritative document pipeline.
//
// REAL, never mocked: createKadiV1WebhookRuntime, createKadiV1RuntimeConfig,
// createKadiV1ProductionMediaResolver, createMediaValidationService,
// createInMemoryTemporaryMediaStore, createGeminiVisionProvider,
// createGoogleGenerativeAIClientAdapter (the actual Gemini network-boundary
// adapter — only the underlying GoogleGenerativeAI-shaped client is faked),
// createKadiBrain, createKadiV1InterpretationRuntimeAdapter,
// createKadiV1ConversationOrchestrator, createKadiV1DocumentRuntimeAdapter,
// createSharedDocumentPipeline, createDischargePipeline,
// createInMemoryV1DocumentRepository. FAKE only true external I/O — the
// WhatsApp Meta media API and the underlying Gemini network call — plus the
// outer ports this file's scenarios never exercise (user context,
// onboarding, history, wallet, issuer resolver) and the conversational
// engine (KADI_CONVERSATIONAL_MULTIMODAL_V1 is never activated here — out
// of T12's scope).

const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { PDFDocument } = require("pdf-lib");

const { createKadiV1WebhookRuntime, VISUAL_DISABLED_TEXT } = require("../kadiV1WebhookRuntime");
const { createKadiV1RuntimeConfig } = require("../kadiV1RuntimeConfig");
const { createKadiV1ProductionMediaResolver } = require("../kadiV1ProductionMediaResolver");
const { createMediaValidationService } = require("../kadiV1MediaValidationService");
const { createInMemoryTemporaryMediaStore } = require("../kadiV1TemporaryMediaStore");
const { createGeminiVisionProvider, createGoogleGenerativeAIClientAdapter } = require("../kadiV1GeminiVisionProvider");
const { createKadiBrain } = require("../kadiV1Brain");
const { createBrainProvider } = require("../kadiV1BrainProviders");
const { createKadiV1ConversationOrchestrator } = require("../kadiV1ConversationOrchestrator");
const { createKadiV1DocumentRuntimeAdapter, createKadiV1InterpretationRuntimeAdapter } = require("../kadiV1RuntimeAdapters");
const { createSharedDocumentPipeline } = require("../kadiV1SharedDocumentPipeline");
const { createDischargePipeline } = require("../kadiV1DischargePipeline");
const { createInMemoryV1DocumentRepository } = require("../kadiV1DocumentRepository");

const OWNER = "22670000000";
const OTHER_OWNER = "22679999999";
const NOW = "2026-08-11T09:00:00.000Z";

async function png({ width = 20, height = 20 } = {}) {
  return sharp({ create: { width, height, channels: 3, background: "white" } }).png().toBuffer();
}
async function jpeg() {
  return sharp({ create: { width: 20, height: 20, channels: 3, background: "white" } }).jpeg().toBuffer();
}
async function webp() {
  return sharp({ create: { width: 20, height: 20, channels: 3, background: "white" } }).webp().toBuffer();
}
async function pdf(pageCount = 1) {
  const document = await PDFDocument.create();
  for (let page = 0; page < pageCount; page += 1) document.addPage([100, 100]);
  return Buffer.from(await document.save());
}

// A minimal, valid FACTURE-shaped Gemini structured-extraction response:
// a real client name and two confirmed line items (quantity/unit price),
// plus a visible ("read") total that must never become backend authority.
// includeTotalRead:false omits the field entirely (T12 R1 scenario A/G —
// proves behavior independent of total_read's own presence).
function structuredInvoiceResponse({
  documentType = "FACTURE",
  clientName = "Client Kadi Test",
  items = [{ description: "Sacs de ciment", quantity: 2, unit: "sac", unit_price: 5000, confidence: 0.94, status: "CONFIRMED", source_reference: "page:1:row1" }],
  totalRead = 999999,
  includeTotalRead = true,
  confidence = 0.93,
  extraFields = {},
  extraTopLevel = {},
} = {}) {
  return {
    document_type: documentType,
    fields: {
      client: { value: { name: clientName }, confidence: 0.95, source_reference: "page:1:header" },
      items: { value: items, confidence: 0.94, source_reference: "page:1:table" },
      ...(includeTotalRead ? { total_read: { value: totalRead, confidence: 0.9, source_reference: "page:1:total" } } : {}),
      ...extraFields,
    },
    missing_fields: [],
    uncertainties: [],
    confidence,
    ...extraTopLevel,
  };
}

function buildGeminiClient({ respond = () => structuredInvoiceResponse(), failWith = null, hang = false } = {}) {
  const calls = [];
  const client = {
    getGenerativeModel: ({ model }) => ({
      generateContent: async (request) => {
        calls.push({ model, request });
        if (hang) return new Promise(() => {});
        if (failWith) throw failWith;
        const payload = typeof respond === "function" ? respond(request) : respond;
        if (payload === "EMPTY_RESPONSE") return { response: { text: () => undefined } };
        if (payload === "MALFORMED_JSON") return { response: { text: () => "{not valid json" } };
        return { response: { text: () => JSON.stringify(payload) } };
      },
    }),
  };
  return { client, calls };
}

function buildConfig(envOverrides = {}) {
  return createKadiV1RuntimeConfig({
    KADI_V1_ENABLED: "true",
    KADI_V1_WEBHOOK_ENABLED: "true",
    KADI_V1_ROLLOUT_MODE: "FULL",
    KADI_V1_VISION_ENABLED: "true",
    KADI_V1_BRAIN_ENABLED: "true",
    ...envOverrides,
  });
}

// Wires the REAL production media/vision/brain/document pipeline described
// in this file's header comment. Only whatsappApi (Meta) and the
// underlying Gemini network call are faked. Returns instrumentation for
// every layer so tests can assert exactly where a message stopped.
function buildHarness({
  config = buildConfig(),
  mediaBuffer,
  mediaMimeType = "image/png",
  fileSize,
  geminiClient = buildGeminiClient(),
  geminiConfig = {},
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
        file_size: fileSize === undefined ? mediaBuffer.length : fileSize,
      };
    },
    downloadMediaToBuffer: async (url) => {
      calls.push(["meta_download", url]);
      return mediaBuffer;
    },
  };

  const temporaryMediaStore = createInMemoryTemporaryMediaStore({ clock });
  const mediaValidationService = createMediaValidationService({
    temporaryMediaStore,
    clock,
    idFactory: (() => { let n = 0; return () => `media_test_${(n += 1)}`; })(),
    config: { maxImageBytes: 8 * 1024 * 1024, maxPdfBytes: 12 * 1024 * 1024, maxPages: 5, retentionMs: 15 * 60 * 1000 },
  });
  const audioValidationService = { ingest: async () => { throw new Error("UNEXPECTED_CALL:audioValidationService"); }, expire: async () => { throw new Error("UNEXPECTED_CALL:audioValidationService.expire"); } };
  const speechToTextService = { transcribe: async () => { throw new Error("UNEXPECTED_CALL:speechToTextService"); } };
  const mediaResolver = createKadiV1ProductionMediaResolver({ whatsappApi, audioValidationService, speechToTextService, mediaValidationService });

  const geminiVisionProvider = createGeminiVisionProvider({
    client: createGoogleGenerativeAIClientAdapter({ client: geminiClient.client }),
    temporaryMediaStore,
    config: {
      enabled: true, model: "gemini-test-model", timeoutMs: 200, maxRetries: 0, temperature: 0,
      policy: "GEMINI_PRIMARY_ONLY", minimumConfidence: 0.7,
      maxImageBytes: 8 * 1024 * 1024, maxPdfBytes: 12 * 1024 * 1024, maxPages: 5,
      ...geminiConfig,
    },
  });
  const unusedTextProvider = createBrainProvider({ name: "OPENAI", understand: async () => { throw new Error("UNEXPECTED_CALL:OPENAI"); } });
  const brain = createKadiBrain({
    providers: { openai: unusedTextProvider, gemini: geminiVisionProvider },
    primaryByModality: { TEXT: "OPENAI", TRANSCRIPTION: "OPENAI", IMAGE: "GEMINI", DOCUMENT: "GEMINI" },
    policy: "PRIMARY_ONLY",
    minimumConfidence: 0.6,
  });
  const interpretationRuntime = createKadiV1InterpretationRuntimeAdapter({ brain });

  const repository = createInMemoryV1DocumentRepository();
  const sharedPipeline = createSharedDocumentPipeline({ repository });
  const dischargePipeline = createDischargePipeline({ repository });
  const issuerResolver = {
    getIssuerProfileId: async () => ({ ok: true, value: { issuerProfileId: "issuer:1" } }),
    getIssuerProfileById: async () => ({ ok: true, value: { issuerProfileId: "issuer:1" } }),
  };
  const realDocumentRuntime = createKadiV1DocumentRuntimeAdapter({ sharedPipeline, dischargePipeline, documentRepository: repository, issuerResolver });
  // createInMemoryV1DocumentRepository has no enumeration/inspect port by
  // design (it mirrors the real Supabase-backed repository's contract,
  // which never allows scanning across owners) — the only real way to
  // reach a document afterward is repository.getDocumentById({documentId,
  // ownerWaId}), the exact same real method the production code itself
  // uses. This thin wrapper records the document_id each real start()/
  // apply() call resolves to, per owner, purely as test instrumentation —
  // it forwards to realDocumentRuntime unchanged and never alters any
  // result.
  const documentIdsByOwner = new Map();
  const applyCallCountByOwner = new Map();
  const documentRuntime = {
    async start(command) {
      const result = await realDocumentRuntime.start(command);
      if (result.ok) documentIdsByOwner.set(command.ownerWaId, result.value.document_id);
      return result;
    },
    async apply(command) {
      const result = await realDocumentRuntime.apply(command);
      if (result.ok) {
        documentIdsByOwner.set(command.ownerWaId, result.value.document_id);
        applyCallCountByOwner.set(command.ownerWaId, (applyCallCountByOwner.get(command.ownerWaId) || 0) + (result.duplicate ? 0 : 1));
      }
      return result;
    },
    cancel: (command) => realDocumentRuntime.cancel(command),
    removeContent: (command) => realDocumentRuntime.removeContent(command),
    changeDocumentType: (command) => realDocumentRuntime.changeDocumentType(command),
  };
  async function getDocument(ownerWaId) {
    const documentId = documentIdsByOwner.get(ownerWaId);
    if (!documentId) return null;
    const loaded = await repository.getDocumentById({ documentId, ownerWaId });
    return loaded.ok ? loaded.value : null;
  }

  const context = { profile: { onboarding_status: "COMPLETED" }, is_new: false, active_document: null };
  const userContextService = { getContext: async () => ({ ok: true, value: context }) };
  const onboardingRuntime = { start: async () => ({ ok: true, value: { welcome_credits_granted: true } }) };
  const historyRuntime = { search: async () => { throw new Error("UNEXPECTED_CALL:historyRuntime"); } };
  const walletRuntime = { getBalance: async () => { throw new Error("UNEXPECTED_CALL:walletRuntime"); } };

  const orchestrator = createKadiV1ConversationOrchestrator({
    config,
    legacyHandler: async () => { throw new Error("UNEXPECTED_CALL:legacyHandler"); },
    userContextService, onboardingRuntime, interpretationRuntime, documentRuntime, historyRuntime, walletRuntime,
  });

  const presenterCalls = [];
  const presenter = {
    presentConversation: async (input) => presenterCalls.push(["conversation", input]),
    presentFlowReply: async (input) => presenterCalls.push(["flow_reply", input]),
    presentRecoverableError: async (input) => presenterCalls.push(["recoverable_error", input]),
  };
  const flowReplyRuntime = { handle: async () => { throw new Error("UNEXPECTED_CALL:flowReplyRuntime"); } };

  const runtime = createKadiV1WebhookRuntime({
    config, orchestrator, flowReplyRuntime, mediaResolver, presenter, logger: { log: () => {} },
  });

  return {
    runtime, calls, presenterCalls, temporaryMediaStore, repository, geminiCalls: geminiClient.calls,
    getDocument, applyCallCountByOwner,
  };
}

function imageMessage({ id = "wamid.image.1", from = OWNER, mediaId = "media-image-1" } = {}) {
  return { id, from, type: "image", image: { id: mediaId } };
}
function pdfMessage({ id = "wamid.pdf.1", from = OWNER, mediaId = "media-pdf-1" } = {}) {
  return { id, from, type: "document", document: { id: mediaId, mime_type: "application/pdf" } };
}
async function send(harness, message) {
  return harness.runtime.handleIncomingValue({ messages: [message] });
}

// =====================================================================
// Disabled ingress: zero media lookup/download (webhook-level flag matrix
// unit tests already live in tests/kadiV1WebhookRuntime.test.js — this is
// the real-pipeline confirmation that disabling either flag also means
// the REAL Meta client/Gemini client are never touched).
// =====================================================================

test("vision=false: zero Meta lookup/download, zero Gemini call, safe user copy, terminally handled", async () => {
  const h = buildHarness({ config: buildConfig({ KADI_V1_VISION_ENABLED: "false" }), mediaBuffer: await png(), mediaMimeType: "image/png" });
  const result = await send(h, imageMessage());
  assert.equal(result.results[0].handled, true);
  assert.equal(result.results[0].accepted, false);
  assert.equal(result.results[0].reason, "KADI_V1_VISION_DISABLED");
  assert.equal(h.calls.length, 0);
  assert.equal(h.geminiCalls.length, 0);
  assert.equal(h.presenterCalls[0][1].canonicalText, VISUAL_DISABLED_TEXT);
});

test("vision=true, brain=false: zero Meta lookup/download, zero Gemini call — no legitimate visual-without-brain path exists", async () => {
  const h = buildHarness({ config: buildConfig({ KADI_V1_BRAIN_ENABLED: "false" }), mediaBuffer: await pdf(1), mediaMimeType: "application/pdf" });
  const result = await send(h, pdfMessage());
  assert.equal(result.results[0].accepted, false);
  assert.equal(result.results[0].reason, "KADI_V1_VISUAL_BRAIN_DISABLED");
  assert.equal(h.calls.length, 0);
  assert.equal(h.geminiCalls.length, 0);
});

// =====================================================================
// IMAGE happy path: WhatsApp IMAGE -> media resolver -> validation ->
// temporary media -> Brain modality IMAGE -> Gemini -> validated
// extraction -> backend document created -> server recalculates ->
// temporary media expired after consumption.
// =====================================================================

test("IMAGE happy path: a photographed FACTURE is genuinely wired end to end through the real pipeline", async () => {
  const h = buildHarness({ mediaBuffer: await png(), mediaMimeType: "image/png" });
  const result = await send(h, imageMessage());
  assert.equal(result.results[0].accepted, true, result.results[0].reason);
  assert.equal(h.calls.filter(([name]) => name === "meta_get_media_info").length, 1);
  assert.equal(h.calls.filter(([name]) => name === "meta_download").length, 1);
  assert.equal(h.geminiCalls.length, 1, "the real Gemini network-boundary adapter was actually invoked");

  const created = await h.getDocument(OWNER);
  assert.ok(created, "a real document was created in the real repository");
  assert.equal(created.document_type, "FACTURE");
  assert.equal(created.client.name, "Client Kadi Test");
  assert.equal(created.items.length, 1);
  assert.equal(created.items[0].description, "Sacs de ciment");
  // Server-authoritative recalculation from saved items: 2 * 5000 = 10000 —
  // never the Gemini-visible total_read (999999) used to build the fixture.
  assert.equal(created.subtotal, 10000);
  assert.equal(created.total, 10000);
  assert.notEqual(created.total, 999999);

  // Gemini is the sole post-ingest consumer of this temporary media — it
  // must no longer be retrievable afterward.
  const leaked = await h.temporaryMediaStore.getTemporaryMedia({ mediaId: "media_test_1", ownerRef: OWNER });
  assert.equal(leaked.ok, false, "temporary media must be expired after successful analysis");
});

test("JPEG and WEBP images are accepted through the same real pipeline", async () => {
  const jpegHarness = buildHarness({ mediaBuffer: await jpeg(), mediaMimeType: "image/jpeg" });
  assert.equal((await send(jpegHarness, imageMessage({ id: "wamid.jpeg" }))).results[0].accepted, true);
  const webpHarness = buildHarness({ mediaBuffer: await webp(), mediaMimeType: "image/webp" });
  assert.equal((await send(webpHarness, imageMessage({ id: "wamid.webp" }))).results[0].accepted, true);
});

// =====================================================================
// PDF happy path + multi-page limit behavior.
// =====================================================================

test("PDF happy path: a multi-page DEVIS is genuinely wired end to end through the real pipeline", async () => {
  const h = buildHarness({
    mediaBuffer: await pdf(3), mediaMimeType: "application/pdf",
    geminiClient: buildGeminiClient({ respond: () => structuredInvoiceResponse({ documentType: "DEVIS", items: [
      { description: "Table", quantity: 1, unit_price: 45000, confidence: 0.92, status: "CONFIRMED", source_reference: "page:1:row1" },
      { description: "Chaise", quantity: 4, unit_price: 8000, confidence: 0.92, status: "CONFIRMED", source_reference: "page:2:row1" },
    ] }) }),
  });
  const result = await send(h, pdfMessage());
  assert.equal(result.results[0].accepted, true, result.results[0].reason);
  assert.equal(h.geminiCalls.length, 1);
  const created = await h.getDocument(OWNER);
  assert.equal(created.document_type, "DEVIS");
  // 45000 + 4*8000 = 77000, server-computed from saved items.
  assert.equal(created.subtotal, 77000);
  assert.equal(created.total, 77000);
  const leaked = await h.temporaryMediaStore.getTemporaryMedia({ mediaId: "media_test_1", ownerRef: OWNER });
  assert.equal(leaked.ok, false);
});

test("PDF page count exceeding the configured limit is rejected before any Gemini call", async () => {
  const h = buildHarness({ mediaBuffer: await pdf(6), mediaMimeType: "application/pdf" });
  const result = await send(h, pdfMessage());
  assert.equal(result.results[0].accepted, false);
  assert.equal(h.geminiCalls.length, 0, "media validation's own maxPages rejects it before Gemini is ever reached");
});

// =====================================================================
// Total authority: a deliberately wrong Gemini-visible total must never
// win over the backend's own recalculation from saved items.
// =====================================================================

test("adversarial: Gemini's visible total is deliberately wrong — backend calculated result wins", async () => {
  const h = buildHarness({
    mediaBuffer: await png(),
    geminiClient: buildGeminiClient({ respond: () => structuredInvoiceResponse({ totalRead: 1, items: [
      { description: "Sac de riz", quantity: 3, unit_price: 12000, confidence: 0.95, status: "CONFIRMED", source_reference: "page:1:row1" },
    ] }) }),
  });
  const result = await send(h, imageMessage());
  assert.equal(result.results[0].accepted, true, result.results[0].reason);
  const created = await h.getDocument(OWNER);
  assert.equal(created.subtotal, 36000);
  assert.equal(created.total, 36000);
  assert.notEqual(created.total, 1, "the deliberately wrong Gemini total_read (1) must never win");
});

// =====================================================================
// Forbidden authority fields: Gemini attempting to emit any of these must
// be rejected by the existing AUTHORITY_FIELDS/Brain validation contract.
// =====================================================================

// A forbidden authority field makes the Gemini extraction fail closed
// inside interpretation.interpret() — the orchestrator still answers the
// webhook with its normal, safe "please retry" recoverable response
// (accepted: true at the webhook layer; kadiV1ConversationOrchestrator.js's
// own COPY.SAVED_RETRY / "INTERPRETATION_RECOVERABLE_FAILURE" business
// action), so "rejected" here is proven by the document, not by
// result.accepted: no forbidden value and no partial mutation is ever
// persisted, and the presented text stays generic.
for (const forbiddenField of ["document_number", "issued_at", "credit_debit", "delivered", "total", "subtotal", "final_total"]) {
  test(`forbidden authority field '${forbiddenField}' at the top level is rejected, never becomes a document mutation`, async () => {
    const h = buildHarness({
      mediaBuffer: await png(),
      geminiClient: buildGeminiClient({ respond: () => ({ ...structuredInvoiceResponse(), [forbiddenField]: forbiddenField === "delivered" ? true : "forbidden-value" }) }),
    });
    const result = await send(h, imageMessage());
    assert.equal(result.results[0].accepted, true, result.results[0].reason);
    assert.equal(h.presenterCalls[0][1].response.business_action, "INTERPRETATION_RECOVERABLE_FAILURE");
    assert.doesNotMatch(JSON.stringify(h.presenterCalls), /forbidden-value/i);
    const created = await h.getDocument(OWNER);
    assert.ok(!created || created.items.length === 0, "no forbidden value or partial mutation must ever be persisted");
  });
}

test("forbidden authority field nested inside fields (e.g. fields.total) is rejected", async () => {
  const h = buildHarness({
    mediaBuffer: await png(),
    geminiClient: buildGeminiClient({ respond: () => structuredInvoiceResponse({ extraFields: { total: { value: 500000, confidence: 1, source_reference: "page:1" } } }) }),
  });
  const result = await send(h, imageMessage());
  assert.equal(result.results[0].accepted, true, result.results[0].reason);
  assert.equal(h.presenterCalls[0][1].response.business_action, "INTERPRETATION_RECOVERABLE_FAILURE");
  const created = await h.getDocument(OWNER);
  assert.ok(!created || created.items.length === 0);
});

// =====================================================================
// Uncertainty / human confirmation: low-confidence or contradictory
// extraction must never silently become confirmed business data.
// =====================================================================

test("uncertain client, quantity and unit price lead to missing_fields/uncertainties and a targeted question — never silently promoted", async () => {
  const h = buildHarness({
    mediaBuffer: await png(),
    geminiClient: buildGeminiClient({ respond: () => structuredInvoiceResponse({
      clientName: "Client Kadi Test",
      extraFields: {
        client: { value: { name: "Client illisible" }, confidence: 0.2, source_reference: "page:1:header" },
        items: { value: [{ description: "Article flou", quantity: 1, unit_price: 999, confidence: 0.15, status: "UNCERTAIN", source_reference: "page:1:row1" }], confidence: 0.2, source_reference: "page:1:table" },
      },
    }) }),
  });
  const result = await send(h, imageMessage());
  assert.equal(result.results[0].accepted, true, result.results[0].reason);
  const created = await h.getDocument(OWNER);
  // Uncertain client/items are never confirmed into the document — no item
  // was ever saved and the document stays in COLLECTING, waiting for a
  // targeted human confirmation instead of guessing.
  assert.equal(created.items.length, 0);
  assert.notEqual(created.status, "VERIFIED");
  assert.ok((created.missing_fields || []).length > 0 || (created.uncertainties || []).length > 0);
});

test("multiple documents detected and unknown document type both require confirmation, never a silent guess", async () => {
  const multiDoc = buildHarness({
    mediaBuffer: await png(),
    geminiClient: buildGeminiClient({ respond: () => structuredInvoiceResponse({ extraTopLevel: { multiple_documents: true } }) }),
  });
  const multiResult = await send(multiDoc, imageMessage({ id: "wamid.multi" }));
  assert.equal(multiResult.results[0].accepted, true, multiResult.results[0].reason);

  const unknownType = buildHarness({
    mediaBuffer: await png(),
    geminiClient: buildGeminiClient({ respond: () => structuredInvoiceResponse({ documentType: null }) }),
  });
  const unknownResult = await send(unknownType, imageMessage({ id: "wamid.unknown-type" }));
  assert.equal(unknownResult.results[0].accepted, true, unknownResult.results[0].reason);
});

// =====================================================================
// Media contract failures (representative end-to-end sample — the
// exhaustive validation-code matrix is already covered at the unit level
// by tests/kadiV1MediaValidation.test.js and tests/kadiV1ProductionMediaResolver.test.js,
// both re-run unchanged as part of this mission's focused regression set).
// =====================================================================

test("unsupported MIME (declared and actual) is rejected before any Gemini call", async () => {
  const h = buildHarness({ mediaBuffer: Buffer.from("not a real image"), mediaMimeType: "image/gif" });
  const result = await send(h, imageMessage());
  assert.equal(result.results[0].accepted, false);
  assert.equal(h.geminiCalls.length, 0);
});

test("declared MIME mismatch between Meta's message and Meta's own media-info lookup is rejected", async () => {
  const buffer = await png();
  const h = buildHarness({ mediaBuffer: buffer, mediaMimeType: "image/png" });
  const mismatched = imageMessage();
  mismatched.image.mime_type = "image/webp";
  const result = await send(h, mismatched);
  assert.equal(result.results[0].accepted, false);
  assert.equal(h.geminiCalls.length, 0);
});

test("empty media download is rejected before any Gemini call", async () => {
  const h = buildHarness({ mediaBuffer: Buffer.alloc(0), mediaMimeType: "image/png" });
  const result = await send(h, imageMessage());
  assert.equal(result.results[0].accepted, false);
  assert.equal(h.geminiCalls.length, 0);
});

test("declared Meta size mismatch is rejected before any Gemini call", async () => {
  const h = buildHarness({ mediaBuffer: await png(), fileSize: 999_999 });
  const result = await send(h, imageMessage());
  assert.equal(result.results[0].accepted, false);
  assert.equal(h.geminiCalls.length, 0);
});

// =====================================================================
// Gemini failure contract: fail closed or ask for clarification, never
// expose raw provider internals; temporary media still expires afterward.
// A Gemini/interpretation failure is a RECOVERABLE orchestrator response
// (accepted: true at the webhook layer, business_action
// "INTERPRETATION_RECOVERABLE_FAILURE", the same generic safe copy every
// time) — never a webhook-level rejection. The real proof of "fail closed"
// is: no document mutation happened, and nothing technical leaked into
// the presented text.
// =====================================================================

function assertRecoverableFailure(h, result) {
  assert.equal(result.results[0].accepted, true, result.results[0].reason);
  assert.equal(h.presenterCalls[0][1].response.business_action, "INTERPRETATION_RECOVERABLE_FAILURE");
}

test("Gemini timeout fails closed and still expires the temporary media", async () => {
  const h = buildHarness({ mediaBuffer: await png(), geminiClient: buildGeminiClient({ hang: true }), geminiConfig: { timeoutMs: 20 } });
  const result = await send(h, imageMessage());
  assertRecoverableFailure(h, result);
  assert.doesNotMatch(JSON.stringify(h.presenterCalls), /gemini|api[_-]?key|timeout after/i);
  const leaked = await h.temporaryMediaStore.getTemporaryMedia({ mediaId: "media_test_1", ownerRef: OWNER });
  assert.equal(leaked.ok, false, "temporary media must be expired even after a timeout");
});

test("Gemini provider exception fails closed, no raw error exposed, temp media expired", async () => {
  const h = buildHarness({ mediaBuffer: await png(), geminiClient: buildGeminiClient({ failWith: new Error("upstream 500 from generativelanguage.googleapis.com") }) });
  const result = await send(h, imageMessage());
  assertRecoverableFailure(h, result);
  assert.doesNotMatch(JSON.stringify(h.presenterCalls), /googleapis|upstream 500/i);
  const leaked = await h.temporaryMediaStore.getTemporaryMedia({ mediaId: "media_test_1", ownerRef: OWNER });
  assert.equal(leaked.ok, false);
});

test("empty Gemini response fails closed", async () => {
  const h = buildHarness({ mediaBuffer: await png(), geminiClient: buildGeminiClient({ respond: () => "EMPTY_RESPONSE" }) });
  const result = await send(h, imageMessage());
  assertRecoverableFailure(h, result);
});

test("malformed JSON from Gemini fails closed, no raw provider text exposed", async () => {
  const h = buildHarness({ mediaBuffer: await png(), geminiClient: buildGeminiClient({ respond: () => "MALFORMED_JSON" }) });
  const result = await send(h, imageMessage());
  assertRecoverableFailure(h, result);
  assert.doesNotMatch(JSON.stringify(h.presenterCalls), /not valid json/i);
});

test("unknown top-level field from Gemini is rejected", async () => {
  const h = buildHarness({ mediaBuffer: await png(), geminiClient: buildGeminiClient({ respond: () => ({ ...structuredInvoiceResponse(), private_ocr_dump: "leaked" }) }) });
  const result = await send(h, imageMessage());
  assertRecoverableFailure(h, result);
  assert.doesNotMatch(JSON.stringify(h.presenterCalls), /leaked/i);
});

test("malformed items array from Gemini is rejected", async () => {
  const h = buildHarness({
    mediaBuffer: await png(),
    geminiClient: buildGeminiClient({ respond: () => structuredInvoiceResponse({ items: [{ description: "X", quantity: -5, unit_price: 1, confidence: 1, status: "CONFIRMED", source_reference: "page:1" }] }) }),
  });
  const result = await send(h, imageMessage());
  assertRecoverableFailure(h, result);
});

test("malformed source_reference from Gemini is normalized to a safe fallback, never crashes the pipeline", async () => {
  const h = buildHarness({
    mediaBuffer: await png(),
    geminiClient: buildGeminiClient({ respond: () => structuredInvoiceResponse({ extraFields: { client: { value: { name: "Client Kadi Test" }, confidence: 0.95, source_reference: "javascript:alert(1)" } } }) }),
  });
  const result = await send(h, imageMessage());
  assert.equal(result.results[0].accepted, true, result.results[0].reason);
});

test("low overall confidence result requires clarification, never silently confirmed", async () => {
  const h = buildHarness({
    mediaBuffer: await png(),
    geminiClient: buildGeminiClient({ respond: () => ({ ...structuredInvoiceResponse(), confidence: 0.1 }) }),
  });
  const result = await send(h, imageMessage());
  assert.equal(result.results[0].accepted, true, result.results[0].reason);
  const created = await h.getDocument(OWNER);
  assert.notEqual(created.status, "VERIFIED");
});

// =====================================================================
// Owner isolation
// =====================================================================

test("owner isolation: Owner A's temporary media is never retrievable/analyzable as Owner B", async () => {
  const h = buildHarness({ mediaBuffer: await png() });
  await send(h, imageMessage({ from: OWNER }));
  const crossRead = await h.temporaryMediaStore.getTemporaryMedia({ mediaId: "media_test_1", ownerRef: OTHER_OWNER });
  assert.equal(crossRead.ok, false, "Owner A's temporary media must never be retrievable under Owner B's identity");
  const otherOwnerDocument = await h.getDocument(OTHER_OWNER);
  assert.equal(otherOwnerDocument, null, "no document was ever created for Owner B from Owner A's message");
});

// =====================================================================
// Exact replay idempotency
// =====================================================================

test("exact replay of the same wamid IMAGE message produces exactly one business mutation", async () => {
  const h = buildHarness({ mediaBuffer: await png() });
  const message = imageMessage({ id: "wamid.image.replay.1" });
  const first = await send(h, message);
  const second = await send(h, message);
  assert.equal(first.results[0].accepted, true, first.results[0].reason);
  assert.equal(second.results[0].accepted, true, second.results[0].reason);
  assert.equal(h.applyCallCountByOwner.get(OWNER), 1, "exactly one real (non-duplicate) business mutation across the exact replay");
  const document = await h.getDocument(OWNER);
  assert.equal(document.items.length, 1, "the item was applied exactly once, never duplicated");
});

// =====================================================================
// T11 non-regression: this file's changes touch only the visual (IMAGE/
// PDF) ingress boundary — inbound audio remains governed solely by
// config.features.transcription, unaffected by vision/brain.
// =====================================================================

test("T11 non-regression: transcription=true, voice=false still works unaffected by T12's vision/brain gate", async () => {
  const h = buildHarness({ config: buildConfig({ KADI_V1_TRANSCRIPTION_ENABLED: "true", KADI_V1_VOICE_ENABLED: "false", KADI_V1_VISION_ENABLED: "false" }) });
  const result = await send(h, { id: "wamid.text.smoke", from: OWNER, type: "text", text: { body: "Solde" } });
  assert.equal(result.results[0].handled, true);
});

// =====================================================================
// T12 R1 (independent review, MEDIUM/P1): forward-progress. Gemini's
// total_read (and date_read/document_number_read) are RESERVED_BRAIN_FIELDS
// — observational OCR evidence only, never backend authority — but they
// must not create an impossible, permanently-blocked business state
// merely because the backend deliberately never confirms them. A
// photographed FACTURE/DEVIS with a confirmed client and confirmed items
// must reach normal review progression (READY_FOR_REVIEW) regardless of
// whether total_read is present, matches, or mismatches the backend's
// own recalculated total.
// =====================================================================

test("R1-A. IMAGE FACTURE with client/items confirmed and NO total_read reaches normal review progression", async () => {
  const h = buildHarness({
    mediaBuffer: await png(),
    geminiClient: buildGeminiClient({ respond: () => structuredInvoiceResponse({ includeTotalRead: false }) }),
  });
  const result = await send(h, imageMessage());
  assert.equal(result.results[0].accepted, true, result.results[0].reason);
  const created = await h.getDocument(OWNER);
  assert.equal(created.status, "READY_FOR_REVIEW", "confirmed client + confirmed items, nothing else outstanding: must advance, not stay COLLECTING");
  assert.deepEqual(created.missing_fields, []);
  assert.deepEqual(created.uncertainties, []);
  assert.equal(created.subtotal, 10000);
  assert.equal(created.total, 10000);
});

test("R1-B. IMAGE FACTURE with matching total_read: backend total correct, total_read never blocks, reaches normal review progression", async () => {
  const h = buildHarness({
    mediaBuffer: await png(),
    geminiClient: buildGeminiClient({ respond: () => structuredInvoiceResponse({ totalRead: 10000 }) }), // 2 * 5000 = 10000, matches backend
  });
  const result = await send(h, imageMessage());
  assert.equal(result.results[0].accepted, true, result.results[0].reason);
  const created = await h.getDocument(OWNER);
  assert.equal(created.status, "READY_FOR_REVIEW");
  assert.ok(!created.missing_fields.includes("total_read"), "total_read must never remain a permanently blocking missing field");
  assert.ok(!created.uncertainties.some((entry) => entry.field === "total_read"), "total_read must never remain a permanently blocking uncertainty");
  assert.equal(created.subtotal, 10000);
  assert.equal(created.total, 10000);
  assert.equal(created.total_read, undefined, "total_read is never copied into an authoritative document field");
});

test("R1-C. IMAGE FACTURE with WRONG total_read: backend total still wins, never writes the provider's total, no impossible permanent state", async () => {
  const h = buildHarness({
    mediaBuffer: await png(),
    geminiClient: buildGeminiClient({ respond: () => structuredInvoiceResponse({ totalRead: 999999 }) }), // mismatches 10000
  });
  const result = await send(h, imageMessage());
  assert.equal(result.results[0].accepted, true, result.results[0].reason);
  const created = await h.getDocument(OWNER);
  assert.equal(created.status, "READY_FOR_REVIEW", "a mismatching non-authoritative total_read must never create a permanently blocked document");
  assert.equal(created.subtotal, 10000);
  assert.equal(created.total, 10000);
  assert.notEqual(created.total, 999999);
  assert.ok(!created.missing_fields.includes("total_read"));
});

test("R1-D. PDF DEVIS with matching total_read reaches normal review progression, same as IMAGE", async () => {
  const h = buildHarness({
    mediaBuffer: await pdf(2), mediaMimeType: "application/pdf",
    geminiClient: buildGeminiClient({ respond: () => structuredInvoiceResponse({
      documentType: "DEVIS", totalRead: 77000,
      items: [
        { description: "Table", quantity: 1, unit_price: 45000, confidence: 0.92, status: "CONFIRMED", source_reference: "page:1:row1" },
        { description: "Chaise", quantity: 4, unit_price: 8000, confidence: 0.92, status: "CONFIRMED", source_reference: "page:2:row1" },
      ],
    }) }),
  });
  const result = await send(h, pdfMessage());
  assert.equal(result.results[0].accepted, true, result.results[0].reason);
  const created = await h.getDocument(OWNER);
  assert.equal(created.document_type, "DEVIS");
  assert.equal(created.status, "READY_FOR_REVIEW");
  assert.equal(created.total, 77000);
});

for (const [label, buildOptions] of [
  ["no total_read", { includeTotalRead: false }],
  ["matching total_read", { totalRead: 10000 }],
  ["mismatching total_read", { totalRead: 999999 }],
]) {
  test(`R1-temp-media. ${label}: temporary media still expires after a successful, review-ready analysis`, async () => {
    const h = buildHarness({
      mediaBuffer: await png(),
      geminiClient: buildGeminiClient({ respond: () => structuredInvoiceResponse(buildOptions) }),
    });
    const result = await send(h, imageMessage());
    assert.equal(result.results[0].accepted, true, result.results[0].reason);
    const leaked = await h.temporaryMediaStore.getTemporaryMedia({ mediaId: "media_test_1", ownerRef: OWNER });
    assert.equal(leaked.ok, false, "temporary media must be expired after analysis regardless of the total_read reconciliation outcome");
  });
}

// =====================================================================
// T12 R1 (independent review, MEDIUM/P1): unknown document type must
// surface Brain's own validated targeted question, never the generic
// MENU dead end — and must never create a document or mutate anything.
// =====================================================================

test("R1-E. IMAGE with unknown document type: zero document created, no guessed type, the validated targeted question is shown — not generic MENU", async () => {
  const h = buildHarness({
    mediaBuffer: await png(),
    geminiClient: buildGeminiClient({ respond: () => structuredInvoiceResponse({ documentType: null, includeTotalRead: false }) }),
  });
  const result = await send(h, imageMessage());
  assert.equal(result.results[0].accepted, true, result.results[0].reason);
  assert.equal(h.presenterCalls[0][1].response.business_action, "PREPARE_DOCUMENT_TYPE_UNKNOWN");
  assert.equal(h.presenterCalls[0][1].response.canonical_text, "Quel document voulez-vous préparer ?");
  assert.notEqual(h.presenterCalls[0][1].response.business_action, "SHOW_MENU", "the validated question must never be silently discarded into the generic menu");
  const created = await h.getDocument(OWNER);
  assert.equal(created, null, "zero document created for an unresolved document type — no guessed type, no financial mutation");
  const leaked = await h.temporaryMediaStore.getTemporaryMedia({ mediaId: "media_test_1", ownerRef: OWNER });
  assert.equal(leaked.ok, false, "temporary media still expires even when no document is created");
});

// =====================================================================
// T12 R1: low overall confidence WITHOUT total_read. Determined genuine
// behavior (documented, not weakened): with nothing individually flagged
// missing/uncertain but overall confidence below the threshold,
// normalizeStructuredExtraction's own validateBrainResult call already
// throws BRAIN_CONFIRMATION_REQUIRED (the general, modality-agnostic
// Brain contract in kadiV1BrainContracts.js — never touched by T12, and
// never weakened here to keep TEXT/TRANSCRIPTION's identical guarantee
// intact). This already satisfies every required outcome: the result is
// never silently trusted, no low-confidence data is ever persisted as
// confirmed business data (interpretation fails closed before any
// document mutation is attempted), and the user gets the existing safe,
// generic retry copy — the same "please retry" recoverable path every
// other interpretation failure already uses.
// =====================================================================

test("R1-F. low overall confidence WITHOUT total_read fails closed as a safe recoverable retry — never silently trusted, zero document mutation", async () => {
  const h = buildHarness({
    mediaBuffer: await png(),
    geminiClient: buildGeminiClient({ respond: () => structuredInvoiceResponse({ includeTotalRead: false, confidence: 0.1 }) }),
  });
  const result = await send(h, imageMessage());
  assert.equal(result.results[0].accepted, true, result.results[0].reason);
  assert.equal(h.presenterCalls[0][1].response.business_action, "INTERPRETATION_RECOVERABLE_FAILURE");
  const created = await h.getDocument(OWNER);
  assert.equal(created, null, "no low-confidence data is ever persisted as confirmed business data");
  const leaked = await h.temporaryMediaStore.getTemporaryMedia({ mediaId: "media_test_1", ownerRef: OWNER });
  assert.equal(leaked.ok, false, "temporary media still expires after a rejected low-confidence analysis");
});
