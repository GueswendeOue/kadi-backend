"use strict";

// Production-composition test for RECHARGE-CONTRACT-001 (T3): kadi_recharge_v1.json
// is one combined form whose single Footer always submits pack_id/
// payment_reference together, regardless of which action (SELECT_PACK/
// CHECK_PAYMENT/CANCEL) was chosen. Before this fix, every real RECHARGE
// submission of any action failed with KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN.
// This traces the complete real chain: nfm_reply -> Flow reply runtime ->
// session consume -> Flow command runtime -> the real production recharge
// runtime (kadiV1ProductionInfrastructure.js's createKadiV1RechargeRuntime)
// -> the real recharge service/repository -> a fake in-memory payment
// provider -> presenter. Only true external I/O (WhatsApp send calls, the
// payment provider, and every unrelated port) is faked/stubbed. No Meta,
// Supabase, Render or real payment mutation anywhere in this file.
//
// The webhook runtime (kadiV1WebhookRuntime.js's handleIncomingValue) never
// exposes the raw business result to the caller — only
// {handled, accepted, duplicate, reason}. Every assertion below therefore
// verifies real, observable production effects instead: the text actually
// sent to the owner (f.sent.texts, built from the same canonicalReplyText
// the real presenter uses) and the real recharge session state read back
// from the same in-memory repository the whole chain writes through.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDocumentDomain } = require("../kadiV1DocumentDomain");
const { createInMemoryV1DocumentRepository } = require("../kadiV1DocumentRepository");
const { createRechargePackCatalog } = require("../kadiV1RechargeConfig");
const { createInMemoryRechargeRepository } = require("../kadiV1RechargeRepository");
const { createRechargeService } = require("../kadiV1RechargeService");
const { createKadiV1RechargeRuntime } = require("../kadiV1ProductionInfrastructure");
const { createKadiV1FlowCommandRuntime } = require("../kadiV1FlowCommandRuntime");
const { createKadiV1FlowReplyRuntime } = require("../kadiV1FlowReplyRuntime");
const { createKadiV1ProductionPresenter } = require("../kadiV1ProductionPresenter");
const { createConversationSessionService, createMemoryConversationSessionRepository } = require("../kadiV1ConversationSession");
const { createKadiV1ProductionComposition } = require("../kadiV1ProductionComposition");

const OWNER = "22670000000";
const OTHER_OWNER = "22679999999";
const NOW = "2026-08-07T02:00:00.000Z";
const PACK_1000 = Object.freeze({ pack_id: "PACK_1000", amount: 1000, currency: "XOF", credits: 10, pricing_version: "legacy-v1", active: true });
const PACK_2000 = Object.freeze({ pack_id: "PACK_2000", amount: 2000, currency: "XOF", credits: 25, pricing_version: "legacy-v1", active: true });

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

// A minimal fake Supabase client — only the one raw query
// createKadiV1RechargeRuntime's real cancel() issues is implemented, kept
// in sync with the real in-memory recharge repository (never a second,
// independently-maintained copy of session state). No network, no real
// Supabase project involved.
function createFakeRechargeSupabaseClient({ rechargeRepository, sessionIdsByOwner }) {
  return {
    async rpc() { throw new Error("UNEXPECTED_CALL:rpc"); },
    storage: { from() { throw new Error("UNEXPECTED_CALL:storage"); } },
    from(table) {
      if (table !== "kadi_v1_recharge_sessions") throw new Error(`UNEXPECTED_TABLE:${table}`);
      return {
        // RECHARGE-CONTRACT-001 R3: mirrors the real query exactly —
        // status is no longer filtered here at all. The contextual newest
        // session (owner-scoped, created_at <= sessionOpenedAt) is
        // resolved first, regardless of status; kadiV1ProductionInfrastructure.js's
        // cancel() itself checks cancellability against the returned
        // status and fails closed without ever falling through to an
        // older row.
        select: () => ({
          eq: (_col, ownerWaId) => ({
            // RECHARGE-CONTRACT-001 R1: mirrors the real
            // .lte("created_at", sessionOpenedAt) bound — only a recharge
            // session created at or before the trusted Flow session's own
            // opened_at is ever eligible.
            lte: (_col2, upperBound) => ({
              order: () => ({
                limit: () => ({
                  async maybeSingle() {
                    const ids = sessionIdsByOwner.get(ownerWaId) || [];
                    const sessions = [];
                    for (const id of ids) {
                      const loaded = await rechargeRepository.getRechargeSession({ rechargeSessionId: id });
                      if (loaded.ok && loaded.value.owner_wa_id === ownerWaId && loaded.value.created_at <= upperBound) {
                        sessions.push(loaded.value);
                      }
                    }
                    sessions.sort((a, b) => b.created_at.localeCompare(a.created_at));
                    const newest = sessions[0];
                    return { data: newest ? { recharge_session_id: newest.recharge_session_id, status: newest.status } : null, error: null };
                  },
                }),
              }),
            }),
          }),
        }),
      };
    },
  };
}

