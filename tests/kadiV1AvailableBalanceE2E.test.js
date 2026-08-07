"use strict";

// T6/BALANCE-001 (BILL-001 confirmed): production-composition proof that
// "Mon solde" (Flow/menu path) and "Quel est mon solde ?" (natural-language
// path) both report AVAILABLE credits — total wallet balance minus the sum
// of live RESERVED holds, the exact same authoritative semantics
// kadi_v1_reserve_generation_credits already uses — never the raw wallet
// balance, and never two independent financial calculations. Wires the
// real document/preview/generation-lifecycle stack (wallet reservation
// service, real renderer with a deterministic barrier for the
// mid-generation case, real delivery) alongside the real FlowCommandRuntime,
// ConversationOrchestrator, WalletRuntimeAdapter and BalanceReader — the
// balance-reading side of this fixture reads directly from the SAME
// generation-lifecycle repository instance that reserveCredits/
// captureReservation/releaseReservation mutate, exactly mirroring how the
// real kadi_v1_get_wallet_balance RPC reads kadi_wallets and
// kadi_v1_wallet_reservations from the same live database in one call. See
// mission "KADI V1 — T6 BALANCE NUMERIC + AVAILABLE-CREDITS AUTHORITY" and
// docs/KADI_ENGINEERING_MEMORY.md fiche AA.3.

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
  createKadiV1WalletRuntimeAdapter,
} = require("../kadiV1RuntimeAdapters");
const { createKadiV1BalanceReader } = require("../kadiV1ProductionInfrastructure");
const { createKadiV1FlowCommandRuntime } = require("../kadiV1FlowCommandRuntime");
const { createKadiV1FlowReplyRuntime } = require("../kadiV1FlowReplyRuntime");
const { createKadiV1ConversationOrchestrator } = require("../kadiV1ConversationOrchestrator");
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

// The balance-reading side of the fixture: reads total/reserved directly
// from the SAME generationRepo instance reserveCredits/captureReservation/
// releaseReservation mutate — never a second, independent wallet map —
// mirroring the real kadi_v1_get_wallet_balance RPC's single read of both
// kadi_wallets and kadi_v1_wallet_reservations.
function createSharedWalletBalanceRepository(generationRepo) {
  return Object.freeze({
    async getBalance({ ownerWaId }) {
      const state = generationRepo.inspect();
      return { ok: true, value: state.balances[ownerWaId] ?? 0 };
    },
    async getAvailableBalance({ ownerWaId }) {
      const state = generationRepo.inspect();
      const total = state.balances[ownerWaId] ?? 0;
      const reserved = state.reservations
        .filter((entry) => entry.owner_wa_id === ownerWaId && entry.status === "RESERVED")
        .reduce((sum, entry) => sum + entry.amount, 0);
      if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(reserved) || reserved < 0 || reserved > total) {
        return { ok: false, error: "KADI_V1_BALANCE_INVALID" };
      }
      return { ok: true, value: { total_credits: total, reserved_credits: reserved, available_credits: total - reserved } };
    },
  });
}

