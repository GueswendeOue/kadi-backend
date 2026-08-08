"use strict";

// RECHARGE_RESUME_AVAILABLE_BALANCE_001 (known MEDIUM/P1, dormant since
// production keeps resumePolicy: "REQUIRE_CONFIRMATION"): resumePendingGeneration()'s
// AUTO_RESUME_IF_VALID precheck used store.getBalance() — the RAW wallet
// total — to decide whether a paid recharge could auto-resume a blocked
// generation. T6 already proved the authoritative spendable amount is
// available_credits = total_credits - reserved_credits: a wallet can
// legitimately have raw=10 with 3 already held by another live
// generation, leaving only 7 truly available. The old precheck (10 >= 8)
// could therefore move a resume forward for an amount that was never
// actually spendable, only for the real, atomic financial authority
// (generationLifecycleService.confirmGeneration -> walletReservationService.reserveCredits)
// to reject it downstream — while resumePendingGeneration had already
// transitioned the document and marked the resume link STARTED.
//
// This file uses the REAL createRechargeService with the REAL
// createInMemoryRechargeRepository (the same repository/getAvailableBalance
// contract T6 introduced and kadiV1SupabaseRechargeRepository.js backs
// with the identical RPC read) — only the true external ports
// (paymentProvider, quoteService, generationLifecycleService) are test
// doubles, exactly matching this codebase's existing convention in
// tests/kadiV1Recharge.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createDocumentDomain, DOCUMENT_EVENTS } = require("../kadiV1DocumentDomain");
const { createInMemoryV1DocumentRepository } = require("../kadiV1DocumentRepository");
const { createRechargePackCatalog } = require("../kadiV1RechargeConfig");
const { createInMemoryRechargeRepository } = require("../kadiV1RechargeRepository");
const { createRechargeService } = require("../kadiV1RechargeService");

const OWNER = "22670000000";
const OTHER_OWNER = "22679999999";
const NOW = "2026-08-02T12:00:00.000Z";
const PACK = Object.freeze({ pack_id: "TEST_10", amount: 2000, currency: "XOF", credits: 10, pricing_version: "test-v1", active: true });
const QUOTE = Object.freeze({
  quote_id: "quote:recharge", document_id: "doc:recharge", document_version: 1, owner_wa_id: OWNER,
  total_credits: 8, pricing_version: "generation-v1", status: "ACTIVE", expires_at: "2026-08-02T13:00:00.000Z",
});

function paymentResult(overrides = {}) {
  return {
    provider: "SYNTHETIC_PAY", provider_payment_id: "payment:one", provider_event_id: "event:one",
    merchant_reference: "unused", amount: PACK.amount, currency: PACK.currency, status: "CONFIRMED",
    verified: true, occurred_at: "2026-08-02T12:05:00.000Z", metadata: { fixture: true }, ...overrides,
  };
}

// AUTO_RESUME_POST_PRECHECK_RACE_STUCK_001 (R1): resumePendingGeneration
// derives confirmGeneration's idempotencyKey from
// (generation_confirmation_id, resume link revision) via the same default
// makeId() formula kadiV1RechargeService.js itself uses, rather than the
// bare generation_confirmation_id — see tests/kadiV1RechargeResumeRealLifecycleRace.test.js
// for the real-composition reproduction/proof. revision=1 on the resume
// link's very first read.
function resumeRoundKey(generationConfirmationId, revision) {
  return `resume:${crypto.createHash("sha256").update(`${generationConfirmationId}:${revision}`).digest("hex").slice(0, 32)}`;
}

