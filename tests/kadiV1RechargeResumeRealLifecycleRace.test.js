"use strict";

// AUTO_RESUME_POST_PRECHECK_RACE_STUCK_001 (independent review of
// RECHARGE_RESUME_AVAILABLE_BALANCE_001's R0 fix): R0's own race test used a
// FAKE generationLifecycleService, so it never actually exercised the REAL
// GenerationLifecycle state machine's reaction to a post-precheck
// INSUFFICIENT_CREDITS. With the real stack: a correct precheck transitions
// the document RECHARGE_REQUIRED -> AWAITING_GENERATION_CONFIRMATION
// (RECHARGE_CONFIRMED) and marks the resume link STARTED; if the real
// walletReservationService.reserveCredits() then rejects (a genuine TOCTOU
// race), the real GenerationLifecycleService moves the document BACK to
// RECHARGE_REQUIRED via its own REQUIRE_RECHARGE event — a state
// confirmGeneration can never legitimately be called against again
// (validateConfirmation requires AWAITING_GENERATION_CONFIRMATION). Before
// this fix, a later retry (generation_started already true) skipped the
// precheck/re-arm entirely and called confirmGeneration directly, forever
// getting GENERATION_CONFIRMATION_STATE_INVALID — even after the competing
// reservation was released. See the pre-fix reproduction evidence recorded
// in docs/KADI_ENGINEERING_MEMORY.md fiche AG (obtained via `git stash` of
// kadiV1RechargeService.js on this exact real-composition fixture).
//
// This file wires REAL createRechargeService, createGenerationLifecycleService,
// createWalletReservationService, createDocumentDomain, real in-memory
// document/recharge/generation-lifecycle repositories, and the real
// preview/render/quote pipeline (via the real production
// createKadiV1PreviewRuntimeAdapter) — never faked, never a second parallel
// pipeline. Fake ONLY the truly external/heavy boundaries: PDF
// rendering/storage (a synthetic in-memory PDF via pdf-lib), the delivery
// network, and the payment provider network — exactly the mission's
// instruction. generationLifecycleService.confirmGeneration() and
// walletReservationService.reserveCredits() are never faked.

const test = require("node:test");
const assert = require("node:assert/strict");
const { PDFDocument } = require("pdf-lib");

const { createDocumentDomain, DOCUMENT_EVENTS } = require("../kadiV1DocumentDomain");
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
const { createRechargePackCatalog } = require("../kadiV1RechargeConfig");
const { createInMemoryRechargeRepository } = require("../kadiV1RechargeRepository");
const { createRechargeService } = require("../kadiV1RechargeService");
const { createKadiV1PreviewRuntimeAdapter } = require("../kadiV1RuntimeAdapters");

const OWNER = "22670000000";
const OTHER_OWNER = "22679999999";
const NOW = "2026-08-08T12:00:00.000Z";

let counter = 0;
function nextKey(prefix) { counter += 1; return `${prefix}:${counter}`; }

async function pdfBuffer(pageCount = 1) {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) pdf.addPage();
  return Buffer.from(await pdf.save());
}

// A deterministic (no-sleep) barrier: pauses exactly at the point requested
// (here, inside the balance precheck read) until the test explicitly
// releases it — the precheck's VALUE is computed and captured BEFORE the
// pause, faithfully representing "the precheck genuinely observed this
// state", while anything that runs after release (the real reservation
// call) observes whatever the test does in between.
function createBarrier() {
  let releaseFn;
  let reachedFn;
  const gate = new Promise((resolve) => { releaseFn = resolve; });
  const reached = new Promise((resolve) => { reachedFn = resolve; });
  let hit = false;
  return {
    reached,
    release() { releaseFn(); },
    async waitForRelease() { if (!hit) { hit = true; reachedFn(); } await gate; },
  };
}

// T6/T5's exact established pattern: the balance-reading side of the
// recharge repository reads directly from the SAME generationRepo instance
// reserveCredits/captureReservation/releaseReservation mutate — never a
// second, independent wallet map — mirroring the real
// kadi_v1_get_wallet_balance RPC's single read of both kadi_wallets and
// kadi_v1_wallet_reservations. barrierHolder is a mutable { current }
// object a test can arm/disarm per call, letting a specific precheck read
// pause deterministically without affecting any other call.
function createSharedWalletRechargeRepository(generationRepo, barrierHolder) {
  const real = createInMemoryRechargeRepository({});
  return {
    ...real,
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
      const value = { total_credits: total, reserved_credits: reserved, available_credits: total - reserved };
      const barrier = barrierHolder.current;
      if (barrier) await barrier.waitForRelease();
      return { ok: true, value };
    },
  };
}

function fakePaymentProvider() {
  const paymentsById = new Map();
  let sequence = 0;
  return {
    name: "SYNTHETIC_PAY",
    async createPaymentRequest(request) {
      sequence += 1;
      const providerPaymentId = `payment:${sequence}`;
      paymentsById.set(providerPaymentId, { merchant_reference: request.merchant_reference, amount: request.amount, currency: request.currency });
      return { ok: true, value: { provider: "SYNTHETIC_PAY", provider_payment_id: providerPaymentId, provider_event_id: null, merchant_reference: request.merchant_reference, amount: request.amount, currency: request.currency, status: "PENDING", verified: true, occurred_at: NOW, metadata: {} } };
    },
    async verifyPaymentEvent(raw) { return { ok: true, value: { ...raw } }; },
    async getPaymentStatus() { return { ok: false, error: "PAYMENT_NOT_FOUND" }; },
  };
}

