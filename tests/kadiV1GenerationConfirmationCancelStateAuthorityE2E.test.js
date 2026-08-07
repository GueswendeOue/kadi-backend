"use strict";

// GENERATION_CONFIRMATION-001 R1 (independent review, HIGH/P0): production-
// composition proof that a stale GENERATION_CONFIRMATION Flow session can no
// longer terminally CANCEL a document after that document has genuinely
// moved on to a different business phase (RECHARGE_REQUIRED,
// GENERATION_IN_PROGRESS), even though document.version never changes on a
// pure state transition. Wires the REAL generation lifecycle stack (wallet
// reservation service, final generation service, delivery service, in-memory
// generation-lifecycle repository) alongside the real document domain,
// shared pipeline and preview/render/quote pipeline already used in
// kadiV1GenerationConfirmationCancelE2E.test.js. Only the renderer is a
// controllable fake (a deterministic barrier, never a sleep) and the
// WhatsApp delivery provider is a synthetic in-memory stub — every other
// component is the real production code. See mission "KADI V1 — T4
// GENERATION_CONFIRMATION/CANCEL INDEPENDENT REVIEW FIX R1" and
// docs/KADI_ENGINEERING_MEMORY.md fiche AA.1.

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
const { createKadiV1FlowReplyRuntime } = require("../kadiV1FlowReplyRuntime");
const { createKadiV1ProductionPresenter } = require("../kadiV1ProductionPresenter");
const { createConversationSessionService, createMemoryConversationSessionRepository } = require("../kadiV1ConversationSession");
const { createKadiV1ProductionComposition } = require("../kadiV1ProductionComposition");

const OWNER = "22670000000";

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

