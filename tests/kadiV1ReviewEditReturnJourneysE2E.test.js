"use strict";

// Production-composition regression coverage for REVIEW-001 / INV-001 /
// INV-002: the real document domain, shared/discharge pipelines, runtime
// adapters, flow command runtime, flow reply runtime, session service and
// presenter are wired exactly as in production. Only true I/O boundaries
// (WhatsApp send calls, and the unrelated onboarding/preview/generation/
// recharge/history/wallet ports, which must never be touched by an edit
// journey) are stubbed to throw on any call. Every scenario asserts both
// the persisted backend state and the actual next visible Flow with its
// suggested data, not just the returned action id — see mission "KADI V1 —
// FIX REAL REVIEW CONTENT AND EDIT RETURN JOURNEYS R0", section 8.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDocumentDomain } = require("../kadiV1DocumentDomain");
const { createInMemoryV1DocumentRepository } = require("../kadiV1DocumentRepository");
const { createSharedDocumentPipeline } = require("../kadiV1SharedDocumentPipeline");
const { createDischargePipeline } = require("../kadiV1DischargePipeline");
const { createKadiV1DocumentRuntimeAdapter } = require("../kadiV1RuntimeAdapters");
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

async function buildComposition() {
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

  // Every port below MUST stay unreachable for a pure review/edit journey:
  // if editing a client, articles or options ever tried to reserve credit,
  // render, confirm generation, or touch recharge/history/balance, this
  // stub throws immediately and fails the test loudly (mission section 9
  // safety requirement, enforced structurally, not just asserted after the
  // fact).
  const commandRuntime = createKadiV1FlowCommandRuntime({
    onboardingRuntime: stubPort(["continueOnboarding"]),
    documentRuntime,
    previewRuntime: stubPort(["prepare"]),
    generationRuntime: stubPort(["confirm", "retryDelivery"]),
    rechargeRuntime: stubPort(["selectPack", "checkPayment", "cancel"]),
    historyRuntime: stubPort(["search", "open"]),
    walletRuntime: stubPort(["getBalance"]),
  });

  const sessionService = createConversationSessionService({
    repository: createMemoryConversationSessionRepository(),
    clock: () => new Date().toISOString(),
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
    whatsappApi, sessionService, clock: () => new Date().toISOString(), logger: { log() {} },
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
  return { composition, sessionService, sent, repository, created };
}

function nfmReply({ sessionId, flowKey, action, data = {}, from = OWNER }) {
  return {
    id: `wamid:${flowKey}:${action}:${sessionId}`, from, type: "interactive",
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

async function send(f, { document = null, flowKey, action, data = {}, ownerWaId = OWNER, expectAccepted = true }) {
  const sessionId = await openSession(f, { document, expectedFlowKey: flowKey, ownerWaId });
  const result = await f.composition.webhookHandler({ messages: [nfmReply({ sessionId, flowKey, action, data, from: ownerWaId })] });
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

// Drives a real FACTURE from scratch through every initial-creation screen
// up to DOCUMENT_REVIEW (READY_FOR_REVIEW).
async function buildFactureAtReview(f, ownerWaId = OWNER) {
  await send(f, { flowKey: "MENU", action: "PREPARE_DOCUMENT", data: {}, ownerWaId });
  await send(f, { flowKey: "DOCUMENT_TYPE", action: "SELECT_DOCUMENT_TYPE", data: { document_type: "FACTURE" }, ownerWaId });
  let document = await loadDocument(f, lastCreatedDocumentId(f), ownerWaId);
  assert.equal(document.document_type, "FACTURE");

  await send(f, { document, flowKey: "INVOICE_TYPE", action: "SAVE_INVOICE_TYPE", data: { invoice_kind: "FINAL" }, ownerWaId });
  document = await loadDocument(f, document.document_id, ownerWaId);

  await send(f, { document, flowKey: "DOCUMENT_CLIENT", action: "SAVE_CLIENT", data: { name: "Awa Traoré", phone: "", email: "", address: "", tax_id: "00123456A" }, ownerWaId });
  document = await loadDocument(f, document.document_id, ownerWaId);
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.ARTICLE_FORM, "initial SAVE_CLIENT must still reach ARTICLE_FORM");

  await send(f, { document, flowKey: "ARTICLE_FORM", action: "ADD_CONTENT", data: { description: "Ciment", quantity: 2, unit: "sac", unit_custom: "", unit_price: 6000 }, ownerWaId });
  document = await loadDocument(f, document.document_id, ownerWaId);

  await send(f, { document, flowKey: "DOCUMENT_CONTENT", action: "FINISH_CONTENT", data: {}, ownerWaId });
  document = await loadDocument(f, document.document_id, ownerWaId);
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.DOCUMENT_OPTIONS, "initial FINISH_CONTENT must still reach DOCUMENT_OPTIONS");

  await send(f, { document, flowKey: "DOCUMENT_OPTIONS", action: "SAVE_OPTIONS", data: { tax_rate_basis_points: 1800, discount_amount: 0, notes: "", payment_terms: "" }, ownerWaId });
  document = await loadDocument(f, document.document_id, ownerWaId);
  assert.equal(document.status, "READY_FOR_REVIEW");
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.DOCUMENT_REVIEW);
  return document;
}

test("A. Invoice initial journey: SAVE_CLIENT reaches ARTICLE_FORM, real state persisted", async () => {
  const f = await buildComposition();
  const document = await buildFactureAtReview(f);
  assert.equal(document.client.name, "Awa Traoré");
  assert.equal(document.items.length, 1);
  assert.equal(document.items[0].description, "Ciment");
  // CLIENT-001: the real Flow submission always includes tax_id — this
  // must normalize to the domain's canonical `ifu` field, never be
  // rejected and never persist as a second, contradictory representation.
  assert.equal(document.client.ifu, "00123456A");
  assert.equal(Object.hasOwn(document.client, "tax_id"), false);
});

test("B. Invoice client correction: EDIT_CLIENT -> real beginEdit Flow opened -> SAVE_CLIENT -> same document, refreshed DOCUMENT_REVIEW with the corrected client, articles and options untouched", async () => {
  const f = await buildComposition();
  const before = await buildFactureAtReview(f);

  const editOpened = await send(f, { document: before, flowKey: "DOCUMENT_REVIEW", action: "EDIT_CLIENT", data: {} });
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.EDIT_CLIENT, "beginEdit must open the real edit Flow, never DOCUMENT_REVIEW again");
  const afterBeginEdit = await loadDocument(f, before.document_id);
  assert.equal(afterBeginEdit.document_id, before.document_id, "same document");
  assert.equal(afterBeginEdit.version, before.version, "beginEdit is a no-op mutation from READY_FOR_REVIEW — no new version, no billing-relevant state change");
  assert.equal(editOpened.accepted, true);

  await send(f, {
    document: afterBeginEdit, flowKey: "EDIT_CLIENT", action: "SAVE_CLIENT",
    data: { name: "Awa Traoré (corrigée)", phone: "", email: "", address: "", tax_id: "" },
  });
  const after = await loadDocument(f, before.document_id);
  assert.equal(after.document_id, before.document_id, "same document_id, never a new document");
  assert.equal(after.document_type, before.document_type, "same document type");
  assert.equal(after.client.name, "Awa Traoré (corrigée)", "client actually persisted the correction");
  assert.equal(after.items.length, before.items.length, "no new article added, none removed");
  assert.equal(after.items[0].description, before.items[0].description, "existing article unchanged");
  assert.equal(after.tax_rate_basis_points, before.tax_rate_basis_points, "options preserved");

  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.DOCUMENT_REVIEW, "must return to review, never ARTICLE_FORM");
  const data = lastFlowData(f);
  assert.match(data.review_summary, /Awa Traoré \(corrigée\)/, "refreshed review must show the corrected client");
  assert.match(data.review_summary, /Ciment/, "existing article must remain visible");
});