// balance is the real, shared generationRepo wallet total for OWNER — the
// document's own eventual quote cost is always exactly 8 credits (pricing
// policy below), matching the mission's "available precheck = 8, generation
// cost = 8" scenario when balance=8.
function buildFixture({ balance = 8, otherOwnerBalance = 0, resumePolicy = "AUTO_RESUME_IF_VALID", documentsOverride = null } = {}) {
  const clock = () => NOW;
  const domain = createDocumentDomain({ clock });
  const realDocuments = createInMemoryV1DocumentRepository();
  const documents = documentsOverride ? documentsOverride(realDocuments) : realDocuments;

  const previewRepository = createInMemoryV1PreviewRepository();
  const previewService = createPreviewService({ documentRepository: documents, previewRepository, domain, clock, idFactory: (kind) => `${kind}:${nextKey(kind)}` });
  const temporaryRenderService = createTemporaryRenderService({
    previewRepository, storage: createInMemoryPrivateTemporaryStorage(),
    renderer: { render: async () => ({ ok: true, value: { buffer: await pdfBuffer(1), mime_type: "application/pdf", renderer: "TEST_RENDERER" } }) },
    pageCountInspector: createPdfLibPageCountInspector({ clock }), clock, idFactory: (kind) => `${kind}:${nextKey(kind)}`, lifetimeSeconds: 600,
  });
  const pricingPolicy = createGenerationPricingPolicy({
    pricingVersion: "r1-race-test-v1", validitySeconds: 600,
    documentTypes: Object.fromEntries(["FACTURE", "DEVIS", "RECU", "DECHARGE"].map((type) => [type, { baseCost: 8, perPageCost: 0 }])),
    modalityCosts: { TEXT: 0, TRANSCRIPTION: 1, IMAGE: 1, DOCUMENT: 1 }, optionCosts: {},
  }, { clock });
  const quoteService = createGenerationQuoteService({
    documentRepository: documents, previewRepository, pricingPolicy, domain, clock,
    idFactory: (kind, key) => `${kind}:${nextKey(key || kind)}`, defaultLifetimeSeconds: 600,
  });
  const previewRuntime = createKadiV1PreviewRuntimeAdapter({ previewService, temporaryRenderService, generationQuoteService: quoteService });

  const generationRepo = createInMemoryGenerationLifecycleRepository({ balances: { [OWNER]: balance, [OTHER_OWNER]: otherOwnerBalance } });
  const walletReservationService = createWalletReservationService({ repository: generationRepo, clock });
  const finalGenerationService = createFinalGenerationService({
    repository: generationRepo, storage: createInMemoryFinalFileStorage(),
    renderer: { render: async () => ({ ok: true, value: { buffer: await pdfBuffer(1), mime_type: "application/pdf" } }) }, clock,
  });
  const deliveryService = createDeliveryService({
    repository: generationRepo,
    provider: { async deliverDocument() { return { ok: true, value: { reference: "synthetic-delivery" } }; }, async getDeliveryStatus() { return { ok: true, value: null }; } },
    clock,
  });
  const generationLifecycleService = createGenerationLifecycleService({
    documentRepository: documents, previewRepository, generationRepository: generationRepo,
    quoteService, walletReservationService, finalGenerationService, deliveryService, domain, clock,
    idFactory: (kind, key) => `${kind}:${nextKey(key || kind)}`, observer: () => {},
  });

  const barrierHolder = { current: null };
  const rechargeRepository = createSharedWalletRechargeRepository(generationRepo, barrierHolder);
  const paymentProvider = fakePaymentProvider();
  const packCatalog = createRechargePackCatalog({ packs: [{ pack_id: "TEST_10", amount: 2000, currency: "XOF", credits: 10, pricing_version: "test-v1", active: true }] });

  function makeService(repoOverride) {
    return createRechargeService({
      repository: repoOverride || rechargeRepository, packCatalog, paymentProvider, documentRepository: documents,
      quoteService, generationLifecycleService, domain, resumePolicy, clock,
    });
  }
  const rechargeService = makeService();

  async function driveToRechargeRequired(ownerWaId, suffix) {
    let document = domain.createDocument({
      document_id: `doc:${suffix}`, document_type: "FACTURE", issuer_profile_id: "issuer:test", currency: "XOF",
      client: { name: `Client ${suffix}` }, items: [{ item_id: `item:${suffix}`, description: "Service", quantity_millis: 1000, unit_price: 5000 }],
    }).value;
    await documents.createDocument({ document, ownerWaId, idempotencyKey: `doc:${suffix}:create` });
    for (const [event, label] of [[DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW, "READY"], [DOCUMENT_EVENTS.VERIFY, "VERIFIED"]]) {
      const next = domain.transitionDocument(document, event, {});
      assert.equal(next.ok, true, next.error);
      const persisted = await documents.persistTransition({ document: next.value, ownerWaId, expectedVersion: 1, fromState: document.status, eventType: `TEST_${label}`, idempotencyKey: `doc:${suffix}:${label.toLowerCase()}` });
      assert.equal(persisted.ok, true, persisted.error);
      document = persisted.value;
    }
    // previewRuntime.prepare() is the REAL production PREPARE_PDF path
    // (persistPreview -> createTemporaryRender -> inspectTemporaryRender ->
    // createGenerationQuote) — createGenerationQuote itself already drives
    // CALCULATE_COST -> REQUEST_GENERATION_CONFIRMATION for real, so the
    // document is already AWAITING_GENERATION_CONFIRMATION afterward, with
    // a genuine, backend-computed 8-credit quote.
    const prepared = await previewRuntime.prepare({ ownerWaId, documentId: document.document_id, expectedVersion: document.version, documentType: "FACTURE", idempotencyKey: `prepare:${suffix}` });
    assert.equal(prepared.ok, true, prepared.error);
    assert.equal(prepared.value.quote.total_credits, 8);
    document = (await documents.getDocumentById({ documentId: document.document_id, ownerWaId })).value;
    assert.equal(document.status, "AWAITING_GENERATION_CONFIRMATION");
    // Equivalent outcome to an earlier real failed confirmGeneration
    // attempt (REQUIRE_RECHARGE is the exact same event
    // kadiV1GenerationLifecycleService.js's own runConfirmation applies on
    // INSUFFICIENT_CREDITS) — bounces the document to RECHARGE_REQUIRED.
    const rechargeRequired = domain.transitionDocument(document, DOCUMENT_EVENTS.REQUIRE_RECHARGE, {});
    assert.equal(rechargeRequired.ok, true, rechargeRequired.error);
    const persisted = await documents.persistTransition({ document: rechargeRequired.value, ownerWaId, expectedVersion: document.version, fromState: document.status, eventType: "TEST_RECHARGE_REQUIRED", idempotencyKey: `doc:${suffix}:recharge-required` });
    assert.equal(persisted.ok, true, persisted.error);
    document = persisted.value;
    assert.equal(document.status, "RECHARGE_REQUIRED");
    return { document, quote: prepared.value.quote };
  }

  async function linkAndConfirmRecharge({ ownerWaId, document, quote, suffix }) {
    const created = await rechargeService.createRechargeSession({
      ownerWaId, packId: "TEST_10", idempotencyKey: `recharge:create:${suffix}`,
      document: { documentId: document.document_id, documentVersion: document.version, quoteId: quote.quote_id, generationConfirmationId: `confirm:${suffix}`, missingCredits: quote.total_credits },
    });
    assert.equal(created.ok, true, created.error);
    const initiated = await rechargeService.initiatePayment({ rechargeSessionId: created.value.recharge_session_id, ownerWaId });
    assert.equal(initiated.ok, true, initiated.error);
    const confirmed = rechargeService.confirmPaymentEvent({
      rechargeSessionId: initiated.value.recharge_session_id,
      rawEvent: { provider: "SYNTHETIC_PAY", provider_payment_id: initiated.value.provider_payment_id, provider_event_id: `event:${suffix}`, merchant_reference: initiated.value.merchant_reference, amount: 2000, currency: "XOF", status: "CONFIRMED", verified: true, occurred_at: NOW, metadata: {} },
    });
    return { rechargeSessionId: initiated.value.recharge_session_id, confirmed };
  }

  return {
    domain, documents, realDocuments, previewRepository, generationRepo, walletReservationService, generationLifecycleService,
    rechargeRepository, rechargeService, barrierHolder, makeService,
    driveToRechargeRequired, linkAndConfirmRecharge,
  };
}

