"use strict";

// Production-composition regression coverage for GENERATION_CONFIRMATION-001
// (T4): kadi_generation_confirmation_v1.json is one combined form whose
// single Footer always submits quote_id, regardless of whether the chosen
// action is CONFIRM_GENERATION or CANCEL — before this fix, a real
// GENERATION_CONFIRMATION/CANCEL submission failed at the Flow reply
// boundary with KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN, the same defect class
// already fixed for RECHARGE-CONTRACT-001 (T3). quote_id is never authority
// for which document gets cancelled — the real document domain, shared
// pipeline, runtime adapters, flow command runtime, flow reply runtime,
// session service and presenter are wired exactly as in production, with a
// real preview/render/quote pipeline (in-memory storage) driving a real
// document all the way to AWAITING_GENERATION_CONFIRMATION. Only true I/O
// boundaries (WhatsApp send calls, and the unrelated onboarding/recharge/
// history/wallet/delivery-retry ports) are stubbed to throw on any call;
// generationRuntime.confirm is a recording spy (never a throw-on-call stub)
// because CONFIRM_GENERATION non-regression must be positively proven, not
// just assumed unreachable. See mission "KADI V1 — T4
// GENERATION_CONFIRMATION/CANCEL ROOT-CONTRACT FIX".

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

function fakeRenderer(pageCount = 1) {
  return { render: async () => ({ ok: true, value: { buffer: await pdfBuffer(pageCount), mime_type: "application/pdf", renderer: "TEST_RENDERER" } }) };
}

function buildComposition() {
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
    renderer: fakeRenderer(1),
    pageCountInspector: createPdfLibPageCountInspector({ clock }),
    clock,
    idFactory: (kind) => `${kind}:${nextKey(kind)}`,
    lifetimeSeconds: 600,
  });
  const pricingPolicy = createGenerationPricingPolicy({
    pricingVersion: "t4-test-v1",
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

  // generationRuntime.confirm MUST be a recording spy, not a throw-on-call
  // stub: CONFIRM_GENERATION non-regression (mission requirement) must be
  // positively exercised through the real Flow command runtime, not merely
  // assumed unreachable. retryDelivery has no reachable caller in any of
  // this file's scenarios and stays a throw-on-call stub.
  const generationConfirmCalls = [];
  const generationRuntime = {
    confirm: async (payload) => { generationConfirmCalls.push(payload); return { ok: true, value: { status: "GENERATION_IN_PROGRESS" } }; },
    retryDelivery: async () => { throw new Error("UNEXPECTED_CALL:retryDelivery"); },
  };

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
  return { composition, sessionService, sent, repository, created, generationConfirmCalls };
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

// Drives a real FACTURE from scratch all the way through PREPARE_PDF, so
// the document genuinely reaches AWAITING_GENERATION_CONFIRMATION with a
// real quote_id — the real preview/render/quote pipeline runs in full
// (in-memory storage only), never a hand-picked fixture document.
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
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.DOCUMENT_PREVIEW, "VERIFY must open DOCUMENT_PREVIEW");

  await send(f, { document, flowKey: "DOCUMENT_PREVIEW", action: "PREPARE_PDF", data: {}, ownerWaId, id: nextKey(`${suffix}-preparepdf`) });
  document = await loadDocument(f, document.document_id, ownerWaId);
  assert.equal(document.status, "AWAITING_GENERATION_CONFIRMATION", "PREPARE_PDF must reach AWAITING_GENERATION_CONFIRMATION through the real preview/render/quote pipeline");
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.GENERATION_CONFIRMATION, "PREPARE_PDF must open GENERATION_CONFIRMATION");

  const quoteId = lastFlowData(f).quote_id;
  assert.ok(quoteId, "a real quote_id must have been produced by the real quote service and surfaced to the Flow");
  return { document, quoteId };
}

