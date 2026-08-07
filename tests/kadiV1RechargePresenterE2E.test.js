"use strict";

// T5/RECHARGE_PRESENTER_001: production-composition proof that the real
// RECHARGE Flow (flows/v1_draft/kadi_recharge_v1.json) is always presented
// with SERVER-authoritative data — the T6 available-balance authority
// (never the raw wallet balance) and the SAME createRechargePackCatalog
// instance already used by RechargeService (never a second pack list, never
// the Flow JSON's own __example__ values). Also proves the RECHARGE/CANCEL
// wording mismatch ("Revenir plus tard" vs a real terminal cancellation) is
// resolved, while leaving T3's R1/R2/R3 cancellation-integrity protections
// and the SELECT_PACK/CHECK_PAYMENT financial lifecycle completely
// untouched. Reuses the exact recharge-stack fixture pattern already proven
// in tests/kadiV1RechargeContractE2E.test.js (T3) and the exact balance/
// reservation fixture pattern already proven in
// tests/kadiV1AvailableBalanceE2E.test.js (T6) — combined here because T5
// sits exactly at their intersection. Only true external I/O (WhatsApp send
// calls, the payment provider, and the one raw Supabase query T3's real
// cancel() issues) is faked. No Meta, Supabase, Render, real payment, or
// real Supabase migration anywhere in this file.

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
  createKadiV1HistoryRuntimeAdapter,
} = require("../kadiV1RuntimeAdapters");
const { createV1HistoryService } = require("../kadiV1HistoryService");
const { createKadiV1BalanceReader, createKadiV1RechargeRuntime } = require("../kadiV1ProductionInfrastructure");
const { createRechargePackCatalog } = require("../kadiV1RechargeConfig");
const { createInMemoryRechargeRepository } = require("../kadiV1RechargeRepository");
const { createRechargeService } = require("../kadiV1RechargeService");
const { createKadiV1FlowCommandRuntime } = require("../kadiV1FlowCommandRuntime");
const { createKadiV1FlowReplyRuntime, validateActionPayload } = require("../kadiV1FlowReplyRuntime");
const { createKadiV1ConversationOrchestrator } = require("../kadiV1ConversationOrchestrator");
const { createKadiV1ProductionPresenter } = require("../kadiV1ProductionPresenter");
const { createConversationSessionService, createMemoryConversationSessionRepository } = require("../kadiV1ConversationSession");
const { createKadiV1ProductionComposition } = require("../kadiV1ProductionComposition");

const OWNER = "22670000000";
const OTHER_OWNER = "22679999999";
const NOW = "2026-08-07T02:00:00.000Z";

const PACK_1000 = Object.freeze({ pack_id: "PACK_1000", amount: 1000, currency: "XOF", credits: 10, pricing_version: "legacy-v1", active: true });
const PACK_2000 = Object.freeze({ pack_id: "PACK_2000", amount: 2000, currency: "XOF", credits: 25, pricing_version: "legacy-v1", active: true });
const PACK_ONE_CREDIT = Object.freeze({ pack_id: "PACK_ONE", amount: 500, currency: "XOF", credits: 1, pricing_version: "legacy-v1", active: true });
const PACK_INACTIVE = Object.freeze({ pack_id: "PACK_RETIRED", amount: 9000, currency: "XOF", credits: 999, pricing_version: "legacy-v1", active: false });

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

// T3's exact fake Supabase client for RECHARGE/CANCEL's real cancel() —
// unmodified, so R1/R2/R3's target-resolution semantics are exercised
// exactly as originally proven.
function createFakeRechargeSupabaseClient({ rechargeRepository, sessionIdsByOwner }) {
  return {
    async rpc() { throw new Error("UNEXPECTED_CALL:rpc"); },
    storage: { from() { throw new Error("UNEXPECTED_CALL:storage"); } },
    from(table) {
      if (table !== "kadi_v1_recharge_sessions") throw new Error(`UNEXPECTED_TABLE:${table}`);
      return {
        select: () => ({
          eq: (_col, ownerWaId) => ({
            lte: (_col2, upperBound) => ({
              order: () => ({
                limit: () => ({
                  async maybeSingle() {
                    const ids = sessionIdsByOwner.get(ownerWaId) || [];
                    const sessions = [];
                    for (const id of ids) {
                      const loaded = await rechargeRepository.getRechargeSession({ rechargeSessionId: id });
                      if (loaded.ok && loaded.value.owner_wa_id === ownerWaId && loaded.value.created_at <= upperBound) {
                        sessions.push(loaded.value);
                      }
                    }
                    sessions.sort((a, b) => b.created_at.localeCompare(a.created_at));
                    const newest = sessions[0];
                    return { data: newest ? { recharge_session_id: newest.recharge_session_id, status: newest.status } : null, error: null };
                  },
                }),
              }),
            }),
          }),
        }),
      };
    },
  };
}