// AUTO_RESUME_CRASH_RECONCILIATION_001: wraps the real in-memory document
// repository's persistTransition — lets the real commit happen, then
// (armed.value===true, matching eventType) throws PROCESS_CRASH before
// returning to the caller, never rolling back the already-persisted
// transition. Mirrors exactly how a real process crash would leave
// durable state: the write landed, but the caller never got to react to
// it or make its own next write.
function wrapDocumentsWithCrash(realDocuments, { crashOnEventType, armed }) {
  return {
    ...realDocuments,
    async persistTransition(command) {
      const result = await realDocuments.persistTransition(command);
      if (armed.value && result.ok && command.eventType === crashOnEventType) {
        armed.value = false;
        throw new Error("SIMULATED_PROCESS_CRASH");
      }
      return result;
    },
  };
}

// Wraps the recharge repository's own updateResumeLink — lets the real
// commit happen for every OTHER call, but throws PROCESS_CRASH on the
// first call matching the given resume_status change, simulating a crash
// strictly AFTER the real financial authority already completed but
// BEFORE this service's own bookkeeping could finish.
function wrapRechargeRepositoryWithCrash(rechargeRepository, { crashOnResumeStatus, armed }) {
  const realUpdateResumeLink = rechargeRepository.updateResumeLink.bind(rechargeRepository);
  return {
    ...rechargeRepository,
    async updateResumeLink(command) {
      if (armed.value && command.changes?.resume_status === crashOnResumeStatus) {
        armed.value = false;
        throw new Error("SIMULATED_PROCESS_CRASH");
      }
      return realUpdateResumeLink(command);
    },
  };
}

// =====================================================================
// 1. Primary race, real composition: correct precheck, real downstream
// INSUFFICIENT_CREDITS, safe non-start, then a real, successful retry once
// the competing reservation is released.
// =====================================================================

test("R1-1. Real GenerationLifecycle composition: a post-precheck race is caught safely by the real authority, and a retry after release genuinely reaches the real wallet reservation again", async () => {
  const f = buildFixture({ balance: 8 });
  const { document, quote } = await f.driveToRechargeRequired(OWNER, "r1-1");
  const barrier = createBarrier();
  f.barrierHolder.current = barrier;
  const { rechargeSessionId, confirmed } = await f.linkAndConfirmRecharge({ ownerWaId: OWNER, document, quote, suffix: "r1-1" });

  await barrier.reached;
  // The precheck has read available=8 (matching cost=8) but not yet
  // returned — inject a REAL competing reservation for the same owner now.
  const competing = await f.walletReservationService.reserveCredits({ ownerWaId: OWNER, quoteId: "quote:competing:r1-1", amount: 1, idempotencyKey: "reserve:competing:r1-1" });
  assert.equal(competing.ok, true, competing.error);
  barrier.release();
  f.barrierHolder.current = null;

  const result = await confirmed;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.resume_error, "GENERATION_RESUME_FAILED", "the precheck was correct; only the real, final authority caught the race");
  const afterRace = await f.documents.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER });
  assert.equal(afterRace.value.status, "RECHARGE_REQUIRED", "the real GenerationLifecycleService's own REQUIRE_RECHARGE bounce-back — never AWAITING_GENERATION_CONFIRMATION stuck");
  const stateAfterRace = f.generationRepo.inspect();
  assert.equal(stateAfterRace.attempts.length, 0, "the real reservation never succeeded — zero generation attempt created");
  const ownReservation = stateAfterRace.reservations.find((entry) => entry.quote_id === quote.quote_id);
  assert.equal(ownReservation, undefined, "the document's own reservation was never created — nothing to release, zero debit");

  const released = await f.walletReservationService.releaseReservation({ reservationId: competing.value.reservation_id, idempotencyKey: "release:competing:r1-1" });
  assert.equal(released.ok, true, released.error);

  const retried = await f.rechargeService.resumePendingGeneration({ rechargeSessionId, ownerWaId: OWNER });
  assert.equal(retried.ok, true, retried.error, "the retry must genuinely reach the real wallet reservation authority again, not stay permanently GENERATION_CONFIRMATION_STATE_INVALID");
  assert.equal(retried.resume.automatic, true);
  const afterRetry = await f.documents.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER });
  assert.equal(afterRetry.value.status, "DELIVERED", "the real pipeline completes end to end once the conflict genuinely resolves");
  const finalState = f.generationRepo.inspect();
  assert.equal(finalState.attempts.length, 1, "exactly one real generation attempt, never duplicated");
  const captured = finalState.reservations.find((entry) => entry.quote_id === quote.quote_id);
  assert.equal(captured.status, "CAPTURED");
  assert.equal(captured.amount, 8);
  const rechargeState = f.rechargeRepository.inspect();
  assert.equal(rechargeState.ledger.length, 1, "the recharge itself was only ever credited once");
  assert.equal(rechargeState.resumeLinks[0].resume_status, "RESUMED");
  assert.equal(rechargeState.resumeLinks[0].last_error_code, null);
});

// =====================================================================
// 2. Repeated race: two consecutive real races, each correctly bounced,
// final retry after release succeeds — no permanent stuck state, no
// accumulating corruption, no duplicate recharge credit.
// =====================================================================

