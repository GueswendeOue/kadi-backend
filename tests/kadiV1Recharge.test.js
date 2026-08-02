"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createDocumentDomain, DOCUMENT_EVENTS } = require("../kadiV1DocumentDomain");
const { createInMemoryV1DocumentRepository } = require("../kadiV1DocumentRepository");
const { createRechargePackCatalog } = require("../kadiV1RechargeConfig");
const { createInMemoryRechargeRepository } = require("../kadiV1RechargeRepository");
const { createRechargeService } = require("../kadiV1RechargeService");
const { normalizePaymentResult } = require("../kadiV1PaymentProvider");
const { createSupabaseRechargeRepository } = require("../kadiV1SupabaseRechargeRepository");

const OWNER = "22670000000";
const NOW = "2026-08-02T12:00:00.000Z";
const PACK = Object.freeze({ pack_id: "TEST_5", amount: 1000, currency: "XOF", credits: 5, pricing_version: "test-v1", active: true });
const QUOTE = Object.freeze({
  quote_id: "quote:recharge", document_id: "doc:recharge", document_version: 1, owner_wa_id: OWNER,
  total_credits: 4, pricing_version: "generation-v1", status: "ACTIVE", expires_at: "2026-08-02T13:00:00.000Z",
});

function paymentResult(overrides = {}) {
  return {
    provider: "SYNTHETIC_PAY",
    provider_payment_id: "payment:one",
    provider_event_id: "event:one",
    merchant_reference: "unused",
    amount: PACK.amount,
    currency: PACK.currency,
    status: "CONFIRMED",
    verified: true,
    occurred_at: "2026-08-02T12:05:00.000Z",
    metadata: { fixture: true },
    ...overrides,
  };
}

async function documentInRecharge({ documents, domain }) {
  let document = domain.createDocument({
    document_id: QUOTE.document_id,
    document_type: "FACTURE",
    issuer_profile_id: "issuer:test",
    currency: "XOF",
    client: { name: "Client fictif" },
    items: [{ item_id: "item:test", description: "Service fictif", quantity_millis: 1000, unit_price: 5000 }],
  }).value;
  await documents.createDocument({ document, ownerWaId: OWNER, idempotencyKey: "doc:recharge:create" });
  const steps = [
    [DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW, {}, "READY"],
    [DOCUMENT_EVENTS.VERIFY, {}, "VERIFIED"],
    [DOCUMENT_EVENTS.PREPARE_PREVIEW, { preview: { preview_id: "preview:recharge" } }, "PREVIEW"],
    [DOCUMENT_EVENTS.CALCULATE_COST, { generation_quote: { quote_id: QUOTE.quote_id, document_version: 1, page_count: 1, credit_cost: QUOTE.total_credits } }, "COST"],
    [DOCUMENT_EVENTS.REQUEST_GENERATION_CONFIRMATION, {}, "CONFIRMATION"],
    [DOCUMENT_EVENTS.REQUIRE_RECHARGE, {}, "RECHARGE"],
  ];
  for (const [event, payload, label] of steps) {
    const next = domain.transitionDocument(document, event, payload);
    assert.equal(next.ok, true, next.error);
    const persisted = await documents.persistTransition({
      document: next.value, ownerWaId: OWNER, expectedVersion: 1, fromState: document.status,
      eventType: `TEST_${label}`, idempotencyKey: `doc:recharge:${label.toLowerCase()}`,
    });
    document = persisted.value;
  }
  return document;
}