// 16 (structural parity, before/after proof): the real Flow JSON must
// declare exactly quote_id in its single combined Footer for both actions,
// and validateActionPayload must accept CANCEL's real submission — this is
// the same reproduction as the unit-level parity test in
// tests/kadiV1FlowReplyRuntime.test.js, kept here too so the E2E suite is
// self-contained proof of the fixed contract.
test("T4-16. Flow/backend parity: the real kadi_generation_confirmation_v1.json contract is accepted for both declared actions", () => {
  const generationFlow = require("../flows/v1_draft/kadi_generation_confirmation_v1.json");
  const screen = generationFlow.screens[0];
  const footerPayload = screen.layout.children.find((child) => child.type === "Form")
    .children.find((child) => child.type === "Footer")["on-click-action"].payload;
  const submittedFields = Object.keys(footerPayload.data);
  assert.deepEqual(submittedFields, ["quote_id"]);
  const declaredActionIds = screen.data.confirmation_actions.__example__.map((entry) => entry.id);
  assert.deepEqual(declaredActionIds.sort(), ["CANCEL", "CONFIRM_GENERATION"].sort());
  for (const action of declaredActionIds) {
    const realSubmission = Object.fromEntries(submittedFields.map((field) => [field, "quote:example"]));
    const checked = validateActionPayload(screen.id, action, realSubmission);
    assert.equal(checked.ok, true, `declared action "${action}" must accept the real combined-form shape (got ${checked.error})`);
  }
});

// 1 & 2. Real GENERATION_CONFIRMATION/CANCEL payload with the real quote_id
// is accepted, uses the trusted server-side document context, transitions
// the document to CANCELLED, and causes zero generation/credit/delivery
// side effects.
test("T4-1/2. Real GENERATION_CONFIRMATION/CANCEL payload (real quote_id) is accepted, cancels the trusted session document, and causes no generation/credit/delivery side effects", async () => {
  const f = buildComposition();
  const { document, quoteId } = await buildFactureAwaitingConfirmation(f);

  const result = await send(f, { document, flowKey: "GENERATION_CONFIRMATION", action: "CANCEL", data: { quote_id: quoteId } });
  assert.equal(result.accepted, true, result.reason);

  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "CANCELLED");
  assert.equal(f.generationConfirmCalls.length, 0, "CANCEL must never call generationRuntime.confirm — zero START_GENERATION");

  const lastText = f.sent.texts.slice(-1)[0];
  assert.ok(lastText, "a confirmation text must have been sent");
  assert.doesNotMatch(lastText.text, /flow_token|payload|draft_id|quote_id/i, "user-facing text must never leak internal identifiers");
});

// 3 & 4. Two independent documents A and B owned by the same owner: A's
// CANCEL Flow must never cancel B, even when the payload carries B's real
// quote_id — quote_id is incidental payload, never a selector.
test("T4-3/4. A's GENERATION_CONFIRMATION/CANCEL never cancels B, even when the payload carries B's real quote_id", async () => {
  const f = buildComposition();
  const a = await buildFactureAwaitingConfirmation(f, OWNER, "docA");
  const b = await buildFactureAwaitingConfirmation(f, OWNER, "docB");
  assert.notEqual(a.document.document_id, b.document.document_id);

  const result = await send(f, {
    document: a.document, flowKey: "GENERATION_CONFIRMATION", action: "CANCEL",
    data: { quote_id: b.quoteId },
  });
  assert.equal(result.accepted, true, result.reason);

  const aAfter = await loadDocument(f, a.document.document_id);
  const bAfter = await loadDocument(f, b.document.document_id);
  assert.equal(aAfter.status, "CANCELLED", "A, the session-bound document, must be the one cancelled");
  assert.equal(bAfter.status, "AWAITING_GENERATION_CONFIRMATION", "B must remain completely untouched — B's own quote_id must never make it the cancellation target");
  assert.equal(bAfter.version, b.document.version, "B's version must be exactly unchanged");
});