test("R1-2. Two consecutive real races each bounce the document safely; the resume recovers once the conflict is genuinely resolved", async () => {
  const f = buildFixture({ balance: 8 });
  const { document, quote } = await f.driveToRechargeRequired(OWNER, "r1-2");
  const barrier1 = createBarrier();
  f.barrierHolder.current = barrier1;
  const { rechargeSessionId, confirmed } = await f.linkAndConfirmRecharge({ ownerWaId: OWNER, document, quote, suffix: "r1-2" });

  await barrier1.reached;
  const race1 = await f.walletReservationService.reserveCredits({ ownerWaId: OWNER, quoteId: "quote:competing:r1-2-a", amount: 1, idempotencyKey: "reserve:competing:r1-2-a" });
  assert.equal(race1.ok, true, race1.error);
  barrier1.release();
  f.barrierHolder.current = null;
  const first = await confirmed;
  assert.equal(first.resume_error, "GENERATION_RESUME_FAILED");
  assert.equal((await f.documents.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER })).value.status, "RECHARGE_REQUIRED");

  // Release race #1, but immediately arm race #2 for the retry's own
  // precheck — proving a SECOND consecutive race is handled just as safely
  // (in particular: the real GenerationLifecycleService's REQUIRE_RECHARGE
  // idempotency key must not go stale on a second bounce-back).
  const released1 = await f.walletReservationService.releaseReservation({ reservationId: race1.value.reservation_id, idempotencyKey: "release:competing:r1-2-a" });
  assert.equal(released1.ok, true, released1.error);
  const barrier2 = createBarrier();
  f.barrierHolder.current = barrier2;
  const retry1Promise = f.rechargeService.resumePendingGeneration({ rechargeSessionId, ownerWaId: OWNER });
  await barrier2.reached;
  const race2 = await f.walletReservationService.reserveCredits({ ownerWaId: OWNER, quoteId: "quote:competing:r1-2-b", amount: 1, idempotencyKey: "reserve:competing:r1-2-b" });
  assert.equal(race2.ok, true, race2.error);
  barrier2.release();
  f.barrierHolder.current = null;
  const retry1 = await retry1Promise;
  assert.equal(retry1.ok, false);
  assert.equal(retry1.error, "GENERATION_RESUME_FAILED");
  const afterSecondRace = await f.documents.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER });
  assert.equal(afterSecondRace.value.status, "RECHARGE_REQUIRED", "the SECOND real race must also correctly bounce the document back — never stuck at AWAITING_GENERATION_CONFIRMATION");

  const released2 = await f.walletReservationService.releaseReservation({ reservationId: race2.value.reservation_id, idempotencyKey: "release:competing:r1-2-b" });
  assert.equal(released2.ok, true, released2.error);
  const retry2 = await f.rechargeService.resumePendingGeneration({ rechargeSessionId, ownerWaId: OWNER });
  assert.equal(retry2.ok, true, retry2.error);
  assert.equal((await f.documents.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER })).value.status, "DELIVERED");
  const finalState = f.generationRepo.inspect();
  assert.equal(finalState.attempts.length, 1, "exactly one real generation attempt across both races and the final success");
  const rechargeState = f.rechargeRepository.inspect();
  assert.equal(rechargeState.ledger.length, 1, "the recharge credit was never duplicated across two races and three resume attempts");
});

// =====================================================================
// 3. Exact replay / concurrency: simultaneous resumePendingGeneration
// calls collapse safely — exactly one reservation, one generation attempt.
// =====================================================================

test("R1-3. Simultaneous resumePendingGeneration calls for the same session collapse to exactly one reservation and one generation attempt", async () => {
  const f = buildFixture({ balance: 8 });
  const { document, quote } = await f.driveToRechargeRequired(OWNER, "r1-3");
  const created = await f.rechargeService.createRechargeSession({
    ownerWaId: OWNER, packId: "TEST_10", idempotencyKey: "recharge:create:r1-3",
    document: { documentId: document.document_id, documentVersion: document.version, quoteId: quote.quote_id, generationConfirmationId: "confirm:r1-3", missingCredits: quote.total_credits },
  });
  assert.equal(created.ok, true, created.error);
  const initiated = await f.rechargeService.initiatePayment({ rechargeSessionId: created.value.recharge_session_id, ownerWaId: OWNER });
  assert.equal(initiated.ok, true, initiated.error);
  const confirmed = await f.rechargeService.confirmPaymentEvent({
    rechargeSessionId: initiated.value.recharge_session_id,
    rawEvent: { provider: "SYNTHETIC_PAY", provider_payment_id: initiated.value.provider_payment_id, provider_event_id: "event:r1-3", merchant_reference: initiated.value.merchant_reference, amount: 2000, currency: "XOF", status: "CONFIRMED", verified: true, occurred_at: NOW, metadata: {} },
  });
  assert.equal(confirmed.ok, true, confirmed.error);
  assert.equal(confirmed.resume.automatic, true);
  assert.equal((await f.documents.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER })).value.status, "DELIVERED");

  // Exact replay: the session is already RESUMED — any further concurrent
  // or sequential resumePendingGeneration call must be a safe, inert
  // duplicate, never a second reservation/attempt/generation.
  const [replayA, replayB] = await Promise.all([
    f.rechargeService.resumePendingGeneration({ rechargeSessionId: initiated.value.recharge_session_id, ownerWaId: OWNER }),
    f.rechargeService.resumePendingGeneration({ rechargeSessionId: initiated.value.recharge_session_id, ownerWaId: OWNER }),
  ]);
  assert.equal(replayA.ok, true, replayA.error);
  assert.equal(replayB.ok, true, replayB.error);
  assert.equal(replayA.duplicate, true);
  assert.equal(replayB.duplicate, true);
  const finalState = f.generationRepo.inspect();
  assert.equal(finalState.attempts.length, 1, "exactly one generation attempt after concurrent replay calls");
  const reserved = finalState.reservations.filter((entry) => entry.quote_id === quote.quote_id);
  assert.equal(reserved.length, 1, "exactly one reservation for this quote, never duplicated");
  const rechargeState = f.rechargeRepository.inspect();
  assert.equal(rechargeState.ledger.length, 1);
});