async function documentInRecharge({ documents, domain, ownerWaId = OWNER }) {
  let document = domain.createDocument({
    document_id: QUOTE.document_id, document_type: "FACTURE", issuer_profile_id: "issuer:test", currency: "XOF",
    client: { name: "Client fictif" },
    items: [{ item_id: "item:test", description: "Service fictif", quantity_millis: 1000, unit_price: 5000 }],
  }).value;
  await documents.createDocument({ document, ownerWaId, idempotencyKey: "doc:recharge:create" });
  const steps = [
    [DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW, {}, "READY"], [DOCUMENT_EVENTS.VERIFY, {}, "VERIFIED"],
    [DOCUMENT_EVENTS.PREPARE_PREVIEW, { preview: { preview_id: "preview:recharge" } }, "PREVIEW"],
    [DOCUMENT_EVENTS.CALCULATE_COST, { generation_quote: { quote_id: QUOTE.quote_id, document_version: 1, page_count: 1, credit_cost: QUOTE.total_credits } }, "COST"],
    [DOCUMENT_EVENTS.REQUEST_GENERATION_CONFIRMATION, {}, "CONFIRMATION"],
    [DOCUMENT_EVENTS.REQUIRE_RECHARGE, {}, "RECHARGE"],
  ];
  for (const [event, payload, label] of steps) {
    const next = domain.transitionDocument(document, event, payload);
    assert.equal(next.ok, true, next.error);
    const persisted = await documents.persistTransition({
      document: next.value, ownerWaId, expectedVersion: 1, fromState: document.status,
      eventType: `TEST_${label}`, idempotencyKey: `doc:recharge:${label.toLowerCase()}`,
    });
    document = persisted.value;
  }
  return document;
}

// generationResult may be a plain {ok,...} result or a function(command)
// returning one — mirrors tests/kadiV1Recharge.test.js's own convention,
// so a test can make the fake downstream financial authority behave
// exactly like the real one (INSUFFICIENT_CREDITS, success, or a
// deliberately-timed race) without rebuilding the whole real generation
// pipeline (preview/render/delivery), which is irrelevant to this
// mission's balance-authority defect.
async function fixture({
  balance = 0,
  reserved = 0,
  ownerWaId = OWNER,
  resumePolicy = "AUTO_RESUME_IF_VALID",
  generationResult = { ok: true, value: { status: "DELIVERED" } },
  quoteOverrides = {},
} = {}) {
  const domain = createDocumentDomain({ clock: () => NOW });
  const documents = createInMemoryV1DocumentRepository();
  await documentInRecharge({ documents, domain, ownerWaId });
  let currentReserved = reserved;
  const repository = createInMemoryRechargeRepository({
    balances: { [ownerWaId]: balance },
    reservedAmountProvider: async () => currentReserved,
  });
  let activeResult = null;
  const provider = {
    name: "SYNTHETIC_PAY",
    async createPaymentRequest(request) {
      activeResult = paymentResult({ provider_event_id: null, merchant_reference: request.merchant_reference, amount: request.amount, currency: request.currency, status: "PENDING" });
      return { ok: true, value: activeResult };
    },
    async verifyPaymentEvent(raw) { return { ok: true, value: { ...raw } }; },
    async getPaymentStatus() { return { ok: true, value: activeResult }; },
  };
  const quote = { ...QUOTE, owner_wa_id: ownerWaId, ...quoteOverrides };
  const quoteService = {
    async getGenerationQuote({ quoteId, ownerWaId: requestOwner }) {
      return quoteId === quote.quote_id && requestOwner === ownerWaId ? { ok: true, value: { ...quote } } : { ok: false, error: "GENERATION_QUOTE_NOT_FOUND" };
    },
  };
  const generationCalls = [];
  const generationLifecycleService = {
    async confirmGeneration(command) {
      generationCalls.push(command);
      return typeof generationResult === "function" ? generationResult(command) : generationResult;
    },
    async getGenerationStatus() { return { ok: false, error: "GENERATION_ATTEMPT_NOT_FOUND" }; },
  };
  const service = createRechargeService({
    repository, packCatalog: createRechargePackCatalog({ packs: [PACK] }), paymentProvider: provider,
    documentRepository: documents, quoteService, generationLifecycleService, domain, resumePolicy, clock: () => NOW,
  });
  const createCommand = {
    ownerWaId, packId: PACK.pack_id, idempotencyKey: "recharge:create:document",
    document: { documentId: QUOTE.document_id, documentVersion: QUOTE.document_version, quoteId: QUOTE.quote_id, generationConfirmationId: "confirm:recharge", missingCredits: QUOTE.total_credits },
  };
  async function started() {
    const created = await service.createRechargeSession(createCommand);
    assert.equal(created.ok, true, created.error);
    const initiated = await service.initiatePayment({ rechargeSessionId: created.value.recharge_session_id, ownerWaId });
    assert.equal(initiated.ok, true, initiated.error);
    return { created: created.value, initiated: initiated.value };
  }
  function confirmedEvent(session, overrides = {}) {
    return paymentResult({ merchant_reference: session.merchant_reference, provider_payment_id: session.provider_payment_id, ...overrides });
  }
  return {
    service, repository, documents, domain, quote, generationCalls, createCommand, started, confirmedEvent, ownerWaId,
    setReserved: (value) => { currentReserved = value; },
  };
}

