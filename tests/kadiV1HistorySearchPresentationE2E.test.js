"use strict";

// Production-composition test for the Flow SEARCH result-presentation fix:
// nfm_reply(SEARCH) -> Flow reply runtime -> history search -> production
// presenter -> visible result list (real kadi_history_search_v1.json
// history_options contract) -> nfm_reply(OPEN_DOCUMENT, picking one of the
// presented options) -> authoritative actions -> "Réenvoyer le PDF" for the
// recoverable document. Only true I/O boundaries (WhatsApp send calls, the
// delivery provider, the PDF renderer/storage) are faked.

const test = require("node:test");
const assert = require("node:assert/strict");
const { PDFDocument } = require("pdf-lib");
const { createDocumentDomain, DOCUMENT_EVENTS } = require("../kadiV1DocumentDomain");
const { createInMemoryV1DocumentRepository } = require("../kadiV1DocumentRepository");
const { createInMemoryV1PreviewRepository } = require("../kadiV1PreviewRepository");
const { createInMemoryGenerationLifecycleRepository } = require("../kadiV1GenerationLifecycleRepository");
const { createWalletReservationService } = require("../kadiV1WalletReservationService");
const { createFinalGenerationService, createInMemoryFinalFileStorage } = require("../kadiV1FinalGenerationService");
const { createDeliveryService } = require("../kadiV1DeliveryService");
const { createGenerationLifecycleService } = require("../kadiV1GenerationLifecycleService");
const { createKadiV1GenerationRuntimeAdapter, createKadiV1HistoryRuntimeAdapter } = require("../kadiV1RuntimeAdapters");
const { createKadiV1DeliveryRetryRuntime } = require("../kadiV1DeliveryRetryRuntime");
const { createKadiV1FlowCommandRuntime } = require("../kadiV1FlowCommandRuntime");
const { createKadiV1FlowReplyRuntime } = require("../kadiV1FlowReplyRuntime");
const { createKadiV1ProductionPresenter } = require("../kadiV1ProductionPresenter");
const { createV1HistoryService } = require("../kadiV1HistoryService");
const { createConversationSessionService, createMemoryConversationSessionRepository } = require("../kadiV1ConversationSession");
const { createKadiV1ProductionComposition } = require("../kadiV1ProductionComposition");

const OWNER = "22670000000";
const DOCUMENT_ID = "doc:searchable01";
const ISSUED_AT = "2026-08-07T02:00:00.000Z";

const FLOW_IDS = Object.freeze({
  ONBOARDING: "100001", MENU: "100002", DOCUMENT_TYPE: "100003", INVOICE_TYPE: "100017", RECEIPT_DETAILS: "100018",
  DOCUMENT_CLIENT: "100004", DOCUMENT_CONTENT: "100005", ARTICLE_FORM: "100016", DOCUMENT_OPTIONS: "100006",
  DOCUMENT_REVIEW: "100007", EDIT_CLIENT: "100008", EDIT_CONTENT: "100009", EDIT_OPTIONS: "100010",
  DOCUMENT_PREVIEW: "100011", GENERATION_CONFIRMATION: "100012", RECHARGE: "100013", HISTORY_SEARCH: "100014",
  DISCHARGE_DETAILS: "100015",
});

async function pdf() {
  const document = await PDFDocument.create();
  document.addPage();
  return Buffer.from(await document.save());
}

function stubPort(methods) {
  const port = {};
  for (const method of methods) port[method] = async () => { throw new Error(`UNEXPECTED_CALL:${method}`); };
  return port;
}