test("C. Invoice item correction: EDIT_CONTENT -> add/update/remove loop stays in EDIT_CONTENT -> FINISH_CONTENT -> refreshed DOCUMENT_REVIEW, client and options untouched", async () => {
  const f = await buildComposition();
  const before = await buildFactureAtReview(f);

  await send(f, { document: before, flowKey: "DOCUMENT_REVIEW", action: "EDIT_CONTENT", data: {} });
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.EDIT_CONTENT);
  let current = await loadDocument(f, before.document_id);
  assert.deepEqual(lastFlowData(f).item_options.map((entry) => entry.id), current.items.map((item) => item.item_id), "real current items offered, never the fake example id");

  // EDIT-CONTENT-001: kadi_edit_content_v1.json's single combined form
  // always submits item_id/description/quantity/unit/unit_custom/unit_price
  // together regardless of the chosen action — every data block below
  // reproduces that real shape faithfully, not a hand-picked subset.
  await send(f, { document: current, flowKey: "EDIT_CONTENT", action: "ADD_CONTENT", data: { item_id: "", description: "Fer à béton", quantity: 5, unit: "unité", unit_custom: "", unit_price: 3000 } });
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.EDIT_CONTENT, "adding another item from the edit screen must stay in EDIT_CONTENT, not bounce to DOCUMENT_CONTENT");
  current = await loadDocument(f, before.document_id);
  assert.equal(current.items.length, 2);

  const cimentItemId = current.items.find((item) => item.description === "Ciment").item_id;
  await send(f, { document: current, flowKey: "EDIT_CONTENT", action: "UPDATE_CONTENT", data: { item_id: cimentItemId, description: "Ciment (corrigé)", quantity: 3, unit: "sac", unit_custom: "", unit_price: 6000 } });
  current = await loadDocument(f, before.document_id);
  assert.equal(current.items.find((item) => item.item_id === cimentItemId).description, "Ciment (corrigé)");

  const ferItemId = current.items.find((item) => item.description === "Fer à béton").item_id;
  await send(f, { document: current, flowKey: "EDIT_CONTENT", action: "REMOVE_CONTENT", data: { item_id: ferItemId, description: "", quantity: "", unit: "", unit_custom: "", unit_price: "" } });
  current = await loadDocument(f, before.document_id);
  assert.equal(current.items.length, 1);

  await send(f, { document: current, flowKey: "EDIT_CONTENT", action: "FINISH_CONTENT", data: { item_id: "", description: "", quantity: "", unit: "", unit_custom: "", unit_price: "" } });
  const after = await loadDocument(f, before.document_id);
  assert.equal(after.client.name, before.client.name, "client untouched by content correction");
  assert.equal(after.tax_rate_basis_points, before.tax_rate_basis_points, "options untouched by content correction");

  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.DOCUMENT_REVIEW, "must return to review, never DOCUMENT_OPTIONS");
  const data = lastFlowData(f);
  assert.match(data.review_summary, /Ciment \(corrigé\)/, "the corrected item must be visible in the refreshed review");
  assert.doesNotMatch(data.review_summary, /Fer à béton/, "the removed item must not reappear");
});

