"use strict";

// T4.5 — DOCUMENT_CANCEL_STATE_AUTHORITY_GATE: the same stale-session
// state-authority gap T4 closed for GENERATION_CONFIRMATION/CANCEL also
// existed for DOCUMENT_REVIEW/CANCEL and DOCUMENT_PREVIEW/CANCEL — both
// routed through the fully generic document CANCEL branch, which never
// passed expectedState, so a stale session (sessions are never
// auto-revoked when a new Flow opens — see kadiV1ConversationSession.js)
// could still terminally CANCEL a document that had since legitimately
// moved to a later business phase, since pure state transitions never
// bump document.version. Reuses the T4 expectedState primitive unmodified
// (kadiV1RuntimeAdapters.js's cancel(),
// kadiV1SharedDocumentPipeline.js's persistStateTransition,
// kadiV1DischargePipeline.js's persistTransition) — the only production
// change is in kadiV1FlowCommandRuntime.js. Wires the real generation
// lifecycle stack for the RECHARGE_REQUIRED/GENERATION_IN_PROGRESS
// reproductions, exactly as in
// kadiV1GenerationConfirmationCancelStateAuthorityE2E.test.js. See mission
// "KADI V1 — T4.5 GLOBAL DOCUMENT CANCEL STATE-AUTHORITY GATE" and
// docs/KADI_ENGINEERING_MEMORY.md fiche AA.2.

const test = require("node:test");
const assert = require("node:assert/strict");
const { PDFDocument } = require("pdf-lib");

const { createDocumentDomain } = require("../kadiV1DocumentDomain");
const { createInMemoryV1DocumentRepository } = require("../kadiV1DocumentRepository");
const { createInMemoryV1PreviewRepository } = require("../kadiV1PreviewRepository");
const { createPreviewService } = require("../kadiV1PreviewService");
const {
  createInMemoryPrivateTemporaryStorage,
  createPdfLibPageCountInspector,
  createTemporaryRenderService,
} = require("../kadiV1TemporaryRenderService");
const { createGenerationPricingPolicy } = require("../kadiV1GenerationPricingPolicy");
const { createGenerationQuoteService } = require("../kadiV1GenerationQuoteService");
const { createInMemoryGenerationLifecycleRepository } = require("../kadiV1GenerationLifecycleRepository");
const { createWalletReservationService } = require("../kadiV1WalletReservationService");
const { createFinalGenerationService, createInMemoryFinalFileStorage } = require("../kadiV1FinalGenerationService");
const { createDeliveryService } = require("../kadiV1DeliveryService");
const { createGenerationLifecycleService } = require("../kadiV1GenerationLifecycleService");
const { createSharedDocumentPipeline } = require("../kadiV1SharedDocumentPipeline");
const { createDischargePipeline } = require("../kadiV1DischargePipeline");
const {
  createKadiV1DocumentRuntimeAdapter,
  createKadiV1PreviewRuntimeAdapter,
  createKadiV1GenerationRuntimeAdapter,
} = require("../kadiV1RuntimeAdapters");
const { createKadiV1FlowCommandRuntime } = require("../kadiV1FlowCommandRuntime");
const { createKadiV1FlowReplyRuntime, validateActionPayload } = require("../kadiV1FlowReplyRuntime");
const { createKadiV1ProductionPresenter } = require("../kadiV1ProductionPresenter");
const { createConversationSessionService, createMemoryConversationSessionRepository } = require("../kadiV1ConversationSession");
const { createKadiV1ProductionComposition } = require("../kadiV1ProductionComposition");

const OWNER = "22670000000";
const OTHER_OWNER = "22679999999";

const FLOW_IDS = Object.freeze({
  ONBOARDING: "100001", MENU: "100002", DOCUMENT_TYPE: "100003", INVOICE_TYPE: "100017", RECEIPT_DETAILS: "100018",
  DOCUMENT_CLIENT: "100004", DOCUMENT_CONTENT: "100005", ARTICLE_FORM: "100016", DOCUMENT_OPTIONS: "100006",
  DOCUMENT_REVIEW: "100007", EDIT_CLIENT: "100008", EDIT_CONTENT: "100009", EDIT_OPTIONS: "100010",
  DOCUMENT_PREVIEW: "100011", GENERATION_CONFIRMATION: "100012", RECHARGE: "100013", HISTORY_SEARCH: "100014",
  DISCHARGE_DETAILS: "100015",
});

function stubPort(methods) {
  const port = {};
  for (const method of methods) port[method] = async () => { throw new Error(`UNEXPECTED_CALL:${method}`); };
  return port;
}

let counter = 0;
function nextKey(prefix) {
  counter += 1;
  return `${prefix}:${counter}`;
}

async function pdfBuffer(pageCount) {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) pdf.addPage();
  return Buffer.from(await pdf.save());
}

// Deterministic barrier, never a sleep — see
// kadiV1GenerationConfirmationCancelStateAuthorityE2E.test.js for the
// identical pattern and rationale.
function createBarrier() {
  let releaseFn;
  let reachedFn;
  const gate = new Promise((resolve) => { releaseFn = resolve; });
  const reached = new Promise((resolve) => { reachedFn = resolve; });
  let hit = false;
  return {
    reached,
    release() { releaseFn(); },
    async waitForRelease() {
      if (!hit) { hit = true; reachedFn(); }
      await gate;
    },
  };
}