// A real payment provider (e.g. Orange Money) keeps its own record of
// which merchant reference a provider_payment_id belongs to — it is never
// told the merchant reference again by the caller at status-check time,
// and never trusts one if it were. getPaymentStatus below resolves
// merchant_reference from that own record, exactly like the real
// kadiV1PaymentProvider.js contract requires.
function fakePaymentProvider({ confirmOnVerify = true } = {}) {
  const requests = [];
  const paymentsById = new Map();
  let sequence = 0;
  return {
    name: "SYNTHETIC_PAY",
    requests,
    async createPaymentRequest(request) {
      sequence += 1;
      const providerPaymentId = `payment:${sequence}`;
      paymentsById.set(providerPaymentId, {
        merchant_reference: request.merchant_reference, amount: request.amount, currency: request.currency,
      });
      requests.push(request);
      return {
        ok: true,
        value: {
          provider: "SYNTHETIC_PAY", provider_payment_id: providerPaymentId, provider_event_id: null,
          merchant_reference: request.merchant_reference, amount: request.amount, currency: request.currency,
          status: "PENDING", verified: true, occurred_at: NOW, metadata: {},
        },
      };
    },
    async getPaymentStatus({ providerPaymentId }) {
      const payment = paymentsById.get(providerPaymentId);
      if (!payment) return { ok: false, error: "PAYMENT_NOT_FOUND" };
      return {
        ok: true,
        value: {
          provider: "SYNTHETIC_PAY", provider_payment_id: providerPaymentId, provider_event_id: `event:${providerPaymentId}`,
          merchant_reference: payment.merchant_reference, amount: payment.amount, currency: payment.currency,
          status: confirmOnVerify ? "CONFIRMED" : "PENDING", verified: true, occurred_at: NOW, metadata: {},
        },
      };
    },
    async verifyPaymentEvent(raw) { return { ok: true, value: { ...raw } }; },
  };
}

// RECHARGE-CONTRACT-001 R1: a genuinely advancing clock, shared between the
// conversation session service (session.opened_at) and the recharge
// service (recharge session created_at), is required to make "created
// before/after this session was opened" meaningfully distinguishable —
// a fixed clock would make every timestamp identical and silently defeat
// the cross-session CANCEL binding this fixture exists to prove.
function createAdvancingClock(startIso) {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.parse(startIso) + tick * 1000).toISOString();
  };
}