// 5. Owner isolation: another WhatsApp owner can never use their own
// message to cancel someone else's document, exactly like every other Flow.
test("T4-5. Owner isolation: another owner's CANCEL submission against the real session is rejected before any document mutation", async () => {
  const f = buildComposition();
  const { document } = await buildFactureAwaitingConfirmation(f);
  const sessionId = await openSession(f, { document, expectedFlowKey: "GENERATION_CONFIRMATION", ownerWaId: OWNER });
  const result = await f.composition.webhookHandler({
    messages: [nfmReply({ sessionId, flowKey: "GENERATION_CONFIRMATION", action: "CANCEL", data: { quote_id: "quote:not-real" }, from: OTHER_OWNER })],
  });
  assert.equal(result.handled, true);
  assert.equal(result.results[0].accepted, false);

  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "AWAITING_GENERATION_CONFIRMATION", "owner mismatch must never mutate the real owner's document");
});

// 6. Stale Flow safety: a GENERATION_CONFIRMATION Flow session opened for
// document D must fail closed on CANCEL if D has already legitimately moved
// on before this session is submitted — never falling through to affect a
// different document, using the existing real server-side concurrency
// mechanism (never a client-controlled field).
//
// Confirmed by direct inspection of kadiV1DocumentDomain.js's
// transitionDocument (used by CANCEL and every other AWAITING_GENERATION_
// CONFIRMATION transition): pure state transitions never bump
// document.version — only content-modifying mutations do (SAVE_CLIENT,
// ADD_CONTENT, SAVE_OPTIONS, etc., via modifyDocument), and none of those
// are reachable once a document has already left review/preview for
// AWAITING_GENERATION_CONFIRMATION. So the real race a stale
// GENERATION_CONFIRMATION/CANCEL Flow can hit here is a STATE race, not a
// version race: the same server-side, non-client-controlled protection
// (loadMutation's fromState equality check, backed by the finite state
// machine's TRANSITIONS table, which has no CANCEL edge out of CANCELLED)
// fails it closed just as reliably — and there is no candidate-selection
// step to fall through in the first place, since the trusted session-bound
// document_id never changes regardless of the document's state.
test("T4-6. A stale GENERATION_CONFIRMATION/CANCEL Flow (document already moved on by a real, non-stale CANCEL) fails closed, never producing a second mutation", async () => {
  const f = buildComposition();
  const { document } = await buildFactureAwaitingConfirmation(f);

  // The stale session is opened while the document is still
  // AWAITING_GENERATION_CONFIRMATION.
  const staleSessionId = await openSession(f, { document, expectedFlowKey: "GENERATION_CONFIRMATION" });

  // A second, independent GENERATION_CONFIRMATION session for the exact
  // same document is opened and submitted first — a real, legitimate CANCEL
  // through the real production chain — genuinely moving the document on
  // before the stale session is ever submitted.
  const freshResult = await send(f, { document, flowKey: "GENERATION_CONFIRMATION", action: "CANCEL", data: { quote_id: "quote:whatever" } });
  assert.equal(freshResult.accepted, true, freshResult.reason);
  const afterFresh = await loadDocument(f, document.document_id);
  assert.equal(afterFresh.status, "CANCELLED");

  const staleMessage = nfmReply({ sessionId: staleSessionId, flowKey: "GENERATION_CONFIRMATION", action: "CANCEL", data: { quote_id: "quote:whatever" } });
  const staleResult = await f.composition.webhookHandler({ messages: [staleMessage] });
  assert.equal(staleResult.results[0].accepted, false, "a stale Flow submitted against an already-moved-on document must be rejected, not silently applied");
  assert.notEqual(staleResult.results[0].reason, undefined);

  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "CANCELLED", "the document must remain exactly as the real, non-stale CANCEL left it");
  assert.equal(after.version, afterFresh.version, "the stale submission must never have produced a second mutation");
});