test("R1-3b. Simultaneous resumePendingGeneration calls arriving BEFORE the first one completes still produce exactly one real reservation and one generation attempt", async () => {
  const f = buildFixture({ balance: 8 });
  const { document, quote } = await f.driveToRechargeRequired(OWNER, "r1-3b");
  const created = await f.rechargeService.createRechargeSession({
    ownerWaId: OWNER, packId: "TEST_10", idempotencyKey: "recharge:create:r1-3b",
    document: { documentId: document.document_id, documentVersion: document.version, quoteId: quote.quote_id, generationConfirmationId: "confirm:r1-3b", missingCredits: quote.total_credits },
  });
  assert.equal(created.ok, true, created.error);
  const initiated = await f.rechargeService.initiatePayment({ rechargeSessionId: created.value.recharge_session_id, ownerWaId: OWNER });
  assert.equal(initiated.ok, true, initiated.error);

  // Two genuinely concurrent confirmPaymentEvent replays of the SAME
  // provider event (a realistic duplicate webhook delivery) — serial()
  // must fully serialize both through the same rechargeSessionId slot.
  const event = { provider: "SYNTHETIC_PAY", provider_payment_id: initiated.value.provider_payment_id, provider_event_id: "event:r1-3b", merchant_reference: initiated.value.merchant_reference, amount: 2000, currency: "XOF", status: "CONFIRMED", verified: true, occurred_at: NOW, metadata: {} };
  const [first, second] = await Promise.all([
    f.rechargeService.confirmPaymentEvent({ rechargeSessionId: initiated.value.recharge_session_id, rawEvent: event }),
    f.rechargeService.confirmPaymentEvent({ rechargeSessionId: initiated.value.recharge_session_id, rawEvent: event }),
  ]);
  assert.equal(first.ok, true, first.error);
  assert.equal(second.ok, true, second.error);
  assert.equal((await f.documents.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER })).value.status, "DELIVERED");
  const finalState = f.generationRepo.inspect();
  assert.equal(finalState.attempts.length, 1, "exactly one real generation attempt from two concurrent identical webhook deliveries");
  const rechargeState = f.rechargeRepository.inspect();
  assert.equal(rechargeState.ledger.length, 1, "exactly one credit from two concurrent identical webhook deliveries");
});

// =====================================================================
// 4. REQUIRE_CONFIRMATION (current production policy) proven unaffected,
// through the same real composition.
// =====================================================================

test("R1-4. REQUIRE_CONFIRMATION through the real composition: credited exactly once, no automatic generation, no reservation ever attempted", async () => {
  const f = buildFixture({ balance: 8, resumePolicy: "REQUIRE_CONFIRMATION" });
  const { document, quote } = await f.driveToRechargeRequired(OWNER, "r1-4");
  const { confirmed } = await f.linkAndConfirmRecharge({ ownerWaId: OWNER, document, quote, suffix: "r1-4" });
  const result = await confirmed;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.resume.automatic, false);
  assert.equal(result.resume.reason, "CONFIRMATION_REQUIRED");
  const state = f.generationRepo.inspect();
  assert.equal(state.attempts.length, 0);
  assert.equal(state.reservations.length, 0);
  assert.equal((await f.documents.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER })).value.status, "RECHARGE_REQUIRED", "REQUIRE_CONFIRMATION never even attempts the precheck/re-arm");
  const rechargeState = f.rechargeRepository.inspect();
  assert.equal(rechargeState.ledger.length, 1, "credited exactly once");
});

// =====================================================================
// 5. Owner isolation via resumePendingGeneration itself.
// =====================================================================

test("R1-5. Owner isolation: Owner B cannot resume Owner A's recharge/session/document through resumePendingGeneration", async () => {
  const f = buildFixture({ balance: 8, otherOwnerBalance: 100 });
  const { document, quote } = await f.driveToRechargeRequired(OWNER, "r1-5");
  const { rechargeSessionId } = await f.linkAndConfirmRecharge({ ownerWaId: OWNER, document, quote, suffix: "r1-5" });

  const asOtherOwner = await f.rechargeService.resumePendingGeneration({ rechargeSessionId, ownerWaId: OTHER_OWNER });
  assert.equal(asOtherOwner.ok, false);
  assert.equal(asOtherOwner.error, "RECHARGE_SESSION_NOT_FOUND", "a session belonging to OWNER must never resolve for a different claimed owner");
  const stateAfterAttempt = f.generationRepo.inspect();
  assert.equal(stateAfterAttempt.attempts.length, 1, "the SAME single legitimate attempt from linkAndConfirmRecharge's own auto-resume — never a second one from Owner B's attempt");
  const otherOwnerReservations = stateAfterAttempt.reservations.filter((entry) => entry.owner_wa_id === OTHER_OWNER);
  assert.equal(otherOwnerReservations.length, 0, "Owner B's own wallet must never be touched by an attempt to resume Owner A's recharge");
});

// =====================================================================
// 6. A document that has progressed to a state auto-resume was never meant
// to act on (e.g. a real generation genuinely already mid-flight) fails
// closed, rather than blindly calling the downstream authority. This is a
// genuinely new code path this fix introduces (the OLD generation_started
// gate would have skipped straight to confirmGeneration here too, and
// confirmGeneration's own findByQuoteId duplicate-detection would have
// silently reported a STALE, unrelated attempt status as if this resume
// had just succeeded — a separate, pre-existing latent defect this
// document-status branching incidentally also closes, discovered during
// this mission's own code trace, not separately reproduced as its own
// ticket).
// =====================================================================

