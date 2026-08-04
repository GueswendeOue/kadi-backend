"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDocumentDomain, DOCUMENT_EVENTS } = require("../kadiV1DocumentDomain");
const { createInMemoryV1DocumentRepository } = require("../kadiV1DocumentRepository");
const { createInMemoryV1PreviewRepository } = require("../kadiV1PreviewRepository");
const { createInMemoryGenerationLifecycleRepository } = require("../kadiV1GenerationLifecycleRepository");
const { createWalletReservationService } = require("../kadiV1WalletReservationService");
const { createGenerationLifecycleService } = require("../kadiV1GenerationLifecycleService");
const { createKadiV1GenerationRuntimeAdapter } = require("../kadiV1RuntimeAdapters");
const { createKadiV1FlowCommandRuntime } = require("../kadiV1FlowCommandRuntime");
const { createKadiV1FlowReplyRuntime } = require("../kadiV1FlowReplyRuntime");
const {
  createConversationSessionService,
  createMemoryConversationSessionRepository,
} = require("../kadiV1ConversationSession");

const OWNER = "22670000000";
const NOW = "2026-08-03T00:00:00.000Z";
const DOCUMENT_ID = "doc:release:recovery";
const PREVIEW_ID = "preview:release:recovery";
const RENDER_ID = "render:release:recovery";
const QUOTE_ID = "quote:release:recovery";

const ok = (value, extra = {}) => ({ ok: true, value, ...extra });
const fail = (error) => ({ ok: false, error });

function passiveCommandRuntimeDependencies(generationRuntime) {
  const noop = async () => ok({});
  return {
    onboardingRuntime: { continueOnboarding: noop },
    documentRuntime: {
      start: noop, setClient: noop, addContent: noop, updateContent: noop, removeContent: noop, finishContent: noop,
      setOptions: noop, verify: noop, beginEdit: noop, saveForLater: noop,
      saveDischargeDetails: noop, cancel: noop,
    },
    previewRuntime: { prepare: noop },
    generationRuntime,
    rechargeRuntime: { selectPack: noop, checkPayment: noop, cancel: noop },
    historyRuntime: { search: noop, open: noop },
    walletRuntime: { getBalance: async () => ok({ credits: 0 }) },
  };
}