// 7. Exact replay causes no second transition — document mutation
// idempotency is inherited from the pre-existing shared document pipeline
// (no RECHARGE-style special short-circuit was needed or added).
test("T4-7. An exact CANCEL replay (same wamid) is recognized as a duplicate and causes zero second transition", async () => {
  const f = buildComposition();
  const { document, quoteId } = await buildFactureAwaitingConfirmation(f);
  const sessionId = await openSession(f, { document, expectedFlowKey: "GENERATION_CONFIRMATION" });
  const message = nfmReply({ sessionId, flowKey: "GENERATION_CONFIRMATION", action: "CANCEL", data: { quote_id: quoteId }, id: "wamid.t4.cancel.replay.1" });

  const first = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(first.results[0].accepted, true);
  const afterFirst = await loadDocument(f, document.document_id);
  assert.equal(afterFirst.status, "CANCELLED");

  const second = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(second.results[0].accepted, true);
  assert.equal(second.results[0].duplicate, true, "an exact replay must be recognized as a duplicate");
  const afterSecond = await loadDocument(f, document.document_id);
  assert.equal(afterSecond.version, afterFirst.version, "no additional mutation on replay");
  assert.equal(afterSecond.status, "CANCELLED");
});

// 8 & 9 & 10 (financial/generation/delivery invariants), structurally
// proven: previewRuntime/generationRuntime/rechargeRuntime/walletRuntime
// only ever expose CANCEL-unrelated ports as throw-on-call stubs except
// generationRuntime.confirm's recording spy — any accidental call from the
// CANCEL path would fail the test loudly. This test also proves it
// end-to-end for a fresh CANCEL from a genuinely current Flow.
test("T4-8/9/10. CANCEL causes zero generation, zero credit debit/capture, and zero delivery — structurally proven", async () => {
  const f = buildComposition();
  const { document, quoteId } = await buildFactureAwaitingConfirmation(f);
  const result = await send(f, { document, flowKey: "GENERATION_CONFIRMATION", action: "CANCEL", data: { quote_id: quoteId } });
  assert.equal(result.accepted, true, result.reason);
  assert.equal(f.generationConfirmCalls.length, 0, "no generation must ever start from CANCEL");
  // rechargeRuntime/walletRuntime are throw-on-call stubs (see buildComposition) —
  // reaching this line without an UNEXPECTED_CALL exception already proves
  // no credit/wallet/delivery-retry port was touched.
});

// 11. An unrelated field outside the real GENERATION_CONFIRMATION Flow
// contract is rejected, even alongside a real quote_id.
test("T4-11. An unrelated field outside the real Flow contract is rejected for GENERATION_CONFIRMATION/CANCEL", async () => {
  const f = buildComposition();
  const { document, quoteId } = await buildFactureAwaitingConfirmation(f);
  const result = await send(f, {
    document, flowKey: "GENERATION_CONFIRMATION", action: "CANCEL",
    data: { quote_id: quoteId, not_a_real_field: "x" }, expectAccepted: false,
  });
  assert.equal(result.accepted, false);
  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "AWAITING_GENERATION_CONFIRMATION", "a rejected submission must never mutate the document");
});

// 12 & 13. The GENERATION_CONFIRMATION-only CANCEL override must never leak
// into DOCUMENT_REVIEW/CANCEL or DOCUMENT_PREVIEW/CANCEL — a quote_id
// submitted there is rejected, exactly as before this fix.
test("T4-12. DOCUMENT_REVIEW/CANCEL still rejects a quote_id — the GENERATION_CONFIRMATION override does not leak", async () => {
  const f = buildComposition();
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

  const result = await send(f, { document, flowKey: "DOCUMENT_REVIEW", action: "CANCEL", data: { quote_id: "quote:not-real" }, expectAccepted: false });
  assert.equal(result.accepted, false);
  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "READY_FOR_REVIEW", "a rejected DOCUMENT_REVIEW/CANCEL must never mutate the document");
});