// =====================================================================
// 1-2. Precheck must use available_credits, never raw balance.
// =====================================================================

test("1. raw=10 / reserved=3 / available=7 / cost=8 => auto-resume does NOT start", async () => {
  const f = await fixture({ balance: 0, reserved: 3 });
  const { initiated } = await f.started();
  const result = await f.service.confirmPaymentEvent({ rechargeSessionId: initiated.recharge_session_id, rawEvent: f.confirmedEvent(initiated) });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.resume_error, undefined, "must not surface as a generic resume failure — the precheck itself declines cleanly");
  assert.deepEqual(result.resume, { automatic: false, reason: "BALANCE_INSUFFICIENT" });
  assert.equal(f.generationCalls.length, 0, "the real financial authority must never even be called for an amount that was never truly available");
  const inspected = f.repository.inspect();
  assert.equal(inspected.sessions[0].status, "RESUME_PENDING");
  assert.equal(inspected.resumeLinks[0].generation_started, false, "generation_started must never be set true by a failed precheck");
  assert.equal(inspected.resumeLinks[0].resume_status, "PENDING");
  assert.equal(inspected.ledger.length, 1, "the recharge credit itself remains — one ledger entry, no debit");
  const doc = await f.documents.getDocumentById({ documentId: QUOTE.document_id, ownerWaId: OWNER });
  assert.equal(doc.value.status, "RECHARGE_REQUIRED", "the document must never be moved out of RECHARGE_REQUIRED by a failed precheck");
});

test("2. raw=10 / reserved=2 / available=8 / cost=8 => eligible precheck, auto-resume proceeds", async () => {
  const f = await fixture({ balance: 0, reserved: 2 });
  const { initiated } = await f.started();
  const result = await f.service.confirmPaymentEvent({ rechargeSessionId: initiated.recharge_session_id, rawEvent: f.confirmedEvent(initiated) });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.resume_error, undefined, result.resume_error);
  assert.equal(result.resume.automatic, true);
  assert.equal(f.generationCalls.length, 1, "exactly the boundary case (available === cost) must still be eligible");
  assert.equal(f.repository.inspect().sessions[0].status, "RESUMED");
});

// =====================================================================
// 3-4. Malformed / impossible balance state fails closed.
// =====================================================================

test("3. malformed balance invariant (total - reserved !== available, simulated via reserved > total) fails closed", async () => {
  // reservedAmountProvider returning more than the wallet total makes
  // getAvailableBalance() itself return KADI_V1_BALANCE_INVALID
  // (kadiV1RechargeRepository.js's own fail-closed contract) — proving
  // resumePendingGeneration surfaces that as a distinct, safe reason
  // rather than crashing or reading `undefined` as "sufficient". balance:0
  // (not some non-zero starting balance) because confirmPaymentEvent
  // credits PACK.credits (10) on top of it — the wallet total at
  // precheck time is always starting-balance + 10, so reserved (11) must
  // exceed THAT for a genuinely malformed total-reserved=available
  // invariant, not merely an insufficient (but valid) one.
  const f = await fixture({ balance: 0, reserved: 11 });
  const { initiated } = await f.started();
  const result = await f.service.confirmPaymentEvent({ rechargeSessionId: initiated.recharge_session_id, rawEvent: f.confirmedEvent(initiated) });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.resume, { automatic: false, reason: "BALANCE_INVALID" });
  assert.equal(f.generationCalls.length, 0);
  assert.equal(f.repository.inspect().resumeLinks[0].generation_started, false);
  const doc = await f.documents.getDocumentById({ documentId: QUOTE.document_id, ownerWaId: OWNER });
  assert.equal(doc.value.status, "RECHARGE_REQUIRED");
});