async function fixture({
  balance = 0,
  packs = [PACK],
  linked = false,
  resumePolicy = "REQUIRE_CONFIRMATION",
  latePaymentPolicy = "REJECT",
  now = NOW,
  generationResult = { ok: true, value: { status: "DELIVERED" } },
  providerOverrides = {},
  observer = () => {},
  failpoint,
} = {}) {
  let currentNow = now;
  const clock = () => currentNow;
  const domain = createDocumentDomain({ clock });
  const documents = createInMemoryV1DocumentRepository();
  if (linked) await documentInRecharge({ documents, domain });
  const repository = createInMemoryRechargeRepository({ balances: { [OWNER]: balance }, failpoint });
  let activeResult = null;
  const provider = {
    name: "SYNTHETIC_PAY",
    async createPaymentRequest(request) {
      activeResult = paymentResult({
        provider_event_id: null,
        merchant_reference: request.merchant_reference,
        amount: request.amount,
        currency: request.currency,
        status: "PENDING",
      });
      return { ok: true, value: activeResult };
    },
    async verifyPaymentEvent(raw) { return { ok: true, value: { ...raw } }; },
    async getPaymentStatus() { return { ok: true, value: activeResult }; },
    ...providerOverrides,
  };
  const quote = { ...QUOTE };
  const quoteService = {
    async getGenerationQuote({ quoteId, ownerWaId }) {
      return quoteId === quote.quote_id && ownerWaId === OWNER ? { ok: true, value: { ...quote } } : { ok: false, error: "GENERATION_QUOTE_NOT_FOUND" };
    },
  };
  const generationCalls = [];
  const generationLifecycleService = {
    async confirmGeneration(command) { generationCalls.push(command); return typeof generationResult === "function" ? generationResult(command) : generationResult; },
  };
  const events = [];
  const service = createRechargeService({
    repository,
    packCatalog: createRechargePackCatalog({ packs }),
    paymentProvider: provider,
    documentRepository: documents,
    quoteService,
    generationLifecycleService,
    domain,
    resumePolicy,
    latePaymentPolicy,
    clock,
    observer: (event) => { events.push(event); observer(event); },
  });
  const createCommand = {
    ownerWaId: OWNER,
    packId: "TEST_5",
    idempotencyKey: linked ? "recharge:create:document" : "recharge:create:menu",
    ...(linked ? { document: {
      documentId: QUOTE.document_id,
      documentVersion: QUOTE.document_version,
      quoteId: QUOTE.quote_id,
      generationConfirmationId: "confirm:recharge",
      missingCredits: 4,
    } } : {}),
  };

  async function started() {
    const created = await service.createRechargeSession(createCommand);
    assert.equal(created.ok, true, created.error);
    const initiated = await service.initiatePayment({ rechargeSessionId: created.value.recharge_session_id, ownerWaId: OWNER });
    assert.equal(initiated.ok, true, initiated.error);
    return { created: created.value, initiated: initiated.value };
  }

  function confirmedEvent(session, overrides = {}) {
    return paymentResult({ merchant_reference: session.merchant_reference, provider_payment_id: session.provider_payment_id, ...overrides });
  }

  return { service, repository, documents, domain, quote, generationCalls, events, createCommand, started, confirmedEvent, setNow: (value) => { currentNow = value; } };
}

test("pack catalog is central, versioned and snapshots active server values", async () => {
  const f = await fixture();
  const created = await f.service.createRechargeSession(f.createCommand);
  assert.equal(created.ok, true);
  assert.deepEqual(created.value.pack_snapshot, PACK);
  assert.equal(created.value.pack_snapshot.amount, 1000);
  assert.equal(created.value.pack_snapshot.credits, 5);
});

test("inactive, duplicate, malformed and user-priced packs fail closed", async () => {
  const f = await fixture({ packs: [{ ...PACK, active: false }] });
  assert.deepEqual(await f.service.createRechargeSession(f.createCommand), { ok: false, error: "RECHARGE_PACK_INACTIVE" });
  assert.throws(() => createRechargePackCatalog({ packs: [PACK, PACK] }), /RECHARGE_PACK_DUPLICATE/);
  assert.throws(() => createRechargePackCatalog({ packs: [{ ...PACK, amount: 0 }] }), /RECHARGE_PACK_AMOUNT_INVALID/);
  const active = await fixture();
  assert.deepEqual(await active.service.createRechargeSession({ ...active.createCommand, amount: 1 }), { ok: false, error: "RECHARGE_CREATE_COMMAND_INVALID" });
});

test("menu recharge creates a provider request from server amount and currency", async () => {
  const f = await fixture();
  const { initiated } = await f.started();
  assert.equal(initiated.status, "PAYMENT_PENDING");
  assert.equal(initiated.provider, "SYNTHETIC_PAY");
  assert.equal(initiated.pack_snapshot.currency, "XOF");
  assert.equal(initiated.document_id, null);
});

test("document recharge preserves document, version, quote, confirmation and missing credits", async () => {
  const f = await fixture({ linked: true });
  const created = await f.service.createRechargeSession(f.createCommand);
  const link = await f.repository.getResumeLink({ rechargeSessionId: created.value.recharge_session_id });
  assert.deepEqual({
    document_id: link.value.document_id, document_version: link.value.document_version, quote_id: link.value.quote_id,
    confirmation: link.value.generation_confirmation_id, missing: link.value.missing_credits,
  }, { document_id: QUOTE.document_id, document_version: 1, quote_id: QUOTE.quote_id, confirmation: "confirm:recharge", missing: 4 });
});