test("T4-13. DOCUMENT_PREVIEW/CANCEL still rejects a quote_id — the GENERATION_CONFIRMATION override does not leak", async () => {
  const f = buildComposition();
  await send(f, { flowKey: "MENU", action: "PREPARE_DOCUMENT", data: {} });
  await send(f, { flowKey: "DOCUMENT_TYPE", action: "SELECT_DOCUMENT_TYPE", data: { document_type: "FACTURE" } });
  let document = await loadDocument(f, lastCreatedDocumentId(f));
  await send(f, { document, flowKey: "INVOICE_TYPE", action: "SAVE_INVOICE_TYPE", data: { invoice_kind: "FINAL" } });
  document = await loadDocument(f, document.document_id);
  await send(f, { document, flowKey: "DOCUMENT_CLIENT", action: "SAVE_CLIENT", data: { name: "Client preview", phone: "", email: "", address: "", tax_id: "" } });
  document = await loadDocument(f, document.document_id);
  await send(f, { document, flowKey: "ARTICLE_FORM", action: "ADD_CONTENT", data: { description: "Ciment", quantity: 1, unit: "sac", unit_custom: "", unit_price: 6000 } });
  document = await loadDocument(f, document.document_id);
  await send(f, { document, flowKey: "DOCUMENT_CONTENT", action: "FINISH_CONTENT", data: {} });
  document = await loadDocument(f, document.document_id);
  await send(f, { document, flowKey: "DOCUMENT_OPTIONS", action: "SAVE_OPTIONS", data: { tax_rate_basis_points: "", discount_amount: "", notes: "", payment_terms: "", validity_days: "", payment_method: "", reference: "" } });
  document = await loadDocument(f, document.document_id);
  await send(f, { document, flowKey: "DOCUMENT_REVIEW", action: "VERIFY", data: {} });
  document = await loadDocument(f, document.document_id);
  assert.equal(document.status, "VERIFIED");

  const result = await send(f, { document, flowKey: "DOCUMENT_PREVIEW", action: "CANCEL", data: { quote_id: "quote:not-real" }, expectAccepted: false });
  assert.equal(result.accepted, false);
  const after = await loadDocument(f, document.document_id);
  assert.equal(after.status, "VERIFIED", "a rejected DOCUMENT_PREVIEW/CANCEL must never mutate the document");
});

// 14. RECHARGE/CANCEL's T3 contract (pack_id + payment_reference) is
// unaffected by the new GENERATION_CONFIRMATION override — both are
// independent entries in FLOW_ACTION_FIELD_OVERRIDES.
test("T4-14. RECHARGE/CANCEL's T3 real combined-form contract is unaffected by the GENERATION_CONFIRMATION-001 fix", () => {
  const stillAccepted = validateActionPayload("RECHARGE", "CANCEL", { pack_id: "PACK_1000", payment_reference: "REF-1" });
  assert.equal(stillAccepted.ok, true, stillAccepted.error);
  const quoteIdLeaking = validateActionPayload("RECHARGE", "CANCEL", { pack_id: "", payment_reference: "", quote_id: "quote:1" });
  assert.deepEqual(quoteIdLeaking, { ok: false, error: "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN" });
});

// 15. CONFIRM_GENERATION non-regression: the normal action already
// legitimately using quote_id must remain completely unchanged, positively
// exercised end-to-end (never a real production generation — the spy
// generationRuntime never renders, delivers or captures anything real).
test("T4-15. CONFIRM_GENERATION real payload is unchanged: quote_id still reaches generation.confirm, owner/document/version resolved server-side", async () => {
  const f = buildComposition();
  const { document, quoteId } = await buildFactureAwaitingConfirmation(f);

  const result = await send(f, { document, flowKey: "GENERATION_CONFIRMATION", action: "CONFIRM_GENERATION", data: { quote_id: quoteId } });
  assert.equal(result.accepted, true, result.reason);
  assert.equal(f.generationConfirmCalls.length, 1);
  const payload = f.generationConfirmCalls[0];
  assert.equal(payload.documentId, document.document_id);
  assert.equal(payload.expectedVersion, document.version, "expectedVersion must come from the trusted server-side session context, never the payload");
  assert.equal(payload.quoteId, quoteId, "quote_id must still reach generation.confirm exactly as before T4");
  assert.equal(payload.ownerWaId, OWNER, "owner must be the authenticated webhook sender, never client-supplied");
});