test("R1-6. A document already progressed to GENERATION_IN_PROGRESS through some other path fails closed on auto-resume, never blindly reporting stale success", async () => {
  // Zero balance for the FIRST auto-resume attempt: the precheck fails
  // cleanly (BALANCE_INSUFFICIENT) — reaching the required session status
  // (RESUME_PENDING) without the automatic resume actually completing, so
  // this test can then simulate an independent, out-of-band real
  // progression (a crashed mid-flight generation) before a later
  // resumePendingGeneration call.
  const f = buildFixture({ balance: 0 });
  const { document, quote } = await f.driveToRechargeRequired(OWNER, "r1-6");
  const { rechargeSessionId, confirmed } = await f.linkAndConfirmRecharge({ ownerWaId: OWNER, document, quote, suffix: "r1-6" });
  const first = await confirmed;
  assert.equal(first.ok, true, first.error);
  assert.equal(first.resume.reason, "BALANCE_INSUFFICIENT");
  assert.equal((await f.documents.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER })).value.status, "RECHARGE_REQUIRED");

  // Simulate a document that independently progressed past
  // AWAITING_GENERATION_CONFIRMATION (e.g. a crashed mid-flight generation
  // that never completed) — re-arm it directly via the domain's own
  // RECHARGE_CONFIRMED + START_GENERATION events, exactly the states the
  // real GenerationLifecycleService itself would produce.
  const rearmed = f.domain.transitionDocument(document, DOCUMENT_EVENTS.RECHARGE_CONFIRMED);
  assert.equal(rearmed.ok, true, rearmed.error);
  let inProgressDoc = (await f.documents.persistTransition({ document: rearmed.value, ownerWaId: OWNER, expectedVersion: document.version, fromState: document.status, eventType: "TEST_REARM", idempotencyKey: "doc:r1-6:rearm" })).value;
  const started = f.domain.transitionDocument(inProgressDoc, DOCUMENT_EVENTS.START_GENERATION, {});
  assert.equal(started.ok, true, started.error);
  inProgressDoc = (await f.documents.persistTransition({ document: started.value, ownerWaId: OWNER, expectedVersion: inProgressDoc.version, fromState: inProgressDoc.status, eventType: "TEST_START", idempotencyKey: "doc:r1-6:start" })).value;
  assert.equal(inProgressDoc.status, "GENERATION_IN_PROGRESS");

  const attempted = await f.rechargeService.resumePendingGeneration({ rechargeSessionId, ownerWaId: OWNER });
  assert.equal(attempted.ok, false);
  assert.equal(attempted.error, "RECHARGE_RESUME_DOCUMENT_STATE_INVALID");
  const state = f.generationRepo.inspect();
  assert.equal(state.attempts.length, 0, "the downstream financial authority was never even called");
  const afterAttempt = await f.documents.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER });
  assert.equal(afterAttempt.value.status, "GENERATION_IN_PROGRESS", "the document's real, in-flight state is never disturbed");
  const rechargeState = f.rechargeRepository.inspect();
  assert.equal(rechargeState.sessions[0].status, "RESUME_PENDING", "a failed-closed resume never mismarks the session as RESUMED");
});

// =====================================================================
// AUTO_RESUME_CRASH_RECONCILIATION_001 (independent R2 review): a process
// crash strictly between two of resumePendingGeneration's own bookkeeping
// writes leaves durable state a later, reconstructed service instance
// must reconcile from -- never guessed from in-memory flags, since the
// serial() queue does not survive a restart. See
// docs/KADI_ENGINEERING_MEMORY.md fiche AH for the confirmed pre-fix
// reproduction (git stash) this closes.
// =====================================================================

// 7. Crash after RECHARGE_CONFIRMED commits, before the resume link's own
// STARTED write -- CASE A. Sufficient credits: the reconstructed service
// must reconcile the link to STARTED (reusing the SAME round identity)
// and reach a normal, exactly-once success.
test("R2-1. Crash after RECHARGE_CONFIRMED commit, before link STARTED: reconstructed service resumes normally, exactly once", async () => {
  const armed = { value: true };
  const f = buildFixture({ balance: 8, documentsOverride: (real) => wrapDocumentsWithCrash(real, { crashOnEventType: "RECHARGE_CONFIRMED", armed }) });
  const { document, quote } = await f.driveToRechargeRequired(OWNER, "r2-1");
  const created = await f.rechargeService.createRechargeSession({
    ownerWaId: OWNER, packId: "TEST_10", idempotencyKey: "recharge:create:r2-1",
    document: { documentId: document.document_id, documentVersion: document.version, quoteId: quote.quote_id, generationConfirmationId: "confirm:r2-1", missingCredits: quote.total_credits },
  });
  assert.equal(created.ok, true, created.error);
  const initiated = await f.rechargeService.initiatePayment({ rechargeSessionId: created.value.recharge_session_id, ownerWaId: OWNER });
  assert.equal(initiated.ok, true, initiated.error);

  let crashed = false;
  try {
    await f.rechargeService.confirmPaymentEvent({
      rechargeSessionId: initiated.value.recharge_session_id,
      rawEvent: { provider: "SYNTHETIC_PAY", provider_payment_id: initiated.value.provider_payment_id, provider_event_id: "event:r2-1", merchant_reference: initiated.value.merchant_reference, amount: 2000, currency: "XOF", status: "CONFIRMED", verified: true, occurred_at: NOW, metadata: {} },
    });
  } catch (error) { crashed = error.message === "SIMULATED_PROCESS_CRASH"; }
  assert.equal(crashed, true, "the crash must have been genuinely simulated");
  const docAfterCrash = await f.realDocuments.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER });
  assert.equal(docAfterCrash.value.status, "AWAITING_GENERATION_CONFIRMATION", "RECHARGE_CONFIRMED already committed before the crash");
  const linkAfterCrash = await f.rechargeRepository.getResumeLink({ rechargeSessionId: initiated.value.recharge_session_id });
  assert.equal(linkAfterCrash.value.resume_status, "WAITING_FOR_CREDIT", "the STARTED write never landed");
  assert.equal(linkAfterCrash.value.generation_started, false);

  // Reconstruct: a brand new createRechargeService instance around the
  // SAME persistent repositories -- the in-memory serial() queue from the
  // crashed instance is gone, proving reconciliation comes from persisted
  // state alone.
  const reconstructed = f.makeService();
  const retried = await reconstructed.resumePendingGeneration({ rechargeSessionId: initiated.value.recharge_session_id, ownerWaId: OWNER });
  assert.equal(retried.ok, true, retried.error);
  assert.equal(retried.resume.automatic, true);
  const docAfterRetry = await f.realDocuments.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER });
  assert.equal(docAfterRetry.value.status, "DELIVERED");
  const genState = f.generationRepo.inspect();
  assert.equal(genState.attempts.length, 1, "exactly one generation attempt");
  assert.equal(genState.reservations.filter((r) => r.quote_id === quote.quote_id).length, 1, "exactly one reservation");
  const linkAfterRetry = await f.rechargeRepository.getResumeLink({ rechargeSessionId: initiated.value.recharge_session_id });
  assert.equal(linkAfterRetry.value.resume_status, "RESUMED", "the link itself must be genuinely reconciled, not just the session");
  const sessionAfterRetry = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: initiated.value.recharge_session_id });
  assert.equal(sessionAfterRetry.value.status, "RESUMED");
});