test("unknown document, wrong state and inactive quote are rejected", async () => {
  const menu = await fixture();
  assert.equal((await menu.service.createRechargeSession({ ...menu.createCommand, document: { documentId: "unknown", documentVersion: 1, quoteId: QUOTE.quote_id, generationConfirmationId: "confirm:x", missingCredits: 1 } })).error, "RECHARGE_DOCUMENT_NOT_ELIGIBLE");
  const linked = await fixture({ linked: true });
  linked.quote.status = "EXPIRED";
  assert.equal((await linked.service.createRechargeSession(linked.createCommand)).error, "RECHARGE_QUOTE_NOT_ELIGIBLE");
});

test("verified confirmed event credits exact snapshot and writes one RECHARGE ledger entry", async () => {
  const f = await fixture({ balance: 2 });
  const { initiated } = await f.started();
  const result = await f.service.confirmPaymentEvent({ rechargeSessionId: initiated.recharge_session_id, rawEvent: f.confirmedEvent(initiated) });
  assert.equal(result.ok, true, result.error);
  const state = f.repository.inspect();
  assert.equal(state.balances[OWNER], 7);
  assert.deepEqual(state.ledger.map((entry) => ({ type: entry.ledger_type, amount: entry.amount })), [{ type: "RECHARGE", amount: 5 }]);
  assert.equal(state.ledger[0].idempotency_key, "recharge_credit:SYNTHETIC_PAY:payment:one");
});

test("unverified events never credit", async () => {
  const f = await fixture({ providerOverrides: { async verifyPaymentEvent(raw) { return { ok: true, value: { ...raw, verified: false } }; } } });
  const { initiated } = await f.started();
  const result = await f.service.confirmPaymentEvent({ rechargeSessionId: initiated.recharge_session_id, rawEvent: f.confirmedEvent(initiated) });
  assert.equal(result.ok, false);
  assert.equal(f.repository.inspect().ledger.length, 0);
});

test("unknown reference, payment id, amount and currency are rejected", async () => {
  for (const override of [{ merchant_reference: "unknown" }, { provider_payment_id: "payment:other" }, { amount: 999 }, { amount: 1001 }, { currency: "EUR" }]) {
    const f = await fixture();
    const { initiated } = await f.started();
    const result = await f.service.confirmPaymentEvent({ rechargeSessionId: initiated.recharge_session_id, rawEvent: f.confirmedEvent(initiated, override) });
    assert.equal(result.ok, false, JSON.stringify(override));
    assert.equal(f.repository.inspect().ledger.length, 0);
  }
});

test("duplicate and concurrent webhooks produce one credit only", async () => {
  const f = await fixture();
  const { initiated } = await f.started();
  const command = { rechargeSessionId: initiated.recharge_session_id, rawEvent: f.confirmedEvent(initiated) };
  const results = await Promise.all([f.service.confirmPaymentEvent(command), f.service.confirmPaymentEvent(command)]);
  assert.equal(results.every((entry) => entry.ok), true);
  assert.equal(f.repository.inspect().ledger.length, 1);
  assert.equal(f.repository.inspect().balances[OWNER], 5);
});

test("repository revalidates payment facts even when called below the service boundary", async () => {
  const f = await fixture();
  const { initiated } = await f.started();
  const event = f.confirmedEvent(initiated, { amount: 1 });
  const direct = await f.repository.confirmPaymentAndCredit({
    rechargeSessionId: initiated.recharge_session_id,
    event,
    fingerprint: "b".repeat(64),
    idempotencyKey: "recharge_credit:SYNTHETIC_PAY:payment:one",
    creditedAt: NOW,
  });
  assert.deepEqual(direct, { ok: false, error: "PAYMENT_EVENT_MISMATCH" });
  assert.equal(f.repository.inspect().ledger.length, 0);
});

test("same provider event with different parameters is a replay conflict", async () => {
  const f = await fixture();
  const { initiated } = await f.started();
  const first = f.confirmedEvent(initiated, { amount: 999 });
  assert.equal((await f.service.confirmPaymentEvent({ rechargeSessionId: initiated.recharge_session_id, rawEvent: first })).ok, false);
  const second = f.confirmedEvent(initiated);
  assert.deepEqual(await f.service.confirmPaymentEvent({ rechargeSessionId: initiated.recharge_session_id, rawEvent: second }), { ok: false, error: "PAYMENT_EVENT_PREVIOUSLY_REJECTED" });
  assert.equal(f.repository.inspect().ledger.length, 0);
});