test("D. Invoice option correction: EDIT_OPTIONS -> SAVE_OPTIONS -> refreshed DOCUMENT_REVIEW, client and articles untouched", async () => {
  const f = await buildComposition();
  const before = await buildFactureAtReview(f);

  await send(f, { document: before, flowKey: "DOCUMENT_REVIEW", action: "EDIT_OPTIONS", data: {} });
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.EDIT_OPTIONS);
  assert.notEqual(lastFlowData(f).current_summary, "Aucune option particulière.", "the edit-options screen must show real current context");
  const reopened = await loadDocument(f, before.document_id);

  await send(f, { document: reopened, flowKey: "EDIT_OPTIONS", action: "SAVE_OPTIONS", data: { discount_amount: 2000, notes: "Livraison offerte", payment_terms: "" } });
  const after = await loadDocument(f, before.document_id);
  assert.equal(after.document_id, before.document_id);
  assert.equal(after.discount, 2000, "the corrected discount must be persisted");
  assert.equal(after.tax_rate_basis_points, before.tax_rate_basis_points, "a field not resubmitted must stay exactly as it was");
  assert.equal(after.client.name, before.client.name, "client untouched by an options correction");
  assert.equal(after.items.length, before.items.length, "articles untouched by an options correction");

  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.DOCUMENT_REVIEW);
  const data = lastFlowData(f);
  assert.match(data.review_summary, /Livraison offerte/);
  assert.match(data.review_summary, /Remise : 2\s000 FCFA/);
});