function buildHistoryRepository({ documents, generationRepository }) {
  return {
    async searchOwnedDocuments({ ownerWaId }) {
      const all = documents.inspectAll ? documents.inspectAll() : [];
      const owned = all.filter((doc) => doc.__ownerWaId === ownerWaId);
      return { ok: true, value: owned.map((doc) => bundleFor(doc, generationRepository)) };
    },
    async getOwnedDocumentBundle({ ownerWaId, documentId }) {
      const doc = await documents.getDocumentById({ documentId, ownerWaId });
      if (!doc.ok) return doc;
      return { ok: true, value: bundleFor(doc.value, generationRepository) };
    },
    async findDuplicateByIdempotencyKey() { return { ok: true, value: null }; },
    async rememberDuplicate() { return { ok: true, value: null }; },
  };
}

function bundleFor(document, generationRepository) {
  const state = generationRepository.inspect();
  const finalFileRow = state.finalFiles.find((entry) => entry.document_id === document.document_id) || null;
  const deliveryRow = finalFileRow ? state.deliveries.find((entry) => entry.final_file_id === finalFileRow.final_file_id) || null : null;
  return {
    classification: "V1_NATIVE",
    document,
    current_snapshot: document,
    versions: [],
    events: [],
    final_file: finalFileRow,
    delivery: deliveryRow ? { status: deliveryRow.status, attempt_count: deliveryRow.attempt_count, last_error_code: deliveryRow.last_error_code } : null,
  };
}