test("expired, cancelled and failed sessions cannot be credited", async () => {
  const expired = await fixture();
  const created = await expired.service.createRechargeSession(expired.createCommand);
  expired.setNow("2026-08-02T14:00:00.000Z");
  assert.equal((await expired.service.initiatePayment({ rechargeSessionId: created.value.recharge_session_id, ownerWaId: OWNER })).value.status, "EXPIRED");
  const cancelled = await fixture();
  const started = await cancelled.started();
  await cancelled.service.cancelRechargeSession({ rechargeSessionId: started.initiated.recharge_session_id, ownerWaId: OWNER });
  assert.equal((await cancelled.service.confirmPaymentEvent({ rechargeSessionId: started.initiated.recharge_session_id, rawEvent: cancelled.confirmedEvent(started.initiated) })).ok, false);
  const failed = await fixture();
  const failedStarted = await failed.started();
  assert.equal((await failed.service.markPaymentFailed({ rechargeSessionId: failedStarted.initiated.recharge_session_id, ownerWaId: OWNER })).value.status, "FAILED");
  assert.equal((await failed.service.confirmPaymentEvent({ rechargeSessionId: failedStarted.initiated.recharge_session_id, rawEvent: failed.confirmedEvent(failedStarted.initiated) })).ok, false);
  assert.equal(failed.repository.inspect().ledger.length, 0);
});

test("provider outage and delayed post-expiry confirmation fail without credit", async () => {
  const unavailable = await fixture({ providerOverrides: { async createPaymentRequest() { return { ok: false, error: "PAYMENT_PROVIDER_UNAVAILABLE" }; } } });
  const created = await unavailable.service.createRechargeSession(unavailable.createCommand);
  assert.deepEqual(await unavailable.service.initiatePayment({ rechargeSessionId: created.value.recharge_session_id, ownerWaId: OWNER }), { ok: false, error: "PAYMENT_PROVIDER_UNAVAILABLE" });
  assert.equal(unavailable.repository.inspect().sessions[0].status, "CREATED");

  const delayed = await fixture();
  const delayedStarted = await delayed.started();
  delayed.setNow("2026-08-02T14:00:00.000Z");
  assert.deepEqual(await delayed.service.confirmPaymentEvent({ rechargeSessionId: delayedStarted.initiated.recharge_session_id, rawEvent: delayed.confirmedEvent(delayedStarted.initiated) }), { ok: false, error: "PAYMENT_EVENT_LATE" });
  assert.equal(delayed.repository.inspect().ledger.length, 0);
});

test("configured late policy accepts only an event that occurred before expiry", async () => {
  const f = await fixture({ latePaymentPolicy: "ACCEPT_VERIFIED_BEFORE_EXPIRY" });
  const started = await f.started();
  f.setNow("2026-08-02T14:00:00.000Z");
  const accepted = await f.service.confirmPaymentEvent({ rechargeSessionId: started.initiated.recharge_session_id, rawEvent: f.confirmedEvent(started.initiated) });
  assert.equal(accepted.ok, true, accepted.error);
  assert.equal(f.repository.inspect().ledger.length, 1);

  const afterExpiry = await fixture({ latePaymentPolicy: "ACCEPT_VERIFIED_BEFORE_EXPIRY" });
  const second = await afterExpiry.started();
  afterExpiry.setNow("2026-08-02T14:00:00.000Z");
  const rejected = await afterExpiry.service.confirmPaymentEvent({
    rechargeSessionId: second.initiated.recharge_session_id,
    rawEvent: afterExpiry.confirmedEvent(second.initiated, { occurred_at: "2026-08-02T13:30:00.000Z" }),
  });
  assert.deepEqual(rejected, { ok: false, error: "PAYMENT_EVENT_LATE" });
});

test("menu recharge only credits wallet and never starts generation", async () => {
  const f = await fixture();
  const { initiated } = await f.started();
  await f.service.confirmPaymentEvent({ rechargeSessionId: initiated.recharge_session_id, rawEvent: f.confirmedEvent(initiated) });
  assert.equal(f.generationCalls.length, 0);
  assert.equal(f.repository.inspect().sessions[0].status, "CREDITED");
});

