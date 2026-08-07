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
const { createInMemoryV1HistoryRepository } = require("../kadiV1HistoryRepository");
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

// HISTORY-CONTRACT-001: searchOwnedDocuments now delegates to the real
// createInMemoryV1HistoryRepository (kadiV1HistoryRepository.js) instead of
// ignoring filters/cursor/limit/direction outright — the same reference
// filtering logic (document_type/counterparty/from/to/text/...) used
// elsewhere in tests/kadiV1HistorySearch.test.js, so a genuine date_from/
// date_to or document_type search is actually exercised through this real
// production chain rather than always returning every owned document.
function buildHistoryRepository({ documents, generationRepository }) {
  return {
    async searchOwnedDocuments({ ownerWaId, filters, cursor, limit, direction }) {
      const all = documents.inspectAll ? documents.inspectAll() : [];
      const owned = all.filter((doc) => doc.__ownerWaId === ownerWaId);
      const bundles = owned.map((doc) => bundleFor(doc, generationRepository, ownerWaId));
      const reference = createInMemoryV1HistoryRepository({ bundles });
      return reference.searchOwnedDocuments({ ownerWaId, filters, cursor, limit, direction });
    },
    async getOwnedDocumentBundle({ ownerWaId, documentId }) {
      const doc = await documents.getDocumentById({ documentId, ownerWaId });
      if (!doc.ok) return doc;
      return { ok: true, value: bundleFor(doc.value, generationRepository, ownerWaId) };
    },
    async findDuplicateByIdempotencyKey() { return { ok: true, value: null }; },
    async rememberDuplicate() { return { ok: true, value: null }; },
  };
}