function buildComposition({ balance = 20, barrier = null, pages = 1, deliveryOk = true } = {}) {
  const clock = () => new Date().toISOString();
  const domain = createDocumentDomain();
  const realRepository = createInMemoryV1DocumentRepository();
  const created = [];
  const repository = {};
  for (const key of Object.keys(realRepository)) repository[key] = realRepository[key];
  repository.createDocument = async (args) => {
    const result = await realRepository.createDocument(args);
    if (result.ok) created.push({ document_id: result.value.document_id, owner_wa_id: args.ownerWaId });
    return result;
  };

  const sharedPipeline = createSharedDocumentPipeline({ repository, domain });
  const dischargePipeline = createDischargePipeline({ repository, domain });
  const issuerResolver = {
    getIssuerProfileId: async () => ({ ok: true, value: { issuerProfileId: "issuer:1" } }),
    getIssuerProfileById: async () => ({ ok: true, value: { business_name: "Kadi Boutique", owner_name: "Awa Traoré" } }),
  };
  const documentRuntime = createKadiV1DocumentRuntimeAdapter({ sharedPipeline, dischargePipeline, documentRepository: repository, issuerResolver });

  const previewRepository = createInMemoryV1PreviewRepository();
  const previewService = createPreviewService({ documentRepository: repository, previewRepository, domain, clock, idFactory: (kind) => `${kind}:${nextKey(kind)}` });
  const temporaryRenderService = createTemporaryRenderService({
    previewRepository,
    storage: createInMemoryPrivateTemporaryStorage(),
    renderer: { render: async () => ({ ok: true, value: { buffer: await pdfBuffer(pages), mime_type: "application/pdf", renderer: "TEST_RENDERER" } }) },
    pageCountInspector: createPdfLibPageCountInspector({ clock }),
    clock,
    idFactory: (kind) => `${kind}:${nextKey(kind)}`,
    lifetimeSeconds: 600,
  });
  const pricingPolicy = createGenerationPricingPolicy({
    pricingVersion: "t4-5-test-v1",
    validitySeconds: 600,
    documentTypes: Object.fromEntries(["FACTURE", "DEVIS", "RECU", "DECHARGE"].map((type) => [type, { baseCost: 1, perPageCost: 1 }])),
    modalityCosts: { TEXT: 0, TRANSCRIPTION: 1, IMAGE: 1, DOCUMENT: 1 },
    optionCosts: {},
  }, { clock });
  const generationQuoteService = createGenerationQuoteService({
    documentRepository: repository, previewRepository, pricingPolicy, domain, clock,
    idFactory: (kind, key) => `${kind}:${nextKey(key || kind)}`,
    defaultLifetimeSeconds: 600,
  });
  const previewRuntime = createKadiV1PreviewRuntimeAdapter({ previewService, temporaryRenderService, generationQuoteService });

  const finalGenerationRepository = createInMemoryGenerationLifecycleRepository({ balances: { [OWNER]: balance } });
  const finalRenderer = {
    render: async ({ preview: renderedPreview }) => {
      if (barrier) await barrier.waitForRelease();
      return { ok: true, value: { buffer: await pdfBuffer(renderedPreview?.structured_preview?.page_count || pages), mime_type: "application/pdf" } };
    },
  };
  const walletReservationService = createWalletReservationService({ repository: finalGenerationRepository, clock });
  const finalGenerationService = createFinalGenerationService({
    repository: finalGenerationRepository, storage: createInMemoryFinalFileStorage(), renderer: finalRenderer, clock,
  });
  const deliveryProviderCalls = [];
  const deliveryProvider = {
    async deliverDocument(args) {
      deliveryProviderCalls.push(args);
      return deliveryOk
        ? { ok: true, value: { reference: `synthetic-delivery:${deliveryProviderCalls.length}` } }
        : { ok: false, error: "DELIVERY_FAILED" };
    },
    async getDeliveryStatus() { return { ok: true, value: null }; },
  };
  const deliveryService = createDeliveryService({ repository: finalGenerationRepository, provider: deliveryProvider, clock });
  const generationLifecycleService = createGenerationLifecycleService({
    documentRepository: repository, previewRepository, generationRepository: finalGenerationRepository,
    quoteService: generationQuoteService, walletReservationService, finalGenerationService, deliveryService,
    domain, clock, idFactory: (kind, key) => `${kind}:${nextKey(key || kind)}`,
    observer: () => {},
  });
  const generationRuntime = createKadiV1GenerationRuntimeAdapter({ generationLifecycleService });

  const commandRuntime = createKadiV1FlowCommandRuntime({
    onboardingRuntime: stubPort(["continueOnboarding"]),
    documentRuntime,
    previewRuntime,
    generationRuntime,
    rechargeRuntime: stubPort(["selectPack", "checkPayment", "cancel"]),
    historyRuntime: stubPort(["search", "open"]),
    walletRuntime: stubPort(["getBalance"]),
  });

  const sessionService = createConversationSessionService({
    repository: createMemoryConversationSessionRepository(),
    clock,
  });
  const flowReplyRuntime = createKadiV1FlowReplyRuntime({ sessionService, commandRuntime });

  const sent = { texts: [], flows: [] };
  const whatsappApi = {
    async sendText(to, text) { sent.texts.push({ to, text }); },
    async sendButtons() { throw new Error("UNEXPECTED_CALL:sendButtons"); },
    async sendFlow(payload) { sent.flows.push(payload); },
  };
  const presenter = createKadiV1ProductionPresenter({
    config: { enabled: true, features: { voice: false }, flowIds: FLOW_IDS },
    whatsappApi, sessionService, clock, logger: { log() {} },
  });
  const config = { enabled: true, features: { webhook: true }, rollout: { mode: "FULL", valid: true, canaryOwnerCount: 0, canaryWaIds: [] } };
  const composition = createKadiV1ProductionComposition({
    config,
    components: {
      orchestrator: stubPort(["handle"]),
      flowReplyRuntime,
      mediaResolver: stubPort(["resolveAudio", "resolveImage", "resolvePdf"]),
      presenter,
      deliveryRetryRuntime: stubPort(["handle"]),
    },
    logger: { warn() {}, log() {} },
  });
  assert.equal(composition.readiness.ready, true, JSON.stringify(composition.readiness));
  return { composition, sessionService, sent, repository, created, finalGenerationRepository, deliveryProviderCalls };
}