// R2 Test B (process-restart semantics): buildComposition optionally
// accepts already-existing, already-persisted stores (session repository,
// recharge repository, its owner index, the payment provider) instead of
// creating fresh ones — everything else (services, runtimes, presenter,
// composition) is always rebuilt from scratch. This lets a test simulate
// "the process restarted" faithfully: only what a real restart would
// actually keep (the database) survives; nothing in-process does.
async function buildComposition({
  balance = 0,
  provider = fakePaymentProvider(),
  sessionRepository = createMemoryConversationSessionRepository(),
  rechargeRepository: existingRechargeRepository = null,
  sessionIdsByOwner: existingSessionIdsByOwner = null,
  sharedClock = createAdvancingClock(NOW),
} = {}) {
  const domain = createDocumentDomain({ clock: () => NOW });
  const documents = createInMemoryV1DocumentRepository();
  const packCatalog = createRechargePackCatalog({ packs: [PACK_1000, PACK_2000] });

  const sessionIdsByOwner = existingSessionIdsByOwner || new Map();
  let rechargeRepository = existingRechargeRepository;
  if (!rechargeRepository) {
    const realRechargeRepository = createInMemoryRechargeRepository({ balances: { [OWNER]: balance, [OTHER_OWNER]: 0 } });
    rechargeRepository = {};
    for (const key of Object.keys(realRechargeRepository)) rechargeRepository[key] = realRechargeRepository[key];
    rechargeRepository.createRechargeSession = async (args) => {
      const result = await realRechargeRepository.createRechargeSession(args);
      if (result.ok) {
        const list = sessionIdsByOwner.get(result.value.owner_wa_id) || [];
        list.push(result.value.recharge_session_id);
        sessionIdsByOwner.set(result.value.owner_wa_id, list);
      }
      return result;
    };
  }

  // Document-linked resume (quoteService/generationLifecycleService) is
  // out of scope for these MENU-triggered recharge scenarios — throwing
  // stubs structurally prove SELECT_PACK/CHECK_PAYMENT/CANCEL never touch
  // generation, exactly like every other port below.
  const rechargeService = createRechargeService({
    repository: rechargeRepository,
    packCatalog,
    paymentProvider: provider,
    documentRepository: documents,
    quoteService: { getGenerationQuote: async () => { throw new Error("UNEXPECTED_CALL:getGenerationQuote"); } },
    generationLifecycleService: { confirmGeneration: async () => { throw new Error("UNEXPECTED_CALL:confirmGeneration"); } },
    clock: sharedClock,
  });

  const client = createFakeRechargeSupabaseClient({ rechargeRepository, sessionIdsByOwner });
  const rechargeRuntime = createKadiV1RechargeRuntime({
    rechargeService, rechargeRepository, paymentProvider: provider, client,
    orangeMoneyNumber: "22670000099", orangeMoneyName: "Kadi",
  });

  const commandRuntime = createKadiV1FlowCommandRuntime({
    onboardingRuntime: stubPort(["continueOnboarding"]),
    documentRuntime: stubPort([
      "start", "setInvoiceKind", "setReceiptDetails", "setClient", "startAddContent", "addContent", "updateContent",
      "removeContent", "finishContent", "setOptions", "verify", "beginEdit", "saveForLater", "saveDischargeDetails", "cancel",
    ]),
    previewRuntime: stubPort(["prepare"]),
    generationRuntime: stubPort(["confirm"]),
    rechargeRuntime,
    historyRuntime: stubPort(["search", "open"]),
    walletRuntime: stubPort(["getBalance"]),
  });
  const sessionService = createConversationSessionService({ repository: sessionRepository, clock: sharedClock });
  const flowReplyRuntime = createKadiV1FlowReplyRuntime({ sessionService, commandRuntime });

  const sent = { texts: [], flows: [] };
  const whatsappApi = {
    async sendText(to, text) { sent.texts.push({ to, text }); },
    async sendButtons() { throw new Error("UNEXPECTED_CALL:sendButtons"); },
    async sendFlow(payload) { sent.flows.push(payload); },
  };
  const presenter = createKadiV1ProductionPresenter({
    config: { enabled: true, features: { voice: false }, flowIds: FLOW_IDS },
    whatsappApi, sessionService, clock: () => NOW, logger: { log() {} },
  });
  const config = { enabled: true, features: { webhook: true }, rollout: { mode: "FULL", valid: true, canaryOwnerCount: 0, canaryWaIds: [] } };
  const composition = createKadiV1ProductionComposition({
    config,
    components: { orchestrator: stubPort(["handle"]), flowReplyRuntime, mediaResolver: stubPort(["resolveAudio", "resolveImage", "resolvePdf"]), presenter, deliveryRetryRuntime: stubPort(["handle"]) },
    logger: { warn() {}, log() {} },
  });
  assert.equal(composition.readiness.ready, true, JSON.stringify(composition.readiness));
  return { composition, sessionService, sent, rechargeRepository, sessionIdsByOwner, sessionRepository, provider, rechargeRuntime };
}

// R2 Test B helper: simulates a real process restart — every in-process
// object (services, runtimes, presenter, composition) is discarded and
// rebuilt from scratch, wired only to the same underlying, already-
// persisted stores (the session repository, the recharge repository and
// its owner index, the payment provider) a real restart would actually
// keep.
async function rebuildCompositionAroundSameRepositories(f) {
  return buildComposition({
    sessionRepository: f.sessionRepository,
    rechargeRepository: f.rechargeRepository,
    sessionIdsByOwner: f.sessionIdsByOwner,
    provider: f.provider,
  });
}

function nfmReply({ sessionId, action, data = {}, from = OWNER }) {
  return {
    id: `wamid:${action}:${sessionId}`, from, type: "interactive",
    interactive: { type: "nfm_reply", nfm_reply: { response_json: JSON.stringify({ session_id: sessionId, flow_key: "RECHARGE", action, data, flow_token: sessionId }) } },
  };
}

async function openSession(f, { ownerWaId = OWNER, idempotencyKey } = {}) {
  const opened = await f.sessionService.open({ ownerWaId, expectedFlowKey: "RECHARGE", idempotencyKey });
  assert.equal(opened.ok, true, opened.error);
  return opened.value.session_id;
}

async function send(f, { action, data = {}, ownerWaId = OWNER, idempotencyKey, expectAccepted = true }) {
  const sessionId = await openSession(f, { ownerWaId, idempotencyKey });
  const message = nfmReply({ sessionId, action, data, from: ownerWaId });
  const result = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(result.handled, true);
  assert.equal(result.results[0].accepted, expectAccepted, result.results[0].reason);
  return result.results[0];
}

let counter = 0;
function nextKey(prefix) { counter += 1; return `${prefix}:${counter}`; }

function latestSessionId(f, ownerWaId = OWNER) {
  const ids = f.sessionIdsByOwner.get(ownerWaId) || [];
  return ids[ids.length - 1];
}