test("E. Quotation (DEVIS) client correction reaches the exact same refreshed review as an invoice", async () => {
  const f = await buildComposition();
  await send(f, { flowKey: "MENU", action: "PREPARE_DOCUMENT", data: {} });
  await send(f, { flowKey: "DOCUMENT_TYPE", action: "SELECT_DOCUMENT_TYPE", data: { document_type: "DEVIS" } });
  let document = await loadDocument(f, lastCreatedDocumentId(f));
  assert.equal(document.document_type, "DEVIS");
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.DOCUMENT_CLIENT, "DEVIS skips INVOICE_TYPE, unlike FACTURE");

  await send(f, { document, flowKey: "DOCUMENT_CLIENT", action: "SAVE_CLIENT", data: { name: "Client Devis", phone: "", email: "", address: "", tax_id: "" } });
  document = await loadDocument(f, document.document_id);
  await send(f, { document, flowKey: "ARTICLE_FORM", action: "ADD_CONTENT", data: { description: "Étude", quantity: 1, unit: "forfait", unit_custom: "", unit_price: 50000 } });
  document = await loadDocument(f, document.document_id);
  await send(f, { document, flowKey: "DOCUMENT_CONTENT", action: "FINISH_CONTENT", data: {} });
  document = await loadDocument(f, document.document_id);
  await send(f, { document, flowKey: "DOCUMENT_OPTIONS", action: "SAVE_OPTIONS", data: {} });
  document = await loadDocument(f, document.document_id);
  assert.equal(document.status, "READY_FOR_REVIEW");

  await send(f, { document, flowKey: "DOCUMENT_REVIEW", action: "EDIT_CLIENT", data: {} });
  const reopened = await loadDocument(f, document.document_id);
  await send(f, { document: reopened, flowKey: "EDIT_CLIENT", action: "SAVE_CLIENT", data: { name: "Client Devis (corrigé)", phone: "", email: "", address: "", tax_id: "" } });
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.DOCUMENT_REVIEW);
  assert.match(lastFlowData(f).review_summary, /Client Devis \(corrigé\)/);
  assert.match(lastFlowData(f).review_summary, /Facture proforma|Devis/i);
});

async function buildRecuAtReview(f, ownerWaId = OWNER) {
  await send(f, { flowKey: "MENU", action: "PREPARE_DOCUMENT", data: {}, ownerWaId });
  await send(f, { flowKey: "DOCUMENT_TYPE", action: "SELECT_DOCUMENT_TYPE", data: { document_type: "RECU" }, ownerWaId });
  let document = await loadDocument(f, lastCreatedDocumentId(f), ownerWaId);
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.RECEIPT_DETAILS, "RECU skips DOCUMENT_CLIENT/ARTICLE_FORM entirely");

  await send(f, {
    document, flowKey: "RECEIPT_DETAILS", action: "SAVE_RECEIPT_DETAILS",
    data: { payer: "Moussa", amount: 15000, reason: "Achat tissu", payment_method: "ESPECES", reference: "", receipt_format: "A4" },
    ownerWaId,
  });
  document = await loadDocument(f, document.document_id, ownerWaId);
  assert.equal(document.status, "READY_FOR_REVIEW");
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.DOCUMENT_REVIEW);
  return document;
}

test("F. Receipt review shows real payer/beneficiary/amount/format, and its single combined edit Flow round-trips back to review", async () => {
  const f = await buildComposition();
  const before = await buildRecuAtReview(f);
  const reviewData = lastFlowData(f);
  assert.match(reviewData.review_summary, /Payeur : Moussa/);
  assert.match(reviewData.review_summary, /Bénéficiaire : Kadi Boutique/, "beneficiary is server-derived from the issuer, never typed");
  assert.match(reviewData.review_summary, /Montant : 15\s000 FCFA/);
  assert.deepEqual(reviewData.review_actions.map((entry) => entry.id), ["VERIFY", "EDIT_CLIENT", "CANCEL"], "one combined edit action, not three redundant invoice-style buttons");

  await send(f, { document: before, flowKey: "DOCUMENT_REVIEW", action: "EDIT_CLIENT", data: {} });
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.RECEIPT_DETAILS, "RECU's edit action opens the same combined RECEIPT_DETAILS Flow");
  const reopened = await loadDocument(f, before.document_id);

  await send(f, {
    document: reopened, flowKey: "RECEIPT_DETAILS", action: "SAVE_RECEIPT_DETAILS",
    data: { payer: "Moussa Konaté", amount: 15000, reason: "Achat tissu", payment_method: "ESPECES", reference: "", receipt_format: "A4" },
  });
  const after = await loadDocument(f, before.document_id);
  assert.equal(after.document_id, before.document_id);
  assert.equal(after.receipt.payer, "Moussa Konaté");
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.DOCUMENT_REVIEW);
  assert.match(lastFlowData(f).review_summary, /Payeur : Moussa Konaté/);
});