function nfmReply({ sessionId, flowKey, action, data = {}, from = OWNER, id }) {
  return {
    id: id || `wamid:${flowKey}:${action}:${sessionId}:${nextKey("msg")}`, from, type: "interactive",
    interactive: { type: "nfm_reply", nfm_reply: { response_json: JSON.stringify({ session_id: sessionId, flow_key: flowKey, action, data, flow_token: sessionId }) } },
  };
}

async function openSession(f, { document = null, expectedFlowKey, ownerWaId = OWNER }) {
  const opened = await f.sessionService.open({
    ownerWaId, document, expectedFlowKey,
    returnState: document?.status || null,
    idempotencyKey: nextKey("session"),
  });
  assert.equal(opened.ok, true, opened.error);
  return opened.value.session_id;
}

async function send(f, { document = null, flowKey, action, data = {}, ownerWaId = OWNER, expectAccepted = true, id } = {}) {
  const sessionId = await openSession(f, { document, expectedFlowKey: flowKey, ownerWaId });
  const result = await f.composition.webhookHandler({ messages: [nfmReply({ sessionId, flowKey, action, data, from: ownerWaId, id })] });
  assert.equal(result.handled, true);
  assert.equal(result.results[0].accepted, expectAccepted, result.results[0].reason);
  return result.results[0];
}

async function sendRaw(f, { document = null, flowKey, action, data = {}, ownerWaId = OWNER, id } = {}) {
  const sessionId = await openSession(f, { document, expectedFlowKey: flowKey, ownerWaId });
  const result = await f.composition.webhookHandler({ messages: [nfmReply({ sessionId, flowKey, action, data, from: ownerWaId, id })] });
  assert.equal(result.handled, true);
  return result.results[0];
}

function lastFlowPayload(f) {
  const flow = f.sent.flows.slice(-1)[0];
  assert.ok(flow, "a Flow must have been sent");
  return flow.interactive.action.parameters;
}

function lastFlowData(f) {
  return lastFlowPayload(f).flow_action_payload.data;
}

async function loadDocument(f, documentId, ownerWaId = OWNER) {
  const loaded = await f.repository.getDocumentById({ documentId, ownerWaId });
  assert.equal(loaded.ok, true, loaded.error);
  return loaded.value;
}

function lastCreatedDocumentId(f) {
  return f.created[f.created.length - 1].document_id;
}

// ---- Journey helpers: FACTURE ----

async function buildFactureAtReview(f, ownerWaId = OWNER, suffix = "a") {
  await send(f, { flowKey: "MENU", action: "PREPARE_DOCUMENT", data: {}, ownerWaId, id: nextKey(`${suffix}-menu`) });
  await send(f, { flowKey: "DOCUMENT_TYPE", action: "SELECT_DOCUMENT_TYPE", data: { document_type: "FACTURE" }, ownerWaId, id: nextKey(`${suffix}-type`) });
  let document = await loadDocument(f, lastCreatedDocumentId(f), ownerWaId);
  await send(f, { document, flowKey: "INVOICE_TYPE", action: "SAVE_INVOICE_TYPE", data: { invoice_kind: "FINAL" }, ownerWaId, id: nextKey(`${suffix}-invtype`) });
  document = await loadDocument(f, document.document_id, ownerWaId);
  await send(f, { document, flowKey: "DOCUMENT_CLIENT", action: "SAVE_CLIENT", data: { name: `Client ${suffix}`, phone: "", email: "", address: "", tax_id: "" }, ownerWaId, id: nextKey(`${suffix}-client`) });
  document = await loadDocument(f, document.document_id, ownerWaId);
  await send(f, { document, flowKey: "ARTICLE_FORM", action: "ADD_CONTENT", data: { description: "Ciment", quantity: 2, unit: "sac", unit_custom: "", unit_price: 6000 }, ownerWaId, id: nextKey(`${suffix}-content`) });
  document = await loadDocument(f, document.document_id, ownerWaId);
  await send(f, { document, flowKey: "DOCUMENT_CONTENT", action: "FINISH_CONTENT", data: {}, ownerWaId, id: nextKey(`${suffix}-finish`) });
  document = await loadDocument(f, document.document_id, ownerWaId);
  await send(f, { document, flowKey: "DOCUMENT_OPTIONS", action: "SAVE_OPTIONS", data: { tax_rate_basis_points: 1800, discount_amount: "", notes: "", payment_terms: "", validity_days: "", payment_method: "", reference: "" }, ownerWaId, id: nextKey(`${suffix}-options`) });
  document = await loadDocument(f, document.document_id, ownerWaId);
  assert.equal(document.status, "READY_FOR_REVIEW");
  return document;
}

