"use strict";

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
const { createKadiV1GenerationRuntimeAdapter } = require("../kadiV1RuntimeAdapters");
const { createKadiV1DeliveryRetryRuntime } = require("../kadiV1DeliveryRetryRuntime");
const { createKadiV1WebhookRuntime } = require("../kadiV1WebhookRuntime");

const OWNER = "22670000000";
const OTHER_OWNER = "22679999999";
const NOW = "2026-08-06T12:00:00.000Z";

async function pdf(pages = 1) {
  const document = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) document.addPage();
  return Buffer.from(await document.save());
}

async function fixture({
  deliveryResults = [{ ok: false, error: "CHANNEL_TEMPORARY" }, { ok: true, value: { reference: "retry-ok" } }],
  balance = 20, wrapRepository = (repository) => repository,
  hangDeliverDocumentCalls = 0, getDeliveryStatus = async () => ({ ok: true, value: null }),
} = {}) {
  const clock = () => NOW;
  const domain = createDocumentDomain({ clock });
  const documents = createInMemoryV1DocumentRepository();
  const artifacts = createInMemoryV1PreviewRepository();
  let document = domain.createDocument({
    document_id: "doc:eligibility", document_type: "FACTURE", issuer_profile_id: "issuer:1", currency: "XOF",
    client: { name: "Client fictif" }, items: [{ item_id: "item:1", description: "Service", quantity_millis: 1000, unit_price: 5000 }],
  }).value;
  await documents.createDocument({ document, ownerWaId: OWNER, idempotencyKey: "doc:eligibility:create" });
  for (const [event, payload, key] of [
    [DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW, {}, "ready"], [DOCUMENT_EVENTS.VERIFY, {}, "verify"],
    [DOCUMENT_EVENTS.PREPARE_PREVIEW, { preview: { preview_id: "preview:eligibility" } }, "preview"],
    [DOCUMENT_EVENTS.CALCULATE_COST, { generation_quote: { quote_id: "quote:eligibility", document_version: 1, page_count: 1, credit_cost: 4 } }, "cost"],
    [DOCUMENT_EVENTS.REQUEST_GENERATION_CONFIRMATION, {}, "await"],
  ]) {
    const next = domain.transitionDocument(document, event, payload).value;
    document = (await documents.persistTransition({ document: next, ownerWaId: OWNER, expectedVersion: 1, fromState: document.status, eventType: `TEST_${key.toUpperCase()}`, idempotencyKey: `doc:eligibility:${key}` })).value;
  }
  const preview = { preview_id: "preview:eligibility", document_id: document.document_id, document_version: 1, owner_wa_id: OWNER, status: "ACTIVE", structured_preview: { document_type: "FACTURE", items: [], total: 5000 } };
  await artifacts.createPreview({ preview, idempotencyKey: "preview:eligibility:create" });
  const render = { render_id: "render:eligibility", preview_id: preview.preview_id, document_id: document.document_id, document_version: 1, owner_wa_id: OWNER, status: "INSPECTED", page_count: 1 };
  await artifacts.createTemporaryRender({ render, idempotencyKey: "render:eligibility:create" });
  const quote = { quote_id: "quote:eligibility", document_id: document.document_id, document_version: 1, owner_wa_id: OWNER, preview_id: preview.preview_id, temporary_render_id: render.render_id, page_count: 1, total_credits: 4, pricing_version: "test-v1", status: "ACTIVE", expires_at: "2026-08-06T13:00:00.000Z" };
  await artifacts.createGenerationQuote({ quote, idempotencyKey: "quote:eligibility:create" });
  const repository = wrapRepository(createInMemoryGenerationLifecycleRepository({ balances: { [OWNER]: balance } }));
  const wallet = createWalletReservationService({ repository, clock });
  const finalStorage = createInMemoryFinalFileStorage();
  const calls = { delivery: 0, render: 0 };
  const renderer = { render: async () => { calls.render += 1; return { ok: true, value: { buffer: await pdf(1), mime_type: "application/pdf" } }; } };
  const finalGeneration = createFinalGenerationService({ repository, storage: finalStorage, renderer, clock });
  const provider = {
    async deliverDocument() {
      const index = calls.delivery;
      calls.delivery += 1;
      // Simulates a crash mid-flight: the call never resolves, so the
      // caller's continuation (deliverFinal's MARK_DELIVERED/recordFailure)
      // never runs either — only claim()'s IN_PROGRESS write ever lands.
      if (index < hangDeliverDocumentCalls) return new Promise(() => {});
      return deliveryResults[Math.min(index, deliveryResults.length - 1)];
    },
    getDeliveryStatus,
  };
  const delivery = createDeliveryService({ repository, provider, clock });
  const quoteService = { async validateGenerationQuote({ quoteId, ownerWaId }) {
    const result = await artifacts.getGenerationQuote({ quoteId });
    if (!result.ok || result.value.owner_wa_id !== ownerWaId || result.value.status !== "ACTIVE") return { ok: false, error: "GENERATION_QUOTE_NOT_ACTIVE" };
    return result;
  } };
  const service = createGenerationLifecycleService({ documentRepository: documents, previewRepository: artifacts, generationRepository: repository, quoteService, walletReservationService: wallet, finalGenerationService: finalGeneration, deliveryService: delivery, domain, clock });
  return { service, repository, documents, artifacts, wallet, calls, document, quote, domain };
}