async function buildDechargeAtReview(f, ownerWaId = OWNER) {
  await send(f, { flowKey: "MENU", action: "PREPARE_DOCUMENT", data: {}, ownerWaId });
  await send(f, { flowKey: "DOCUMENT_TYPE", action: "SELECT_DOCUMENT_TYPE", data: { document_type: "DECHARGE" }, ownerWaId });
  let document = await loadDocument(f, lastCreatedDocumentId(f), ownerWaId);
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.DISCHARGE_DETAILS);

  await send(f, {
    document, flowKey: "DISCHARGE_DETAILS", action: "SAVE_DETAILS",
    data: { giver: "Ibrahim", recipient: "Fatou", transferred_content_type: "MONEY", amount: 25000, reason: "Prêt de matériel" },
    ownerWaId,
  });
  document = await loadDocument(f, document.document_id, ownerWaId);
  assert.equal(document.status, "READY_FOR_REVIEW");
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.DOCUMENT_REVIEW);
  return document;
}

test("G. Discharge review shows real giver/receiver/amount, never a 'client', and its single combined edit Flow round-trips back to review", async () => {
  const f = await buildComposition();
  const before = await buildDechargeAtReview(f);
  const reviewData = lastFlowData(f);
  assert.match(reviewData.review_summary, /Remettant : Ibrahim/);
  assert.match(reviewData.review_summary, /Bénéficiaire : Fatou/);
  assert.match(reviewData.review_summary, /25\s000 FCFA/);
  assert.deepEqual(reviewData.review_actions.map((entry) => entry.id), ["VERIFY", "EDIT_CONTENT", "CANCEL"]);
  assert.equal(reviewData.review_actions.some((entry) => entry.id === "EDIT_CLIENT"), false, "a discharge has no invoice-style client");

  await send(f, { document: before, flowKey: "DOCUMENT_REVIEW", action: "EDIT_CONTENT", data: {} });
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.DISCHARGE_DETAILS);
  const reopened = await loadDocument(f, before.document_id);

  await send(f, {
    document: reopened, flowKey: "DISCHARGE_DETAILS", action: "SAVE_DETAILS",
    data: { giver: "Ibrahim", recipient: "Fatou Diallo", transferred_content_type: "MONEY", amount: 25000, reason: "Prêt de matériel" },
  });
  const after = await loadDocument(f, before.document_id);
  assert.equal(after.discharge.receiver, "Fatou Diallo");
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.DOCUMENT_REVIEW);
  assert.match(lastFlowData(f).review_summary, /Fatou Diallo/);
});

test("H. Explicit CANCEL from review remains the only normal cancellation path — no accidental cancellation from an unresolved edit context", async () => {
  const f = await buildComposition();
  const before = await buildFactureAtReview(f);

  await send(f, { document: before, flowKey: "DOCUMENT_REVIEW", action: "CANCEL", data: {} });
  const after = await loadDocument(f, before.document_id);
  assert.equal(after.status, "CANCELLED");
  const lastText = f.sent.texts.slice(-1)[0];
  assert.equal(lastText.text, "L’opération est annulée.");
});