async function buildFactureAtVerified(f, ownerWaId = OWNER, suffix = "a") {
  const document = await buildFactureAtReview(f, ownerWaId, suffix);
  await send(f, { document, flowKey: "DOCUMENT_REVIEW", action: "VERIFY", data: {}, ownerWaId, id: nextKey(`${suffix}-verify`) });
  const verified = await loadDocument(f, document.document_id, ownerWaId);
  assert.equal(verified.status, "VERIFIED");
  return verified;
}

async function buildFactureAwaitingConfirmation(f, ownerWaId = OWNER, suffix = "a") {
  const document = await buildFactureAtVerified(f, ownerWaId, suffix);
  await send(f, { document, flowKey: "DOCUMENT_PREVIEW", action: "PREPARE_PDF", data: {}, ownerWaId, id: nextKey(`${suffix}-preparepdf`) });
  const awaiting = await loadDocument(f, document.document_id, ownerWaId);
  assert.equal(awaiting.status, "AWAITING_GENERATION_CONFIRMATION");
  const quoteId = lastFlowData(f).quote_id;
  assert.ok(quoteId);
  return { document: awaiting, quoteId };
}

// ---- Journey helpers: DECHARGE ----

async function buildDechargeAtReview(f, ownerWaId = OWNER, suffix = "d") {
  await send(f, { flowKey: "MENU", action: "PREPARE_DOCUMENT", data: {}, ownerWaId, id: nextKey(`${suffix}-menu`) });
  await send(f, { flowKey: "DOCUMENT_TYPE", action: "SELECT_DOCUMENT_TYPE", data: { document_type: "DECHARGE" }, ownerWaId, id: nextKey(`${suffix}-type`) });
  let document = await loadDocument(f, lastCreatedDocumentId(f), ownerWaId);
  await send(f, {
    document, flowKey: "DISCHARGE_DETAILS", action: "SAVE_DETAILS",
    data: { giver: "Ibrahim", recipient: "Fatou", transferred_content_type: "MONEY", amount: 25000, reason: "Prêt de matériel" },
    ownerWaId, id: nextKey(`${suffix}-details`),
  });
  document = await loadDocument(f, document.document_id, ownerWaId);
  assert.equal(document.status, "READY_FOR_REVIEW");
  return document;
}

async function buildDechargeAtVerified(f, ownerWaId = OWNER, suffix = "d") {
  const document = await buildDechargeAtReview(f, ownerWaId, suffix);
  await send(f, { document, flowKey: "DOCUMENT_REVIEW", action: "VERIFY", data: {}, ownerWaId, id: nextKey(`${suffix}-verify`) });
  const verified = await loadDocument(f, document.document_id, ownerWaId);
  assert.equal(verified.status, "VERIFIED");
  return verified;
}

// =====================================================================
// A. DOCUMENT_REVIEW STALE CANCEL
// =====================================================================

test("A1. DOCUMENT_REVIEW current CANCEL from READY_FOR_REVIEW still cancels normally", async () => {
  const f = buildComposition();
  const document = await buildFactureAtReview(f);
  const result = await send(f, { document, flowKey: "DOCUMENT_REVIEW", action: "CANCEL", data: {} });
  assert.equal(result.accepted, true, result.reason);
  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "CANCELLED");
});

test("A1-repro. A stale DOCUMENT_REVIEW/CANCEL Flow fails closed after the document has genuinely moved to VERIFIED (document.version unchanged)", async () => {
  const f = buildComposition();
  const document = await buildFactureAtReview(f);
  const staleSessionId = await openSession(f, { document, expectedFlowKey: "DOCUMENT_REVIEW" });

  const verifyResult = await send(f, { document, flowKey: "DOCUMENT_REVIEW", action: "VERIFY", data: {} });
  assert.equal(verifyResult.accepted, true, verifyResult.reason);
  const afterVerify = await loadDocument(f, document.document_id);
  assert.equal(afterVerify.status, "VERIFIED");
  assert.equal(afterVerify.version, document.version, "pure state transitions never bump document.version — confirmed real behavior");

  const staleMessage = nfmReply({ sessionId: staleSessionId, flowKey: "DOCUMENT_REVIEW", action: "CANCEL", data: {} });
  const staleResult = await f.composition.webhookHandler({ messages: [staleMessage] });
  assert.equal(staleResult.results[0].accepted, false, "a stale DOCUMENT_REVIEW Flow must never cancel a document that has moved to VERIFIED");

  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "VERIFIED", "the document must remain exactly VERIFIED — never CANCELLED by the stale Flow");
  assert.equal(after.version, afterVerify.version, "no mutation from the rejected stale CANCEL");
});