// 8-12. Same crash window, but a real competing reservation lands before
// the reconstructed retry, so the real downstream reservation genuinely
// returns INSUFFICIENT_CREDITS -- bookkeeping must stay safely retryable
// (no stale idempotency-key dead end), and a further retry after the
// competing hold is released must succeed.
test("R2-2. Same crash window, then real INSUFFICIENT_CREDITS after restart: bookkeeping stays safely retryable, no stale dead end", async () => {
  const armed = { value: true };
  const f = buildFixture({ balance: 8, documentsOverride: (real) => wrapDocumentsWithCrash(real, { crashOnEventType: "RECHARGE_CONFIRMED", armed }) });
  const { document, quote } = await f.driveToRechargeRequired(OWNER, "r2-2");
  const created = await f.rechargeService.createRechargeSession({
    ownerWaId: OWNER, packId: "TEST_10", idempotencyKey: "recharge:create:r2-2",
    document: { documentId: document.document_id, documentVersion: document.version, quoteId: quote.quote_id, generationConfirmationId: "confirm:r2-2", missingCredits: quote.total_credits },
  });
  const initiated = await f.rechargeService.initiatePayment({ rechargeSessionId: created.value.recharge_session_id, ownerWaId: OWNER });
  let crashed = false;
  try {
    await f.rechargeService.confirmPaymentEvent({
      rechargeSessionId: initiated.value.recharge_session_id,
      rawEvent: { provider: "SYNTHETIC_PAY", provider_payment_id: initiated.value.provider_payment_id, provider_event_id: "event:r2-2", merchant_reference: initiated.value.merchant_reference, amount: 2000, currency: "XOF", status: "CONFIRMED", verified: true, occurred_at: NOW, metadata: {} },
    });
  } catch (error) { crashed = error.message === "SIMULATED_PROCESS_CRASH"; }
  assert.equal(crashed, true);

  const competing = await f.walletReservationService.reserveCredits({ ownerWaId: OWNER, quoteId: "quote:competing:r2-2", amount: 1, idempotencyKey: "reserve:competing:r2-2" });
  assert.equal(competing.ok, true, competing.error);

  const svc2 = f.makeService();
  const retried = await svc2.resumePendingGeneration({ rechargeSessionId: initiated.value.recharge_session_id, ownerWaId: OWNER });
  assert.equal(retried.ok, false);
  assert.equal(retried.error, "GENERATION_RESUME_FAILED");
  const docAfter = await f.realDocuments.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER });
  assert.equal(docAfter.value.status, "RECHARGE_REQUIRED", "the real authority's own REQUIRE_RECHARGE bounce-back");
  const sessionAfter = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: initiated.value.recharge_session_id });
  assert.equal(sessionAfter.value.status, "RESUME_PENDING", "never falsely marked RESUMED");

  const released = await f.walletReservationService.releaseReservation({ reservationId: competing.value.reservation_id, idempotencyKey: "release:competing:r2-2" });
  assert.equal(released.ok, true, released.error);
  const svc3 = f.makeService();
  const finalRetry = await svc3.resumePendingGeneration({ rechargeSessionId: initiated.value.recharge_session_id, ownerWaId: OWNER });
  assert.equal(finalRetry.ok, true, finalRetry.error, "no stale idempotency-key dead end once the conflict genuinely resolves");
  const docFinal = await f.realDocuments.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER });
  assert.equal(docFinal.value.status, "DELIVERED");
  const genState = f.generationRepo.inspect();
  assert.equal(genState.attempts.length, 1, "exactly one generation attempt, across the crash, the race, and the eventual success");
});

// 13-17. The real generation genuinely reaches DELIVERED, but the process
// crashes strictly before resumePendingGeneration's own bookkeeping
// (finalizeResumedSession) can mark the link/session RESUMED --
// reconstruction must authoritatively recognize this exact round's own
// completion and reconcile, WITHOUT generating a second time.
test("R2-3. Real generation reaches DELIVERED, crash before bookkeeping finalization: reconstructed service reconciles the same round, never regenerates", async () => {
  const f = buildFixture({ balance: 8 });
  const { document, quote } = await f.driveToRechargeRequired(OWNER, "r2-3");
  const armed = { value: true };
  const crashRepo = wrapRechargeRepositoryWithCrash(f.rechargeRepository, { crashOnResumeStatus: "RESUMED", armed });
  const svc1 = f.makeService(crashRepo);
  const created = await svc1.createRechargeSession({
    ownerWaId: OWNER, packId: "TEST_10", idempotencyKey: "recharge:create:r2-3",
    document: { documentId: document.document_id, documentVersion: document.version, quoteId: quote.quote_id, generationConfirmationId: "confirm:r2-3", missingCredits: quote.total_credits },
  });
  const initiated = await svc1.initiatePayment({ rechargeSessionId: created.value.recharge_session_id, ownerWaId: OWNER });
  let crashed = false;
  try {
    await svc1.confirmPaymentEvent({
      rechargeSessionId: initiated.value.recharge_session_id,
      rawEvent: { provider: "SYNTHETIC_PAY", provider_payment_id: initiated.value.provider_payment_id, provider_event_id: "event:r2-3", merchant_reference: initiated.value.merchant_reference, amount: 2000, currency: "XOF", status: "CONFIRMED", verified: true, occurred_at: NOW, metadata: {} },
    });
  } catch (error) { crashed = error.message === "SIMULATED_PROCESS_CRASH"; }
  assert.equal(crashed, true, "the crash must land after real success, before bookkeeping finalization");
  const docAfterCrash = await f.realDocuments.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER });
  assert.equal(docAfterCrash.value.status, "DELIVERED", "the real generation genuinely completed");
  const sessionAfterCrash = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: initiated.value.recharge_session_id });
  assert.equal(sessionAfterCrash.value.status, "RESUME_PENDING", "never finalized before the crash");
  const genStateBefore = f.generationRepo.inspect();
  assert.equal(genStateBefore.attempts.length, 1);

  const svc2 = f.makeService();
  const retried = await svc2.resumePendingGeneration({ rechargeSessionId: initiated.value.recharge_session_id, ownerWaId: OWNER });
  assert.equal(retried.ok, true, retried.error, "authoritative reconciliation must recognize the already-completed round");
  assert.equal(retried.resume.automatic, true);
  const linkAfter = await f.rechargeRepository.getResumeLink({ rechargeSessionId: initiated.value.recharge_session_id });
  assert.equal(linkAfter.value.resume_status, "RESUMED");
  const sessionAfter = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: initiated.value.recharge_session_id });
  assert.equal(sessionAfter.value.status, "RESUMED");
  const genStateAfter = f.generationRepo.inspect();
  assert.equal(genStateAfter.attempts.length, 1, "reconciliation must never generate a second time");
  const rechargeState = f.rechargeRepository.inspect();
  assert.equal(rechargeState.ledger.length, 1, "the recharge itself was only ever credited once");
});