async function latestSession(f, ownerWaId = OWNER) {
  const id = latestSessionId(f, ownerWaId);
  assert.ok(id, `no recharge session was ever created for ${ownerWaId}`);
  const loaded = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: id });
  assert.equal(loaded.ok, true, loaded.error);
  return loaded.value;
}

// R2 independent review (HIGH/P0): kadiV1FlowCommandRuntime.js now
// rejects RECHARGE/CANCEL unconditionally, before rechargeRuntime.cancel()
// is ever called (see kadiV1RechargePresenterE2E.test.js's R2/HIGH tests
// for the full defect/fix — a RECHARGE Flow proved to have no reliable
// way to prove which recharge session it is actually about, even in a
// "bound" context). "Do not weaken T3 tests of its lower-level
// target-selection primitive": the tests below call
// rechargeRuntime.cancel({ownerWaId, sessionOpenedAt}) directly,
// bypassing the now-closed FlowCommandRuntime entry point, to keep
// proving R1 (sessionOpenedAt bound) and R3 (no-fallthrough) are
// completely unchanged and correct at the level where they actually
// live (kadiV1ProductionInfrastructure.js's cancel()).
async function rechargeSessionOpenedAt(f, ownerWaId = OWNER) {
  const opened = await f.sessionService.open({ ownerWaId, expectedFlowKey: "RECHARGE", idempotencyKey: nextKey("cancel-primitive-session") });
  assert.equal(opened.ok, true, opened.error);
  return opened.value.opened_at;
}

// 1 + 2 + 3. SELECT_PACK: real combined payload, blank payment_reference,
// stale nonblank payment_reference — all accepted, exactly the trusted
// catalog pack selected, payment_reference never influences anything.
test("1-3. SELECT_PACK real combined-form payload (blank or stale payment_reference) selects exactly the trusted catalog pack and returns real payment instructions", async () => {
  for (const paymentReference of ["", "REF-STALE-FROM-A-PRIOR-SCREEN"]) {
    const f = await buildComposition();
    await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: paymentReference }, idempotencyKey: nextKey("select") });

    const session = await latestSession(f);
    assert.equal(session.pack_id, "PACK_1000", "the exact real, trusted catalog pack must be selected, never influenced by payment_reference");
    assert.equal(session.pack_snapshot.amount, PACK_1000.amount);
    assert.equal(session.pack_snapshot.credits, PACK_1000.credits);
    assert.equal(session.status, "PAYMENT_PENDING");
    assert.equal(f.provider.requests.length, 1, "exactly one payment initiation");

    const [lastText] = f.sent.texts.slice(-1);
    assert.match(lastText.text, /1\s000 FCFA pour 10 crédits/, "payment_instructions must reach the owner as real text");
    assert.match(lastText.text, /22670000099/);
  }
});

// 4. SELECT_PACK missing/blank pack_id fails safely.
test("4. SELECT_PACK with a blank/missing pack_id fails safely, no session created", async () => {
  const f = await buildComposition();
  const result = await send(f, { action: "SELECT_PACK", data: { pack_id: "", payment_reference: "" }, idempotencyKey: nextKey("select-blank"), expectAccepted: false });
  assert.equal(result.reason, "KADI_V1_RECHARGE_PACK_ID_INVALID");
  assert.equal(f.sessionIdsByOwner.has(OWNER), false, "no recharge session must ever be created from an invalid pack_id");
});

// SELECT_PACK: client cannot inject amount/currency/credits (server-side
// pack resolution only, financial invariant).
test("SELECT_PACK ignores any client-supplied pack fields — the real Flow never submits them, and the backend never trusts them", async () => {
  const f = await buildComposition();
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_2000", payment_reference: "" }, idempotencyKey: nextKey("select-trusted") });
  const session = await latestSession(f);
  assert.equal(session.pack_snapshot.amount, PACK_2000.amount, "amount always comes from the trusted server catalog");
  assert.equal(session.pack_snapshot.credits, PACK_2000.credits, "credits always comes from the trusted server catalog");
});