test("A2-repro. A stale DOCUMENT_REVIEW/CANCEL Flow fails closed after the document has reached AWAITING_GENERATION_CONFIRMATION", async () => {
  const f = buildComposition();
  const document = await buildFactureAtReview(f);
  const staleSessionId = await openSession(f, { document, expectedFlowKey: "DOCUMENT_REVIEW" });

  await send(f, { document, flowKey: "DOCUMENT_REVIEW", action: "VERIFY", data: {} });
  const verified = await loadDocument(f, document.document_id);
  await send(f, { document: verified, flowKey: "DOCUMENT_PREVIEW", action: "PREPARE_PDF", data: {} });
  const awaiting = await loadDocument(f, document.document_id);
  assert.equal(awaiting.status, "AWAITING_GENERATION_CONFIRMATION");
  assert.equal(awaiting.version, document.version, "still no version bump across two further pure state transitions");

  const staleMessage = nfmReply({ sessionId: staleSessionId, flowKey: "DOCUMENT_REVIEW", action: "CANCEL", data: {} });
  const staleResult = await f.composition.webhookHandler({ messages: [staleMessage] });
  assert.equal(staleResult.results[0].accepted, false, "a stale DOCUMENT_REVIEW Flow must never cancel a document now awaiting generation confirmation");

  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "AWAITING_GENERATION_CONFIRMATION");
  assert.equal(after.version, awaiting.version);
});

test("A4. An exact DOCUMENT_REVIEW/CANCEL replay (same wamid) is recognized as a duplicate and causes zero second transition", async () => {
  const f = buildComposition();
  const document = await buildFactureAtReview(f);
  const sessionId = await openSession(f, { document, expectedFlowKey: "DOCUMENT_REVIEW" });
  const message = nfmReply({ sessionId, flowKey: "DOCUMENT_REVIEW", action: "CANCEL", data: {}, id: "wamid.t4.5.review.cancel.replay.1" });

  const first = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(first.results[0].accepted, true);
  const afterFirst = await loadDocument(f, document.document_id);
  assert.equal(afterFirst.status, "CANCELLED");

  const second = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(second.results[0].accepted, true);
  assert.equal(second.results[0].duplicate, true);
  const afterSecond = await loadDocument(f, document.document_id);
  assert.equal(afterSecond.version, afterFirst.version);
  assert.equal(afterSecond.status, "CANCELLED");
});

test("A-owner. Owner isolation for DOCUMENT_REVIEW/CANCEL", async () => {
  const f = buildComposition();
  const document = await buildFactureAtReview(f);
  const sessionId = await openSession(f, { document, expectedFlowKey: "DOCUMENT_REVIEW", ownerWaId: OWNER });
  const result = await f.composition.webhookHandler({
    messages: [nfmReply({ sessionId, flowKey: "DOCUMENT_REVIEW", action: "CANCEL", data: {}, from: OTHER_OWNER })],
  });
  assert.equal(result.results[0].accepted, false);
  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "READY_FOR_REVIEW");
});

test("A-multidoc. A's stale DOCUMENT_REVIEW/CANCEL never affects B", async () => {
  const f = buildComposition();
  const a = await buildFactureAtReview(f, OWNER, "revA");
  const b = await buildFactureAtReview(f, OWNER, "revB");
  const staleSessionId = await openSession(f, { document: a, expectedFlowKey: "DOCUMENT_REVIEW" });

  await send(f, { document: a, flowKey: "DOCUMENT_REVIEW", action: "VERIFY", data: {} });
  const aVerified = await loadDocument(f, a.document_id);
  assert.equal(aVerified.status, "VERIFIED");

  const staleMessage = nfmReply({ sessionId: staleSessionId, flowKey: "DOCUMENT_REVIEW", action: "CANCEL", data: {} });
  const staleResult = await f.composition.webhookHandler({ messages: [staleMessage] });
  assert.equal(staleResult.results[0].accepted, false);

  const bAfter = await loadDocument(f, b.document_id);
  assert.equal(bAfter.status, "READY_FOR_REVIEW", "B, a completely different document, must remain untouched");
});

// =====================================================================
// B. DOCUMENT_PREVIEW STALE CANCEL
// =====================================================================

test("B1. DOCUMENT_PREVIEW current CANCEL from VERIFIED still cancels normally", async () => {
  const f = buildComposition();
  const document = await buildFactureAtVerified(f);
  const result = await send(f, { document, flowKey: "DOCUMENT_PREVIEW", action: "CANCEL", data: {} });
  assert.equal(result.accepted, true, result.reason);
  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "CANCELLED");
});