// 18-21. Crash after the link's own STARTED write, but before
// confirmGeneration is ever called -- the reconstructed service must
// reuse the same round identity (still recoverable from the unbumped
// revision) and reach exactly one real generation.
test("R2-4. Crash after link STARTED, before confirmGeneration is called: reconstructed service reuses the same round identity, exactly one generation", async () => {
  const f = buildFixture({ balance: 8 });
  const { document, quote } = await f.driveToRechargeRequired(OWNER, "r2-4");
  const armed = { value: true };
  const crashRepo = wrapRechargeRepositoryWithCrash(f.rechargeRepository, { crashOnResumeStatus: "STARTED", armed });
  const svc1 = f.makeService(crashRepo);
  const created = await svc1.createRechargeSession({
    ownerWaId: OWNER, packId: "TEST_10", idempotencyKey: "recharge:create:r2-4",
    document: { documentId: document.document_id, documentVersion: document.version, quoteId: quote.quote_id, generationConfirmationId: "confirm:r2-4", missingCredits: quote.total_credits },
  });
  const initiated = await svc1.initiatePayment({ rechargeSessionId: created.value.recharge_session_id, ownerWaId: OWNER });
  let crashed = false;
  try {
    await svc1.confirmPaymentEvent({
      rechargeSessionId: initiated.value.recharge_session_id,
      rawEvent: { provider: "SYNTHETIC_PAY", provider_payment_id: initiated.value.provider_payment_id, provider_event_id: "event:r2-4", merchant_reference: initiated.value.merchant_reference, amount: 2000, currency: "XOF", status: "CONFIRMED", verified: true, occurred_at: NOW, metadata: {} },
    });
  } catch (error) { crashed = error.message === "SIMULATED_PROCESS_CRASH"; }
  assert.equal(crashed, true);
  const docAfterCrash = await f.realDocuments.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER });
  assert.equal(docAfterCrash.value.status, "AWAITING_GENERATION_CONFIRMATION");
  const genStateBefore = f.generationRepo.inspect();
  assert.equal(genStateBefore.attempts.length, 0, "confirmGeneration was never reached before the crash");

  const svc2 = f.makeService();
  const retried = await svc2.resumePendingGeneration({ rechargeSessionId: initiated.value.recharge_session_id, ownerWaId: OWNER });
  assert.equal(retried.ok, true, retried.error);
  const docAfterRetry = await f.realDocuments.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER });
  assert.equal(docAfterRetry.value.status, "DELIVERED");
  const genStateAfter = f.generationRepo.inspect();
  assert.equal(genStateAfter.attempts.length, 1, "exactly one generation attempt");
});

// Crash strictly between MARK_GENERATED committing (credits already
// captured, PDF already promoted -- completeAfterCapture applies
// promoteFinal BEFORE persisting MARK_GENERATED) and delivery ever being
// attempted: document stuck at GENERATED, never DELIVERED. Proves the
// document.status === "DELIVERED" requirement in reconcileCompletedGeneration
// -- attempt.status is already PROMOTED and reservation CAPTURED here,
// but the recharge must NEVER be reconciled as RESUMED until delivery
// itself has genuinely resolved, matching exactly what the normal
// (non-crash) confirmGeneration path itself would report.
test("R2-5. Crash after capture/promotion but before delivery resolves (document stuck GENERATED): never falsely reconciled as RESUMED", async () => {
  const armed = { value: true };
  const f = buildFixture({ balance: 8, documentsOverride: (real) => wrapDocumentsWithCrash(real, { crashOnEventType: "DOCUMENT_GENERATED", armed }) });
  const { document, quote } = await f.driveToRechargeRequired(OWNER, "r2-5");
  const created = await f.rechargeService.createRechargeSession({
    ownerWaId: OWNER, packId: "TEST_10", idempotencyKey: "recharge:create:r2-5",
    document: { documentId: document.document_id, documentVersion: document.version, quoteId: quote.quote_id, generationConfirmationId: "confirm:r2-5", missingCredits: quote.total_credits },
  });
  const initiated = await f.rechargeService.initiatePayment({ rechargeSessionId: created.value.recharge_session_id, ownerWaId: OWNER });

  let crashed = false;
  try {
    await f.rechargeService.confirmPaymentEvent({
      rechargeSessionId: initiated.value.recharge_session_id,
      rawEvent: { provider: "SYNTHETIC_PAY", provider_payment_id: initiated.value.provider_payment_id, provider_event_id: "event:r2-5", merchant_reference: initiated.value.merchant_reference, amount: 2000, currency: "XOF", status: "CONFIRMED", verified: true, occurred_at: NOW, metadata: {} },
    });
  } catch (error) { crashed = error.message === "SIMULATED_PROCESS_CRASH"; }
  assert.equal(crashed, true, "the crash must land after capture/promotion, before delivery resolves");
  const docAfterCrash = await f.realDocuments.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER });
  assert.equal(docAfterCrash.value.status, "GENERATED", "credits captured, PDF promoted, but never delivered");
  const genState = f.generationRepo.inspect();
  const attempt = genState.attempts.find((a) => a.quote_id === quote.quote_id);
  assert.equal(attempt.status, "PROMOTED");
  const reservation = genState.reservations.find((r) => r.quote_id === quote.quote_id);
  assert.equal(reservation.status, "CAPTURED");

  const svc3 = f.makeService();
  const retried = await svc3.resumePendingGeneration({ rechargeSessionId: initiated.value.recharge_session_id, ownerWaId: OWNER });
  assert.equal(retried.ok, false);
  assert.equal(retried.error, "RECHARGE_RESUME_DOCUMENT_STATE_INVALID", "must never be reconciled as RESUMED while genuinely undelivered");
  const sessionAfter = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: initiated.value.recharge_session_id });
  assert.equal(sessionAfter.value.status, "RESUME_PENDING", "left retryable via the existing delivery-retry contract, never falsely finalized");
});
