"use strict";

// PR #14 final release verification — the complete, real chain, not
// isolated units: history search → OPEN_DOCUMENT → history service →
// Flow command runtime → Flow reply runtime → production presenter →
// webhook → deliveryRetryRuntime → runtime adapter → lifecycle
// retryDelivery. Built on kadiV1ProductionComposition.js itself (the same
// module kadiV1ProductionBootstrap.js uses in production), with only the
// true external I/O boundaries faked (WhatsApp send calls, the WhatsApp
// delivery provider, the PDF renderer/storage) — every internal service,
// adapter, repository and runtime in between is the real module.

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
// document_number is deterministic: FA-<issued_at digits, 14 chars>-<last 8
// alnum chars of document_id, uppercased> (kadiV1DocumentDomain.js
// generateDocumentNumber). Chosen document_id/clock below reproduce the
// exact founder incident's document number byte for byte, without special-
// casing the domain function itself.
const DOCUMENT_ID = "doc:a0eac605";
const ISSUED_AT = "2026-08-06T19:06:33.000Z";
const EXPECTED_DOCUMENT_NUMBER = "FA-20260806190633-A0EAC605";
const EXPECTED_FILENAME = "facture_FA-20260806190633-A0EAC605.pdf";

const FLOW_IDS = Object.freeze({
  ONBOARDING: "100001", MENU: "100002", DOCUMENT_TYPE: "100003", INVOICE_TYPE: "100017", RECEIPT_DETAILS: "100018",
  DOCUMENT_CLIENT: "100004", DOCUMENT_CONTENT: "100005", ARTICLE_FORM: "100016", DOCUMENT_OPTIONS: "100006",
  DOCUMENT_REVIEW: "100007", EDIT_CLIENT: "100008", EDIT_CONTENT: "100009", EDIT_OPTIONS: "100010",
  DOCUMENT_PREVIEW: "100011", GENERATION_CONFIRMATION: "100012", RECHARGE: "100013", HISTORY_SEARCH: "100014",
  DISCHARGE_DETAILS: "100015",
});

async function pdf(pages = 1) {
  const document = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) document.addPage();
  return Buffer.from(await document.save());
}

function stubPort(methods) {
  const port = {};
  for (const method of methods) {
    port[method] = async () => { throw new Error(`UNEXPECTED_CALL:${method}`); };
  }
  return port;
}

// A real, in-repository projection of what the SQL RPC
// (kadi_v1_owned_history_bundle) returns — reads the same repositories
// the rest of the fixture already writes to, never a canned fixture value.
function buildHistoryRepository({ documents, generationRepository }) {
  return {
    async searchOwnedDocuments() { return { ok: true, value: [] }; },
    async getOwnedDocumentBundle({ ownerWaId, documentId }) {
      const doc = await documents.getDocumentById({ documentId, ownerWaId });
      if (!doc.ok) return doc;
      const state = generationRepository.inspect();
      const finalFileRow = state.finalFiles.find((entry) => entry.document_id === documentId) || null;
      const deliveryRow = finalFileRow ? state.deliveries.find((entry) => entry.final_file_id === finalFileRow.final_file_id) || null : null;
      return {
        ok: true,
        value: {
          classification: "V1_NATIVE",
          document: doc.value,
          current_snapshot: doc.value,
          versions: [],
          events: [],
          final_file: finalFileRow,
          delivery: deliveryRow ? { status: deliveryRow.status, attempt_count: deliveryRow.attempt_count, last_error_code: deliveryRow.last_error_code } : null,
        },
      };
    },
    async findDuplicateByIdempotencyKey() { return { ok: true, value: null }; },
    async rememberDuplicate() { return { ok: true, value: null }; },
  };
}