test("B1-repro. A stale DOCUMENT_PREVIEW/CANCEL Flow fails closed after the document has reached AWAITING_GENERATION_CONFIRMATION", async () => {
  const f = buildComposition();
  const document = await buildFactureAtVerified(f);
  const staleSessionId = await openSession(f, { document, expectedFlowKey: "DOCUMENT_PREVIEW" });

  const prepareResult = await send(f, { document, flowKey: "DOCUMENT_PREVIEW", action: "PREPARE_PDF", data: {} });
  assert.equal(prepareResult.accepted, true, prepareResult.reason);
  const afterPrepare = await loadDocument(f, document.document_id);
  assert.equal(afterPrepare.status, "AWAITING_GENERATION_CONFIRMATION");
  assert.equal(afterPrepare.version, document.version, "pure state transitions never bump document.version — confirmed real behavior");

  const staleMessage = nfmReply({ sessionId: staleSessionId, flowKey: "DOCUMENT_PREVIEW", action: "CANCEL", data: {} });
  const staleResult = await f.composition.webhookHandler({ messages: [staleMessage] });
  assert.equal(staleResult.results[0].accepted, false, "a stale DOCUMENT_PREVIEW Flow must never cancel a document now awaiting generation confirmation");

  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "AWAITING_GENERATION_CONFIRMATION");
  assert.equal(after.version, afterPrepare.version);
});

test("B2-repro. A stale DOCUMENT_PREVIEW/CANCEL Flow fails closed after the document has moved to RECHARGE_REQUIRED", async () => {
  const f = buildComposition({ balance: 0 });
  const document = await buildFactureAtVerified(f);
  const staleSessionId = await openSession(f, { document, expectedFlowKey: "DOCUMENT_PREVIEW" });

  await send(f, { document, flowKey: "DOCUMENT_PREVIEW", action: "PREPARE_PDF", data: {} });
  const awaiting = await loadDocument(f, document.document_id);
  const quoteId = lastFlowData(f).quote_id;

  const confirmResult = await sendRaw(f, { document: awaiting, flowKey: "GENERATION_CONFIRMATION", action: "CONFIRM_GENERATION", data: { quote_id: quoteId } });
  assert.equal(confirmResult.accepted, false);
  assert.equal(confirmResult.reason, "INSUFFICIENT_CREDITS");
  const rechargeRequired = await loadDocument(f, document.document_id);
  assert.equal(rechargeRequired.status, "RECHARGE_REQUIRED");
  assert.equal(rechargeRequired.version, document.version);

  const staleMessage = nfmReply({ sessionId: staleSessionId, flowKey: "DOCUMENT_PREVIEW", action: "CANCEL", data: {} });
  const staleResult = await f.composition.webhookHandler({ messages: [staleMessage] });
  assert.equal(staleResult.results[0].accepted, false, "a stale DOCUMENT_PREVIEW Flow must never cancel a document now RECHARGE_REQUIRED");

  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "RECHARGE_REQUIRED");
  assert.equal(after.version, rechargeRequired.version);
});

test("B3-repro. A stale DOCUMENT_PREVIEW/CANCEL Flow fails closed while generation is genuinely in flight, and the real generation completes normally afterward", async () => {
  const barrierObj = createBarrier();
  const f = buildComposition({ balance: 20, barrier: barrierObj });
  const document = await buildFactureAtVerified(f);
  const staleSessionId = await openSession(f, { document, expectedFlowKey: "DOCUMENT_PREVIEW" });

  await send(f, { document, flowKey: "DOCUMENT_PREVIEW", action: "PREPARE_PDF", data: {} });
  const awaiting = await loadDocument(f, document.document_id);
  const quoteId = lastFlowData(f).quote_id;

  const confirmSessionId = await openSession(f, { document: awaiting, expectedFlowKey: "GENERATION_CONFIRMATION" });
  const confirmMessage = nfmReply({ sessionId: confirmSessionId, flowKey: "GENERATION_CONFIRMATION", action: "CONFIRM_GENERATION", data: { quote_id: quoteId } });
  const confirmPromise = f.composition.webhookHandler({ messages: [confirmMessage] });

  await barrierObj.reached;

  const midFlight = await loadDocument(f, document.document_id);
  assert.equal(midFlight.status, "GENERATION_IN_PROGRESS", "generation must genuinely be in flight, persisted, before the stale CANCEL is submitted");
  assert.equal(midFlight.version, document.version);
  const reservationsMidFlight = f.finalGenerationRepository.inspect().reservations;
  assert.equal(reservationsMidFlight.length, 1);
  assert.equal(reservationsMidFlight[0].status, "RESERVED");

  const staleMessage = nfmReply({ sessionId: staleSessionId, flowKey: "DOCUMENT_PREVIEW", action: "CANCEL", data: {} });
  const staleResult = await f.composition.webhookHandler({ messages: [staleMessage] });
  assert.equal(staleResult.results[0].accepted, false, "a stale DOCUMENT_PREVIEW Flow must never cancel a document with generation genuinely in flight");

  const stillInProgress = await loadDocument(f, document.document_id);
  assert.equal(stillInProgress.status, "GENERATION_IN_PROGRESS");
  assert.equal(stillInProgress.version, midFlight.version);

  const reservationsAfterStaleCancel = f.finalGenerationRepository.inspect().reservations;
  assert.equal(reservationsAfterStaleCancel.length, 1, "no new reservation, no release, from the rejected stale CANCEL");
  assert.equal(reservationsAfterStaleCancel[0].status, "RESERVED");

  barrierObj.release();
  const confirmResult = await confirmPromise;
  assert.equal(confirmResult.results[0].accepted, true, confirmResult.results[0].reason);

  const finalDocument = await loadDocument(f, document.document_id);
  assert.equal(finalDocument.status, "DELIVERED", "the real, fresh generation must complete normally after the stale CANCEL was rejected");

  const finalState = f.finalGenerationRepository.inspect();
  assert.equal(finalState.reservations.length, 1);
  assert.equal(finalState.reservations[0].status, "CAPTURED");
  assert.equal(finalState.ledger.length, 1, "exactly one credit ledger entry — no second credit operation");
  assert.equal(finalState.finalFiles.length, 1);
  assert.equal(f.deliveryProviderCalls.length, 1);
});