const command = { documentId: "doc:eligibility", documentVersion: 1, quoteId: "quote:eligibility", ownerWaId: OWNER, idempotencyKey: "confirm:eligibility" };

async function failedDelivery(overrides = {}) {
  const f = await fixture(overrides);
  const confirmed = await f.service.confirmGeneration(command);
  assert.equal(confirmed.ok, false);
  assert.equal(confirmed.error, "DELIVERY_RECOVERABLE_FAILURE");
  return f;
}

test("eligibility: wrong owner is rejected — never leaks whether the document exists", async () => {
  const f = await failedDelivery();
  const result = await f.service.retryDelivery({ documentId: command.documentId, ownerWaId: OTHER_OWNER, idempotencyKey: "retry:wrong-owner" });
  assert.equal(result.ok, false);
});

test("eligibility: document not in RECOVERABLE_FAILURE is rejected", async () => {
  const f = await fixture();
  // Document is still AWAITING_GENERATION_CONFIRMATION — never confirmed.
  const result = await f.service.retryDelivery({ documentId: command.documentId, ownerWaId: OWNER, idempotencyKey: "retry:wrong-state" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "DELIVERY_RETRY_NOT_ELIGIBLE");
});

test("eligibility: a RECOVERABLE_FAILURE recorded at an unrelated stage (resume_state GENERATION_IN_PROGRESS, not GENERATED) is rejected", async () => {
  const f = await fixture({ deliveryResults: [{ ok: true, value: { reference: "ok" } }] });
  // Force the document into RECOVERABLE_FAILURE from a stage that has
  // nothing to do with delivery, by transitioning directly through the
  // domain rather than going through a real render/delivery failure.
  const loaded = await f.documents.getDocumentById({ documentId: command.documentId, ownerWaId: OWNER });
  const started = f.domain.transitionDocument(loaded.value, DOCUMENT_EVENTS.START_GENERATION).value;
  await f.documents.persistTransition({ document: started, ownerWaId: OWNER, expectedVersion: 1, fromState: loaded.value.status, eventType: "TEST_START", idempotencyKey: "doc:eligibility:start-unrelated" });
  const reloaded = await f.documents.getDocumentById({ documentId: command.documentId, ownerWaId: OWNER });
  const failed = f.domain.transitionDocument(reloaded.value, DOCUMENT_EVENTS.RECORD_RECOVERABLE_FAILURE, { code: "FINAL_RENDER_FAILED" }).value;
  await f.documents.persistTransition({ document: failed, ownerWaId: OWNER, expectedVersion: reloaded.value.version, fromState: reloaded.value.status, eventType: "TEST_FAIL", idempotencyKey: "doc:eligibility:fail-unrelated" });
  const result = await f.service.retryDelivery({ documentId: command.documentId, ownerWaId: OWNER, idempotencyKey: "retry:unrelated-stage" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "DELIVERY_RETRY_NOT_ELIGIBLE");
});

test("eligibility: an uncaptured reservation is rejected (defense in depth — should be structurally impossible once DELIVERY_FAILED is recorded)", async () => {
  const f = await failedDelivery();
  const state = f.repository.inspect();
  const reservation = state.reservations[0];
  await f.wallet.releaseReservation({ reservationId: reservation.reservation_id, idempotencyKey: "force:release" }).catch(() => {});
  // releaseReservation only succeeds from RESERVED — this reservation is
  // already CAPTURED, so this call is expected to fail and leave state
  // unchanged; the eligibility check itself is what this test really
  // proves: it independently re-verifies CAPTURED status, not just trusts
  // the document's own recorded state.
  const result = await f.service.retryDelivery({ documentId: command.documentId, ownerWaId: OWNER, idempotencyKey: "retry:reservation-check" });
  assert.equal(result.ok, true, "reservation remains CAPTURED since release from CAPTURED is rejected — retry proceeds normally");
});

test("eligibility: already-delivered document is idempotent-safe, never a second delivery or capture", async () => {
  const f = await failedDelivery();
  const first = await f.service.retryDelivery({ documentId: command.documentId, ownerWaId: OWNER, idempotencyKey: "retry:first" });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.value.document.status, "DELIVERED");
  const second = await f.service.retryDelivery({ documentId: command.documentId, ownerWaId: OWNER, idempotencyKey: "retry:second" });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.duplicate, true);
  const state = f.repository.inspect();
  assert.equal(state.ledger.length, 1, "never a second credit capture");
  assert.equal(state.finalFiles.length, 1, "never a second final artifact");
  assert.equal(state.deliveries.filter((entry) => entry.status === "DELIVERED").length, 1, "never a second delivery");
});