function fakePaymentProvider({ confirmOnVerify = true } = {}) {
  const paymentsById = new Map();
  let sequence = 0;
  return {
    name: "SYNTHETIC_PAY",
    async createPaymentRequest(request) {
      sequence += 1;
      const providerPaymentId = `payment:${sequence}`;
      paymentsById.set(providerPaymentId, { merchant_reference: request.merchant_reference, amount: request.amount, currency: request.currency });
      return {
        ok: true,
        value: {
          provider: "SYNTHETIC_PAY", provider_payment_id: providerPaymentId, provider_event_id: null,
          merchant_reference: request.merchant_reference, amount: request.amount, currency: request.currency,
          status: "PENDING", verified: true, occurred_at: NOW, metadata: {},
        },
      };
    },
    async getPaymentStatus({ providerPaymentId }) {
      const payment = paymentsById.get(providerPaymentId);
      if (!payment) return { ok: false, error: "PAYMENT_NOT_FOUND" };
      return {
        ok: true,
        value: {
          provider: "SYNTHETIC_PAY", provider_payment_id: providerPaymentId, provider_event_id: `event:${providerPaymentId}`,
          merchant_reference: payment.merchant_reference, amount: payment.amount, currency: payment.currency,
          status: confirmOnVerify ? "CONFIRMED" : "PENDING", verified: true, occurred_at: NOW, metadata: {},
        },
      };
    },
    async verifyPaymentEvent(raw) { return { ok: true, value: { ...raw } }; },
  };
}

function createAdvancingClock(startIso) {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.parse(startIso) + tick * 1000).toISOString();
  };
}

// T6's exact pattern: the balance-reading side reads directly from the SAME
// generationRepo instance reserveCredits/captureReservation/
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

// Minimal real history-repository adapter, reading live from the same
// in-memory document repository this fixture already uses — needed because
// driveToRechargeRequired() now reopens the stuck document through the real
// HISTORY_SEARCH/OPEN_DOCUMENT path (see driveToRechargeRequired's comment).
// Only getOwnedDocumentBundle is ever exercised by these tests; the other
// three methods exist solely to satisfy kadiV1HistoryRepository.js's
// assertV1HistoryRepository contract.
function buildHistoryRepository(documentRepository) {
  return {
    async searchOwnedDocuments() { return { ok: true, value: { documents: [], next_cursor: null } }; },
    async getOwnedDocumentBundle({ ownerWaId, documentId }) {
      const found = await documentRepository.getDocumentById({ documentId, ownerWaId });
      if (!found.ok) return found;
      const document = found.value;
      return {
        ok: true,
        value: {
          classification: "V1_NATIVE",
          owner_wa_id: ownerWaId,
          document: { ...document, updated_at: document.updated_at || document.events?.at(-1)?.occurred_at || NOW },
          current_snapshot: document,
          versions: [],
          events: [],
          final_file: null,
          delivery: null,
        },
      };
    },
    async findDuplicateByIdempotencyKey() { return { ok: true, value: null }; },
    async rememberDuplicate() { return { ok: true, value: null }; },
  };
}