function buildComposition({ balance = 20, barrier = null, pages = 1, deliveryOk = true, balanceRepositoryOverride = null } = {}) {
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
    pricingVersion: "t6-test-v1",
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

  const generationRepo = createInMemoryGenerationLifecycleRepository({ balances: { [OWNER]: balance } });
  const finalRenderer = {
    render: async ({ preview: renderedPreview }) => {
      if (barrier) await barrier.waitForRelease();
      return { ok: true, value: { buffer: await pdfBuffer(renderedPreview?.structured_preview?.page_count || pages), mime_type: "application/pdf" } };
    },
  };
  const walletReservationService = createWalletReservationService({ repository: generationRepo, clock });
  const finalGenerationService = createFinalGenerationService({
    repository: generationRepo, storage: createInMemoryFinalFileStorage(), renderer: finalRenderer, clock,
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
  const deliveryService = createDeliveryService({ repository: generationRepo, provider: deliveryProvider, clock });
  const generationLifecycleService = createGenerationLifecycleService({
    documentRepository: repository, previewRepository, generationRepository: generationRepo,
    quoteService: generationQuoteService, walletReservationService, finalGenerationService, deliveryService,
    domain, clock, idFactory: (kind, key) => `${kind}:${nextKey(key || kind)}`,
    observer: () => {},
  });
  const generationRuntime = createKadiV1GenerationRuntimeAdapter({ generationLifecycleService });

  const rechargeRepository = balanceRepositoryOverride || createSharedWalletBalanceRepository(generationRepo);
  const balanceReader = createKadiV1BalanceReader({ rechargeRepository });
  const walletRuntime = createKadiV1WalletRuntimeAdapter({ balanceReader });
  const walletCallLog = [];
  const spiedWalletRuntime = Object.freeze({
    async getBalance(command) { walletCallLog.push(command); return walletRuntime.getBalance(command); },
  });

  const commandRuntime = createKadiV1FlowCommandRuntime({
    onboardingRuntime: stubPort(["continueOnboarding"]),
    documentRuntime,
    previewRuntime,
    generationRuntime,
    rechargeRuntime: stubPort(["selectPack", "checkPayment", "cancel"]),
    historyRuntime: stubPort(["search", "open"]),
    walletRuntime: spiedWalletRuntime,
  });

  const sessionService = createConversationSessionService({
    repository: createMemoryConversationSessionRepository(),
    clock,
  });
  const flowReplyRuntime = createKadiV1FlowReplyRuntime({ sessionService, commandRuntime });

  const orchestrator = createKadiV1ConversationOrchestrator({
    config: { enabled: true, features: { brain: false, vision: false, transcription: false, voice: false, history: true } },
    legacyHandler: async () => { throw new Error("UNEXPECTED_CALL:legacyHandler"); },
    userContextService: {
      getContext: async () => ({
        ok: true,
        value: { is_new: false, profile: { onboarding_status: "COMPLETED", voice_response_mode: "TEXT_ONLY" }, active_document: null },
      }),
    },
    onboardingRuntime: stubPort(["start", "continueOnboarding"]),
    interpretationRuntime: stubPort(["interpret"]),
    documentRuntime,
    historyRuntime: stubPort(["search", "open"]),
    walletRuntime: spiedWalletRuntime,
  });

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
      orchestrator,
      flowReplyRuntime,
      mediaResolver: stubPort(["resolveAudio", "resolveImage", "resolvePdf"]),
      presenter,
      deliveryRetryRuntime: stubPort(["handle"]),
    },
    logger: { warn() {}, log() {} },
  });
  assert.equal(composition.readiness.ready, true, JSON.stringify(composition.readiness));
  return { composition, sessionService, sent, repository, created, generationRepo, walletReservationService, deliveryProviderCalls, walletCallLog };
}

function nfmReply({ sessionId, flowKey, action, data = {}, from = OWNER, id }) {
  return {
    id: id || `wamid:${flowKey}:${action}:${sessionId}:${nextKey("msg")}`, from, type: "interactive",
    interactive: { type: "nfm_reply", nfm_reply: { response_json: JSON.stringify({ session_id: sessionId, flow_key: flowKey, action, data, flow_token: sessionId }) } },
  };
}