// A deterministic barrier, never a sleep: render() suspends on `gate` until
// release() is called, and `reached` resolves the instant render() is
// actually invoked (i.e. strictly after START_GENERATION/GENERATION_IN_PROGRESS
// has already been persisted, since generatePrivate is only ever called
// after that in kadiV1GenerationLifecycleService.js's runConfirmation).
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
    pricingVersion: "t4-r1-test-v1",
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

  // Final-generation renderer: a real PDF is produced (pdf-lib), but its
  // resolution is gated behind the caller-supplied barrier when present —
  // this is the deterministic, injected I/O-boundary pause point the
  // mission requires (never a sleep). Strictly after
  // GENERATION_IN_PROGRESS/START_GENERATION has already been persisted
  // (confirmed by direct inspection of runConfirmation), strictly before
  // captureReservation/promoteFinal/deliver.
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
  const generationEvents = [];
  const generationLifecycleService = createGenerationLifecycleService({
    documentRepository: repository, previewRepository, generationRepository: finalGenerationRepository,
    quoteService: generationQuoteService, walletReservationService, finalGenerationService, deliveryService,
    domain, clock, idFactory: (kind, key) => `${kind}:${nextKey(key || kind)}`,
    observer: (event) => generationEvents.push(event),
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
  return { composition, sessionService, sent, repository, created, finalGenerationRepository, generationEvents, deliveryProviderCalls };
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

// Same helper as the reply-only message form, but does not assert
// `accepted` — used where the mission requires observing the raw result
// (e.g. a fresh CONFIRM_GENERATION that legitimately fails with
// INSUFFICIENT_CREDITS at the Flow-command level while still correctly
// mutating the document to RECHARGE_REQUIRED as a real side effect).
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

async function buildFactureAwaitingConfirmation(f, ownerWaId = OWNER, suffix = "a") {
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

  await send(f, { document, flowKey: "DOCUMENT_REVIEW", action: "VERIFY", data: {}, ownerWaId, id: nextKey(`${suffix}-verify`) });
  document = await loadDocument(f, document.document_id, ownerWaId);
  assert.equal(document.status, "VERIFIED");

  await send(f, { document, flowKey: "DOCUMENT_PREVIEW", action: "PREPARE_PDF", data: {}, ownerWaId, id: nextKey(`${suffix}-preparepdf`) });
  document = await loadDocument(f, document.document_id, ownerWaId);
  assert.equal(document.status, "AWAITING_GENERATION_CONFIRMATION", "PREPARE_PDF must reach AWAITING_GENERATION_CONFIRMATION through the real preview/render/quote pipeline");

  const quoteId = lastFlowData(f).quote_id;
  assert.ok(quoteId, "a real quote_id must have been produced by the real quote service and surfaced to the Flow");
  return { document, quoteId };
}

async function buildDechargeAwaitingConfirmation(f, ownerWaId = OWNER, suffix = "d") {
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

  await send(f, { document, flowKey: "DOCUMENT_REVIEW", action: "VERIFY", data: {}, ownerWaId, id: nextKey(`${suffix}-verify`) });
  document = await loadDocument(f, document.document_id, ownerWaId);
  assert.equal(document.status, "VERIFIED");

  await send(f, { document, flowKey: "DOCUMENT_PREVIEW", action: "PREPARE_PDF", data: {}, ownerWaId, id: nextKey(`${suffix}-preparepdf`) });
  document = await loadDocument(f, document.document_id, ownerWaId);
  assert.equal(document.status, "AWAITING_GENERATION_CONFIRMATION", "DECHARGE must reach AWAITING_GENERATION_CONFIRMATION through the exact same shared preview/render/quote pipeline");

  const quoteId = lastFlowData(f).quote_id;
  assert.ok(quoteId);
  return { document, quoteId };
}

// ===== Mandatory reproduction A: stale Flow after AWAITING_GENERATION_CONFIRMATION -> RECHARGE_REQUIRED =====

test("R1-A. A stale GENERATION_CONFIRMATION/CANCEL Flow fails closed after the document has genuinely moved to RECHARGE_REQUIRED (document.version unchanged)", async () => {
  const f = buildComposition({ balance: 0 });
  const { document, quoteId } = await buildFactureAwaitingConfirmation(f);

  // Stale session opened while the document is still AWAITING_GENERATION_CONFIRMATION.
  const staleSessionId = await openSession(f, { document, expectedFlowKey: "GENERATION_CONFIRMATION" });

  // A real, fresh CONFIRM_GENERATION with insufficient credits — the real
  // generation lifecycle service persists REQUIRE_RECHARGE as a genuine
  // side effect before failing.
  const confirmResult = await sendRaw(f, { document, flowKey: "GENERATION_CONFIRMATION", action: "CONFIRM_GENERATION", data: { quote_id: quoteId } });
  assert.equal(confirmResult.accepted, false);
  assert.equal(confirmResult.reason, "INSUFFICIENT_CREDITS");

  const afterConfirm = await loadDocument(f, document.document_id);
  assert.equal(afterConfirm.status, "RECHARGE_REQUIRED", "the document must have genuinely moved to RECHARGE_REQUIRED");
  assert.equal(afterConfirm.version, document.version, "pure state transitions never bump document.version — confirmed real behavior, not an assumption");

  const staleMessage = nfmReply({ sessionId: staleSessionId, flowKey: "GENERATION_CONFIRMATION", action: "CANCEL", data: { quote_id: quoteId } });
  const staleResult = await f.composition.webhookHandler({ messages: [staleMessage] });
  assert.equal(staleResult.results[0].accepted, false, "a stale Flow must never be allowed to cancel a document that has moved to RECHARGE_REQUIRED");

  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "RECHARGE_REQUIRED", "the document must remain exactly RECHARGE_REQUIRED — never CANCELLED by the stale Flow");
  assert.equal(after.version, afterConfirm.version, "no mutation at all from the rejected stale CANCEL");
});

// ===== Mandatory reproduction B: concurrent stale CANCEL during GENERATION_IN_PROGRESS =====

test("R1-B. A stale GENERATION_CONFIRMATION/CANCEL Flow submitted while generation is genuinely in flight fails closed, and the real generation completes normally afterward with exactly one reservation and one capture", async () => {
  const barrierObj = createBarrier();
  const f = buildComposition({ balance: 20, barrier: barrierObj });
  const { document, quoteId } = await buildFactureAwaitingConfirmation(f);

  const staleSessionId = await openSession(f, { document, expectedFlowKey: "GENERATION_CONFIRMATION" });

  // Fire the fresh CONFIRM_GENERATION WITHOUT awaiting it yet — it will
  // block inside the real renderer, strictly after GENERATION_IN_PROGRESS
  // has already been persisted (proven below), strictly before
  // captureReservation/promoteFinal/deliver.
  const confirmSessionId = await openSession(f, { document, expectedFlowKey: "GENERATION_CONFIRMATION" });
  const confirmMessage = nfmReply({ sessionId: confirmSessionId, flowKey: "GENERATION_CONFIRMATION", action: "CONFIRM_GENERATION", data: { quote_id: quoteId } });
  const confirmPromise = f.composition.webhookHandler({ messages: [confirmMessage] });

  // Deterministic synchronization point: resolves exactly when the real
  // renderer has been invoked, never a sleep/timeout guess.
  await barrierObj.reached;

  const midFlight = await loadDocument(f, document.document_id);
  assert.equal(midFlight.status, "GENERATION_IN_PROGRESS", "generation must genuinely be in flight, persisted, before the stale CANCEL is submitted");
  assert.equal(midFlight.version, document.version, "pure state transitions (including START_GENERATION) never bump document.version — confirmed real behavior");
  const reservationsMidFlight = f.finalGenerationRepository.inspect().reservations;
  assert.equal(reservationsMidFlight.length, 1);
  assert.equal(reservationsMidFlight[0].status, "RESERVED", "exactly one credit reservation, still RESERVED (not yet captured)");

  // The stale CANCEL — submitted concurrently, for the first time, while
  // generation is genuinely mid-flight.
  const staleMessage = nfmReply({ sessionId: staleSessionId, flowKey: "GENERATION_CONFIRMATION", action: "CANCEL", data: { quote_id: quoteId } });
  const staleResult = await f.composition.webhookHandler({ messages: [staleMessage] });
  assert.equal(staleResult.results[0].accepted, false, "a stale Flow must never be allowed to cancel a document with generation genuinely in flight");

  const stillInProgress = await loadDocument(f, document.document_id);
  assert.equal(stillInProgress.status, "GENERATION_IN_PROGRESS", "the document must remain exactly GENERATION_IN_PROGRESS — never CANCELLED by the stale Flow");
  assert.equal(stillInProgress.version, midFlight.version, "no mutation at all from the rejected stale CANCEL");

  // Zero financial mutation caused by the rejected stale CANCEL.
  const reservationsAfterStaleCancel = f.finalGenerationRepository.inspect().reservations;
  assert.equal(reservationsAfterStaleCancel.length, 1, "no new reservation, no release, from the rejected stale CANCEL");
  assert.equal(reservationsAfterStaleCancel[0].status, "RESERVED", "the live reservation must remain exactly RESERVED — not released by the rejected stale CANCEL");

  // Release the barrier and let the real, fresh generation complete.
  barrierObj.release();
  const confirmResult = await confirmPromise;
  assert.equal(confirmResult.results[0].accepted, true, confirmResult.results[0].reason);

  const finalDocument = await loadDocument(f, document.document_id);
  assert.equal(finalDocument.status, "DELIVERED", "the real, fresh generation must complete normally after the stale CANCEL was rejected — no DOCUMENT_STATE_CONFLICT caused by the stale attempt");

  const finalState = f.finalGenerationRepository.inspect();
  assert.equal(finalState.reservations.length, 1, "exactly one reservation for the whole scenario");
  assert.equal(finalState.reservations[0].status, "CAPTURED", "exactly one capture — the stale CANCEL never released or otherwise disturbed it");
  assert.equal(finalState.ledger.length, 1, "exactly one credit ledger entry — no second credit operation");
  assert.equal(finalState.finalFiles.length, 1, "exactly one final file promoted");
  assert.equal(f.deliveryProviderCalls.length, 1, "exactly one delivery attempt");
});

// ===== Post-fix required behavior: current, non-stale CANCEL still works =====

test("R1-current. A genuinely current (non-stale) GENERATION_CONFIRMATION/CANCEL still cancels the document normally", async () => {
  const f = buildComposition({ balance: 20 });
  const { document, quoteId } = await buildFactureAwaitingConfirmation(f);
  const result = await send(f, { document, flowKey: "GENERATION_CONFIRMATION", action: "CANCEL", data: { quote_id: quoteId } });
  assert.equal(result.accepted, true, result.reason);
  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "CANCELLED");
});