test("4. negative/impossible financial values fail closed, never treated as sufficient", async () => {
  // A repository whose getAvailableBalance() returns an impossible shape
  // (negative available_credits) — resumePendingGeneration must not
  // trust it, even though the naive comparison (-1 >= 8) is already
  // false; the point is the balanceShapeValid guard rejects it as
  // BALANCE_INVALID rather than silently relying on a coincidentally-safe
  // comparison outcome that a different cost/threshold could flip.
  const f = await fixture({ balance: 0, reserved: 3 });
  const brokenRepository = {
    ...f.repository,
    getAvailableBalance: async () => ({ ok: true, value: { total_credits: 10, reserved_credits: 3, available_credits: -1 } }),
  };
  const brokenService = createRechargeService({
    repository: brokenRepository,
    packCatalog: createRechargePackCatalog({ packs: [PACK] }),
    paymentProvider: {
      name: "SYNTHETIC_PAY",
      async createPaymentRequest(request) { return { ok: true, value: paymentResult({ provider_event_id: null, merchant_reference: request.merchant_reference, amount: request.amount, currency: request.currency, status: "PENDING" }) }; },
      async verifyPaymentEvent(raw) { return { ok: true, value: { ...raw } }; },
      async getPaymentStatus() { return { ok: true, value: paymentResult({ status: "PENDING" }) }; },
    },
    documentRepository: f.documents,
    quoteService: { async getGenerationQuote({ quoteId, ownerWaId }) { return quoteId === QUOTE.quote_id && ownerWaId === OWNER ? { ok: true, value: { ...QUOTE } } : { ok: false, error: "GENERATION_QUOTE_NOT_FOUND" }; } },
    generationLifecycleService: {
      async confirmGeneration() { throw new Error("UNEXPECTED_CALL:confirmGeneration"); },
      async getGenerationStatus() { throw new Error("UNEXPECTED_CALL:getGenerationStatus"); },
    },
    domain: f.domain,
    resumePolicy: "AUTO_RESUME_IF_VALID",
    clock: () => NOW,
  });
  const created = await brokenService.createRechargeSession(f.createCommand);
  assert.equal(created.ok, true, created.error);
  const initiated = await brokenService.initiatePayment({ rechargeSessionId: created.value.recharge_session_id, ownerWaId: OWNER });
  assert.equal(initiated.ok, true, initiated.error);
  const result = await brokenService.confirmPaymentEvent({ rechargeSessionId: initiated.value.recharge_session_id, rawEvent: f.confirmedEvent(initiated.value) });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.resume, { automatic: false, reason: "BALANCE_INVALID" });
});

// =====================================================================
// 5. Race after a successful precheck: the final reservation still wins.
// =====================================================================