test("automatic resume uses the unchanged quote and original confirmation exactly once", async () => {
  const f = await fixture({ linked: true, resumePolicy: "AUTO_RESUME_IF_VALID" });
  const { initiated } = await f.started();
  const result = await f.service.confirmPaymentEvent({ rechargeSessionId: initiated.recharge_session_id, rawEvent: f.confirmedEvent(initiated) });
  assert.equal(result.ok, true, result.resume_error);
  assert.equal(f.generationCalls.length, 1);
  assert.deepEqual(f.generationCalls[0], { documentId: QUOTE.document_id, ownerWaId: OWNER, documentVersion: 1, quoteId: QUOTE.quote_id, idempotencyKey: "confirm:recharge" });
  assert.equal(f.repository.inspect().sessions[0].status, "RESUMED");
  assert.equal(f.repository.inspect().ledger.length, 1);
});

test("REQUIRE_CONFIRMATION credits but never resumes automatically", async () => {
  const f = await fixture({ linked: true, resumePolicy: "REQUIRE_CONFIRMATION" });
  const { initiated } = await f.started();
  const result = await f.service.confirmPaymentEvent({ rechargeSessionId: initiated.recharge_session_id, rawEvent: f.confirmedEvent(initiated) });
  assert.equal(result.ok, true);
  assert.equal(result.resume.automatic, false);
  assert.equal(f.generationCalls.length, 0);
  assert.equal(f.repository.inspect().sessions[0].status, "RESUME_PENDING");
});

test("expired quote, changed cost and modified document prevent automatic resume", async () => {
  for (const [label, mutation] of [
    ["expired quote", (f) => { f.quote.expires_at = "2026-08-02T11:00:00.000Z"; }],
    ["changed cost", (f) => { f.quote.total_credits = 6; }],
    ["modified document", async (f) => {
      const loaded = await f.documents.getDocumentById({ documentId: QUOTE.document_id, ownerWaId: OWNER });
      const modified = f.domain.modifyDocument(loaded.value, { notes: "Modification après quote" });
      const saved = await f.documents.saveNewVersion({ document: modified.value, ownerWaId: OWNER, expectedVersion: 1, fromState: "RECHARGE_REQUIRED", eventType: "TEST_MODIFIED", idempotencyKey: "doc:recharge:modified" });
      assert.equal(saved.ok, true, saved.error);
    }],
  ]) {
    const f = await fixture({ linked: true, resumePolicy: "AUTO_RESUME_IF_VALID" });
    const { initiated } = await f.started();
    await mutation(f);
    const result = await f.service.confirmPaymentEvent({ rechargeSessionId: initiated.recharge_session_id, rawEvent: f.confirmedEvent(initiated) });
    assert.equal(result.ok, true);
    assert.equal(f.generationCalls.length, 0, label);
    assert.equal(f.repository.inspect().ledger.length, 1);
  }
});

test("resume failure preserves credited wallet and retry never credits again", async () => {
  let calls = 0;
  const f = await fixture({ linked: true, resumePolicy: "AUTO_RESUME_IF_VALID", generationResult: () => {
    calls += 1;
    return calls === 1 ? { ok: false, error: "DELIVERY_RECOVERABLE_FAILURE" } : { ok: true, value: { status: "DELIVERED" } };
  } });
  const { initiated } = await f.started();
  const event = f.confirmedEvent(initiated);
  const first = await f.service.confirmPaymentEvent({ rechargeSessionId: initiated.recharge_session_id, rawEvent: event });
  assert.equal(first.ok, true);
  assert.equal(first.resume_error, "GENERATION_RESUME_FAILED");
  assert.equal(f.repository.inspect().ledger.length, 1);
  const retried = await f.service.resumePendingGeneration({ rechargeSessionId: initiated.recharge_session_id, ownerWaId: OWNER });
  assert.equal(retried.ok, true, retried.error);
  assert.equal(f.repository.inspect().ledger.length, 1);
  assert.equal(calls, 2);
});

test("partial credit failure rolls back session, event, ledger and balance", async () => {
  const f = await fixture({ failpoint: async (point) => { if (point === "before_recharge_credit") throw new Error("SYNTHETIC_FAILURE"); } });
  const { initiated } = await f.started();
  await assert.rejects(() => f.service.confirmPaymentEvent({ rechargeSessionId: initiated.recharge_session_id, rawEvent: f.confirmedEvent(initiated) }), /SYNTHETIC_FAILURE/);
  const state = f.repository.inspect();
  assert.equal(state.ledger.length, 0);
  assert.equal(state.events.length, 0);
  assert.equal(state.balances[OWNER], 0);
  assert.equal(state.sessions[0].status, "PAYMENT_PENDING");
});