async function createRecoveryHarness({
  balance = 20,
  failPromotionOnce = false,
  deliveryResults = [ok({ reference: "delivery:release:ok" })],
} = {}) {
  const clock = () => NOW;
  const domain = createDocumentDomain({ clock });
  const documents = createInMemoryV1DocumentRepository();
  const artifacts = createInMemoryV1PreviewRepository();
  const generationRepository = createInMemoryGenerationLifecycleRepository({ balances: { [OWNER]: balance } });
  const wallet = createWalletReservationService({ repository: generationRepository, clock });

  let document = domain.createDocument({
    document_id: DOCUMENT_ID,
    document_type: "FACTURE",
    issuer_profile_id: "issuer:release",
    currency: "XOF",
    client: { name: "Client test release" },
    items: [{ item_id: "item:release:1", description: "Prestation", quantity_millis: 1000, unit_price: 5000 }],
  }).value;
  await documents.createDocument({ document, ownerWaId: OWNER, idempotencyKey: "release:recovery:create" });

  for (const [event, payload, key] of [
    [DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW, {}, "ready"],
    [DOCUMENT_EVENTS.VERIFY, {}, "verify"],
    [DOCUMENT_EVENTS.PREPARE_PREVIEW, { preview: { preview_id: PREVIEW_ID } }, "preview"],
    [DOCUMENT_EVENTS.CALCULATE_COST, {
      generation_quote: { quote_id: QUOTE_ID, document_version: 1, page_count: 2, credit_cost: 4 },
    }, "cost"],
    [DOCUMENT_EVENTS.REQUEST_GENERATION_CONFIRMATION, {}, "confirmation"],
  ]) {
    const transitioned = domain.transitionDocument(document, event, payload);
    assert.equal(transitioned.ok, true, transitioned.error);
    const saved = await documents.persistTransition({
      document: transitioned.value,
      ownerWaId: OWNER,
      expectedVersion: document.version,
      fromState: document.status,
      eventType: `RELEASE_${key.toUpperCase()}`,
      idempotencyKey: `release:recovery:${key}`,
    });
    assert.equal(saved.ok, true, saved.error);
    document = saved.value;
  }

  await artifacts.createPreview({
    preview: {
      preview_id: PREVIEW_ID,
      document_id: DOCUMENT_ID,
      document_version: 1,
      owner_wa_id: OWNER,
      status: "ACTIVE",
      structured_preview: { document_type: "FACTURE", total: 5000 },
    },
    idempotencyKey: "release:recovery:preview-record",
  });
  await artifacts.createTemporaryRender({
    render: {
      render_id: RENDER_ID,
      preview_id: PREVIEW_ID,
      document_id: DOCUMENT_ID,
      document_version: 1,
      owner_wa_id: OWNER,
      status: "INSPECTED",
      page_count: 2,
    },
    idempotencyKey: "release:recovery:render-record",
  });
  await artifacts.createGenerationQuote({
    quote: {
      quote_id: QUOTE_ID,
      document_id: DOCUMENT_ID,
      document_version: 1,
      owner_wa_id: OWNER,
      preview_id: PREVIEW_ID,
      temporary_render_id: RENDER_ID,
      page_count: 2,
      total_credits: 4,
      pricing_version: "release-v1",
      status: "ACTIVE",
      expires_at: "2026-08-03T01:00:00.000Z",
    },
    idempotencyKey: "release:recovery:quote-record",
  });

  let promotionShouldFail = failPromotionOnce;
  let deliveryIndex = 0;
  const finalGeneration = {
    async generatePrivate({ generationAttemptId, expectedPageCount }) {
      const attempt = await generationRepository.getGenerationAttempt({ generationAttemptId });
      if (!attempt.ok) return attempt;
      return generationRepository.updateGenerationAttempt({
        generationAttemptId,
        expectedStatus: "STARTED",
        changes: {
          status: "PDF_VALIDATED",
          staging_path: `private/staging/${generationAttemptId}.pdf`,
          checksum: "a".repeat(64),
          page_count: expectedPageCount,
        },
      });
    },
    async discardPrivate() { return ok({ discarded: true }); },
    async markCaptured({ generationAttemptId, reservationId }) {
      const attempt = await generationRepository.getGenerationAttempt({ generationAttemptId });
      if (!attempt.ok) return attempt;
      if (["CAPTURED", "PROMOTED"].includes(attempt.value.status)) return attempt;
      return generationRepository.updateGenerationAttempt({
        generationAttemptId,
        expectedStatus: "PDF_VALIDATED",
        changes: { status: "CAPTURED", reservation_id: reservationId },
      });
    },
    async promoteFinal({ generationAttemptId, documentId, documentVersion, idempotencyKey }) {
      if (promotionShouldFail) {
        promotionShouldFail = false;
        return fail("PROMOTION_TEMPORARY");
      }
      const attempt = await generationRepository.getGenerationAttempt({ generationAttemptId });
      if (!attempt.ok) return attempt;
      const finalFile = {
        final_file_id: `final:${generationAttemptId}`,
        generation_attempt_id: generationAttemptId,
        document_id: documentId,
        document_version: documentVersion,
        private_path: `private/final/${documentId}/v${documentVersion}.pdf`,
        checksum: "a".repeat(64),
        page_count: 2,
      };
      const promoted = await generationRepository.promoteFinalFile({ finalFile, idempotencyKey });
      if (!promoted.ok) return promoted;
      if (attempt.value.status === "CAPTURED") {
        const marked = await generationRepository.updateGenerationAttempt({
          generationAttemptId,
          expectedStatus: "CAPTURED",
          changes: { status: "PROMOTED", final_file_id: promoted.value.final_file_id },
        });
        if (!marked.ok) return marked;
      }
      return promoted;
    },
  };

  const delivery = {
    async createDeliveryAttempt({ finalFileId, ownerRef, idempotencyKey }) {
      return generationRepository.createDeliveryAttempt({
        delivery: {
          delivery_attempt_id: `delivery:${finalFileId}`,
          final_file_id: finalFileId,
          owner_ref: ownerRef,
          status: "PENDING",
          attempt_count: 0,
        },
        idempotencyKey,
      });
    },
    async deliver({ deliveryAttemptId }) {
      const current = await generationRepository.getDeliveryAttempt({ deliveryAttemptId });
      if (!current.ok) return current;
      const result = deliveryResults[Math.min(deliveryIndex, deliveryResults.length - 1)];
      deliveryIndex += 1;
      const status = result.ok ? "DELIVERED" : "RECOVERABLE_FAILURE";
      await generationRepository.updateDeliveryAttempt({
        deliveryAttemptId,
        changes: { status, attempt_count: current.value.attempt_count + 1 },
      });
      return result;
    },
    async retryDelivery({ deliveryAttemptId }) { return this.deliver({ deliveryAttemptId }); },
  };

  const quoteService = {
    async validateGenerationQuote({ quoteId, ownerWaId }) {
      const quote = await artifacts.getGenerationQuote({ quoteId });
      if (!quote.ok || quote.value.owner_wa_id !== ownerWaId || quote.value.status !== "ACTIVE") {
        return fail("GENERATION_QUOTE_NOT_ACTIVE");
      }
      return quote;
    },
  };

  const lifecycle = createGenerationLifecycleService({
    documentRepository: documents,
    previewRepository: artifacts,
    generationRepository,
    quoteService,
    walletReservationService: wallet,
    finalGenerationService: finalGeneration,
    deliveryService: delivery,
    domain,
    clock,
  });
  const generationRuntime = createKadiV1GenerationRuntimeAdapter({ generationLifecycleService: lifecycle });
  const commandRuntime = createKadiV1FlowCommandRuntime(passiveCommandRuntimeDependencies(generationRuntime));
  let sessionSequence = 0;
  const sessions = createConversationSessionService({
    repository: createMemoryConversationSessionRepository(),
    clock,
    idFactory: () => `kadi_session:recovery:${++sessionSequence}`,
  });
  const replies = createKadiV1FlowReplyRuntime({ sessionService: sessions, commandRuntime });

  async function openConfirmationSession(key = "default") {
    const current = await documents.getDocumentById({ documentId: DOCUMENT_ID, ownerWaId: OWNER });
    assert.equal(current.ok, true);
    const opened = await sessions.open({
      ownerWaId: OWNER,
      document: current.value,
      expectedFlowKey: "GENERATION_CONFIRMATION",
      idempotencyKey: `release:confirmation-session:${key}`,
    });
    assert.equal(opened.ok, true, opened.error);
    return opened.value;
  }

  async function confirmThroughFlow({ session, replyKey = "release:confirm:reply" }) {
    return replies.handle({
      ownerWaId: OWNER,
      sessionId: session.session_id,
      flowKey: "GENERATION_CONFIRMATION",
      action: "CONFIRM_GENERATION",
      data: { quote_id: QUOTE_ID },
      idempotencyKey: replyKey,
    });
  }

  return {
    domain,
    documents,
    artifacts,
    generationRepository,
    lifecycle,
    openConfirmationSession,
    confirmThroughFlow,
  };
}