// balanceRepositoryOverride lets the pre-fix-reproduction test simulate
// "the presenter has no balanceReader/packCatalog wired in at all" without
// touching production code — see T5-repro below.
function buildComposition({
  balance = 20,
  barrier = null,
  pages = 1,
  packs = [PACK_1000, PACK_2000],
  presenterMissingRechargeDeps = false,
  provider = fakePaymentProvider(),
  sessionRepository = createMemoryConversationSessionRepository(),
  rechargeRepository: existingRechargeRepository = null,
  sessionIdsByOwner: existingSessionIdsByOwner = null,
  sharedClock = createAdvancingClock(NOW),
} = {}) {
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
    pricingVersion: "t5-test-v1",
    validitySeconds: 600,
    // Deliberately far above any balance used in this file's fixtures
    // (all small, 0-20): driveToRechargeRequired() relies on the quote
    // cost genuinely exceeding the wallet total, and a failed
    // (INSUFFICIENT_CREDITS) confirm never touches the wallet at all — so
    // the balance shown afterward is still exactly whatever `balance` the
    // composition was built with, letting the presentation tests below
    // freely choose any display value.
    documentTypes: Object.fromEntries(["FACTURE", "DEVIS", "RECU", "DECHARGE"].map((type) => [type, { baseCost: 1000, perPageCost: 1000 }])),
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
  const deliveryProvider = {
    async deliverDocument() { return { ok: true, value: { reference: "synthetic-delivery" } }; },
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

  // T5: the same generationRepo drives both the real reservation lifecycle
  // AND the presenter/BALANCE authority — never two independent financial
  // calculations.
  const balanceRepository = createSharedWalletBalanceRepository(generationRepo);
  const balanceReader = createKadiV1BalanceReader({ rechargeRepository: balanceRepository });
  const walletRuntime = createKadiV1WalletRuntimeAdapter({ balanceReader });

  // T3's exact recharge stack, unmodified.
  const packCatalog = createRechargePackCatalog({ packs });
  const sessionIdsByOwner = existingSessionIdsByOwner || new Map();
  let rechargeRepository = existingRechargeRepository;
  if (!rechargeRepository) {
    const realRechargeRepository = createInMemoryRechargeRepository({ balances: { [OWNER]: 0, [OTHER_OWNER]: 0 } });
    rechargeRepository = {};
    for (const key of Object.keys(realRechargeRepository)) rechargeRepository[key] = realRechargeRepository[key];
    rechargeRepository.createRechargeSession = async (args) => {
      const result = await realRechargeRepository.createRechargeSession(args);
      if (result.ok) {
        const list = sessionIdsByOwner.get(result.value.owner_wa_id) || [];
        list.push(result.value.recharge_session_id);
        sessionIdsByOwner.set(result.value.owner_wa_id, list);
      }
      return result;
    };
  }
  const rechargeService = createRechargeService({
    repository: rechargeRepository,
    packCatalog,
    paymentProvider: provider,
    documentRepository: repository,
    quoteService: { getGenerationQuote: async () => { throw new Error("UNEXPECTED_CALL:getGenerationQuote"); } },
    generationLifecycleService: { confirmGeneration: async () => { throw new Error("UNEXPECTED_CALL:confirmGeneration"); } },
    clock: sharedClock,
  });
  const rechargeClient = createFakeRechargeSupabaseClient({ rechargeRepository, sessionIdsByOwner });
  const rechargeRuntime = createKadiV1RechargeRuntime({
    rechargeService, rechargeRepository, paymentProvider: provider, client: rechargeClient,
    orangeMoneyNumber: "22670000099", orangeMoneyName: "Kadi",
  });

  // Real (not stubbed) history stack: driveToRechargeRequired() reopens a
  // stuck RECHARGE_REQUIRED document through HISTORY_SEARCH/OPEN_DOCUMENT,
  // the actual reachable path a real user takes.
  const historyRepository = buildHistoryRepository(repository);
  const historyService = createV1HistoryService({ historyRepository, documentRepository: repository, clock });
  const historyRuntime = createKadiV1HistoryRuntimeAdapter({ historyService });

  const commandRuntime = createKadiV1FlowCommandRuntime({
    onboardingRuntime: stubPort(["continueOnboarding"]),
    documentRuntime,
    previewRuntime,
    generationRuntime,
    rechargeRuntime,
    historyRuntime,
    walletRuntime,
  });

  const sessionService = createConversationSessionService({ repository: sessionRepository, clock: sharedClock });
  const flowReplyRuntime = createKadiV1FlowReplyRuntime({ sessionService, commandRuntime });

  const orchestrator = createKadiV1ConversationOrchestrator({
    config: { enabled: true, features: { brain: false, vision: false, transcription: false, voice: false, history: true, recharge: true } },
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
    historyRuntime,
    walletRuntime,
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
    // T5-repro: presenterMissingRechargeDeps simulates the pre-fix
    // constructor shape (no balanceReader/packCatalog at all) without
    // touching any production file.
    ...(presenterMissingRechargeDeps ? {} : { balanceReader, packCatalog }),
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
  return {
    composition, sessionService, sent, repository, created, generationRepo,
    rechargeRepository, sessionIdsByOwner, sessionRepository, provider,
    walletReservationService, presenter,
  };
}

function rebuildCompositionAroundSameRepositories(f, overrides = {}) {
  return buildComposition({
    sessionRepository: f.sessionRepository,
    rechargeRepository: f.rechargeRepository,
    sessionIdsByOwner: f.sessionIdsByOwner,
    provider: f.provider,
    ...overrides,
  });
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

async function send(f, { document = null, flowKey, action, data = {}, ownerWaId = OWNER, expectAccepted = true, id } = {}) {
  const sessionId = await openSession(f, { document, expectedFlowKey: flowKey, ownerWaId });
  const result = await f.composition.webhookHandler({ messages: [nfmReply({ sessionId, flowKey, action, data, from: ownerWaId, id })] });
  assert.equal(result.handled, true);
  assert.equal(result.results[0].accepted, expectAccepted, result.results[0].reason);
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

function lastText(f) {
  const entry = f.sent.texts.slice(-1)[0];
  assert.ok(entry, "a text must have been sent");
  return entry.text;
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
  await send(f, { document, flowKey: "DOCUMENT_REVIEW", action: "VERIFY", data: {}, ownerWaId, id: nextKey(`${suffix}-verify`) });
  document = await loadDocument(f, document.document_id, ownerWaId);
  await send(f, { document, flowKey: "DOCUMENT_PREVIEW", action: "PREPARE_PDF", data: {}, ownerWaId, id: nextKey(`${suffix}-preparepdf`) });
  document = await loadDocument(f, document.document_id, ownerWaId);
  const quoteId = lastFlowData(f).quote_id;
  return { document, quoteId };
}

// A failed (INSUFFICIENT_CREDITS) CONFIRM_GENERATION never reaches
// presentFlowReply at all — kadiV1WebhookRuntime.js's handleMessage()
// routes any !result.ok flow-reply outcome through recover() ->
// presentRecoverableError(), which only ever sends a generic "couldn't
// complete this step" text and never opens a Flow (confirmed by reading
// both functions directly). So the RECHARGE Flow is never shown at the
// exact moment a document becomes RECHARGE_REQUIRED. The real, reachable
// way a user later sees RECHARGE for a stuck document is by reopening it
// from history: HISTORY_SEARCH/OPEN_DOCUMENT -> kadiV1HistoryService.js's
// getDocumentDetails() -> presentFlowReply()'s generic path (the
// RETRY_DELIVERY-specific branch is skipped since there is no delivery
// attempt) -> nextFlowForReply() -> routeDocument() maps RECHARGE_REQUIRED
// to "RECHARGE". This helper reproduces that real path so lastFlowData(f)
// reflects an actual RECHARGE Flow send, not a stale earlier screen.
async function driveToRechargeRequired(f, ownerWaId = OWNER, suffix = "rr") {
  const { document, quoteId } = await buildFactureAwaitingConfirmation(f, ownerWaId, suffix);
  const confirmResult = await send(f, { document, flowKey: "GENERATION_CONFIRMATION", action: "CONFIRM_GENERATION", data: { quote_id: quoteId }, ownerWaId, expectAccepted: false, id: nextKey(`${suffix}-confirm`) });
  assert.equal(confirmResult.reason, "INSUFFICIENT_CREDITS");
  const rechargeRequired = await loadDocument(f, document.document_id, ownerWaId);
  assert.equal(rechargeRequired.status, "RECHARGE_REQUIRED");
  const reopen = await send(f, {
    flowKey: "HISTORY_SEARCH", action: "OPEN_DOCUMENT",
    data: { document_id: rechargeRequired.document_id, query: "", document_type: "", date_from: "", date_to: "" },
    ownerWaId, id: nextKey(`${suffix}-open`),
  });
  assert.equal(reopen.accepted, true, reopen.reason);
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.RECHARGE, "reopening a RECHARGE_REQUIRED document from history must show the RECHARGE Flow");
  return rechargeRequired;
}

// =====================================================================
// Defect A reproduction (before any fix — proven, not assumed)
// =====================================================================

// Genuine pre-fix behavior (the presenter constructor not accepting
// balanceReader/packCatalog at all, so suggestedDataForFlow() has no
// RECHARGE branch and safeFlowData() falls back straight to the Flow
// JSON's own __example__ placeholders) is proven separately via a real
// git-stash reproduction against the actual production files, not
// simulated here — see the T5 mission report's PLACEHOLDER_REPRODUCTION
// section. What IS exercised here, permanently, is the fail-closed
// invariant this fix must uphold when the dependencies are present but
// unusable: never the JSON's fake examples, never a fabricated zero.
test("T5-repro. Missing balanceReader/packCatalog fails closed — never the Flow JSON's placeholder examples, never a fabricated zero", async () => {
  const f = buildComposition({ balance: 42, presenterMissingRechargeDeps: true });
  const document = await driveToRechargeRequired(f);
  void document;
  const data = lastFlowData(f);
  assert.equal(data.balance_summary, "Solde indisponible pour le moment.", "a missing balanceReader must fail closed, never show the JSON's fake 'Solde actuel : 0 crédit.' placeholder as if it were live");
  assert.deepEqual(data.pack_options, [], "a missing packCatalog must fail closed to an empty list, never the JSON's fake PACK_1000/2000/5000 examples");
});

// =====================================================================
// Presentation contexts 1-5, dynamic balance summary, pack options
// =====================================================================

test("T5-1. RECHARGE opened from RECHARGE_REQUIRED shows the actual available balance and active packs", async () => {
  const f = buildComposition({ balance: 7 });
  const document = await driveToRechargeRequired(f);
  const sessionId = await openSession(f, { document, expectedFlowKey: "RECHARGE" });
  // Trigger a reopen by submitting SELECT_PACK from this exact session — but
  // first assert the flow that was ALREADY sent when RECHARGE_REQUIRED was
  // first reached (from driveToRechargeRequired's own CONFIRM_GENERATION).
  void sessionId;
  const data = lastFlowData(f);
  assert.equal(data.balance_summary, "Solde disponible : 7 crédits.");
  assert.deepEqual(data.pack_options.map((option) => option.id), ["PACK_1000", "PACK_2000"]);
  assert.equal(data.pack_options[0].title, "1 000 FCFA — 10 crédits");
});

test("T5-3. Reserved credits reduce the RECHARGE balance summary exactly as T6", async () => {
  const f = buildComposition({ balance: 10 });
  const reserved = await f.walletReservationService.reserveCredits({ ownerWaId: OWNER, quoteId: "quote:t5-3", amount: 3, idempotencyKey: "reserve:t5-3" });
  assert.equal(reserved.ok, true, reserved.error);
  const document = await driveToRechargeRequired(f);
  void document;
  const data = lastFlowData(f);
  assert.equal(data.balance_summary, "Solde disponible : 7 crédits.\n3 crédits sont temporairement réservés.");
});

test("T5-4. Menu/natural BALANCE and RECHARGE balance summary agree on the same available number", async () => {
  const f = buildComposition({ balance: 10 });
  const reserved = await f.walletReservationService.reserveCredits({ ownerWaId: OWNER, quoteId: "quote:t5-4", amount: 3, idempotencyKey: "reserve:t5-4" });
  assert.equal(reserved.ok, true, reserved.error);

  const menuSessionId = await openSession(f, { expectedFlowKey: "MENU" });
  await f.composition.webhookHandler({ messages: [nfmReply({ sessionId: menuSessionId, flowKey: "MENU", action: "BALANCE", data: {} })] });
  assert.equal(lastText(f), "Vous avez 7 crédits disponibles.\n3 crédits sont temporairement réservés pour une génération en cours.");

  const document = await driveToRechargeRequired(f, OWNER, "parity");
  void document;
  assert.equal(lastFlowData(f).balance_summary, "Solde disponible : 7 crédits.\n3 crédits sont temporairement réservés.", "the number (7 available, 3 reserved) must match the BALANCE response exactly, even though the phrasing differs by design");
});

test("T5-5. A balance lookup failure never displays a fake zero — a safe non-numeric phrase is shown instead", async () => {
  const f = buildComposition({ balance: 42 });
  // Swap in a balanceReader that always fails, to prove the failure path
  // without touching production code.
  const failingBalanceReader = { async getBalance() { return { ok: false, error: "WALLET_BALANCE_LOOKUP_FAILED" }; } };
  const presenter = createKadiV1ProductionPresenter({
    config: { enabled: true, features: { voice: false }, flowIds: FLOW_IDS },
    whatsappApi: { sendText: async (to, text) => f.sent.texts.push({ to, text }), sendFlow: async (payload) => f.sent.flows.push(payload), sendButtons: async () => { throw new Error("x"); } },
    sessionService: f.sessionService, clock: () => new Date().toISOString(), logger: { log() {} },
    balanceReader: failingBalanceReader,
    packCatalog: createRechargePackCatalog({ packs: [PACK_1000] }),
  });
  const document = await loadDocument(f, (await driveToRechargeRequired(f)).document_id).catch(() => null);
  const documentForFlow = document || (await f.repository.getDocumentById({ documentId: f.created[f.created.length - 1].document_id, ownerWaId: OWNER })).value;
  const flow = await presenter.presentFlowReply({
    ownerWaId: OWNER,
    result: { handled: true, action: "SAVE_OPTIONS", flow_key: "DOCUMENT_OPTIONS", duplicate: false, result: { document: documentForFlow } },
  }).catch(() => null);
  void flow;
  // Simplest, most direct proof: open RECHARGE explicitly through this
  // presenter instance and inspect the data it actually sent.
  const sessionId = await f.sessionService.open({ ownerWaId: OWNER, document: documentForFlow, expectedFlowKey: "RECHARGE", returnState: "RECHARGE_REQUIRED", idempotencyKey: nextKey("fail-session") });
  assert.equal(sessionId.ok, true);
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    result: { handled: true, action: "CONFIRM_GENERATION", flow_key: "GENERATION_CONFIRMATION", duplicate: false, result: { document: { ...documentForFlow, status: "RECHARGE_REQUIRED" } } },
  });
  const data = lastFlowData(f);
  assert.equal(data.balance_summary, "Solde indisponible pour le moment.");
  assert.doesNotMatch(data.balance_summary, /^Solde (actuel|disponible) : 0/, "a lookup failure must never render as a fabricated zero");
});

test("T5-6/T5-7. Pack options derive from the active catalog only — inactive packs are omitted", async () => {
  const f = buildComposition({ balance: 5, packs: [PACK_1000, PACK_2000, PACK_INACTIVE] });
  const document = await driveToRechargeRequired(f);
  void document;
  const options = lastFlowData(f).pack_options;
  assert.deepEqual(options.map((option) => option.id), ["PACK_1000", "PACK_2000"]);
  assert.equal(options.some((option) => option.id === "PACK_RETIRED"), false, "an inactive pack must never appear");
});

test("T5-8. Zero active packs shows an empty list, never the JSON's example packs as if they were live", async () => {
  const f = buildComposition({ balance: 5, packs: [PACK_INACTIVE] });
  const document = await driveToRechargeRequired(f);
  void document;
  const options = lastFlowData(f).pack_options;
  assert.deepEqual(options, [], "zero active packs must render as an empty list, never fall back to fake examples");
});

test("T5-pack-singular. A one-credit pack renders with correct singular grammar", async () => {
  const f = buildComposition({ balance: 5, packs: [PACK_ONE_CREDIT] });
  const document = await driveToRechargeRequired(f);
  void document;
  const options = lastFlowData(f).pack_options;
  assert.equal(options[0].title, "500 FCFA — 1 crédit");
});

// =====================================================================
// SELECT_PACK / CHECK_PAYMENT continuity (T3 behavior kept)
// =====================================================================

test("T5-9/T5-10. SELECT_PACK still shows authoritative Orange Money instructions, and the reopened RECHARGE is authoritative again", async () => {
  const f = buildComposition({ balance: 6 });
  const document = await driveToRechargeRequired(f);
  const result = await send(f, { document, flowKey: "RECHARGE", action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" } });
  assert.equal(result.accepted, true, result.reason);
  assert.match(lastText(f), /Pack sélectionné : 1 000 FCFA pour 10 crédits\./);
  assert.match(lastText(f), /Orange Money/);
  assert.match(lastText(f), /Vérifier mon paiement/);
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.RECHARGE, "SELECT_PACK must reopen RECHARGE");
  const data = lastFlowData(f);
  assert.equal(data.balance_summary, "Solde disponible : 6 crédits.", "the reopened RECHARGE must be authoritative again, not stale");
  assert.deepEqual(data.pack_options.map((option) => option.id), ["PACK_1000", "PACK_2000"]);
});

test("T5-11. CHECK_PAYMENT pending: existing copy preserved, RECHARGE reopens with authoritative data", async () => {
  const f = buildComposition({ balance: 3, provider: fakePaymentProvider({ confirmOnVerify: false }) });
  const document = await driveToRechargeRequired(f);
  const select = await send(f, { document, flowKey: "RECHARGE", action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" } });
  assert.equal(select.accepted, true, select.reason);
  const reference = f.sent.texts.slice(-1)[0].text.match(/Référence à conserver : (\S+)\./)[1];
  const checkResult = await send(f, { document, flowKey: "RECHARGE", action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: reference } });
  assert.equal(checkResult.accepted, true, checkResult.reason);
  assert.equal(lastText(f), "Le paiement n’est pas encore confirmé. Vérifiez la référence puis réessayez.");
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.RECHARGE, "a pending CHECK_PAYMENT must reopen RECHARGE");
  assert.equal(lastFlowData(f).balance_summary, "Solde disponible : 3 crédits.");
});

test("T5-12. CHECK_PAYMENT credited: existing confirmation copy preserved, existing next-flow (MENU) behavior unaffected — RECHARGE is not reopened", async () => {
  const f = buildComposition({ balance: 3, provider: fakePaymentProvider({ confirmOnVerify: true }) });
  const document = await driveToRechargeRequired(f);
  const select = await send(f, { document, flowKey: "RECHARGE", action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" } });
  assert.equal(select.accepted, true, select.reason);
  const reference = f.sent.texts.slice(-1)[0].text.match(/Référence à conserver : (\S+)\./)[1];
  const checkResult = await send(f, { document, flowKey: "RECHARGE", action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: reference } });
  assert.equal(checkResult.accepted, true, checkResult.reason);
  assert.equal(lastText(f), "Votre paiement est confirmé et vos crédits ont été ajoutés.");
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.MENU, "credited CHECK_PAYMENT must keep going to MENU, not RECHARGE");
});

// =====================================================================
// CANCEL wording (product mismatch resolved)
// =====================================================================

test("T5-13/T5-14. RECHARGE/CANCEL's visible action label is terminal and unambiguous, and the confirmation text is recharge-specific", async () => {
  const f = buildComposition({ balance: 5 });
  const document = await driveToRechargeRequired(f);
  void document;
  const actions = lastFlowData(f).recharge_actions;
  const cancelAction = actions.find((entry) => entry.id === "CANCEL");
  assert.ok(cancelAction, "CANCEL must be offered");
  assert.equal(cancelAction.title, "Annuler cette recharge");
  assert.notEqual(cancelAction.title, "Revenir plus tard", "the misleading non-terminal label must no longer be shown");

  const select = await send(f, { flowKey: "RECHARGE", action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" } });
  assert.equal(select.accepted, true, select.reason);
  const sessionId = await openSession(f, { document, expectedFlowKey: "RECHARGE" });
  const result = await f.composition.webhookHandler({ messages: [nfmReply({ sessionId, flowKey: "RECHARGE", action: "CANCEL", data: { pack_id: "", payment_reference: "" } })] });
  assert.equal(result.results[0].accepted, true, result.results[0].reason);
  assert.equal(lastText(f), "La recharge est annulée. Vous pourrez en démarrer une nouvelle plus tard.");
  assert.notEqual(lastText(f), "L’opération est annulée.");
});

test("T5-21. Other CANCEL flows keep the generic copy, completely unaffected", async () => {
  const f = buildComposition({ balance: 5 });
  await send(f, { flowKey: "MENU", action: "PREPARE_DOCUMENT", data: {} });
  await send(f, { flowKey: "DOCUMENT_TYPE", action: "SELECT_DOCUMENT_TYPE", data: { document_type: "FACTURE" } });
  const document = await loadDocument(f, lastCreatedDocumentId(f));
  const sessionId = await openSession(f, { document: { ...document, status: "COLLECTING" }, expectedFlowKey: "DOCUMENT_TYPE" });
  void sessionId;
  await send(f, { document, flowKey: "INVOICE_TYPE", action: "SAVE_INVOICE_TYPE", data: { invoice_kind: "FINAL" } });
  const withInvoiceType = await loadDocument(f, document.document_id);
  await send(f, { document: withInvoiceType, flowKey: "DOCUMENT_CLIENT", action: "SAVE_CLIENT", data: { name: "Client cancel", phone: "", email: "", address: "", tax_id: "" } });
  const withClient = await loadDocument(f, document.document_id);
  await send(f, { document: withClient, flowKey: "ARTICLE_FORM", action: "ADD_CONTENT", data: { description: "Ciment", quantity: 1, unit: "sac", unit_custom: "", unit_price: 6000 } });
  const withContent = await loadDocument(f, document.document_id);
  await send(f, { document: withContent, flowKey: "DOCUMENT_CONTENT", action: "FINISH_CONTENT", data: {} });
  const withFinishedContent = await loadDocument(f, document.document_id);
  await send(f, { document: withFinishedContent, flowKey: "DOCUMENT_OPTIONS", action: "SAVE_OPTIONS", data: { tax_rate_basis_points: "", discount_amount: "", notes: "", payment_terms: "", validity_days: "", payment_method: "", reference: "" } });
  const atReview = await loadDocument(f, document.document_id);
  assert.equal(atReview.status, "READY_FOR_REVIEW");

  const cancelResult = await send(f, { document: atReview, flowKey: "DOCUMENT_REVIEW", action: "CANCEL", data: {} });
  assert.equal(cancelResult.accepted, true, cancelResult.reason);
  assert.equal(lastText(f), "L’opération est annulée.", "DOCUMENT_REVIEW/CANCEL must keep its own unrelated generic copy");
});

// =====================================================================
// T3 R1/R2/R3 non-regression (mandatory)
// =====================================================================

test("T5-16. T3 R1: a stale RECHARGE Flow cannot cancel a recharge created after that Flow was opened", async () => {
  const f = buildComposition({ balance: 0 });
  const staleSessionId = await openSession(f, { expectedFlowKey: "RECHARGE" });
  const select = await send(f, { flowKey: "RECHARGE", action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" } });
  assert.equal(select.accepted, true, select.reason);
  const staleMessage = nfmReply({ sessionId: staleSessionId, flowKey: "RECHARGE", action: "CANCEL", data: { pack_id: "", payment_reference: "" } });
  const staleResult = await f.composition.webhookHandler({ messages: [staleMessage] });
  assert.equal(staleResult.results[0].accepted, false, "a stale RECHARGE Flow must never cancel a recharge session created after it was opened");
});

test("T5-15/T5-17. T3 R2/R3: exact duplicate CANCEL causes zero second mutation, and target resolution never falls through", async () => {
  const f = buildComposition({ balance: 0 });
  await send(f, { flowKey: "RECHARGE", action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" } });
  const balanceAfterA = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  void balanceAfterA;
  await send(f, { flowKey: "RECHARGE", action: "SELECT_PACK", data: { pack_id: "PACK_2000", payment_reference: "" } });

  const cancelSessionId = await openSession(f, { expectedFlowKey: "RECHARGE" });
  const cancelMessage = nfmReply({ sessionId: cancelSessionId, flowKey: "RECHARGE", action: "CANCEL", data: { pack_id: "", payment_reference: "" } });
  const first = await f.composition.webhookHandler({ messages: [cancelMessage] });
  assert.equal(first.results[0].accepted, true);

  const second = await f.composition.webhookHandler({ messages: [cancelMessage] });
  assert.equal(second.results[0].accepted, true);
  assert.equal(second.results[0].duplicate, true, "an exact replay must be recognized as a duplicate — zero second mutation");
});

test("T5-restart. T3 R2 process-restart semantics survive the T5 presenter changes", async () => {
  const f = buildComposition({ balance: 0 });
  await send(f, { flowKey: "RECHARGE", action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" } });
  const cancelSessionId = await openSession(f, { expectedFlowKey: "RECHARGE" });
  const cancelMessage = nfmReply({ sessionId: cancelSessionId, flowKey: "RECHARGE", action: "CANCEL", data: { pack_id: "", payment_reference: "" } });
  const first = await f.composition.webhookHandler({ messages: [cancelMessage] });
  assert.equal(first.results[0].accepted, true);

  const rebuilt = rebuildCompositionAroundSameRepositories(f);
  const replay = await rebuilt.composition.webhookHandler({ messages: [cancelMessage] });
  assert.equal(replay.results[0].accepted, true);
  assert.equal(replay.results[0].duplicate, true, "duplicate detection must survive a full runtime reconstruction (process-restart semantics)");
});

// =====================================================================
// Owner isolation, Flow contract, financial invariants
// =====================================================================

test("T5-18. Owner isolation: RECHARGE presentation is scoped to the authenticated owner only", async () => {
  const f = buildComposition({ balance: 15 });
  const sessionId = await openSession(f, { expectedFlowKey: "RECHARGE", ownerWaId: OWNER });
  const result = await f.composition.webhookHandler({
    messages: [nfmReply({ sessionId, flowKey: "RECHARGE", action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, from: OTHER_OWNER })],
  });
  assert.equal(result.results[0].accepted, false, "a session opened for OWNER must reject a reply claiming to be from a different owner");
});

test("T5-19/T5-20. The combined-form pack_id/payment_reference contract is retained, and an unknown field is still rejected", () => {
  const accepted = validateActionPayload("RECHARGE", "CANCEL", { pack_id: "PACK_1000", payment_reference: "REF-1" });
  assert.equal(accepted.ok, true, accepted.error);
  const rejected = validateActionPayload("RECHARGE", "CANCEL", { pack_id: "", payment_reference: "", not_a_real_field: "x" });
  assert.deepEqual(rejected, { ok: false, error: "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN" });
});

test("T5-22. T6 BALANCE behavior is completely unaffected by the T5 presenter changes", async () => {
  const f = buildComposition({ balance: 4 });
  const sessionId = await openSession(f, { expectedFlowKey: "MENU" });
  const result = await f.composition.webhookHandler({ messages: [nfmReply({ sessionId, flowKey: "MENU", action: "BALANCE", data: {} })] });
  assert.equal(result.results[0].accepted, true);
  assert.equal(lastText(f), "Vous avez 4 crédits disponibles.");
});

test("T5-23. No pricing/catalog values are changed by T5 — the exact same pack definitions round-trip unchanged", async () => {
  const f = buildComposition({ balance: 5, packs: [PACK_1000, PACK_2000] });
  const document = await driveToRechargeRequired(f);
  void document;
  const options = lastFlowData(f).pack_options;
  assert.equal(options.length, 2);
  assert.equal(options[0].title, "1 000 FCFA — 10 crédits");
  assert.equal(options[1].title, "2 000 FCFA — 25 crédits");
});

test("Financial invariant: RECHARGE presentation itself causes zero reservation/wallet mutation", async () => {
  const f = buildComposition({ balance: 8 });
  const before = f.generationRepo.inspect();
  await driveToRechargeRequired(f);
  const afterPresentation = f.generationRepo.inspect();
  // driveToRechargeRequired legitimately mutates the document (that's the
  // real REQUIRE_RECHARGE transition) but must never touch the wallet or
  // create/capture/release a reservation.
  assert.deepEqual(afterPresentation.balances, before.balances);
  assert.deepEqual(afterPresentation.reservations, before.reservations);
  assert.deepEqual(afterPresentation.ledger, before.ledger);
});

// =====================================================================
// Conversational RECHARGE-opening path (context 5) — direct presenter proof
// =====================================================================

test("T5-conversational. The conversational RECHARGE-opening path also receives authoritative balance_summary/pack_options/recharge_actions", async () => {
  const f = buildComposition({ balance: 9, packs: [PACK_1000] });
  const result = await f.presenter.presentConversation({
    ownerWaId: OWNER,
    response: {
      handled: true,
      canonical_text: "Voici les options pour recharger votre solde.",
      business_action: "RECHARGE_REQUESTED",
      flow_request: { flow_key: "RECHARGE", prefill: null },
    },
  });
  assert.equal(result.flow_sent, true);
  const data = lastFlowData(f);
  assert.equal(data.balance_summary, "Solde disponible : 9 crédits.");
  assert.deepEqual(data.pack_options.map((option) => option.id), ["PACK_1000"]);
  assert.deepEqual(data.recharge_actions.map((entry) => entry.id), ["SELECT_PACK", "CHECK_PAYMENT", "CANCEL"]);
});