async function buildRealComposition({ deliveryResults, hangDeliverDocumentCalls = 0, getDeliveryStatus = async () => ({ ok: true, value: null }) }) {
  const clock = () => ISSUED_AT;
  const domain = createDocumentDomain({ clock });
  const documents = createInMemoryV1DocumentRepository();
  const artifacts = createInMemoryV1PreviewRepository();

  let document = domain.createDocument({
    document_id: DOCUMENT_ID, document_type: "FACTURE", issuer_profile_id: "issuer:1", currency: "XOF",
    client: { name: "Client fictif" }, items: [{ item_id: "item:1", description: "Service", quantity_millis: 1000, unit_price: 10000 }],
    options: { invoice_kind: "FINAL" },
  }).value;
  await documents.createDocument({ document, ownerWaId: OWNER, idempotencyKey: "doc:e2e:create" });
  for (const [event, payload, key] of [
    [DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW, {}, "ready"], [DOCUMENT_EVENTS.VERIFY, {}, "verify"],
    [DOCUMENT_EVENTS.PREPARE_PREVIEW, { preview: { preview_id: "preview:e2e" } }, "preview"],
    [DOCUMENT_EVENTS.CALCULATE_COST, { generation_quote: { quote_id: "quote:e2e", document_version: 1, page_count: 1, credit_cost: 4 } }, "cost"],
    [DOCUMENT_EVENTS.REQUEST_GENERATION_CONFIRMATION, {}, "await"],
  ]) {
    const next = domain.transitionDocument(document, event, payload).value;
    document = (await documents.persistTransition({ document: next, ownerWaId: OWNER, expectedVersion: 1, fromState: document.status, eventType: `TEST_${key.toUpperCase()}`, idempotencyKey: `doc:e2e:${key}` })).value;
  }
  const preview = { preview_id: "preview:e2e", document_id: DOCUMENT_ID, document_version: 1, owner_wa_id: OWNER, status: "ACTIVE", structured_preview: { document_type: "FACTURE", items: [], total: 10000 } };
  await artifacts.createPreview({ preview, idempotencyKey: "preview:e2e:create" });
  const render = { render_id: "render:e2e", preview_id: preview.preview_id, document_id: DOCUMENT_ID, document_version: 1, owner_wa_id: OWNER, status: "INSPECTED", page_count: 1 };
  await artifacts.createTemporaryRender({ render, idempotencyKey: "render:e2e:create" });
  const quote = { quote_id: "quote:e2e", document_id: DOCUMENT_ID, document_version: 1, owner_wa_id: OWNER, preview_id: preview.preview_id, temporary_render_id: render.render_id, page_count: 1, total_credits: 4, pricing_version: "test-v1", status: "ACTIVE", expires_at: "2026-08-06T20:00:00.000Z" };
  await artifacts.createGenerationQuote({ quote, idempotencyKey: "quote:e2e:create" });

  const generationRepository = createInMemoryGenerationLifecycleRepository({ balances: { [OWNER]: 20 } });
  const wallet = createWalletReservationService({ repository: generationRepository, clock });
  const finalStorage = createInMemoryFinalFileStorage();
  const calls = { delivery: 0, render: 0 };
  const renderer = { render: async () => { calls.render += 1; return { ok: true, value: { buffer: await pdf(1), mime_type: "application/pdf" } }; } };
  const finalGeneration = createFinalGenerationService({ repository: generationRepository, storage: finalStorage, renderer, clock });
  const provider = {
    async deliverDocument() {
      const index = calls.delivery;
      calls.delivery += 1;
      if (index < hangDeliverDocumentCalls) return new Promise(() => {});
      return deliveryResults[Math.min(index, deliveryResults.length - 1)];
    },
    getDeliveryStatus,
  };
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

  const sent = { buttons: [], texts: [] };
  const whatsappApi = {
    async sendText(to, text) { sent.texts.push({ to, text }); },
    async sendButtons(to, body, buttons) { sent.buttons.push({ to, body, buttons }); },
    async sendFlow() { throw new Error("UNEXPECTED_FLOW_SEND"); },
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
      deliveryRetryRuntime,
    },
    logger: { warn() {}, log() {} },
  });
  assert.equal(composition.readiness.ready, true, "production composition must be fully wired, not degraded");
  assert.equal(composition.readiness.state, "READY");

  return { composition, documents, generationRepository, artifacts, wallet, calls, sent, sessionService, clock, lifecycleService };
}

async function driveToConfirmedFailure(errorCode) {
  const f = await buildRealComposition({ deliveryResults: [{ ok: false, error: errorCode }, { ok: true, value: { reference: "retry-ok" } }] });
  const confirmed = await f.lifecycleService.confirmGeneration({
    documentId: DOCUMENT_ID, documentVersion: 1, quoteId: "quote:e2e", ownerWaId: OWNER, idempotencyKey: "confirm:e2e",
  });
  assert.equal(confirmed.ok, false);
  assert.equal(confirmed.error, "DELIVERY_RECOVERABLE_FAILURE");
  const doc = await f.documents.getDocumentById({ documentId: DOCUMENT_ID, ownerWaId: OWNER });
  assert.equal(doc.value.status, "RECOVERABLE_FAILURE");
  assert.equal(doc.value.document_number, EXPECTED_DOCUMENT_NUMBER);
  const stateBefore = f.generationRepository.inspect();
  assert.equal(stateBefore.finalFiles.length, 1, "the render/final-file must exist before any retry — proves retry never re-renders");
  return f;
}