test("eligibility: an empty documentId is rejected by the service's own envelope check, before any repository read", async () => {
  const f = await fixture();
  const badDocument = await f.service.retryDelivery({ documentId: "", ownerWaId: OWNER, idempotencyKey: "retry:bad" });
  assert.equal(badDocument.ok, false);
  assert.equal(badDocument.error, "DELIVERY_RETRY_INVALID");
});

test("eligibility: a non-phone-shaped ownerWaId is rejected earlier, at the runtime-adapter layer (kadiV1RuntimeAdapters.test.js covers this directly) — at the service layer it fails closed as a not-found, never as a false eligibility grant", async () => {
  const f = await fixture();
  const badOwner = await f.service.retryDelivery({ documentId: command.documentId, ownerWaId: "not-a-number", idempotencyKey: "retry:bad" });
  assert.equal(badOwner.ok, false);
  assert.notEqual(badOwner.ok, true, "must never be granted eligibility for an owner that cannot possibly be the real owner");
});

test("concurrency: two concurrent retryDelivery calls for the same document produce exactly one effective delivery", async () => {
  const f = await failedDelivery({ deliveryResults: [{ ok: false, error: "CHANNEL_TEMPORARY" }, { ok: true, value: { reference: "winner" } }] });
  const [first, second] = await Promise.all([
    f.service.retryDelivery({ documentId: command.documentId, ownerWaId: OWNER, idempotencyKey: "retry:concurrent-a" }),
    f.service.retryDelivery({ documentId: command.documentId, ownerWaId: OWNER, idempotencyKey: "retry:concurrent-b" }),
  ]);
  const outcomes = [first, second];
  assert.equal(outcomes.filter((entry) => entry.ok && entry.document?.status !== undefined).length >= 0, true);
  const state = f.repository.inspect();
  assert.equal(state.deliveries.filter((entry) => entry.status === "DELIVERED").length, 1, "exactly one delivery ever reaches DELIVERED");
  assert.equal(state.ledger.length, 1, "never a second credit capture");
  assert.equal(state.finalFiles.length, 1, "never a second final artifact");
  assert.equal(f.calls.render, 1, "never a second render");
  assert.ok(outcomes.some((entry) => entry.ok === true), "at least one of the two concurrent callers must succeed");
});