// 12. Replay SELECT_PACK: recharge session created at most once, payment
// initiated at most once.
test("12. A replayed SELECT_PACK reply (same wamid) is idempotent — recharge session and payment initiation both happen at most once", async () => {
  const f = await buildComposition();
  const sessionId = await openSession(f, { idempotencyKey: nextKey("select-replay-session") });
  const message = nfmReply({ sessionId, action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" } });

  const first = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(first.results[0].accepted, true, first.results[0].reason);
  assert.equal(first.results[0].duplicate, false);
  assert.equal(f.provider.requests.length, 1);
  assert.equal((f.sessionIdsByOwner.get(OWNER) || []).length, 1);

  const second = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(second.results[0].accepted, true, second.results[0].reason);
  assert.equal(second.results[0].duplicate, true, "an exact SELECT_PACK replay must be recognized as a duplicate");
  assert.equal(f.provider.requests.length, 1, "the replay must never initiate a second payment request");
  assert.equal((f.sessionIdsByOwner.get(OWNER) || []).length, 1, "the replay must never create a second recharge session");
});

// 5 + 6. CHECK_PAYMENT: real combined payload, stale nonblank pack_id
// ignored, valid owned reference accepted, credited.
test("5-6. CHECK_PAYMENT real combined-form payload with a stale nonblank pack_id is accepted, ignores pack_id and credits the real owned session", async () => {
  const f = await buildComposition({ balance: 0 });
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, idempotencyKey: nextKey("check-select") });
  const session = await latestSession(f);
  const paymentReference = session.provider_payment_id;

  await send(f, {
    action: "CHECK_PAYMENT", data: { pack_id: "PACK_2000", payment_reference: paymentReference }, idempotencyKey: nextKey("check"),
  });
  const balance = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balance.value, PACK_1000.credits, "credited amount must come from the real, owned session's trusted pack, never the stale pack_id");
  const afterCredit = await latestSession(f);
  assert.equal(afterCredit.status, "CREDITED");

  const [lastText] = f.sent.texts.slice(-1);
  assert.equal(lastText.text, "Votre paiement est confirmé et vos crédits ont été ajoutés.");
});

// 7. CHECK_PAYMENT missing/blank payment_reference fails safely.
test("7. CHECK_PAYMENT with a blank/missing payment_reference fails safely", async () => {
  const f = await buildComposition();
  const result = await send(f, { action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: "" }, idempotencyKey: nextKey("check-blank"), expectAccepted: false });
  assert.equal(result.reason, "KADI_V1_PAYMENT_REFERENCE_INVALID");
});

// 8. CHECK_PAYMENT owner mismatch fails closed.
test("8. CHECK_PAYMENT can never verify another owner's payment reference", async () => {
  const f = await buildComposition();
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, idempotencyKey: nextKey("owner-select") });
  const session = await latestSession(f);
  const paymentReference = session.provider_payment_id;

  const result = await send(f, {
    action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: paymentReference }, ownerWaId: OTHER_OWNER,
    idempotencyKey: nextKey("owner-check"), expectAccepted: false,
  });
  assert.equal(result.reason, "RECHARGE_SESSION_NOT_FOUND");
  const stillPending = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: session.recharge_session_id });
  assert.equal(stillPending.value.status, "PAYMENT_PENDING", "the real owner's session must never be affected by another owner's attempt");
  const otherBalance = await f.rechargeRepository.getBalance({ ownerWaId: OTHER_OWNER });
  assert.equal(otherBalance.value, 0, "the other owner must never be credited");
});

// 13. Replay CHECK_PAYMENT: does not double-credit.
test("13. A replayed CHECK_PAYMENT reply (same wamid) is idempotent — never double-credits", async () => {
  const f = await buildComposition({ balance: 0 });
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, idempotencyKey: nextKey("replay-check-select") });
  const session = await latestSession(f);
  const paymentReference = session.provider_payment_id;

  const sessionId = await openSession(f, { idempotencyKey: nextKey("replay-check-session") });
  const message = nfmReply({ sessionId, action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: paymentReference } });

  const first = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(first.results[0].accepted, true, first.results[0].reason);
  const balanceAfterFirst = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balanceAfterFirst.value, PACK_1000.credits);

  const second = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(second.results[0].accepted, true, second.results[0].reason);
  assert.equal(second.results[0].duplicate, true, "an exact CHECK_PAYMENT replay must be recognized as a duplicate");
  const balanceAfterSecond = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balanceAfterSecond.value, PACK_1000.credits, "balance must never increase a second time from a replay");
});

// 9 + 10 (R2/HIGH, superseding the original T3 premise): RECHARGE/CANCEL
// through the full webhook chain is now rejected unconditionally by
// kadiV1FlowCommandRuntime.js, before rechargeRuntime.cancel() is ever
// called — regardless of pack_id/payment_reference payload content. See
// kadiV1RechargePresenterE2E.test.js's R2/HIGH tests for the full
// defect/fix rationale.
test("9-10 (R2). RECHARGE/CANCEL through the full webhook chain is rejected unconditionally, regardless of pack_id/payment_reference payload", async () => {
  const f = await buildComposition({ balance: 0 });
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, idempotencyKey: nextKey("cancel-select") });
  const before = await latestSession(f);
  assert.equal(before.status, "PAYMENT_PENDING");

  const result = await send(f, {
    action: "CANCEL", data: { pack_id: "PACK_2000", payment_reference: "REF-COMPLETELY-UNRELATED" }, idempotencyKey: nextKey("cancel"),
    expectAccepted: false,
  });
  assert.equal(result.reason, "KADI_V1_RECHARGE_CANCEL_NOT_EXPOSED");

  const after = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: before.recharge_session_id });
  assert.equal(after.value.status, "PAYMENT_PENDING", "the rejected CANCEL must never cancel anything");
  const balance = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balance.value, 0, "cancelling must never change credits");
});