async function openDocumentFromHistory(f) {
  const opened = await f.sessionService.open({ ownerWaId: OWNER, expectedFlowKey: "HISTORY_SEARCH", idempotencyKey: "session:history:e2e" });
  assert.equal(opened.ok, true, opened.error);
  const message = {
    id: "wamid.flow.open", from: OWNER, type: "interactive",
    interactive: { type: "nfm_reply", nfm_reply: { response_json: JSON.stringify({
      session_id: opened.value.session_id, flow_key: "HISTORY_SEARCH", action: "OPEN_DOCUMENT",
      data: { document_id: DOCUMENT_ID }, flow_token: opened.value.session_id,
    }) } },
  };
  return f.composition.webhookHandler({ messages: [message] });
}

function buttonMessage(id, title) {
  return { id: "wamid.button.e2e", from: OWNER, type: "interactive", interactive: { type: "button", button_reply: { id, title } } };
}

test("E2E confirmed-failure: history search -> OPEN_DOCUMENT -> history service -> Flow command runtime -> Flow reply runtime -> production presenter -> real 'Réenvoyer le PDF' button -> webhook RETRY_DELIVERY -> deliveryRetryRuntime -> runtime adapter -> lifecycle retryDelivery, with zero new billing/render/artifact", async () => {
  const f = await driveToConfirmedFailure("DELIVERY_DESTINATION_LOOKUP_FAILED");

  const opened = await openDocumentFromHistory(f);
  assert.equal(opened.handled, true);
  assert.equal(opened.results[0].accepted, true, "the OPEN_DOCUMENT command itself must be processed successfully end-to-end");
  assert.equal(f.sent.buttons.length, 1, "the real presenter must have sent exactly one buttons message from server-authoritative summary.actions");
  const offer = f.sent.buttons[0];
  assert.equal(offer.to, OWNER);
  assert.match(offer.body, /Réenvoyer le PDF/);
  assert.equal(offer.buttons.length, 1);
  assert.equal(offer.buttons[0].title, "Réenvoyer le PDF");
  assert.equal(offer.buttons[0].id, `RETRY_DELIVERY:${DOCUMENT_ID}`);
  assert.equal(f.sent.texts.length, 0, "must never also send the generic 'document is open' text");

  const stateBeforeRetry = f.generationRepository.inspect();
  const walletEntriesBefore = stateBeforeRetry.ledger.length;
  const finalFilesBefore = stateBeforeRetry.finalFiles.length;
  const renderCallsBefore = f.calls.render;
  const finalFileIdBefore = stateBeforeRetry.finalFiles[0].final_file_id;

  const pressed = await f.composition.webhookHandler({ messages: [buttonMessage(offer.buttons[0].id, offer.buttons[0].title)] });
  assert.equal(pressed.handled, true);
  assert.equal(pressed.results[0].accepted, true, pressed.results[0].reason);

  const stateAfterRetry = f.generationRepository.inspect();
  assert.equal(stateAfterRetry.ledger.length, walletEntriesBefore, "no new credit reservation or capture");
  assert.equal(stateAfterRetry.finalFiles.length, finalFilesBefore, "no new artifact");
  assert.equal(f.calls.render, renderCallsBefore, "no renderer call on retry");
  assert.equal(stateAfterRetry.finalFiles[0].final_file_id, finalFileIdBefore, "same final-file ID reused, never regenerated");

  const finalDoc = await f.documents.getDocumentById({ documentId: DOCUMENT_ID, ownerWaId: OWNER });
  assert.equal(finalDoc.value.status, "DELIVERED");
  assert.equal(finalDoc.value.document_number, EXPECTED_DOCUMENT_NUMBER, "same document number, never reassigned");

  const { canonicalFinalFilename } = require("../kadiV1FinalFilename");
  const filename = canonicalFinalFilename({ document_type: finalDoc.value.document_type, invoice_kind: finalDoc.value.options?.invoice_kind ?? null, document_number: finalDoc.value.document_number });
  assert.equal(filename, EXPECTED_FILENAME);
});