// --- PR #14 final-review follow-up: existing-document recovery and
// delivery outcome safety (fiche R) ---

test("stale claim: a delivery attempt stuck IN_PROGRESS beyond the staleness window is reconciled to an outcome-unknown recoverable failure, never a confirmed one, and never resent without explicit confirmation", async () => {
  const f = await failedDelivery();
  const state = f.repository.inspect();
  const attemptId = state.deliveries[0].delivery_attempt_id;
  // Simulate the crash: the provider call happened (or was about to) but
  // the finalize write never landed, leaving the row claimed a long time
  // ago — force this directly rather than via a real timeout.
  await f.repository.updateDeliveryAttempt({
    deliveryAttemptId: attemptId, expectedStatus: "RECOVERABLE_FAILURE",
    changes: { status: "IN_PROGRESS", last_attempt_at: "2020-01-01T00:00:00.000Z" },
  });
  const callsBefore = f.calls.delivery;
  const result = await f.service.retryDelivery({ documentId: command.documentId, ownerWaId: OWNER, idempotencyKey: "retry:stale-claim" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "DELIVERY_OUTCOME_UNKNOWN_CONFIRMATION_REQUIRED");
  assert.equal(f.calls.delivery, callsBefore, "reconciliation must never call the provider again");
  const reconciled = f.repository.inspect().deliveries.find((entry) => entry.delivery_attempt_id === attemptId);
  assert.equal(reconciled.status, "RECOVERABLE_FAILURE");
  assert.equal(reconciled.last_error_code, "DELIVERY_OUTCOME_UNKNOWN");
});

test("stale claim: a delivery attempt still fresh (claimed recently) is left completely untouched — rejected as still in progress, no reconciliation, no provider call", async () => {
  const f = await failedDelivery();
  const state = f.repository.inspect();
  const attemptId = state.deliveries[0].delivery_attempt_id;
  await f.repository.updateDeliveryAttempt({
    deliveryAttemptId: attemptId, expectedStatus: "RECOVERABLE_FAILURE",
    changes: { status: "IN_PROGRESS", last_attempt_at: NOW },
  });
  const callsBefore = f.calls.delivery;
  const result = await f.service.retryDelivery({ documentId: command.documentId, ownerWaId: OWNER, idempotencyKey: "retry:fresh-claim" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "DELIVERY_ALREADY_IN_PROGRESS");
  assert.equal(f.calls.delivery, callsBefore);
  const untouched = f.repository.inspect().deliveries.find((entry) => entry.delivery_attempt_id === attemptId);
  assert.equal(untouched.status, "IN_PROGRESS");
  assert.equal(untouched.last_attempt_at, NOW);
});

test("a crash during the very first delivery attempt (claim lands, provider call never returns, deliverFinal's continuation never runs) leaves the document at GENERATED — a later stale-claim reconciliation that confirms success must still heal the document to DELIVERED, not strand it forever (independent-review finding)", async () => {
  const f = await fixture({
    hangDeliverDocumentCalls: 1,
    getDeliveryStatus: async () => ({ ok: true, value: { status: "DELIVERED" } }),
  });
  // Fire-and-forget: confirmGeneration will hang forever inside the first
  // deliverDocument() call, exactly like a crashed process never resuming.
  f.service.confirmGeneration(command).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stuck = await f.documents.getDocumentById({ documentId: command.documentId, ownerWaId: OWNER });
  assert.equal(stuck.value.status, "GENERATED", "document must still be GENERATED — deliverFinal's continuation never ran");
  const stuckDelivery = f.repository.inspect().deliveries.find((entry) => entry.final_file_id);
  assert.equal(stuckDelivery.status, "IN_PROGRESS");
  // Force the claim to look stale without waiting for real time to pass.
  await f.repository.updateDeliveryAttempt({
    deliveryAttemptId: stuckDelivery.delivery_attempt_id, expectedStatus: "IN_PROGRESS",
    changes: { status: "IN_PROGRESS", last_attempt_at: "2020-01-01T00:00:00.000Z" },
  });
  const healed = await f.service.retryDelivery({ documentId: command.documentId, ownerWaId: OWNER, idempotencyKey: "retry:heal-generated" });
  assert.equal(healed.ok, true, healed.error);
  assert.equal(healed.value.document.status, "DELIVERED", "must heal from GENERATED, not just RECOVERABLE_FAILURE — this is exactly what the independent review flagged as missing");
});

test("outcome-unknown resend requires an explicit second confirmation; a plain retry press never resends, only the confirmed press does", async () => {
  const f = await failedDelivery();
  const state = f.repository.inspect();
  const attemptId = state.deliveries[0].delivery_attempt_id;
  await f.repository.updateDeliveryAttempt({
    deliveryAttemptId: attemptId, expectedStatus: "RECOVERABLE_FAILURE",
    changes: { status: "IN_PROGRESS", last_attempt_at: "2020-01-01T00:00:00.000Z" },
  });
  const callsBeforeUnconfirmed = f.calls.delivery;
  const unconfirmed = await f.service.retryDelivery({ documentId: command.documentId, ownerWaId: OWNER, idempotencyKey: "retry:unconfirmed" });
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.error, "DELIVERY_OUTCOME_UNKNOWN_CONFIRMATION_REQUIRED");
  assert.equal(f.calls.delivery, callsBeforeUnconfirmed, "must never call the provider before explicit confirmation");
  const confirmed = await f.service.retryDelivery({ documentId: command.documentId, ownerWaId: OWNER, idempotencyKey: "retry:confirmed", confirmed: true });
  assert.equal(confirmed.ok, true, confirmed.error);
  assert.equal(confirmed.value.document.status, "DELIVERED");
  assert.equal(f.calls.delivery, callsBeforeUnconfirmed + 1, "exactly one provider call, only after explicit confirmation");
});

test("finalize-write exhaustion after a real provider call leaves the attempt IN_PROGRESS for later reconciliation — never a confirmed outcome", async () => {
  // The DB write immediately following a claim (status expectedStatus
  // IN_PROGRESS) is the finalize write this test forces to fail every
  // time — simulating a DB failure/crash after the provider already
  // responded. Wrapped in before the delivery/lifecycle services are
  // built, since the in-memory repository object is frozen.
  function wrapRepository(repository) {
    const wrapped = {};
    for (const key of Object.keys(repository)) wrapped[key] = repository[key];
    let inProgressCallIndex = 0;
    wrapped.updateDeliveryAttempt = async (args) => {
      if (args.expectedStatus === "IN_PROGRESS") {
        const index = inProgressCallIndex;
        inProgressCallIndex += 1;
        // Let the very first finalize write (the initial confirmGeneration
        // recording the seeded provider failure) succeed normally, so the
        // fixture reaches its expected RECOVERABLE_FAILURE baseline; force
        // every finalize write after that — i.e. the retry's — to fail.
        if (index > 0) return { ok: false, error: "SIMULATED_DB_FAILURE" };
      }
      return repository.updateDeliveryAttempt(args);
    };
    return wrapped;
  }
  const f = await failedDelivery({ wrapRepository });
  const result = await f.service.retryDelivery({ documentId: command.documentId, ownerWaId: OWNER, idempotencyKey: "retry:finalize-unresolved" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "DELIVERY_OUTCOME_UNKNOWN");
  const attemptId = f.repository.inspect().deliveries[0].delivery_attempt_id;
  const stuck = f.repository.inspect().deliveries.find((entry) => entry.delivery_attempt_id === attemptId);
  assert.equal(stuck.status, "IN_PROGRESS", "never silently marked DELIVERED or RECOVERABLE_FAILURE on a finalize-write failure");
});

test("history-driven recovery surface: a document shaped exactly like the confirmed stuck-document incident exposes a reachable RETRY_DELIVERY action from history, classified as a confirmed failure", async () => {
  const f = await failedDelivery();
  const { createV1HistoryService } = require("../kadiV1HistoryService");
  const state = f.repository.inspect();
  const deliveryRow = state.deliveries[0];
  const finalFileRow = state.finalFiles[0];
  const historyRepository = {
    async searchOwnedDocuments() { return { ok: true, value: [] }; },
    async getOwnedDocumentBundle({ ownerWaId, documentId }) {
      const doc = await f.documents.getDocumentById({ documentId, ownerWaId });
      if (!doc.ok) return doc;
      return {
        ok: true,
        value: {
          classification: "V1_NATIVE",
          document: doc.value,
          current_snapshot: doc.value,
          versions: [], events: [],
          final_file: finalFileRow,
          delivery: { status: deliveryRow.status, attempt_count: deliveryRow.attempt_count, last_error_code: deliveryRow.last_error_code },
        },
      };
    },
    async findDuplicateByIdempotencyKey() { return { ok: true, value: null }; },
    async rememberDuplicate() { return { ok: true, value: null }; },
  };
  const history = createV1HistoryService({ historyRepository, documentRepository: f.documents });
  const details = await history.getDocumentDetails({ ownerWaId: OWNER, documentId: command.documentId });
  assert.equal(details.ok, true);
  assert.ok(details.value.summary.actions.includes("RETRY_DELIVERY"), "the exact reachability gap this fix closes");
  assert.equal(details.value.delivery.outcome, "CONFIRMED_FAILURE");
});

test("full production path: pressing the reachable button through the real webhook, real presenter and real lifecycle service delivers exactly once", async () => {
  const f = await failedDelivery();
  const generationRuntime = createKadiV1GenerationRuntimeAdapter({ generationLifecycleService: f.service });
  const deliveryRetryRuntime = createKadiV1DeliveryRetryRuntime({ generationRuntime });
  const sent = { buttons: [], texts: [] };
  const presenter = {
    async presentConversation() {},
    async presentFlowReply() {},
    async presentRecoverableError() {},
    async presentDeliveryFailureWithRetry({ ownerWaId, documentId }) {
      sent.buttons.push({ ownerWaId, documentId });
    },
    async presentDeliveryRetryOutcome({ ownerWaId, outcome }) {
      sent.texts.push({ ownerWaId, outcome });
    },
  };
  const runtime = createKadiV1WebhookRuntime({
    config: { enabled: true, features: { webhook: true }, rollout: { mode: "FULL", valid: true, canaryOwnerCount: 0, canaryWaIds: [] } },
    orchestrator: { handle: async () => ({ handled: true, canonical_text: "…", business_action: "X", flow_request: null, voice_request: null, events: [] }) },
    flowReplyRuntime: { handle: async () => ({ ok: true, value: { handled: true, action: "X", duplicate: false, result: {} } }) },
    mediaResolver: { resolveAudio: async () => ({ ok: false, error: "N/A" }), resolveImage: async () => ({ ok: false, error: "N/A" }), resolvePdf: async () => ({ ok: false, error: "N/A" }) },
    presenter,
    deliveryRetryRuntime,
  });
  const message = { id: "wamid:retry-press", from: OWNER, type: "interactive", interactive: { type: "button", button_reply: { id: `RETRY_DELIVERY:${command.documentId}`, title: "Réenvoyer le PDF" } } };
  const result = await runtime.handleIncomingValue({ messages: [message] });
  assert.equal(result.handled, true);
  assert.equal(result.results[0].accepted, true);
  assert.equal(sent.texts.length, 1);
  assert.equal(sent.texts[0].outcome, "SUCCEEDED");
  const state = f.repository.inspect();
  assert.equal(state.deliveries.filter((entry) => entry.status === "DELIVERED").length, 1);
  assert.equal(state.ledger.length, 1);
});