test("payment result validation rejects hostile and incomplete provider data", () => {
  assert.equal(normalizePaymentResult({}).ok, false);
  assert.equal(normalizePaymentResult(paymentResult({ amount: -1 })).ok, false);
  assert.equal(normalizePaymentResult(paymentResult({ metadata: { token: "x".repeat(300) } })).ok, false);
  const hostile = {};
  Object.defineProperty(hostile, "provider", { enumerable: true, get() { throw new Error("MUST_NOT_RUN"); } });
  assert.deepEqual(normalizePaymentResult(hostile), { ok: false, error: "PAYMENT_RESULT_INVALID" });
  assert.equal(normalizePaymentResult(paymentResult({ metadata: { provider_note: "line\nbreak" } })).ok, false);
});

test("observability contains closed non-sensitive fields only", async () => {
  const observed = [];
  const f = await fixture({ observer: (event) => observed.push(event) });
  const { initiated } = await f.started();
  await f.service.confirmPaymentEvent({ rechargeSessionId: initiated.recharge_session_id, rawEvent: f.confirmedEvent(initiated) });
  const serialized = JSON.stringify(observed);
  assert.match(serialized, /recharge_session_created/);
  assert.match(serialized, /recharge_credited/);
  assert.doesNotMatch(serialized, /secret|signature|mobile|payload|document_content|authorization/i);
  assert.equal(serialized.includes(OWNER), false);
});

test("migration is additive, constrained and credits through one atomic RPC", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "20260802_add_kadi_v1_recharge.sql"), "utf8");
  for (const table of ["kadi_v1_recharge_sessions", "kadi_v1_payment_events", "kadi_v1_payment_provider_references", "kadi_v1_recharge_resume_links"]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`));
  }
  assert.match(sql, /kadi_v1_confirm_recharge_credit/);
  assert.match(sql, /kadi_v1_create_recharge_session/);
  assert.match(sql, /kadi_add_credits_v2/);
  assert.match(sql, /p_reason\s*=>\s*'RECHARGE'/);
  assert.match(sql, /recharge_credit:/);
  assert.match(sql, /kadi_v1_payment_event:/);
  assert.match(sql, /PAYMENT_PROVIDER_REFERENCE_CONFLICT/);
  assert.doesNotMatch(sql, /\b(?:drop\s+(?:table|column|constraint)|truncate\s+table|delete\s+from)\b/i);
  assert.doesNotMatch(sql, /WELCOME_CREDITS|\bstamp\b|\btampon\b/i);
  assert.doesNotMatch(sql, /update\s+public\.(?:kadi_wallets|kadi_credit_ledger|kadi_topups)\b/i);
});

test("Supabase adapter delegates credit confirmation to the atomic RPC", async () => {
  const calls = [];
  const client = {
    rpc(name, parameters) {
      calls.push({ name, parameters });
      return Promise.resolve({ data: { ok: true, session: { recharge_session_id: "recharge:rpc", status: "CREDITED" }, balance: 5 }, error: null });
    },
    from() { throw new Error("TABLE_ACCESS_NOT_EXPECTED"); },
  };
  const repository = createSupabaseRechargeRepository(client);
  const event = paymentResult({ merchant_reference: "recharge:rpc" });
  const result = await repository.confirmPaymentAndCredit({
    rechargeSessionId: "recharge:rpc", event, fingerprint: "a".repeat(64),
    idempotencyKey: "recharge_credit:SYNTHETIC_PAY:payment:one", creditedAt: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].name, "kadi_v1_confirm_recharge_credit");
  assert.equal(JSON.stringify(calls).includes("rawEvent"), false);
});

test("Lot 9 has no Meta, real provider SDK, PDF or webhook dependency", () => {
  for (const file of ["kadiV1RechargeConfig.js", "kadiV1PaymentProvider.js", "kadiV1RechargeRepository.js", "kadiV1RechargeService.js", "kadiV1SupabaseRechargeRepository.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.doesNotMatch(source, /require\(["'][^"']*(?:whatsapp|orange|moov|wave|mtn|pdf|openai|gemini|axios)/i, file);
    assert.doesNotMatch(source, /\/webhook|\/data_exchange|phone_number_id|flow_id/i, file);
  }
});