test("E2E outcome-unknown: history-open never calls the provider, offers a two-button confirmation, and only the explicit RESEND_UNKNOWN_DELIVERY press (confirmed:true) reaches retryDelivery", async () => {
  const f = await driveToConfirmedFailure("DELIVERY_PROVIDER_FAILED");
  // Reach OUTCOME_UNKNOWN the same way a real crash would: force the
  // delivery attempt to a stale IN_PROGRESS claim, then let the real
  // reconciliation path (triggered by a retry request) resolve it —
  // never fabricate the OUTCOME_UNKNOWN state directly.
  const attemptId = f.generationRepository.inspect().deliveries[0].delivery_attempt_id;
  await f.generationRepository.updateDeliveryAttempt({
    deliveryAttemptId: attemptId, expectedStatus: "RECOVERABLE_FAILURE",
    changes: { status: "IN_PROGRESS", last_attempt_at: "2020-01-01T00:00:00.000Z" },
  });
  const reconcile = await f.lifecycleService.retryDelivery({ documentId: DOCUMENT_ID, ownerWaId: OWNER, idempotencyKey: "reconcile:e2e" });
  assert.equal(reconcile.ok, false);
  assert.equal(reconcile.error, "DELIVERY_OUTCOME_UNKNOWN_CONFIRMATION_REQUIRED");
  const preOpenCalls = f.calls.delivery;

  const opened = await openDocumentFromHistory(f);
  assert.equal(opened.handled, true);
  assert.equal(f.calls.delivery, preOpenCalls, "opening the document from history must never call the provider");
  assert.equal(f.sent.buttons.length, 1);
  const offer = f.sent.buttons[0];
  assert.match(offer.body, /pas certains que votre document ait été envoyé/);
  assert.equal(offer.buttons.length, 2);
  assert.equal(offer.buttons[0].id, `RESEND_UNKNOWN_DELIVERY:${DOCUMENT_ID}`);
  assert.equal(offer.buttons[0].title, "Renvoyer le PDF");
  assert.equal(offer.buttons[1].id, `CANCEL_UNKNOWN_DELIVERY:${DOCUMENT_ID}`);
  assert.equal(offer.buttons[1].title, "Annuler");

  const resend = await f.composition.webhookHandler({ messages: [buttonMessage(offer.buttons[0].id, offer.buttons[0].title)] });
  assert.equal(resend.handled, true);
  assert.equal(resend.results[0].accepted, true, resend.results[0].reason);
  assert.equal(f.calls.delivery, preOpenCalls + 1, "exactly one provider call, only after the explicit confirmed:true press");
  const finalDoc = await f.documents.getDocumentById({ documentId: DOCUMENT_ID, ownerWaId: OWNER });
  assert.equal(finalDoc.value.status, "DELIVERED");
});

test("E2E outcome-unknown: pressing Annuler performs no send and no business mutation", async () => {
  const f = await driveToConfirmedFailure("DELIVERY_PROVIDER_FAILED");
  const attemptId = f.generationRepository.inspect().deliveries[0].delivery_attempt_id;
  await f.generationRepository.updateDeliveryAttempt({
    deliveryAttemptId: attemptId, expectedStatus: "RECOVERABLE_FAILURE",
    changes: { status: "IN_PROGRESS", last_attempt_at: "2020-01-01T00:00:00.000Z" },
  });
  await f.lifecycleService.retryDelivery({ documentId: DOCUMENT_ID, ownerWaId: OWNER, idempotencyKey: "reconcile:cancel:e2e" });
  const beforeCancel = f.generationRepository.inspect();
  const callsBefore = f.calls.delivery;

  const cancelled = await f.composition.webhookHandler({ messages: [buttonMessage(`CANCEL_UNKNOWN_DELIVERY:${DOCUMENT_ID}`, "Annuler")] });
  assert.equal(cancelled.handled, true);
  assert.equal(cancelled.results[0].accepted, false);
  assert.equal(f.calls.delivery, callsBefore, "cancel must never call the provider");
  const afterCancel = f.generationRepository.inspect();
  assert.deepEqual(afterCancel.deliveries, beforeCancel.deliveries, "cancel must never mutate the delivery attempt");
  const doc = await f.documents.getDocumentById({ documentId: DOCUMENT_ID, ownerWaId: OWNER });
  assert.equal(doc.value.status, "RECOVERABLE_FAILURE", "document state untouched by cancel");
  assert.equal(f.sent.texts.length, 1);
  assert.match(f.sent.texts[0].text, /ne renvoie rien pour le moment/);
});