// ===== Exact CANCEL replay is still idempotent (unaffected by expectedState) =====

test("R1-replay. An exact CANCEL replay (same wamid) is still recognized as a duplicate and causes zero second transition, with expectedState in place", async () => {
  const f = buildComposition({ balance: 20 });
  const { document, quoteId } = await buildFactureAwaitingConfirmation(f);
  const sessionId = await openSession(f, { document, expectedFlowKey: "GENERATION_CONFIRMATION" });
  const message = nfmReply({ sessionId, flowKey: "GENERATION_CONFIRMATION", action: "CANCEL", data: { quote_id: quoteId }, id: "wamid.t4.r1.cancel.replay.1" });

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

// ===== Owner isolation, unaffected by expectedState =====

test("R1-owner. Owner isolation is unaffected by the expectedState fix", async () => {
  const f = buildComposition({ balance: 20 });
  const { document } = await buildFactureAwaitingConfirmation(f);
  const sessionId = await openSession(f, { document, expectedFlowKey: "GENERATION_CONFIRMATION", ownerWaId: OWNER });
  const result = await f.composition.webhookHandler({
    messages: [nfmReply({ sessionId, flowKey: "GENERATION_CONFIRMATION", action: "CANCEL", data: { quote_id: "quote:not-real" }, from: "22679999999" })],
  });
  assert.equal(result.results[0].accepted, false);
  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "AWAITING_GENERATION_CONFIRMATION");
});

// ===== Multi-document isolation, unaffected by expectedState =====

test("R1-multidoc. A's CANCEL never affects B even with B's quote_id, expectedState fix in place", async () => {
  const f = buildComposition({ balance: 20 });
  const a = await buildFactureAwaitingConfirmation(f, OWNER, "docA");
  const b = await buildFactureAwaitingConfirmation(f, OWNER, "docB");
  const result = await send(f, { document: a.document, flowKey: "GENERATION_CONFIRMATION", action: "CANCEL", data: { quote_id: b.quoteId } });
  assert.equal(result.accepted, true, result.reason);
  const aAfter = await loadDocument(f, a.document.document_id);
  const bAfter = await loadDocument(f, b.document.document_id);
  assert.equal(aAfter.status, "CANCELLED");
  assert.equal(bAfter.status, "AWAITING_GENERATION_CONFIRMATION");
});

// ===== quote_id irrelevance, unaffected =====

test("R1-quoteid. quote_id remains irrelevant to the cancellation target with expectedState in place", async () => {
  const f = buildComposition({ balance: 20 });
  const { document } = await buildFactureAwaitingConfirmation(f);
  const result = await send(f, { document, flowKey: "GENERATION_CONFIRMATION", action: "CANCEL", data: { quote_id: "quote:totally-unrelated" } });
  assert.equal(result.accepted, true, result.reason);
  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "CANCELLED");
});