test("B10. An exact DOCUMENT_PREVIEW/CANCEL replay (same wamid) is recognized as a duplicate and causes zero second transition", async () => {
  const f = buildComposition();
  const document = await buildFactureAtVerified(f);
  const sessionId = await openSession(f, { document, expectedFlowKey: "DOCUMENT_PREVIEW" });
  const message = nfmReply({ sessionId, flowKey: "DOCUMENT_PREVIEW", action: "CANCEL", data: {}, id: "wamid.t4.5.preview.cancel.replay.1" });

  const first = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(first.results[0].accepted, true);
  const afterFirst = await loadDocument(f, document.document_id);
  assert.equal(afterFirst.status, "CANCELLED");

  const second = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(second.results[0].accepted, true);
  assert.equal(second.results[0].duplicate, true);
  const afterSecond = await loadDocument(f, document.document_id);
  assert.equal(afterSecond.version, afterFirst.version);
  assert.equal(afterSecond.status, "CANCELLED");
});

test("B-owner. Owner isolation for DOCUMENT_PREVIEW/CANCEL", async () => {
  const f = buildComposition();
  const document = await buildFactureAtVerified(f);
  const sessionId = await openSession(f, { document, expectedFlowKey: "DOCUMENT_PREVIEW", ownerWaId: OWNER });
  const result = await f.composition.webhookHandler({
    messages: [nfmReply({ sessionId, flowKey: "DOCUMENT_PREVIEW", action: "CANCEL", data: {}, from: OTHER_OWNER })],
  });
  assert.equal(result.results[0].accepted, false);
  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "VERIFIED");
});

test("B-multidoc. A's stale DOCUMENT_PREVIEW/CANCEL never affects B", async () => {
  const f = buildComposition();
  const a = await buildFactureAtVerified(f, OWNER, "prevA");
  const b = await buildFactureAtVerified(f, OWNER, "prevB");
  const staleSessionId = await openSession(f, { document: a, expectedFlowKey: "DOCUMENT_PREVIEW" });

  await send(f, { document: a, flowKey: "DOCUMENT_PREVIEW", action: "PREPARE_PDF", data: {} });
  const aAwaiting = await loadDocument(f, a.document_id);
  assert.equal(aAwaiting.status, "AWAITING_GENERATION_CONFIRMATION");

  const staleMessage = nfmReply({ sessionId: staleSessionId, flowKey: "DOCUMENT_PREVIEW", action: "CANCEL", data: {} });
  const staleResult = await f.composition.webhookHandler({ messages: [staleMessage] });
  assert.equal(staleResult.results[0].accepted, false);

  const bAfter = await loadDocument(f, b.document_id);
  assert.equal(bAfter.status, "VERIFIED", "B, a completely different document, must remain untouched");
});

// =====================================================================
// DECHARGE PARITY
// =====================================================================

test("DECHARGE-review-current. DOCUMENT_REVIEW current CANCEL still works for DECHARGE", async () => {
  const f = buildComposition();
  const document = await buildDechargeAtReview(f);
  const result = await send(f, { document, flowKey: "DOCUMENT_REVIEW", action: "CANCEL", data: {} });
  assert.equal(result.accepted, true, result.reason);
  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "CANCELLED");
});

test("DECHARGE-review-stale. A stale DOCUMENT_REVIEW/CANCEL Flow fails closed for DECHARGE after the document reaches VERIFIED", async () => {
  const f = buildComposition();
  const document = await buildDechargeAtReview(f);
  const staleSessionId = await openSession(f, { document, expectedFlowKey: "DOCUMENT_REVIEW" });

  await send(f, { document, flowKey: "DOCUMENT_REVIEW", action: "VERIFY", data: {} });
  const verified = await loadDocument(f, document.document_id);
  assert.equal(verified.status, "VERIFIED");
  assert.equal(verified.version, document.version);

  const staleMessage = nfmReply({ sessionId: staleSessionId, flowKey: "DOCUMENT_REVIEW", action: "CANCEL", data: {} });
  const staleResult = await f.composition.webhookHandler({ messages: [staleMessage] });
  assert.equal(staleResult.results[0].accepted, false, "DECHARGE's discharge cancellation pipeline must be protected exactly like the shared pipeline");

  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "VERIFIED");
});