async function buildComposition() {
  const clock = () => ISSUED_AT;
  const domain = createDocumentDomain({ clock });
  const realDocuments = createInMemoryV1DocumentRepository();
  const seen = [];
  const documents = {};
  for (const key of Object.keys(realDocuments)) documents[key] = realDocuments[key];
  documents.createDocument = async (args) => {
    const result = await realDocuments.createDocument(args);
    if (result.ok) seen.push({ ...result.value, __ownerWaId: args.ownerWaId });
    return result;
  };
  documents.inspectAll = () => seen;

  const artifacts = createInMemoryV1PreviewRepository();
  let document = domain.createDocument({
    document_id: DOCUMENT_ID, document_type: "FACTURE", issuer_profile_id: "issuer:1", currency: "XOF",
    client: { name: "Client Recherché" }, items: [{ item_id: "item:1", description: "Service", quantity_millis: 1000, unit_price: 5000 }],
    options: { invoice_kind: "FINAL" },
  }).value;
  await documents.createDocument({ document, ownerWaId: OWNER, idempotencyKey: "doc:search:create" });
  for (const [event, payload, key] of [
    [DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW, {}, "ready"], [DOCUMENT_EVENTS.VERIFY, {}, "verify"],
    [DOCUMENT_EVENTS.PREPARE_PREVIEW, { preview: { preview_id: "preview:search" } }, "preview"],
    [DOCUMENT_EVENTS.CALCULATE_COST, { generation_quote: { quote_id: "quote:search", document_version: 1, page_count: 1, credit_cost: 4 } }, "cost"],
    [DOCUMENT_EVENTS.REQUEST_GENERATION_CONFIRMATION, {}, "await"],
  ]) {
    const next = domain.transitionDocument(document, event, payload).value;
    document = (await documents.persistTransition({ document: next, ownerWaId: OWNER, expectedVersion: 1, fromState: document.status, eventType: `TEST_${key.toUpperCase()}`, idempotencyKey: `doc:search:${key}` })).value;
  }
  const preview = { preview_id: "preview:search", document_id: DOCUMENT_ID, document_version: 1, owner_wa_id: OWNER, status: "ACTIVE", structured_preview: { document_type: "FACTURE", items: [], total: 5000 } };
  await artifacts.createPreview({ preview, idempotencyKey: "preview:search:create" });
  const render = { render_id: "render:search", preview_id: preview.preview_id, document_id: DOCUMENT_ID, document_version: 1, owner_wa_id: OWNER, status: "INSPECTED", page_count: 1 };
  await artifacts.createTemporaryRender({ render, idempotencyKey: "render:search:create" });
  const quote = { quote_id: "quote:search", document_id: DOCUMENT_ID, document_version: 1, owner_wa_id: OWNER, preview_id: preview.preview_id, temporary_render_id: render.render_id, page_count: 1, total_credits: 4, pricing_version: "test-v1", status: "ACTIVE", expires_at: "2026-08-07T03:00:00.000Z" };
  await artifacts.createGenerationQuote({ quote, idempotencyKey: "quote:search:create" });

  const generationRepository = createInMemoryGenerationLifecycleRepository({ balances: { [OWNER]: 20 } });
  const wallet = createWalletReservationService({ repository: generationRepository, clock });
  const finalStorage = createInMemoryFinalFileStorage();
  const renderer = { render: async () => ({ ok: true, value: { buffer: await pdf(), mime_type: "application/pdf" } }) };
  const finalGeneration = createFinalGenerationService({ repository: generationRepository, storage: finalStorage, renderer, clock });
  const provider = { async deliverDocument() { return { ok: false, error: "DELIVERY_DESTINATION_LOOKUP_FAILED" }; }, async getDeliveryStatus() { return { ok: true, value: null }; } };
  const deliveryService = createDeliveryService({ repository: generationRepository, provider, clock });
  const quoteService = { async validateGenerationQuote({ quoteId, ownerWaId }) {
    const result = await artifacts.getGenerationQuote({ quoteId });
    if (!result.ok || result.value.owner_wa_id !== ownerWaId || result.value.status !== "ACTIVE") return { ok: false, error: "GENERATION_QUOTE_NOT_ACTIVE" };
    return result;
  } };
  const lifecycleService = createGenerationLifecycleService({
    documentRepository: documents, previewRepository: artifacts, generationRepository, quoteService,
    walletReservationService: wallet, finalGenerationService: finalGeneration, deliveryService, domain, clock,
  });
  const confirmed = await lifecycleService.confirmGeneration({ documentId: DOCUMENT_ID, documentVersion: 1, quoteId: "quote:search", ownerWaId: OWNER, idempotencyKey: "confirm:search" });
  assert.equal(confirmed.ok, false);
  assert.equal(confirmed.error, "DELIVERY_RECOVERABLE_FAILURE");

  const generationRuntime = createKadiV1GenerationRuntimeAdapter({ generationLifecycleService: lifecycleService });
  const deliveryRetryRuntime = createKadiV1DeliveryRetryRuntime({ generationRuntime });
  const historyRepository = buildHistoryRepository({ documents, generationRepository });
  const historyService = createV1HistoryService({ historyRepository, documentRepository: documents, clock });
  const historyRuntime = createKadiV1HistoryRuntimeAdapter({ historyService });

  const commandRuntime = createKadiV1FlowCommandRuntime({
    onboardingRuntime: stubPort(["continueOnboarding"]),
    documentRuntime: stubPort([
      "start", "setInvoiceKind", "setReceiptDetails", "setClient", "startAddContent", "addContent", "updateContent",
      "removeContent", "finishContent", "setOptions", "verify", "beginEdit", "saveForLater", "saveDischargeDetails", "cancel",
    ]),
    previewRuntime: stubPort(["prepare"]),
    generationRuntime,
    rechargeRuntime: stubPort(["selectPack", "checkPayment", "cancel"]),
    historyRuntime,
    walletRuntime: stubPort(["getBalance"]),
  });
  const sessionService = createConversationSessionService({ repository: createMemoryConversationSessionRepository(), clock });
  const flowReplyRuntime = createKadiV1FlowReplyRuntime({ sessionService, commandRuntime });

  const sent = { buttons: [], texts: [], flows: [] };
  const whatsappApi = {
    async sendText(to, text) { sent.texts.push({ to, text }); },
    async sendButtons(to, body, buttons) { sent.buttons.push({ to, body, buttons }); },
    async sendFlow(payload) { sent.flows.push(payload); },
  };
  const presenter = createKadiV1ProductionPresenter({
    config: { enabled: true, features: { voice: false }, flowIds: FLOW_IDS },
    whatsappApi, sessionService, clock, logger: { log() {} },
  });
  const config = { enabled: true, features: { webhook: true }, rollout: { mode: "FULL", valid: true, canaryOwnerCount: 0, canaryWaIds: [] } };
  const composition = createKadiV1ProductionComposition({
    config,
    components: { orchestrator: stubPort(["handle"]), flowReplyRuntime, mediaResolver: stubPort(["resolveAudio", "resolveImage", "resolvePdf"]), presenter, deliveryRetryRuntime },
    logger: { warn() {}, log() {} },
  });
  assert.equal(composition.readiness.ready, true);
  return { composition, sessionService, sent, documents };
}