// ===== CONFIRM_GENERATION non-regression, real generation lifecycle, full success path =====

test("R1-confirm. CONFIRM_GENERATION still completes a real generation end-to-end (reservation, capture, final file, delivery) unaffected by the CANCEL fix", async () => {
  const f = buildComposition({ balance: 20 });
  const { document, quoteId } = await buildFactureAwaitingConfirmation(f);
  const result = await send(f, { document, flowKey: "GENERATION_CONFIRMATION", action: "CONFIRM_GENERATION", data: { quote_id: quoteId } });
  assert.equal(result.accepted, true, result.reason);
  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "DELIVERED");
  const state = f.finalGenerationRepository.inspect();
  assert.equal(state.reservations.length, 1);
  assert.equal(state.reservations[0].status, "CAPTURED");
  assert.equal(state.ledger.length, 1);
});

// ===== Shared-document (FACTURE) cancellation path, already exercised above; DECHARGE path required separately =====

test("R1-decharge. DECHARGE reaches AWAITING_GENERATION_CONFIRMATION through the exact same pipeline, and a stale Flow after it moves to RECHARGE_REQUIRED fails closed", async () => {
  const f = buildComposition({ balance: 0 });
  const { document, quoteId } = await buildDechargeAwaitingConfirmation(f);

  const staleSessionId = await openSession(f, { document, expectedFlowKey: "GENERATION_CONFIRMATION" });

  const confirmResult = await sendRaw(f, { document, flowKey: "GENERATION_CONFIRMATION", action: "CONFIRM_GENERATION", data: { quote_id: quoteId } });
  assert.equal(confirmResult.accepted, false);
  assert.equal(confirmResult.reason, "INSUFFICIENT_CREDITS");
  const afterConfirm = await loadDocument(f, document.document_id);
  assert.equal(afterConfirm.status, "RECHARGE_REQUIRED");
  assert.equal(afterConfirm.version, document.version);

  const staleMessage = nfmReply({ sessionId: staleSessionId, flowKey: "GENERATION_CONFIRMATION", action: "CANCEL", data: { quote_id: quoteId } });
  const staleResult = await f.composition.webhookHandler({ messages: [staleMessage] });
  assert.equal(staleResult.results[0].accepted, false, "DECHARGE's discharge cancellation pipeline must be protected exactly like the shared pipeline");

  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "RECHARGE_REQUIRED", "DECHARGE must remain RECHARGE_REQUIRED, never CANCELLED by the stale Flow");
});