test("5. race after a correct precheck: another reservation lands first, the real authority rejects safely, zero financial corruption", async () => {
  // available = 8 at precheck time, exactly matching the cost — a
  // genuinely correct, eligible precheck. Deterministically (no sleep),
  // the fake downstream financial authority simulates a concurrent
  // reservation consuming 1 credit BETWEEN this precheck and its own
  // atomic reserve call, then makes its ok/fail decision from the
  // POST-race state — exactly mirroring what a real
  // walletReservationService.reserveCredits() race would observe.
  let raceActive = true;
  const f = await fixture({
    balance: 0, reserved: 2, // available = 10 - 2 = 8, matches cost 8
    generationResult: async () => {
      if (raceActive) f.setReserved(3); // the race: another reservation lands, consuming 1 more credit
      const available = await f.repository.getAvailableBalance({ ownerWaId: OWNER });
      return available.value.available_credits >= QUOTE.total_credits
        ? { ok: true, value: { status: "DELIVERED" } }
        : { ok: false, error: "INSUFFICIENT_CREDITS" };
    },
  });
  const { initiated } = await f.started();
  const result = await f.service.confirmPaymentEvent({ rechargeSessionId: initiated.recharge_session_id, rawEvent: f.confirmedEvent(initiated) });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.resume_error, "GENERATION_RESUME_FAILED", "the precheck was correct; only the real, final authority caught the race");
  assert.equal(f.generationCalls.length, 1, "the precheck correctly allowed exactly one real-authority attempt");
  const inspected = f.repository.inspect();
  assert.equal(inspected.resumeLinks[0].resume_status, "FAILED");
  assert.equal(inspected.resumeLinks[0].last_error_code, "INSUFFICIENT_CREDITS");
  assert.equal(inspected.ledger.length, 1, "zero debit — the recharge credit itself remains in the wallet");
  assert.equal((await f.repository.getBalance({ ownerWaId: OWNER })).value, 10, "raw wallet total is untouched by the rejected attempt");
  // Resume bookkeeping stays coherent and safely retryable: a bare retry
  // does not crash or corrupt state (no double debit, no duplicate
  // generation call beyond this one retry attempt) — since the correct
  // precheck already set generation_started=true, a retry goes straight
  // to the real financial authority again (unchanged, pre-existing
  // behavior, independent of this mission's balance-authority fix) and
  // fails again identically while the underlying conflict persists.
  const stillRacing = await f.service.resumePendingGeneration({ rechargeSessionId: initiated.recharge_session_id, ownerWaId: OWNER });
  assert.equal(stillRacing.ok, false);
  assert.equal(stillRacing.error, "GENERATION_RESUME_FAILED");
  assert.equal(f.generationCalls.length, 2, "exactly one more real-authority attempt, never a silent extra one");
  assert.equal(f.repository.inspect().ledger.length, 1, "still zero debit while the conflict persists");
  // Once the underlying conflict genuinely resolves (the racing
  // reservation is released), a further retry succeeds normally —
  // proving the bookkeeping was never permanently stuck, just correctly
  // reflecting a real, still-unresolved resource conflict.
  raceActive = false;
  f.setReserved(2);
  const resolved = await f.service.resumePendingGeneration({ rechargeSessionId: initiated.recharge_session_id, ownerWaId: OWNER });
  assert.equal(resolved.ok, true, resolved.error);
  assert.equal(resolved.resume.automatic, true);
  assert.equal(f.generationCalls.length, 3);
  assert.equal(f.repository.inspect().resumeLinks[0].resume_status, "RESUMED");
  assert.equal(f.repository.inspect().ledger.length, 1, "still exactly one ledger entry — the recharge was only ever credited once");
});

// =====================================================================
// 6. Successful AUTO_RESUME: exactly one generation start.
// =====================================================================

test("6. successful AUTO_RESUME with sufficient available credits: exactly one generation start", async () => {
  const f = await fixture({ balance: 0, reserved: 0 });
  const { initiated } = await f.started();
  const result = await f.service.confirmPaymentEvent({ rechargeSessionId: initiated.recharge_session_id, rawEvent: f.confirmedEvent(initiated) });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.resume.automatic, true);
  assert.equal(f.generationCalls.length, 1);
  assert.deepEqual(f.generationCalls[0], { documentId: QUOTE.document_id, ownerWaId: OWNER, documentVersion: 1, quoteId: QUOTE.quote_id, idempotencyKey: resumeRoundKey("confirm:recharge", 1) });
  assert.equal(f.repository.inspect().sessions[0].status, "RESUMED");
  assert.equal(f.repository.inspect().resumeLinks[0].resume_status, "RESUMED");
});

// =====================================================================
// 7. Exact replay: payment confirmation, resumePendingGeneration, failed
// auto-resume, successful auto-resume — none may debit/reserve/generate
// twice, corrupt generation_started, or mark a failed attempt permanently
// successful.
// =====================================================================

test("7a. exact replay of confirmPaymentEvent (successful auto-resume) credits and resumes exactly once", async () => {
  const f = await fixture({ balance: 0, reserved: 0 });
  const { initiated } = await f.started();
  const event = f.confirmedEvent(initiated);
  const first = await f.service.confirmPaymentEvent({ rechargeSessionId: initiated.recharge_session_id, rawEvent: event });
  const second = await f.service.confirmPaymentEvent({ rechargeSessionId: initiated.recharge_session_id, rawEvent: event });
  assert.equal(first.ok, true, first.error);
  assert.equal(second.ok, true, second.error);
  assert.equal(f.generationCalls.length, 1, "the replay must not call the real financial authority a second time");
  assert.equal(f.repository.inspect().ledger.length, 1);
});