function textMessage(body, from = OWNER, id) {
  return { id: id || `wamid:text:${nextKey("text")}`, from, type: "text", text: { body } };
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

async function sendMenuBalance(f, { ownerWaId = OWNER, id } = {}) {
  const sessionId = await openSession(f, { expectedFlowKey: "MENU", ownerWaId });
  const message = nfmReply({ sessionId, flowKey: "MENU", action: "BALANCE", data: {}, from: ownerWaId, id });
  return f.composition.webhookHandler({ messages: [message] });
}

async function sendNaturalBalance(f, { ownerWaId = OWNER, text = "Quel est mon solde ?", id } = {}) {
  return f.composition.webhookHandler({ messages: [textMessage(text, ownerWaId, id)] });
}

function lastText(f) {
  const entry = f.sent.texts.slice(-1)[0];
  assert.ok(entry, "a text must have been sent");
  return entry.text;
}

// =====================================================================
// 1/2. Menu and natural-language BALANCE report identical available credits
// =====================================================================

test("T6-1. Menu BALANCE returns the numeric available balance, not the static sentence", async () => {
  const f = buildComposition({ balance: 7 });
  const result = await sendMenuBalance(f);
  assert.equal(result.results[0].accepted, true, result.results[0].reason);
  assert.equal(lastText(f), "Vous avez 7 crédits disponibles.");
  assert.notEqual(lastText(f), "Votre solde a été consulté.");
});

test("T6-2. Natural-language BALANCE reports the exact same available credits as the menu path", async () => {
  const f = buildComposition({ balance: 7 });
  const menuResult = await sendMenuBalance(f);
  assert.equal(menuResult.results[0].accepted, true);
  const menuText = lastText(f);

  const naturalResult = await sendNaturalBalance(f);
  assert.equal(naturalResult.handled, true);
  const naturalText = lastText(f);

  assert.equal(menuText, "Vous avez 7 crédits disponibles.");
  assert.equal(naturalText, "Vous avez 7 crédits disponibles.");
  assert.equal(menuText, naturalText, "Flow/menu and natural-language BALANCE must report the exact same text");
});

test("T6-2b. With 10 total and 3 reserved, both paths say 7 available — never one 10 and the other 7", async () => {
  const f = buildComposition({ balance: 10 });
  const reserved = await f.walletReservationService.reserveCredits({ ownerWaId: OWNER, quoteId: "quote:parity:1", amount: 3, idempotencyKey: "reserve:parity:1" });
  assert.equal(reserved.ok, true, reserved.error);

  const menuResult = await sendMenuBalance(f);
  assert.equal(lastText(f), "Vous avez 7 crédits disponibles.\n3 crédits sont temporairement réservés pour une génération en cours.");
  assert.equal(menuResult.results[0].accepted, true);

  const naturalResult = await sendNaturalBalance(f);
  assert.equal(naturalResult.handled, true);
  assert.equal(lastText(f), "Vous avez 7 crédits disponibles.\n3 crédits sont temporairement réservés pour une génération en cours.");
});

// =====================================================================
// 3/4/5. zero / singular / plural
// =====================================================================

test("T6-3. Zero available credits", async () => {
  const f = buildComposition({ balance: 0 });
  await sendMenuBalance(f);
  assert.equal(lastText(f), "Vous avez 0 crédit disponible.");
});

test("T6-4. Singular one available credit", async () => {
  const f = buildComposition({ balance: 1 });
  await sendMenuBalance(f);
  assert.equal(lastText(f), "Vous avez 1 crédit disponible.");
});

test("T6-5. Plural available credits", async () => {
  const f = buildComposition({ balance: 12 });
  await sendMenuBalance(f);
  assert.equal(lastText(f), "Vous avez 12 crédits disponibles.");
});

// =====================================================================
// 6/7/8. reserved / released / captured reduce (or don't reduce) the value
// =====================================================================

test("T6-6. A live RESERVED reservation reduces the displayed available value", async () => {
  const f = buildComposition({ balance: 10 });
  const reserved = await f.walletReservationService.reserveCredits({ ownerWaId: OWNER, quoteId: "quote:t6-6", amount: 3, idempotencyKey: "reserve:t6-6" });
  assert.equal(reserved.ok, true, reserved.error);
  await sendMenuBalance(f);
  assert.match(lastText(f), /^Vous avez 7 crédits disponibles\./);
});

test("T6-7. A RELEASED reservation does not reduce the displayed available value", async () => {
  const f = buildComposition({ balance: 10 });
  const reserved = await f.walletReservationService.reserveCredits({ ownerWaId: OWNER, quoteId: "quote:t6-7", amount: 3, idempotencyKey: "reserve:t6-7" });
  assert.equal(reserved.ok, true, reserved.error);
  const released = await f.walletReservationService.releaseReservation({ reservationId: reserved.value.reservation_id, idempotencyKey: "release:t6-7" });
  assert.equal(released.ok, true, released.error);
  assert.equal(released.value.status, "RELEASED");
  await sendMenuBalance(f);
  assert.equal(lastText(f), "Vous avez 10 crédits disponibles.");
});

test("T6-8. A CAPTURED reservation is not subtracted a second time (wallet total already reflects it)", async () => {
  const f = buildComposition({ balance: 10 });
  const reserved = await f.walletReservationService.reserveCredits({ ownerWaId: OWNER, quoteId: "quote:t6-8", amount: 3, idempotencyKey: "reserve:t6-8" });
  assert.equal(reserved.ok, true, reserved.error);
  const captured = await f.walletReservationService.captureReservation({ reservationId: reserved.value.reservation_id, idempotencyKey: "capture:t6-8" });
  assert.equal(captured.ok, true, captured.error);
  assert.equal(captured.value.status, "CAPTURED");
  const state = f.generationRepo.inspect();
  assert.equal(state.balances[OWNER], 7, "capture must already have consumed the wallet total (7, not 10)");
  await sendMenuBalance(f);
  assert.equal(lastText(f), "Vous avez 7 crédits disponibles.", "must be 7, never 4 (double-subtracted)");
});

test("T6-mid-generation. Reserved credits held by a real in-flight generation reduce available, and BALANCE causes zero interference with that generation", async () => {
  const barrier = createBarrier();
  const f = buildComposition({ balance: 20, barrier });

  // Drive a real FACTURE to AWAITING_GENERATION_CONFIRMATION, then confirm
  // generation for real — reservation genuinely RESERVED, mid-flight.
  async function send(payload) {
    const sessionId = await openSession(f, { document: payload.document, expectedFlowKey: payload.flowKey, ownerWaId: OWNER });
    const result = await f.composition.webhookHandler({ messages: [nfmReply({ sessionId, flowKey: payload.flowKey, action: payload.action, data: payload.data || {}, id: nextKey("msg") })] });
    assert.equal(result.results[0].accepted, payload.expectAccepted !== false, result.results[0].reason);
    return result.results[0];
  }
  async function loadDocument(documentId) {
    const loaded = await f.repository.getDocumentById({ documentId, ownerWaId: OWNER });
    assert.equal(loaded.ok, true, loaded.error);
    return loaded.value;
  }
  function lastFlowData() {
    const flow = f.sent.flows.slice(-1)[0];
    return flow.interactive.action.parameters.flow_action_payload.data;
  }

  await send({ flowKey: "MENU", action: "PREPARE_DOCUMENT", data: {} });
  await send({ flowKey: "DOCUMENT_TYPE", action: "SELECT_DOCUMENT_TYPE", data: { document_type: "FACTURE" } });
  let document = await loadDocument(f.created[f.created.length - 1].document_id);
  await send({ document, flowKey: "INVOICE_TYPE", action: "SAVE_INVOICE_TYPE", data: { invoice_kind: "FINAL" } });
  document = await loadDocument(document.document_id);
  await send({ document, flowKey: "DOCUMENT_CLIENT", action: "SAVE_CLIENT", data: { name: "Client T6", phone: "", email: "", address: "", tax_id: "" } });
  document = await loadDocument(document.document_id);
  await send({ document, flowKey: "ARTICLE_FORM", action: "ADD_CONTENT", data: { description: "Ciment", quantity: 2, unit: "sac", unit_custom: "", unit_price: 6000 } });
  document = await loadDocument(document.document_id);
  await send({ document, flowKey: "DOCUMENT_CONTENT", action: "FINISH_CONTENT", data: {} });
  document = await loadDocument(document.document_id);
  await send({ document, flowKey: "DOCUMENT_OPTIONS", action: "SAVE_OPTIONS", data: { tax_rate_basis_points: 1800, discount_amount: "", notes: "", payment_terms: "", validity_days: "", payment_method: "", reference: "" } });
  document = await loadDocument(document.document_id);
  await send({ document, flowKey: "DOCUMENT_REVIEW", action: "VERIFY", data: {} });
  document = await loadDocument(document.document_id);
  await send({ document, flowKey: "DOCUMENT_PREVIEW", action: "PREPARE_PDF", data: {} });
  document = await loadDocument(document.document_id);
  const quoteId = lastFlowData().quote_id;

  const confirmSessionId = await openSession(f, { document, expectedFlowKey: "GENERATION_CONFIRMATION" });
  const confirmMessage = nfmReply({ sessionId: confirmSessionId, flowKey: "GENERATION_CONFIRMATION", action: "CONFIRM_GENERATION", data: { quote_id: quoteId } });
  const confirmPromise = f.composition.webhookHandler({ messages: [confirmMessage] });
  await barrier.reached;

  const balanceDuringGeneration = await sendMenuBalance(f, { id: "wamid:balance:midgen" });
  assert.equal(balanceDuringGeneration.results[0].accepted, true);
  assert.equal(lastText(f), "Vous avez 18 crédits disponibles.\n2 crédits sont temporairement réservés pour une génération en cours.");

  const stateDuringGeneration = f.generationRepo.inspect();
  assert.equal(stateDuringGeneration.reservations.length, 1);
  assert.equal(stateDuringGeneration.reservations[0].status, "RESERVED", "BALANCE must never disturb the live reservation");

  barrier.release();
  const confirmResult = await confirmPromise;
  assert.equal(confirmResult.results[0].accepted, true, confirmResult.results[0].reason);
  const finalDoc = await loadDocument(document.document_id);
  assert.equal(finalDoc.status, "DELIVERED");

  await sendMenuBalance(f, { id: "wamid:balance:aftergen" });
  assert.equal(lastText(f), "Vous avez 18 crédits disponibles.", "after capture, available must be 18 (20 - 2 captured), not 16");
});

// =====================================================================
// 9. malformed financial snapshot fails closed
// =====================================================================

test("T6-9. A malformed/impossible financial snapshot (reserved > total) fails closed — no negative or guessed balance shown", async () => {
  const badRepository = {
    async getBalance() { return { ok: true, value: 3 }; },
    async getAvailableBalance() { return { ok: true, value: { total_credits: 3, reserved_credits: 5, available_credits: -2 } }; },
  };
  const f = buildComposition({ balance: 3, balanceRepositoryOverride: badRepository });
  const result = await sendMenuBalance(f);
  assert.equal(result.results[0].accepted, false, "a malformed financial snapshot must fail the request, never render a negative/guessed balance");
  // A generic recoverable-error text is sent (the same pre-existing
  // behavior every other failed Flow command already has) — but it must
  // never be a balance sentence, never contain "crédit", and never show a
  // negative or fabricated number.
  const text = lastText(f);
  assert.doesNotMatch(text, /crédit/i, "no balance-shaped text may be sent for an impossible financial state");
  assert.doesNotMatch(text, /-\d/, "no negative number may ever be shown to the user");
});

// =====================================================================
// 10. owner isolation
// =====================================================================

test("T6-10. Owner isolation: a different authenticated owner never sees owner A's balance", async () => {
  const f = buildComposition({ balance: 42 });
  const sessionId = await openSession(f, { expectedFlowKey: "MENU", ownerWaId: OWNER });
  const result = await f.composition.webhookHandler({
    messages: [nfmReply({ sessionId, flowKey: "MENU", action: "BALANCE", data: {}, from: OTHER_OWNER })],
  });
  assert.equal(result.results[0].accepted, false, "a session opened for OWNER must reject a reply claiming to be from a different owner");
  assert.equal(f.walletCallLog.length, 0, "the wallet must never even be queried for a rejected cross-owner submission");
});

test("T6-10b. Owner isolation: each owner's own BALANCE only ever queries their own wallet", async () => {
  const f = buildComposition({ balance: 5 });
  await sendMenuBalance(f, { ownerWaId: OWNER });
  assert.deepEqual(f.walletCallLog.map((c) => c.ownerWaId), [OWNER]);
});

// =====================================================================
// 11. BALANCE causes zero financial mutation
// =====================================================================

test("T6-11. BALANCE causes zero financial mutation", async () => {
  const f = buildComposition({ balance: 9 });
  const before = f.generationRepo.inspect();
  await sendMenuBalance(f);
  await sendNaturalBalance(f);
  const after = f.generationRepo.inspect();
  assert.deepEqual(after.balances, before.balances, "wallet balance must be completely unchanged");
  assert.deepEqual(after.reservations, before.reservations, "no reservation created/captured/released");
  assert.deepEqual(after.ledger, before.ledger, "no ledger entry");
});

// =====================================================================
// 12. static text no longer the successful output; 13. unrelated presenter text unchanged
// =====================================================================

test("T6-12. The static sentence is never the successful BALANCE output, across a range of balances", async () => {
  for (const balance of [0, 1, 2, 50]) {
    const f = buildComposition({ balance });
    await sendMenuBalance(f);
    assert.notEqual(lastText(f), "Votre solde a été consulté.");
  }
});

test("T6-13. Unrelated presenter responses (PREPARE_DOCUMENT, CANCEL) remain unchanged by the BALANCE fix", async () => {
  const f = buildComposition({ balance: 5 });
  await sendMenuBalance(f); // exercise BALANCE first, then prove other actions are untouched

  const menuSessionId = await openSession(f, { expectedFlowKey: "MENU", ownerWaId: OWNER });
  await f.composition.webhookHandler({ messages: [nfmReply({ sessionId: menuSessionId, flowKey: "MENU", action: "PREPARE_DOCUMENT", data: {} })] });
  assert.equal(lastText(f), "Choisissez le document à préparer.");

  const typeSessionId = await openSession(f, { expectedFlowKey: "DOCUMENT_TYPE", ownerWaId: OWNER });
  await f.composition.webhookHandler({ messages: [nfmReply({ sessionId: typeSessionId, flowKey: "DOCUMENT_TYPE", action: "SELECT_DOCUMENT_TYPE", data: { document_type: "FACTURE" } })] });
  assert.equal(lastText(f), "Le type de document est enregistré.");
  const document = (await f.repository.getDocumentById({ documentId: f.created[f.created.length - 1].document_id, ownerWaId: OWNER })).value;

  const cancelSessionId = await openSession(f, { document, expectedFlowKey: "DOCUMENT_REVIEW", ownerWaId: OWNER });
  const cancelResult = await f.composition.webhookHandler({
    messages: [nfmReply({ sessionId: cancelSessionId, flowKey: "DOCUMENT_REVIEW", action: "CANCEL", data: {} })],
  });
  assert.equal(cancelResult.results[0].accepted, false, "this document is COLLECTING, not READY_FOR_REVIEW — the T4.5 state-authority gate must still reject it exactly as before, unaffected by BALANCE");
});

// =====================================================================
// SQL RPC contract (structural, no production mutation)
// =====================================================================

test("T6-sql. kadi_v1_get_wallet_balance's new migration computes reserved via the SAME live RESERVED semantics as kadi_v1_reserve_generation_credits, atomically, in one function", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const migrationPath = path.join(__dirname, "..", "migrations", "20260807_add_kadi_v1_available_wallet_balance.sql");
  const sql = fs.readFileSync(migrationPath, "utf8");
  const normalized = sql.toLowerCase().replace(/\s+/g, " ");

  assert.match(normalized, /create or replace function public\.kadi_v1_get_wallet_balance\(p_owner_wa_id text\)/, "must replace the existing function in place, same name and signature");
  assert.match(normalized, /where owner_wa_id = p_owner_wa_id and status = 'reserved'/, "must use the exact same live RESERVED filter as kadi_v1_reserve_generation_credits");
  assert.match(normalized, /'available_credits', v_balance - v_held/, "available must be computed as balance minus the RESERVED sum");
  assert.match(normalized, /'total_credits', v_balance/);
  assert.match(normalized, /'reserved_credits', v_held/);
  assert.match(normalized, /'balance', v_balance/, "the pre-existing balance field must be preserved for backward compatibility");
  assert.match(normalized, /for share/, "must lock the wallet row to keep the balance and reservation reads consistent against a concurrent reserve/capture");
  // Exactly one function body (one `create or replace function ... kadi_v1_get_wallet_balance`) —
  // proves this is a single database round trip, not two separate queries.
  const occurrences = (normalized.match(/create or replace function public\.kadi_v1_get_wallet_balance/g) || []).length;
  assert.equal(occurrences, 1);
  const supabasePath = path.join(__dirname, "..", "supabase", "migrations", "20260807220000_add_kadi_v1_available_wallet_balance.sql");
  assert.equal(fs.readFileSync(supabasePath, "utf8"), sql, "the migrations/ and supabase/migrations/ mirrors must stay byte-identical, matching the repository's existing convention");
});