test("release recovery: insufficient credits redirects the document to recharge before any reservation or PDF", async () => {
  const harness = await createRecoveryHarness({ balance: 3 });
  const session = await harness.openConfirmationSession("insufficient");
  const result = await harness.confirmThroughFlow({ session, replyKey: "release:confirm:insufficient" });
  assert.deepEqual(result, { ok: false, error: "INSUFFICIENT_CREDITS" });
  const state = harness.generationRepository.inspect();
  assert.equal(state.reservations.length, 0);
  assert.equal(state.ledger.length, 0);
  assert.equal(state.finalFiles.length, 0);
  const document = await harness.documents.getDocumentById({ documentId: DOCUMENT_ID, ownerWaId: OWNER });
  assert.equal(document.value.status, "RECHARGE_REQUIRED");
});

test("release recovery: replaying the same Flow confirmation cannot debit or generate twice", async () => {
  const harness = await createRecoveryHarness();
  const session = await harness.openConfirmationSession("replay");
  const first = await harness.confirmThroughFlow({ session, replyKey: "release:confirm:replay" });
  const replay = await harness.confirmThroughFlow({ session, replyKey: "release:confirm:replay" });
  assert.equal(first.ok, true, first.error);
  assert.equal(replay.ok, true, replay.error);
  const state = harness.generationRepository.inspect();
  assert.equal(state.reservations.length, 1);
  assert.equal(state.ledger.length, 1);
  assert.equal(state.finalFiles.length, 1);
  assert.equal(state.deliveries.length, 1);
});