function nfmReply(sessionId, flowKey, action, data) {
  return {
    id: `wamid.${action}`, from: OWNER, type: "interactive",
    interactive: { type: "nfm_reply", nfm_reply: { response_json: JSON.stringify({ session_id: sessionId, flow_key: flowKey, action, data, flow_token: sessionId }) } },
  };
}

test("E2E: SEARCH result list is presented and the owner can open a document from it, reaching the retry offer — full real chain, no forged eligibility", async () => {
  const f = await buildComposition();

  const searchSession = await f.sessionService.open({ ownerWaId: OWNER, expectedFlowKey: "HISTORY_SEARCH", idempotencyKey: "session:search:1" });
  assert.equal(searchSession.ok, true, searchSession.error);
  const searchResult = await f.composition.webhookHandler({ messages: [nfmReply(searchSession.value.session_id, "HISTORY_SEARCH", "SEARCH", { query: "" })] });
  assert.equal(searchResult.handled, true);
  assert.equal(searchResult.results[0].accepted, true, searchResult.results[0].reason);

  const [searchText] = f.sent.texts.slice(-1);
  assert.match(searchText.text, /J.ai trouvé 1 document/);
  const [flowSent] = f.sent.flows.slice(-1);
  const payload = flowSent.interactive.action.parameters.flow_action_payload;
  assert.equal(payload.screen, "HISTORY_SEARCH");
  assert.equal(payload.data.history_options.length, 1);
  const offeredDocumentId = payload.data.history_options[0].id;
  assert.equal(offeredDocumentId, DOCUMENT_ID, "the presented option id must be the real, server-resolved document_id — never client-invented");

  // Owner picks the option and presses Continuer with action=OPEN_DOCUMENT.
  const openSession = await f.sessionService.open({ ownerWaId: OWNER, expectedFlowKey: "HISTORY_SEARCH", idempotencyKey: "session:search:2" });
  const openResult = await f.composition.webhookHandler({ messages: [nfmReply(openSession.value.session_id, "HISTORY_SEARCH", "OPEN_DOCUMENT", { document_id: offeredDocumentId })] });
  assert.equal(openResult.handled, true);
  assert.equal(openResult.results[0].accepted, true, openResult.results[0].reason);

  const [buttonsSent] = f.sent.buttons.slice(-1);
  assert.match(buttonsSent.body, /Réenvoyer le PDF/);
  assert.equal(buttonsSent.buttons[0].id, `RETRY_DELIVERY:${DOCUMENT_ID}`);
});

test("E2E: SEARCH with genuinely zero results for the owner states so honestly, no fabricated option list", async () => {
  const f = await buildComposition();
  // A different, unrelated owner has no documents at all.
  const otherOwner = "22679999999";
  const session = await f.sessionService.open({ ownerWaId: otherOwner, expectedFlowKey: "HISTORY_SEARCH", idempotencyKey: "session:search:empty" });
  const message = { ...nfmReply(session.value.session_id, "HISTORY_SEARCH", "SEARCH", { query: "" }), from: otherOwner };
  const result = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(result.handled, true);
  assert.equal(result.results[0].accepted, true, result.results[0].reason);
  const [lastText] = f.sent.texts.filter((entry) => entry.to === otherOwner).slice(-1);
  assert.equal(lastText.text, "Je n’ai trouvé aucun document correspondant. Donnez-moi un nom, un type de document ou une période.");
});