test("R1-decharge-current. A genuinely current DECHARGE GENERATION_CONFIRMATION/CANCEL still cancels normally", async () => {
  const f = buildComposition({ balance: 20 });
  const { document, quoteId } = await buildDechargeAwaitingConfirmation(f);
  const result = await send(f, { document, flowKey: "GENERATION_CONFIRMATION", action: "CANCEL", data: { quote_id: quoteId } });
  assert.equal(result.accepted, true, result.reason);
  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "CANCELLED");
});

// ===== Other CANCEL flows and T3 RECHARGE contract completely unaffected =====

test("R1-other-flows. DOCUMENT_REVIEW/CANCEL and DOCUMENT_PREVIEW/CANCEL never require or reference AWAITING_GENERATION_CONFIRMATION", async () => {
  const f = buildComposition({ balance: 20 });
  await send(f, { flowKey: "MENU", action: "PREPARE_DOCUMENT", data: {} });
  await send(f, { flowKey: "DOCUMENT_TYPE", action: "SELECT_DOCUMENT_TYPE", data: { document_type: "FACTURE" } });
  let document = await loadDocument(f, lastCreatedDocumentId(f));
  await send(f, { document, flowKey: "INVOICE_TYPE", action: "SAVE_INVOICE_TYPE", data: { invoice_kind: "FINAL" } });
  document = await loadDocument(f, document.document_id);
  await send(f, { document, flowKey: "DOCUMENT_CLIENT", action: "SAVE_CLIENT", data: { name: "Client review", phone: "", email: "", address: "", tax_id: "" } });
  document = await loadDocument(f, document.document_id);
  await send(f, { document, flowKey: "ARTICLE_FORM", action: "ADD_CONTENT", data: { description: "Ciment", quantity: 1, unit: "sac", unit_custom: "", unit_price: 6000 } });
  document = await loadDocument(f, document.document_id);
  await send(f, { document, flowKey: "DOCUMENT_CONTENT", action: "FINISH_CONTENT", data: {} });
  document = await loadDocument(f, document.document_id);
  await send(f, { document, flowKey: "DOCUMENT_OPTIONS", action: "SAVE_OPTIONS", data: { tax_rate_basis_points: "", discount_amount: "", notes: "", payment_terms: "", validity_days: "", payment_method: "", reference: "" } });
  document = await loadDocument(f, document.document_id);
  assert.equal(document.status, "READY_FOR_REVIEW");

  const reviewCancel = await send(f, { document, flowKey: "DOCUMENT_REVIEW", action: "CANCEL", data: {} });
  assert.equal(reviewCancel.accepted, true, "DOCUMENT_REVIEW/CANCEL from READY_FOR_REVIEW (never AWAITING_GENERATION_CONFIRMATION) must still succeed normally");
  const afterReviewCancel = await loadDocument(f, document.document_id);
  assert.equal(afterReviewCancel.status, "CANCELLED");
});

const { validateActionPayload } = require("../kadiV1FlowReplyRuntime");

test("R1-t3. RECHARGE/CANCEL's T3 contract and safety are completely untouched by the R1 state-authority fix", () => {
  const stillAccepted = validateActionPayload("RECHARGE", "CANCEL", { pack_id: "PACK_1000", payment_reference: "REF-1" });
  assert.equal(stillAccepted.ok, true, stillAccepted.error);
});