function bundleFor(document, generationRepository, ownerWaId) {
  const state = generationRepository.inspect();
  const finalFileRow = state.finalFiles.find((entry) => entry.document_id === document.document_id) || null;
  const deliveryRow = finalFileRow ? state.deliveries.find((entry) => entry.final_file_id === finalFileRow.final_file_id) || null : null;
  // documents.createDocument()/getDocumentById() return the hydrated domain
  // snapshot, which (unlike the real repository's DB row) never carries its
  // own updated_at column — the real createInMemoryV1HistoryRepository
  // needs one to sort/compare. The document's own event log already
  // records exactly when it was last genuinely mutated (its clock at that
  // point), so the most recent event's occurred_at is the faithful
  // equivalent here.
  const updatedAt = document.updated_at || document.events?.at(-1)?.occurred_at || null;
  return {
    classification: "V1_NATIVE",
    owner_wa_id: ownerWaId || document.__ownerWaId,
    document: { ...document, updated_at: updatedAt },
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

// HISTORY-CONTRACT-001: kadi_history_search_v1.json's single combined form
// always submits query/document_type/date_from/date_to/document_id
// together, regardless of which action (SEARCH/OPEN_DOCUMENT) was chosen.
// Before this fix, SEARCH failed on the extra document_id field and
// OPEN_DOCUMENT failed on the extra query/document_type/date_from/date_to
// fields — every real submission of either action was rejected outright
// with KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN. This reproduces the exact real
// shape (including the stale query/date/type values the Flow's single
// screen still carries from the SEARCH step when the owner then presses
// Continuer with OPEN_DOCUMENT) end to end.
test("E2E: SEARCH result list is presented and the owner can open a document from it, reaching the retry offer — real combined-form payloads, full real chain, no forged eligibility", async () => {
  const f = await buildComposition();

  const searchSession = await f.sessionService.open({ ownerWaId: OWNER, expectedFlowKey: "HISTORY_SEARCH", idempotencyKey: "session:search:1" });
  assert.equal(searchSession.ok, true, searchSession.error);
  const searchResult = await f.composition.webhookHandler({ messages: [nfmReply(searchSession.value.session_id, "HISTORY_SEARCH", "SEARCH", {
    query: "", document_type: "", date_from: "", date_to: "", document_id: "",
  })] });
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
  // The real Flow's single screen still carries the query/document_type/
  // date_from/date_to values from the SEARCH step above — they must be
  // ignored, never influence which document opens.
  const openSession = await f.sessionService.open({ ownerWaId: OWNER, expectedFlowKey: "HISTORY_SEARCH", idempotencyKey: "session:search:2" });
  const openResult = await f.composition.webhookHandler({ messages: [nfmReply(openSession.value.session_id, "HISTORY_SEARCH", "OPEN_DOCUMENT", {
    query: "stale leftover text", document_type: "DEVIS", date_from: "2020-01-01", date_to: "2020-01-02", document_id: offeredDocumentId,
  })] });
  assert.equal(openResult.handled, true);
  assert.equal(openResult.results[0].accepted, true, openResult.results[0].reason);

  const [buttonsSent] = f.sent.buttons.slice(-1);
  assert.match(buttonsSent.body, /Réenvoyer le PDF/);
  assert.equal(buttonsSent.buttons[0].id, `RETRY_DELIVERY:${DOCUMENT_ID}`);
});

test("HISTORY-CONTRACT-001: OPEN_DOCUMENT with a blank document_id (nothing selected in the list) fails safely, never opens an arbitrary document", async () => {
  const f = await buildComposition();
  const session = await f.sessionService.open({ ownerWaId: OWNER, expectedFlowKey: "HISTORY_SEARCH", idempotencyKey: "session:search:blank-open" });
  const result = await f.composition.webhookHandler({ messages: [nfmReply(session.value.session_id, "HISTORY_SEARCH", "OPEN_DOCUMENT", {
    query: "", document_type: "", date_from: "", date_to: "", document_id: "",
  })] });
  assert.equal(result.handled, true);
  assert.equal(result.results[0].accepted, false, "a blank document_id must fail closed, not silently open something");
  assert.equal(result.results[0].reason, "KADI_V1_HISTORY_DOCUMENT_ID_INVALID");
});

test("HISTORY-CONTRACT-001: an unrelated field outside the real Flow contract is still rejected through the full webhook chain", async () => {
  const f = await buildComposition();
  const session = await f.sessionService.open({ ownerWaId: OWNER, expectedFlowKey: "HISTORY_SEARCH", idempotencyKey: "session:search:unknown-field" });
  const result = await f.composition.webhookHandler({ messages: [nfmReply(session.value.session_id, "HISTORY_SEARCH", "SEARCH", {
    query: "", document_type: "", date_from: "", date_to: "", document_id: "", not_a_real_field: "x",
  })] });
  assert.equal(result.handled, true);
  assert.equal(result.results[0].accepted, false);
});

test("E2E: SEARCH with genuinely zero results for the owner states so honestly, no fabricated option list", async () => {
  const f = await buildComposition();
  // A different, unrelated owner has no documents at all.
  const otherOwner = "22679999999";
  const session = await f.sessionService.open({ ownerWaId: otherOwner, expectedFlowKey: "HISTORY_SEARCH", idempotencyKey: "session:search:empty" });
  const message = { ...nfmReply(session.value.session_id, "HISTORY_SEARCH", "SEARCH", { query: "", document_type: "", date_from: "", date_to: "", document_id: "" }), from: otherOwner };
  const result = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(result.handled, true);
  assert.equal(result.results[0].accepted, true, result.results[0].reason);
  const [lastText] = f.sent.texts.filter((entry) => entry.to === otherOwner).slice(-1);
  assert.equal(lastText.text, "Je n’ai trouvé aucun document correspondant. Donnez-moi un nom, un type de document ou une période.");
});

// --- Multi-document filtering, ownership isolation and replay coverage ---
// A second, lighter composition: several plain draft documents (no paid
// generation lifecycle needed here — only SEARCH/OPEN_DOCUMENT are
// exercised), each created with its own fixed clock so updated_at genuinely
// differs, proving date_from/date_to filtering is real rather than merely
// accepted.

async function buildMultiDocumentComposition(entries) {
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

  for (const entry of entries) {
    const domain = createDocumentDomain({ clock: () => entry.updatedAt });
    const input = entry.type === "DECHARGE"
      ? { document_id: entry.documentId, document_type: "DECHARGE", issuer_profile_id: "issuer:1", currency: "XOF", discharge: { giver: "Remettant", receiver: entry.client, subject: { type: "MONEY", amount: 1000 }, reason: "Test" } }
      : entry.type === "RECU"
        ? { document_id: entry.documentId, document_type: "RECU", issuer_profile_id: "issuer:1", currency: "XOF", client: { name: entry.client }, receipt: { payer: entry.client, beneficiary: "Entreprise", amount: 1000, reason: "Paiement" } }
        : { document_id: entry.documentId, document_type: entry.type, issuer_profile_id: "issuer:1", currency: "XOF", client: { name: entry.client }, items: [{ item_id: `${entry.documentId}:item`, description: "Service", quantity_millis: 1000, unit_price: 5000 }] };
    const created = domain.createDocument(input);
    assert.equal(created.ok, true, created.error);
    const persisted = await documents.createDocument({ document: created.value, ownerWaId: entry.ownerWaId || OWNER, idempotencyKey: `create:${entry.documentId}` });
    assert.equal(persisted.ok, true, persisted.error);
  }

  const generationRepository = createInMemoryGenerationLifecycleRepository({ balances: { [OWNER]: 20 } });
  const historyRepository = buildHistoryRepository({ documents, generationRepository });
  const historyService = createV1HistoryService({ historyRepository, documentRepository: documents, clock: () => ISSUED_AT });
  const historyRuntime = createKadiV1HistoryRuntimeAdapter({ historyService });

  const commandRuntime = createKadiV1FlowCommandRuntime({
    onboardingRuntime: stubPort(["continueOnboarding"]),
    documentRuntime: stubPort([
      "start", "setInvoiceKind", "setReceiptDetails", "setClient", "startAddContent", "addContent", "updateContent",
      "removeContent", "finishContent", "setOptions", "verify", "beginEdit", "saveForLater", "saveDischargeDetails", "cancel",
    ]),
    previewRuntime: stubPort(["prepare"]),
    generationRuntime: stubPort(["confirm"]),
    rechargeRuntime: stubPort(["selectPack", "checkPayment", "cancel"]),
    historyRuntime,
    walletRuntime: stubPort(["getBalance"]),
  });
  const sessionService = createConversationSessionService({ repository: createMemoryConversationSessionRepository(), clock: () => ISSUED_AT });
  const flowReplyRuntime = createKadiV1FlowReplyRuntime({ sessionService, commandRuntime });

  const sent = { buttons: [], texts: [], flows: [] };
  const whatsappApi = {
    async sendText(to, text) { sent.texts.push({ to, text }); },
    async sendButtons(to, body, buttons) { sent.buttons.push({ to, body, buttons }); },
    async sendFlow(payload) { sent.flows.push(payload); },
  };
  const presenter = createKadiV1ProductionPresenter({
    config: { enabled: true, features: { voice: false }, flowIds: FLOW_IDS },
    whatsappApi, sessionService, clock: () => ISSUED_AT, logger: { log() {} },
  });
  const config = { enabled: true, features: { webhook: true }, rollout: { mode: "FULL", valid: true, canaryOwnerCount: 0, canaryWaIds: [] } };
  const composition = createKadiV1ProductionComposition({
    config,
    components: { orchestrator: stubPort(["handle"]), flowReplyRuntime, mediaResolver: stubPort(["resolveAudio", "resolveImage", "resolvePdf"]), presenter, deliveryRetryRuntime: stubPort(["handle"]) },
    logger: { warn() {}, log() {} },
  });
  assert.equal(composition.readiness.ready, true);
  return { composition, sessionService, sent, documents };
}

const MULTI = Object.freeze({
  invoice: { documentId: "doc:multi:invoice", type: "FACTURE", client: "Atelier Bois", updatedAt: "2026-01-10T09:00:00.000Z" },
  quote: { documentId: "doc:multi:quote", type: "DEVIS", client: "Atelier Bois", updatedAt: "2026-03-15T09:00:00.000Z" },
  receipt: { documentId: "doc:multi:receipt", type: "RECU", client: "Client Divers", updatedAt: "2026-05-20T09:00:00.000Z" },
});

let searchOnceCounter = 0;
async function searchOnce(f, ownerWaId, data) {
  searchOnceCounter += 1;
  const session = await f.sessionService.open({ ownerWaId, expectedFlowKey: "HISTORY_SEARCH", idempotencyKey: `session:search-once:${searchOnceCounter}` });
  assert.equal(session.ok, true, session.error);
  const message = { ...nfmReply(session.value.session_id, "HISTORY_SEARCH", "SEARCH", data), from: ownerWaId };
  const result = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(result.handled, true);
  assert.equal(result.results[0].accepted, true, result.results[0].reason);
  const [flowSent] = f.sent.flows.slice(-1);
  return flowSent ? flowSent.interactive.action.parameters.flow_action_payload.data.history_options : [];
}

test("HISTORY-CONTRACT-001: search by query/client narrows results to matching documents only", async () => {
  const f = await buildMultiDocumentComposition(Object.values(MULTI));
  const options = await searchOnce(f, OWNER, { query: "Atelier", document_type: "", date_from: "", date_to: "", document_id: "" });
  assert.deepEqual(options.map((entry) => entry.id).sort(), [MULTI.invoice.documentId, MULTI.quote.documentId].sort());
});

test("HISTORY-CONTRACT-001: search by document_type narrows results to that type only", async () => {
  const f = await buildMultiDocumentComposition(Object.values(MULTI));
  const options = await searchOnce(f, OWNER, { query: "", document_type: "DEVIS", date_from: "", date_to: "", document_id: "" });
  assert.deepEqual(options.map((entry) => entry.id), [MULTI.quote.documentId]);
});

test("HISTORY-CONTRACT-001: search by date_from/date_to genuinely narrows results — not silently ignored or rejected", async () => {
  const f = await buildMultiDocumentComposition(Object.values(MULTI));
  const options = await searchOnce(f, OWNER, { query: "", document_type: "", date_from: "2026-03-01", date_to: "2026-04-01", document_id: "" });
  assert.deepEqual(options.map((entry) => entry.id), [MULTI.quote.documentId], "only the document updated inside the real date range must be returned");
});

// HISTORY-CONTRACT-001 (R1 independent review, MEDIUM/merge blocker): the
// real HISTORY_SEARCH Flow's date_from/date_to fields submit a bare
// calendar date ("2026-04-01"), never a full timestamp — a document
// updated during the last day of the requested range must still be
// included, not silently excluded because a bare date parses as that
// day's exact midnight.
const DATE_BOUNDARY = Object.freeze({
  mar31: { documentId: "doc:boundary:mar31", type: "FACTURE", client: "Client Frontière", updatedAt: "2026-03-31T23:00:00.000Z" },
  apr01: { documentId: "doc:boundary:apr01", type: "FACTURE", client: "Client Frontière", updatedAt: "2026-04-01T10:00:00.000Z" },
  apr02: { documentId: "doc:boundary:apr02", type: "FACTURE", client: "Client Frontière", updatedAt: "2026-04-02T00:00:00.000Z" },
});

test("HISTORY-CONTRACT-001: a real same-day date_from/date_to search includes the document updated during the end date and excludes the next day", async () => {
  const f = await buildMultiDocumentComposition(Object.values(DATE_BOUNDARY));
  const options = await searchOnce(f, OWNER, { query: "", document_type: "", date_from: "2026-04-01", date_to: "2026-04-01", document_id: "" });
  assert.deepEqual(options.map((entry) => entry.id), [DATE_BOUNDARY.apr01.documentId], "a document updated at 10:00 on the requested end day must be included, not excluded by a midnight-only upper bound");
});

test("HISTORY-CONTRACT-001: an unconstrained search returns every owned document as real history_options — no placeholder", async () => {
  const f = await buildMultiDocumentComposition(Object.values(MULTI));
  const options = await searchOnce(f, OWNER, { query: "", document_type: "", date_from: "", date_to: "", document_id: "" });
  assert.equal(options.length, 3);
  assert.deepEqual(options.map((entry) => entry.id).sort(), Object.values(MULTI).map((entry) => entry.documentId).sort());
  for (const option of options) {
    assert.equal(typeof option.title, "string");
    assert.ok(option.title.length > 0);
    assert.doesNotMatch(option.title, /^document:example$/, "must never be the Flow schema's static placeholder option");
  }
});

test("HISTORY-CONTRACT-001: an owner can never open another owner's document by submitting its document_id — fails closed, not found", async () => {
  const f = await buildMultiDocumentComposition(Object.values(MULTI));
  const otherOwner = "22679999999";
  const session = await f.sessionService.open({ ownerWaId: otherOwner, expectedFlowKey: "HISTORY_SEARCH", idempotencyKey: "session:owner-mismatch-open" });
  const message = { ...nfmReply(session.value.session_id, "HISTORY_SEARCH", "OPEN_DOCUMENT", {
    query: "", document_type: "", date_from: "", date_to: "", document_id: MULTI.invoice.documentId,
  }), from: otherOwner };
  const result = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(result.handled, true);
  assert.equal(result.results[0].accepted, false, "a document_id belonging to a different owner must never open");
});

test("HISTORY-CONTRACT-001: a replayed SEARCH reply (same wamid) is recognized as a duplicate, no double side effect", async () => {
  const f = await buildMultiDocumentComposition(Object.values(MULTI));
  const session = await f.sessionService.open({ ownerWaId: OWNER, expectedFlowKey: "HISTORY_SEARCH", idempotencyKey: "session:replay-search" });
  const message = nfmReply(session.value.session_id, "HISTORY_SEARCH", "SEARCH", { query: "Atelier", document_type: "", date_from: "", date_to: "", document_id: "" });

  const first = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(first.results[0].accepted, true, first.results[0].reason);
  assert.equal(first.results[0].duplicate, false);

  const second = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(second.results[0].accepted, true, second.results[0].reason);
  assert.equal(second.results[0].duplicate, true, "an exact SEARCH replay must be recognized as a duplicate");
  assert.equal(f.sent.flows.length, 1, "the replay must never re-run the search or send a second Flow");
});

test("HISTORY-CONTRACT-001: a replayed OPEN_DOCUMENT reply (same wamid) is recognized as a duplicate, no double side effect", async () => {
  const f = await buildMultiDocumentComposition(Object.values(MULTI));
  const session = await f.sessionService.open({ ownerWaId: OWNER, expectedFlowKey: "HISTORY_SEARCH", idempotencyKey: "session:replay-open" });
  const message = nfmReply(session.value.session_id, "HISTORY_SEARCH", "OPEN_DOCUMENT", {
    query: "", document_type: "", date_from: "", date_to: "", document_id: MULTI.invoice.documentId,
  });

  const first = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(first.results[0].accepted, true, first.results[0].reason);
  assert.equal(first.results[0].duplicate, false);
  const textsAfterFirst = f.sent.texts.length;

  const second = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(second.results[0].accepted, true, second.results[0].reason);
  assert.equal(second.results[0].duplicate, true, "an exact OPEN_DOCUMENT replay must be recognized as a duplicate");
  assert.equal(f.sent.texts.length, textsAfterFirst, "the replay must never send a second message");
});