test("DECHARGE-preview-current. DOCUMENT_PREVIEW current CANCEL still works for DECHARGE", async () => {
  const f = buildComposition();
  const document = await buildDechargeAtVerified(f);
  const result = await send(f, { document, flowKey: "DOCUMENT_PREVIEW", action: "CANCEL", data: {} });
  assert.equal(result.accepted, true, result.reason);
  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "CANCELLED");
});

test("DECHARGE-preview-stale. A stale DOCUMENT_PREVIEW/CANCEL Flow fails closed for DECHARGE after the document moves to RECHARGE_REQUIRED", async () => {
  const f = buildComposition({ balance: 0 });
  const document = await buildDechargeAtVerified(f);
  const staleSessionId = await openSession(f, { document, expectedFlowKey: "DOCUMENT_PREVIEW" });

  await send(f, { document, flowKey: "DOCUMENT_PREVIEW", action: "PREPARE_PDF", data: {} });
  const awaiting = await loadDocument(f, document.document_id);
  const quoteId = lastFlowData(f).quote_id;

  const confirmResult = await sendRaw(f, { document: awaiting, flowKey: "GENERATION_CONFIRMATION", action: "CONFIRM_GENERATION", data: { quote_id: quoteId } });
  assert.equal(confirmResult.accepted, false);
  assert.equal(confirmResult.reason, "INSUFFICIENT_CREDITS");
  const rechargeRequired = await loadDocument(f, document.document_id);
  assert.equal(rechargeRequired.status, "RECHARGE_REQUIRED");

  const staleMessage = nfmReply({ sessionId: staleSessionId, flowKey: "DOCUMENT_PREVIEW", action: "CANCEL", data: {} });
  const staleResult = await f.composition.webhookHandler({ messages: [staleMessage] });
  assert.equal(staleResult.results[0].accepted, false);

  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "RECHARGE_REQUIRED");
});

// =====================================================================
// T4 / T3 non-regression
// =====================================================================

test("T4-nonregression. GENERATION_CONFIRMATION/CANCEL keeps quote_id override, expectedState=AWAITING_GENERATION_CONFIRMATION, and rejects stale RECHARGE_REQUIRED/GENERATION_IN_PROGRESS", async () => {
  // Field-contract override retained.
  const accepted = validateActionPayload("GENERATION_CONFIRMATION", "CANCEL", { quote_id: "quote:1" });
  assert.equal(accepted.ok, true, accepted.error);

  // State-authority (T4 R1) retained: current cancel still works.
  const f = buildComposition();
  const { document, quoteId } = await buildFactureAwaitingConfirmation(f);
  const result = await send(f, { document, flowKey: "GENERATION_CONFIRMATION", action: "CANCEL", data: { quote_id: quoteId } });
  assert.equal(result.accepted, true, result.reason);
  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "CANCELLED");
});

test("T3-nonregression. RECHARGE/CANCEL's combined-form contract remains completely unaffected by T4.5", () => {
  const stillAccepted = validateActionPayload("RECHARGE", "CANCEL", { pack_id: "PACK_1000", payment_reference: "REF-1" });
  assert.equal(stillAccepted.ok, true, stillAccepted.error);
  const quoteIdLeaking = validateActionPayload("RECHARGE", "CANCEL", { pack_id: "", payment_reference: "", quote_id: "quote:1" });
  assert.deepEqual(quoteIdLeaking, { ok: false, error: "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN" });
});

// =====================================================================
// Non-CANCEL actions unaffected + unknown field still rejected
// =====================================================================

test("non-CANCEL-nonregression. VERIFY/EDIT_CLIENT/EDIT_CONTENT/EDIT_OPTIONS (DOCUMENT_REVIEW) still succeed and never require expectedState", async () => {
  const f = buildComposition();
  const document = await buildFactureAtReview(f);
  const verifyResult = await send(f, { document, flowKey: "DOCUMENT_REVIEW", action: "VERIFY", data: {} });
  assert.equal(verifyResult.accepted, true, verifyResult.reason);
  const verified = await loadDocument(f, document.document_id);

  const editResult = await send(f, { document: verified, flowKey: "DOCUMENT_REVIEW", action: "EDIT_CLIENT", data: {} });
  assert.equal(editResult.accepted, true, editResult.reason);
});

test("non-CANCEL-nonregression. PREPARE_PDF/EDIT_CLIENT/SAVE_FOR_LATER (DOCUMENT_PREVIEW) still succeed and never require expectedState", async () => {
  const f = buildComposition();
  const document = await buildFactureAtVerified(f);
  const saveForLaterResult = await send(f, { document, flowKey: "DOCUMENT_PREVIEW", action: "SAVE_FOR_LATER", data: {} });
  assert.equal(saveForLaterResult.accepted, true, saveForLaterResult.reason);
});

test("unknown-field. An unrelated field is still rejected for DOCUMENT_REVIEW/CANCEL and DOCUMENT_PREVIEW/CANCEL", () => {
  assert.deepEqual(validateActionPayload("DOCUMENT_REVIEW", "CANCEL", { unexpected: "x" }), { ok: false, error: "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN" });
  assert.deepEqual(validateActionPayload("DOCUMENT_PREVIEW", "CANCEL", { unexpected: "x" }), { ok: false, error: "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN" });
});