// 14 (R2): an exact replay of the same rejected CANCEL webhook message is
// still recognized as a duplicate at the session layer (the generic
// consumeReply() mechanism, unrelated to and unchanged by this mission) —
// silently absorbed a second time, never sending a second message, never
// touching the recharge repository. Both the first (rejected) and second
// (duplicate-absorbed) submissions cause zero mutation, consistent with
// the new "CANCEL is never exposed" contract.
test("14 (R2). An exact replay of a rejected RECHARGE/CANCEL reply is recognized as a duplicate and causes zero mutation, same as the first rejected attempt", async () => {
  const f = await buildComposition();
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, idempotencyKey: nextKey("replay-cancel-select") });
  const before = await latestSession(f);

  const sessionId = await openSession(f, { idempotencyKey: nextKey("replay-cancel-session") });
  const message = nfmReply({ sessionId, action: "CANCEL", data: { pack_id: "", payment_reference: "" } });

  const first = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(first.results[0].accepted, false, "the first submission must be rejected — CANCEL is never exposed");
  assert.notEqual(first.results[0].duplicate, true, "the rejected first submission is not itself a duplicate");
  const afterFirst = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: before.recharge_session_id });
  assert.equal(afterFirst.value.status, "PAYMENT_PENDING", "the rejected first attempt must never cancel anything");

  const second = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(second.results[0].duplicate, true, "an exact replay of the same message must still be recognized as a duplicate at the session layer");
  const afterSecond = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: before.recharge_session_id });
  assert.equal(afterSecond.value.status, "PAYMENT_PENDING", "the replay must also cause zero mutation");
});

// 11. Unrelated unknown field rejected.
test("11. An unrelated field outside the real RECHARGE Flow contract is rejected through the full webhook chain", async () => {
  const f = await buildComposition();
  const result = await send(f, {
    action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "", not_a_real_field: "x" },
    idempotencyKey: nextKey("unknown-field"), expectAccepted: false,
  });
  assert.equal(result.reason, "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN");
});

// 15. Unrelated Flow CANCEL does NOT inherit recharge fields — proven
// through the full webhook chain, not just the isolated allowlist unit
// test already covering this in tests/kadiV1FlowReplyRuntime.test.js.
test("15. DOCUMENT_REVIEW/CANCEL through the full webhook chain still rejects pack_id/payment_reference — the RECHARGE-only override never leaks", async () => {
  const f = await buildComposition();
  const sessionId = await f.sessionService.open({ ownerWaId: OWNER, expectedFlowKey: "DOCUMENT_REVIEW", idempotencyKey: nextKey("review-cancel-session") });
  assert.equal(sessionId.ok, true, sessionId.error);
  const message = {
    id: "wamid:review-cancel", from: OWNER, type: "interactive",
    interactive: { type: "nfm_reply", nfm_reply: { response_json: JSON.stringify({
      session_id: sessionId.value.session_id, flow_key: "DOCUMENT_REVIEW", action: "CANCEL",
      data: { pack_id: "PACK_1000", payment_reference: "REF-1" }, flow_token: sessionId.value.session_id,
    }) } },
  };
  const result = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(result.handled, true);
  assert.equal(result.results[0].accepted, false, "DOCUMENT_REVIEW/CANCEL must never accept RECHARGE-only fields");
});

test("5b. DOCUMENT_PREVIEW/CANCEL through the full webhook chain still rejects pack_id/payment_reference — the RECHARGE-only override never leaks", async () => {
  const f = await buildComposition();
  const sessionId = await f.sessionService.open({ ownerWaId: OWNER, expectedFlowKey: "DOCUMENT_PREVIEW", idempotencyKey: nextKey("preview-cancel-session") });
  assert.equal(sessionId.ok, true, sessionId.error);
  const message = {
    id: "wamid:preview-cancel", from: OWNER, type: "interactive",
    interactive: { type: "nfm_reply", nfm_reply: { response_json: JSON.stringify({
      session_id: sessionId.value.session_id, flow_key: "DOCUMENT_PREVIEW", action: "CANCEL",
      data: { pack_id: "PACK_1000", payment_reference: "REF-1" }, flow_token: sessionId.value.session_id,
    }) } },
  };
  const result = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(result.handled, true);
  assert.equal(result.results[0].accepted, false, "DOCUMENT_PREVIEW/CANCEL must never accept RECHARGE-only fields");
});