test("release recovery: concurrent confirmations for one quote produce one capture and one controlled conflict", async () => {
  const harness = await createRecoveryHarness();
  const firstSession = await harness.openConfirmationSession("concurrent-a");
  const secondSession = await harness.openConfirmationSession("concurrent-b");
  const results = await Promise.all([
    harness.confirmThroughFlow({ session: firstSession, replyKey: "release:confirm:concurrent-a" }),
    harness.confirmThroughFlow({ session: secondSession, replyKey: "release:confirm:concurrent-b" }),
  ]);
  assert.equal(results.filter((entry) => entry.ok).length, 1);
  assert.equal(results.filter((entry) => entry.error === "GENERATION_CONFIRMATION_CONFLICT").length, 1);
  const state = harness.generationRepository.inspect();
  assert.equal(state.reservations.length, 1);
  assert.equal(state.ledger.length, 1);
  assert.equal(state.finalFiles.length, 1);
});

test("release recovery: a delivery outage resumes with the same immutable PDF and no second debit", async () => {
  const harness = await createRecoveryHarness({
    deliveryResults: [fail("CHANNEL_TEMPORARY"), ok({ reference: "delivery:retry:ok" })],
  });
  const session = await harness.openConfirmationSession("delivery-failure");
  const failed = await harness.confirmThroughFlow({ session, replyKey: "release:confirm:delivery-failure" });
  assert.deepEqual(failed, { ok: false, error: "DELIVERY_RECOVERABLE_FAILURE" });
  let state = harness.generationRepository.inspect();
  assert.equal(state.ledger.length, 1);
  assert.equal(state.finalFiles.length, 1);
  assert.equal(state.deliveries[0].attempt_count, 1);

  const retried = await harness.lifecycle.retryDelivery({
    quoteId: QUOTE_ID,
    ownerWaId: OWNER,
    deliveryAttemptId: state.deliveries[0].delivery_attempt_id,
    idempotencyKey: "release:delivery:retry",
  });
  assert.equal(retried.ok, true, retried.error);
  state = harness.generationRepository.inspect();
  assert.equal(state.ledger.length, 1);
  assert.equal(state.finalFiles.length, 1);
  assert.equal(state.deliveries[0].attempt_count, 2);
});

test("release recovery: promotion failure after capture resumes without another wallet entry", async () => {
  const harness = await createRecoveryHarness({ failPromotionOnce: true });
  const session = await harness.openConfirmationSession("promotion-failure");
  const failed = await harness.confirmThroughFlow({ session, replyKey: "release:confirm:promotion-failure" });
  assert.deepEqual(failed, { ok: false, error: "FINAL_PROMOTION_RECOVERABLE_FAILURE" });
  assert.equal(harness.generationRepository.inspect().ledger.length, 1);

  const resumed = await harness.lifecycle.resumeGeneration({
    quoteId: QUOTE_ID,
    ownerWaId: OWNER,
    idempotencyKey: "release:generation:resume-promotion",
  });
  assert.equal(resumed.ok, true, resumed.error);
  const state = harness.generationRepository.inspect();
  assert.equal(state.ledger.length, 1);
  assert.equal(state.reservations.length, 1);
  assert.equal(state.finalFiles.length, 1);
});

test("release recovery: correcting after preview invalidates the old version before reservation", async () => {
  const harness = await createRecoveryHarness();
  const before = await harness.documents.getDocumentById({ documentId: DOCUMENT_ID, ownerWaId: OWNER });
  const corrected = harness.domain.modifyDocument(before.value, { notes: "Correction utilisateur" });
  assert.equal(corrected.ok, true, corrected.error);
  const saved = await harness.documents.persistTransition({
    document: corrected.value,
    ownerWaId: OWNER,
    expectedVersion: before.value.version,
    fromState: before.value.status,
    eventType: "RELEASE_DOCUMENT_CORRECTED",
    idempotencyKey: "release:recovery:correction-after-preview",
  });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.value.version, 2);
  assert.equal(saved.value.preview, null);
  assert.equal(saved.value.generation_quote, null);

  const staleSession = await harness.openConfirmationSession("stale-correction");
  const result = await harness.confirmThroughFlow({ session: staleSession, replyKey: "release:confirm:stale-correction" });
  assert.deepEqual(result, { ok: false, error: "GENERATION_CONFIRMATION_STATE_INVALID" });
  const state = harness.generationRepository.inspect();
  assert.equal(state.reservations.length, 0);
  assert.equal(state.ledger.length, 0);
  assert.equal(state.finalFiles.length, 0);
});