test("7b. exact replay of resumePendingGeneration after a balance-insufficient precheck stays exactly-once and does not resurrect a failed attempt as successful", async () => {
  const f = await fixture({ balance: 0, reserved: 3 }); // available=7, cost=8
  const { initiated } = await f.started();
  await f.service.confirmPaymentEvent({ rechargeSessionId: initiated.recharge_session_id, rawEvent: f.confirmedEvent(initiated) });
  const first = await f.service.resumePendingGeneration({ rechargeSessionId: initiated.recharge_session_id, ownerWaId: OWNER });
  const second = await f.service.resumePendingGeneration({ rechargeSessionId: initiated.recharge_session_id, ownerWaId: OWNER });
  assert.equal(first.ok, true, first.error);
  assert.equal(second.ok, true, second.error);
  assert.equal(f.generationCalls.length, 0, "the real authority is never called for an amount that was never truly available, on any replay");
  assert.equal(f.repository.inspect().resumeLinks[0].generation_started, false);
  assert.equal(f.repository.inspect().ledger.length, 1);
});

// =====================================================================
// 8. REQUIRE_CONFIRMATION (the current production policy) remains
// byte-for-byte behaviorally unchanged.
// =====================================================================

test("8. REQUIRE_CONFIRMATION: credited exactly once, no automatic generation, automatic:false/CONFIRMATION_REQUIRED — unaffected by the balance-authority fix", async () => {
  const f = await fixture({ balance: 0, reserved: 3, resumePolicy: "REQUIRE_CONFIRMATION" }); // available would be insufficient, but must never even be evaluated
  const { initiated } = await f.started();
  const result = await f.service.confirmPaymentEvent({ rechargeSessionId: initiated.recharge_session_id, rawEvent: f.confirmedEvent(initiated) });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.resume.automatic, false);
  assert.equal(result.resume.reason, "CONFIRMATION_REQUIRED");
  assert.equal(f.generationCalls.length, 0);
  assert.equal(f.repository.inspect().sessions[0].status, "RESUME_PENDING");
  assert.equal(f.repository.inspect().ledger.length, 1, "credited exactly once");
  // The user explicitly confirms later — resumePendingGeneration under
  // REQUIRE_CONFIRMATION always short-circuits before ever reaching the
  // balance precheck at all.
  const explicit = await f.service.resumePendingGeneration({ rechargeSessionId: initiated.recharge_session_id, ownerWaId: OWNER });
  assert.equal(explicit.ok, true, explicit.error);
  assert.equal(explicit.resume.automatic, false);
  assert.equal(f.generationCalls.length, 0);
});

// =====================================================================
// 9. Owner isolation.
// =====================================================================

test("9. owner isolation: Owner A's reservation never affects Owner B's available-balance precheck", async () => {
  // Two independent document/quote fixtures would be needed for a full
  // two-owner resume; the essential, minimal proof for THIS mission's
  // owner-isolation requirement is that getAvailableBalance() itself is
  // scoped per owner (reservedAmountProvider only ever receives the
  // requested ownerWaId) and resumePendingGeneration always resolves the
  // session/link through the SAME ownerWaId it was given.
  const reservedByOwner = { [OWNER]: 3, [OTHER_OWNER]: 0 };
  const repository = createInMemoryRechargeRepository({
    balances: { [OWNER]: 10, [OTHER_OWNER]: 10 },
    reservedAmountProvider: async ({ ownerWaId }) => reservedByOwner[ownerWaId] ?? 0,
  });
  const ownerAvailable = await repository.getAvailableBalance({ ownerWaId: OWNER });
  const otherAvailable = await repository.getAvailableBalance({ ownerWaId: OTHER_OWNER });
  assert.deepEqual(ownerAvailable.value, { total_credits: 10, reserved_credits: 3, available_credits: 7 });
  assert.deepEqual(otherAvailable.value, { total_credits: 10, reserved_credits: 0, available_credits: 10 }, "Owner B's available balance must never be affected by Owner A's reservation");
});

// =====================================================================
// 10. T5/T6/T10/T11/T12 focused non-regression — re-run separately as
// part of this mission's focused test pass (see FOCUSED_TESTS in the
// final report); this file only exercises kadiV1RechargeService.js's
// resumePendingGeneration and the pre-existing, unmodified
// getAvailableBalance()/getBalance() contract.
// =====================================================================