// 16. No render/generation/document mutation caused by merely selecting,
// checking or cancelling — structurally proven: documentRuntime,
// previewRuntime, generationRuntime and historyRuntime are all
// throw-on-call stubs used throughout this file's buildComposition(), so
// any accidental call in the tests above would already have failed them.
test("16. Selecting, checking or cancelling a recharge never touches document/preview/generation ports (structural proof)", async () => {
  const f = await buildComposition({ balance: 0 });
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, idempotencyKey: nextKey("no-side-effect-select") });
  const session = await latestSession(f);
  await send(f, { action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: session.provider_payment_id }, idempotencyKey: nextKey("no-side-effect-check") });
  // Reaching this point without any UNEXPECTED_CALL throw from the stubbed
  // documentRuntime/previewRuntime/generationRuntime/historyRuntime ports
  // in buildComposition() is itself the proof.
  assert.ok(true);
});

// --- R1/R3 independent review: HIGH/P0 cross-session/no-fallthrough
// CANCEL safety, tested at the lower-level primitive (R2/HIGH closed the
// Flow entry point entirely — see the "9-10 (R2)" test above and
// kadiV1RechargePresenterE2E.test.js's R2/HIGH tests) ---
//
// rechargeRuntime.cancel({ownerWaId, sessionOpenedAt}) resolves its
// target by owner + sessionOpenedAt (the trusted moment a Flow session
// was opened) bound, newest-first, regardless of status, then checks
// cancellability on that exact resolved row without ever falling
// through to an older one. These tests call it directly — bypassing the
// now-closed kadiV1FlowCommandRuntime.js entry point — to keep proving
// this resolution logic itself is completely unchanged and correct.
// (The R2-independent-review "duplicate short-circuit" tests that used
// to live here tested kadiV1FlowReplyRuntime.js's session-layer
// short-circuit specifically for RECHARGE/CANCEL — now moot, since
// FlowCommandRuntime rejects CANCEL unconditionally regardless of
// duplicate status; see "14 (R2)" above for what replay behavior looks
// like today.)

test("R1 (lower-level, direct): a stale sessionOpenedAt cannot cancel a recharge created after that moment", async () => {
  const f = await buildComposition({ balance: 0 });

  const staleOpenedAt = await rechargeSessionOpenedAt(f);
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, idempotencyKey: nextKey("stale-flow-select-b") });
  const sessionB = await latestSession(f);
  assert.equal(sessionB.status, "PAYMENT_PENDING");

  const result = await f.rechargeRuntime.cancel({ ownerWaId: OWNER, sessionOpenedAt: staleOpenedAt });
  assert.equal(result.ok, false, "a stale sessionOpenedAt must never cancel a recharge session created after that moment");
  assert.equal(result.error, "RECHARGE_SESSION_NOT_FOUND");

  const sessionBAfter = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionB.recharge_session_id });
  assert.equal(sessionBAfter.value.status, "PAYMENT_PENDING", "B must remain untouched by a sessionOpenedAt that predates its existence");
});

test("R1 (lower-level, direct): a genuinely current cancel (sessionOpenedAt after the active recharge exists) still succeeds normally", async () => {
  const f = await buildComposition({ balance: 0 });
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, idempotencyKey: nextKey("current-cancel-select") });
  const session = await latestSession(f);
  const openedAt = await rechargeSessionOpenedAt(f);

  const result = await f.rechargeRuntime.cancel({ ownerWaId: OWNER, sessionOpenedAt: openedAt });
  assert.equal(result.ok, true, result.error);

  const after = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: session.recharge_session_id });
  assert.equal(after.value.status, "CANCELLED", "a cancel opened after the active recharge already existed must still cancel it normally");
});

// R3 independent review (HIGH/P0): the R1 targeting query filtered status
// (IN CREATED/PAYMENT_PENDING) BEFORE ordering/limiting to the contextual
// newest session. If the contextual-newest session (the one that actually
// existed when sessionOpenedAt was captured) transitions out of that
// status set before cancel() is ever called, the status filter silently
// excludes it and the query falls through to an OLDER row that still
// matches both the status filter and the created_at bound — cancelling a
// session the caller was never actually about, even on a genuine
// first-time call.