test("I. Replayed SAVE_CLIENT reply (same wamid) is idempotent — no duplicate client mutation, no version bump on the replay", async () => {
  const f = await buildComposition();
  const before = await buildFactureAtReview(f);
  await send(f, { document: before, flowKey: "DOCUMENT_REVIEW", action: "EDIT_CLIENT", data: {} });
  const reopened = await loadDocument(f, before.document_id);

  const sessionId = await openSession(f, { document: reopened, expectedFlowKey: "EDIT_CLIENT" });
  const data = { name: "Awa Traoré (corrigée)", phone: "", email: "", address: "", tax_id: "" };
  const message = nfmReply({ sessionId, flowKey: "EDIT_CLIENT", action: "SAVE_CLIENT", data });

  const first = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(first.results[0].accepted, true);
  const afterFirst = await loadDocument(f, before.document_id);

  const second = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(second.results[0].accepted, true);
  assert.equal(second.results[0].duplicate, true, "an exact replay must be recognized as a duplicate");
  const afterSecond = await loadDocument(f, before.document_id);
  assert.equal(afterSecond.version, afterFirst.version, "no additional mutation on replay");
  assert.equal(afterSecond.client.name, "Awa Traoré (corrigée)");
});

test("J. Replayed FINISH_CONTENT reply (same wamid) is idempotent — no duplicate item added, single return to review", async () => {
  const f = await buildComposition();
  const before = await buildFactureAtReview(f);
  await send(f, { document: before, flowKey: "DOCUMENT_REVIEW", action: "EDIT_CONTENT", data: {} });
  const reopened = await loadDocument(f, before.document_id);
  await send(f, { document: reopened, flowKey: "EDIT_CONTENT", action: "ADD_CONTENT", data: { item_id: "", description: "Peinture", quantity: 1, unit: "unité", unit_custom: "", unit_price: 8000 } });
  const withNewItem = await loadDocument(f, before.document_id);
  assert.equal(withNewItem.items.length, 2);

  const sessionId = await openSession(f, { document: withNewItem, expectedFlowKey: "EDIT_CONTENT" });
  const message = nfmReply({ sessionId, flowKey: "EDIT_CONTENT", action: "FINISH_CONTENT", data: { item_id: "", description: "", quantity: "", unit: "", unit_custom: "", unit_price: "" } });

  const first = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(first.results[0].accepted, true);
  const afterFirst = await loadDocument(f, before.document_id);
  assert.equal(afterFirst.items.length, 2, "FINISH_CONTENT itself adds nothing");

  const second = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(second.results[0].accepted, true);
  assert.equal(second.results[0].duplicate, true);
  const afterSecond = await loadDocument(f, before.document_id);
  assert.equal(afterSecond.items.length, 2, "no duplicate item from the replay");
  assert.equal(afterSecond.version, afterFirst.version, "no additional mutation on replay");
});

test("K. A stale edit response against a document already mutated by something else is rejected, never silently overwritten", async () => {
  const f = await buildComposition();
  const before = await buildFactureAtReview(f);

  // Open the EDIT_CLIENT session while the document is still at `before`'s
  // version, then mutate the document through a second, unrelated edit
  // before the first session's reply ever arrives — reproducing a stale
  // Flow response racing a newer state.
  const staleSessionId = await openSession(f, { document: before, expectedFlowKey: "EDIT_CLIENT" });

  await send(f, { document: before, flowKey: "DOCUMENT_REVIEW", action: "EDIT_OPTIONS", data: {} });
  const reopenedForOptions = await loadDocument(f, before.document_id);
  await send(f, { document: reopenedForOptions, flowKey: "EDIT_OPTIONS", action: "SAVE_OPTIONS", data: { notes: "Changé entre-temps" } });
  const mutated = await loadDocument(f, before.document_id);
  assert.notEqual(mutated.version, before.version, "the document must genuinely have moved on");

  const staleMessage = nfmReply({ sessionId: staleSessionId, flowKey: "EDIT_CLIENT", action: "SAVE_CLIENT", data: { name: "Ne doit pas s’appliquer", phone: "", email: "", address: "", tax_id: "" } });
  const staleResult = await f.composition.webhookHandler({ messages: [staleMessage] });
  assert.equal(staleResult.results[0].accepted, false, "a stale document_version must be rejected, not silently applied");

  const after = await loadDocument(f, before.document_id);
  assert.notEqual(after.client.name, "Ne doit pas s’appliquer", "the stale reply must never have overwritten the real, newer state");
  assert.equal(after.notes, "Changé entre-temps", "the real newer state must remain exactly as the non-stale edit left it");
});