test("R3 (lower-level, direct, Test A): a cancel whose contextual newest recharge became CREDITED before the call must never fall through to an older recharge", async () => {
  const f = await buildComposition({ balance: 0 });

  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, idempotencyKey: nextKey("falltrough-credited-select-a") });
  const sessionA = await latestSession(f);
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_2000", payment_reference: "" }, idempotencyKey: nextKey("falltrough-credited-select-b") });
  const sessionB = await latestSession(f);

  // sessionOpenedAt is captured only after both A and B exist — B is the
  // contextual newest recharge at this exact moment.
  const cancelOpenedAt = await rechargeSessionOpenedAt(f);

  // Before calling cancel(), transition B out of CREATED/PAYMENT_PENDING
  // through a real, existing chain — CHECK_PAYMENT on B.
  await send(f, { action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: sessionB.provider_payment_id }, idempotencyKey: nextKey("falltrough-credited-check-b") });
  const bAfterCredit = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionB.recharge_session_id });
  assert.equal(bAfterCredit.value.status, "CREDITED");
  const balanceAfterCredit = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balanceAfterCredit.value, PACK_2000.credits);

  const result = await f.rechargeRuntime.cancel({ ownerWaId: OWNER, sessionOpenedAt: cancelOpenedAt });
  assert.equal(result.ok, false, "cancel must fail closed — the contextual newest recharge (B) is no longer cancellable, and must never fall through to an older one");
  assert.equal(result.error, "RECHARGE_SESSION_NOT_CANCELLABLE");

  const bAfter = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionB.recharge_session_id });
  assert.equal(bAfter.value.status, "CREDITED", "B must remain exactly as the real CHECK_PAYMENT left it");
  const aAfter = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionA.recharge_session_id });
  assert.equal(aAfter.value.status, "PAYMENT_PENDING", "A must remain untouched — cancel must never fall through to it");
  const balanceAfter = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balanceAfter.value, PACK_2000.credits, "no credit change from the failed cancel attempt");
});

test("R3 (lower-level, direct, Test B): a cancel whose contextual newest recharge is already CANCELLED must never fall through to an older recharge", async () => {
  const f = await buildComposition({ balance: 0 });

  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, idempotencyKey: nextKey("falltrough-cancelled-select-a") });
  const sessionA = await latestSession(f);
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_2000", payment_reference: "" }, idempotencyKey: nextKey("falltrough-cancelled-select-b") });
  const sessionB = await latestSession(f);
  const cancelOpenedAt = await rechargeSessionOpenedAt(f);

  // B is cancelled through a separate, real cancel() call before the
  // captured sessionOpenedAt above is ever used.
  const firstCancelOpenedAt = await rechargeSessionOpenedAt(f);
  const preCancel = await f.rechargeRuntime.cancel({ ownerWaId: OWNER, sessionOpenedAt: firstCancelOpenedAt });
  assert.equal(preCancel.ok, true, preCancel.error);
  const bAfterCancel = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionB.recharge_session_id });
  assert.equal(bAfterCancel.value.status, "CANCELLED");

  const result = await f.rechargeRuntime.cancel({ ownerWaId: OWNER, sessionOpenedAt: cancelOpenedAt });
  assert.equal(result.ok, false, "cancel must fail closed — B is already terminal, must never fall through to A");
  assert.equal(result.error, "RECHARGE_SESSION_NOT_CANCELLABLE");

  const aAfter = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionA.recharge_session_id });
  assert.equal(aAfter.value.status, "PAYMENT_PENDING", "A must remain untouched");
});

test("R3 (lower-level, direct, Test C): a normal current cancel with B still active continues to cancel B only", async () => {
  const f = await buildComposition({ balance: 0 });
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, idempotencyKey: nextKey("falltrough-normal-select-a") });
  const sessionA = await latestSession(f);
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_2000", payment_reference: "" }, idempotencyKey: nextKey("falltrough-normal-select-b") });
  const sessionB = await latestSession(f);
  const cancelOpenedAt = await rechargeSessionOpenedAt(f);

  const result = await f.rechargeRuntime.cancel({ ownerWaId: OWNER, sessionOpenedAt: cancelOpenedAt });
  assert.equal(result.ok, true, result.error);

  const bAfter = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionB.recharge_session_id });
  assert.equal(bAfter.value.status, "CANCELLED", "B, the contextual newest and still-cancellable session, must be the one cancelled");
  const aAfter = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionA.recharge_session_id });
  assert.equal(aAfter.value.status, "PAYMENT_PENDING", "A must remain untouched");
});

test("10. The presenter sends nothing at all for a duplicate SELECT_PACK reply (kadiV1ProductionPresenter.js's presentFlowReply short-circuits on result.duplicate === true)", async () => {
  const f = await buildComposition();
  const sessionId = await openSession(f, { idempotencyKey: nextKey("presenter-silent-session") });
  const message = nfmReply({ sessionId, action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" } });

  const first = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(first.results[0].accepted, true, first.results[0].reason);
  assert.equal(first.results[0].duplicate, false);
  const textsAfterFirst = f.sent.texts.length;
  const flowsAfterFirst = f.sent.flows.length;
  assert.ok(textsAfterFirst > 0, "the first, real reply must send real payment instructions");

  const second = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(second.results[0].accepted, true, second.results[0].reason);
  assert.equal(second.results[0].duplicate, true);
  assert.equal(f.sent.texts.length, textsAfterFirst, "a duplicate reply must never send a second text message");
  assert.equal(f.sent.flows.length, flowsAfterFirst, "a duplicate reply must never send a second Flow");
});
