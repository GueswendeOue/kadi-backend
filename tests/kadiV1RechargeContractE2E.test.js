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
  return { composition, sessionService, sent, rechargeRepository, sessionIdsByOwner, sessionRepository, provider };
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

// 9 + 10. RECHARGE/CANCEL: real combined payload, stale nonblank values
// ignored, no credit change, no payment falsely confirmed.
test("9-10. RECHARGE/CANCEL real combined-form payload with stale nonblank pack_id/payment_reference reaches the real cancel path, ignoring both fields", async () => {
  const f = await buildComposition({ balance: 0 });
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, idempotencyKey: nextKey("cancel-select") });
  const before = await latestSession(f);
  assert.equal(before.status, "PAYMENT_PENDING");

  await send(f, {
    action: "CANCEL", data: { pack_id: "PACK_2000", payment_reference: "REF-COMPLETELY-UNRELATED" }, idempotencyKey: nextKey("cancel"),
  });

  const after = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: before.recharge_session_id });
  assert.equal(after.value.status, "CANCELLED", "the real, owner's own most recent session must be the one cancelled, never derived from pack_id/payment_reference");
  const balance = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balance.value, 0, "cancelling must never change credits");
});

// 14. Replay CANCEL, per the current session idempotency contract: an
// exact replay (same wamid) is recognized as a duplicate at the
// Flow-reply-runtime session layer, never re-executed against the
// recharge service.
// Unlike SELECT_PACK (idempotency-keyed session creation) and
// CHECK_PAYMENT (idempotency-keyed, fingerprinted credit confirmation),
// the real RECHARGE/CANCEL path (kadiV1ProductionInfrastructure.js's
// cancel()) carries no idempotency key of its own — it always re-resolves
// "the owner's current CREATED/PAYMENT_PENDING session" fresh. This is
// pre-existing behavior, unrelated to and unchanged by the field-contract
// fix in this mission (cancel() itself was not modified). A replay is
// still safe in the sense required here: the second attempt finds nothing
// left to cancel (the session is already CANCELLED) and fails closed,
// rather than double-cancelling, corrupting state, or crashing.
test("14. A replayed RECHARGE/CANCEL reply (same wamid) is recognized as a duplicate and executes zero second cancel mutation (R2 short-circuit)", async () => {
  const f = await buildComposition();
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, idempotencyKey: nextKey("replay-cancel-select") });
  const before = await latestSession(f);

  const sessionId = await openSession(f, { idempotencyKey: nextKey("replay-cancel-session") });
  const message = nfmReply({ sessionId, action: "CANCEL", data: { pack_id: "", payment_reference: "" } });

  const first = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(first.results[0].accepted, true, first.results[0].reason);
  assert.equal(first.results[0].duplicate, false);
  const afterFirst = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: before.recharge_session_id });
  assert.equal(afterFirst.value.status, "CANCELLED");

  const second = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(second.results[0].accepted, true, second.results[0].reason);
  assert.equal(second.results[0].duplicate, true, "the replay must be recognized as a duplicate — the R2 short-circuit never calls the recharge lookup/cancel a second time");
  const afterSecond = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: before.recharge_session_id });
  assert.equal(afterSecond.value.status, "CANCELLED", "state must remain exactly as the first cancel left it");
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

// --- R1 independent review: HIGH/P0 cross-session CANCEL safety ---
//
// kadiV1FlowReplyRuntime.js's handle() calls commands.execute(...)
// unconditionally, even when sessions.consumeReply() already reported
// consumed.duplicate === true — the presenter merely suppresses the
// user-visible reply afterward, but the business command still ran a
// second time. For SELECT_PACK/CHECK_PAYMENT this was masked by their own
// idempotency-key-based dedup deeper in the stack (createRechargeSession's
// findSessionByIdempotencyKey, confirmPaymentAndCredit's event
// fingerprint). RECHARGE/CANCEL had no such command-level idempotency key:
// createKadiV1RechargeRuntime's cancel({ownerWaId} = {}) used to
// destructure only ownerWaId — the idempotencyKey FlowCommandRuntime
// passed it was silently discarded — and always re-resolved "the owner's
// current newest CREATED/PAYMENT_PENDING session" fresh from storage. A
// delayed exact replay of an already-consumed CANCEL message, or a
// first-time submission of an old still-valid RECHARGE Flow, could
// therefore cancel a completely different, newer recharge session than
// the one that Flow context was ever about.
//
// Fix: sessionOpenedAt (the trusted server-side moment the exact Flow
// session was opened, set only by kadiV1FlowReplyRuntime.js from the
// session record, never client-supplied) now bounds which recharge
// session cancel() may ever target — only one created at or before that
// moment. No new Supabase column: kadi_v1_conversation_sessions.opened_at
// and kadi_v1_recharge_sessions.created_at both already exist.

test("R1 HIGH/P0: a delayed exact replay of an already-consumed CANCEL message never affects a newer, unrelated recharge session", async () => {
  const f = await buildComposition({ balance: 0 });

  // 1. SELECT_PACK creates recharge A.
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, idempotencyKey: nextKey("cross-session-replay-select-a") });
  const sessionA = await latestSession(f);
  assert.equal(sessionA.status, "PAYMENT_PENDING");

  // 2. CANCEL message C cancels A successfully — same session/message
  // reused verbatim in step 4 below.
  const cancelSessionId = await openSession(f, { idempotencyKey: nextKey("cross-session-replay-cancel-session") });
  const cancelMessage = nfmReply({ sessionId: cancelSessionId, action: "CANCEL", data: { pack_id: "", payment_reference: "" } });
  const first = await f.composition.webhookHandler({ messages: [cancelMessage] });
  assert.equal(first.results[0].accepted, true, first.results[0].reason);
  assert.equal(first.results[0].duplicate, false);
  const afterFirstCancel = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionA.recharge_session_id });
  assert.equal(afterFirstCancel.value.status, "CANCELLED");

  // 3. Create a NEW recharge B for the same owner, created strictly after
  // the CANCEL session (step 2) was opened — now the owner's newest
  // active (CREATED/PAYMENT_PENDING) session.
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_2000", payment_reference: "" }, idempotencyKey: nextKey("cross-session-replay-select-b") });
  const sessionB = await latestSession(f);
  assert.notEqual(sessionB.recharge_session_id, sessionA.recharge_session_id);
  assert.equal(sessionB.status, "PAYMENT_PENDING");

  // 4. Replay the EXACT original CANCEL message C — same wamid, same Flow
  // session, same consumed reply idempotency key. The R2 short-circuit
  // recognizes this as a duplicate before the recharge lookup ever runs
  // again, so B is never even queried, let alone touched.
  const replay = await f.composition.webhookHandler({ messages: [cancelMessage] });
  assert.equal(replay.results[0].accepted, true, replay.results[0].reason);
  assert.equal(replay.results[0].duplicate, true, "the replay must be recognized as a duplicate");

  const sessionBAfterReplay = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionB.recharge_session_id });
  assert.equal(sessionBAfterReplay.value.status, "PAYMENT_PENDING", "B must remain exactly as it was — a replay of a message that was only ever about A must never touch B");
  const balanceAfter = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balanceAfter.value, 0, "no credit change from any of this");
});

test("R1 HIGH/P0: a stale, never-yet-submitted RECHARGE Flow cannot cancel a recharge created after that Flow was opened", async () => {
  const f = await buildComposition({ balance: 0 });

  // 1. A RECHARGE Flow/session is opened (not yet submitted).
  const staleSessionId = await openSession(f, { idempotencyKey: nextKey("stale-flow-session") });

  // 2. Time/user actions cause a later recharge B to become the newest
  // active session — the owner selects a pack through a completely
  // separate, later Flow round-trip, created strictly after the stale
  // session above was opened.
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, idempotencyKey: nextKey("stale-flow-select-b") });
  const sessionB = await latestSession(f);
  assert.equal(sessionB.status, "PAYMENT_PENDING");

  // 3. The older still-valid RECHARGE Flow is submitted for the first time
  // with action=CANCEL — this is a genuinely first-time submission of the
  // stale session, not a replay of anything.
  const staleMessage = nfmReply({ sessionId: staleSessionId, action: "CANCEL", data: { pack_id: "", payment_reference: "" } });
  const result = await f.composition.webhookHandler({ messages: [staleMessage] });
  assert.notEqual(result.results[0].duplicate, true, "this is a first-time submission of the stale session, not a replay");
  assert.equal(result.results[0].accepted, false, "the stale Flow must fail closed — B did not exist when this Flow session was opened, so it is never an eligible cancel target");
  assert.equal(result.results[0].reason, "RECHARGE_SESSION_NOT_FOUND");

  const sessionBAfter = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionB.recharge_session_id });
  assert.equal(sessionBAfter.value.status, "PAYMENT_PENDING", "B must remain untouched by a Flow context that predates its existence");
});

test("R1: a genuinely current CANCEL (opened after the active recharge exists) still succeeds normally — the binding never blocks a real cancellation", async () => {
  const f = await buildComposition({ balance: 0 });
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, idempotencyKey: nextKey("current-cancel-select") });
  const session = await latestSession(f);

  await send(f, { action: "CANCEL", data: { pack_id: "", payment_reference: "" }, idempotencyKey: nextKey("current-cancel-session") });

  const after = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: session.recharge_session_id });
  assert.equal(after.value.status, "CANCELLED", "a CANCEL Flow opened after the active recharge already existed must still cancel it normally");
});

// R2 independent review (HIGH/P0): sessionOpenedAt (R1) alone does not
// make RECHARGE/CANCEL idempotent when MULTIPLE eligible active recharge
// sessions already existed before the cancel Flow was opened. Without a
// duplicate short-circuit, a replay would re-resolve "the newest
// remaining eligible session <= sessionOpenedAt" — since the first cancel
// already removed the true target from that set, the replay would find
// and cancel a second, different, older session instead. Fixed by a
// RECHARGE/CANCEL-scoped short-circuit in kadiV1FlowReplyRuntime.js's
// handle(): when the session layer's own persisted, authoritative
// duplicate signal (CONSUMED status + matching consumed_reply_key — never
// an in-process flag, safe across a process restart) reports
// consumed.duplicate === true for this exact (RECHARGE, CANCEL) pair,
// commands.execute() is never called at all.

// Test A (mandatory): two active sessions predating the Flow + exact
// replay — zero second cancel mutation.
test("R2 HIGH/P0 (Test A): an exact CANCEL replay, with two active sessions predating the Flow, executes zero second cancel mutation", async () => {
  const f = await buildComposition({ balance: 0 });

  // 1 + 2. Two independent SELECT_PACK calls create A and B for the same
  // owner — createRechargeSession only dedupes by idempotency key, it
  // does not enforce one active recharge per owner.
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, idempotencyKey: nextKey("multi-active-select-a") });
  const sessionA = await latestSession(f);
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_2000", payment_reference: "" }, idempotencyKey: nextKey("multi-active-select-b") });
  const sessionB = await latestSession(f);
  assert.notEqual(sessionA.recharge_session_id, sessionB.recharge_session_id);

  // 3. Confirm both are active before the cancel Flow is even opened.
  assert.equal((await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionA.recharge_session_id })).value.status, "PAYMENT_PENDING");
  assert.equal((await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionB.recharge_session_id })).value.status, "PAYMENT_PENDING");

  // 4 + 5. Open RECHARGE Flow/session C only after both A and B exist,
  // then submit CANCEL message X from C.
  const cancelSessionId = await openSession(f, { idempotencyKey: nextKey("multi-active-cancel-session") });
  const cancelMessage = nfmReply({ sessionId: cancelSessionId, action: "CANCEL", data: { pack_id: "", payment_reference: "" } });
  const first = await f.composition.webhookHandler({ messages: [cancelMessage] });
  assert.equal(first.results[0].accepted, true, first.results[0].reason);
  assert.equal(first.results[0].duplicate, false);

  const bAfterFirst = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionB.recharge_session_id });
  assert.equal(bAfterFirst.value.status, "CANCELLED", "the first CANCEL must cancel B, the newest eligible session");
  const aAfterFirst = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionA.recharge_session_id });
  assert.equal(aAfterFirst.value.status, "PAYMENT_PENDING", "A must remain untouched by the first CANCEL");

  // 6. Replay the EXACT same CANCEL message X — must execute zero second
  // cancel mutation: the session layer recognizes the duplicate and the
  // short-circuit prevents commands.execute() (and therefore
  // cancelRechargeSession) from ever running a second time.
  const replay = await f.composition.webhookHandler({ messages: [cancelMessage] });
  assert.equal(replay.results[0].accepted, true, replay.results[0].reason);
  assert.equal(replay.results[0].duplicate, true, "the replay must still be recognized as a duplicate");

  const aAfterReplay = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionA.recharge_session_id });
  assert.equal(aAfterReplay.value.status, "PAYMENT_PENDING", "A must remain untouched — the replay must never cancel a second, different session");
  const bAfterReplay = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionB.recharge_session_id });
  assert.equal(bAfterReplay.value.status, "CANCELLED", "B must remain exactly as the first cancel left it");
});

// Test B (mandatory): the duplicate protection must derive from the
// persisted conversation-session state, not an in-process flag — proven
// by tearing down and reconstructing the entire FlowReplyRuntime/
// FlowCommandRuntime/recharge-runtime stack around the SAME underlying
// session repository (and the same recharge repository) between the first
// CANCEL and the replay, simulating a process restart. No new schema: the
// conversation session repository already persists status/
// consumed_reply_key exactly as before.
test("R2 HIGH/P0 (Test B): the exact-replay protection survives a full runtime reconstruction (process-restart semantics), because it derives from persisted session state", async () => {
  const f = await buildComposition({ balance: 0 });

  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, idempotencyKey: nextKey("restart-select-a") });
  const sessionA = await latestSession(f);
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_2000", payment_reference: "" }, idempotencyKey: nextKey("restart-select-b") });
  const sessionB = await latestSession(f);

  const cancelSessionId = await openSession(f, { idempotencyKey: nextKey("restart-cancel-session") });
  const cancelMessage = nfmReply({ sessionId: cancelSessionId, action: "CANCEL", data: { pack_id: "", payment_reference: "" } });
  const first = await f.composition.webhookHandler({ messages: [cancelMessage] });
  assert.equal(first.results[0].accepted, true, first.results[0].reason);
  assert.equal((await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionB.recharge_session_id })).value.status, "CANCELLED");

  // Simulate a process restart: build a completely new
  // FlowReplyRuntime/FlowCommandRuntime/recharge-runtime/presenter stack
  // from scratch, wired to the SAME underlying session and recharge
  // repositories (the only state that genuinely survives a real restart —
  // no in-memory runtime object is reused).
  const restarted = await rebuildCompositionAroundSameRepositories(f);

  const replay = await restarted.composition.webhookHandler({ messages: [cancelMessage] });
  assert.equal(replay.results[0].accepted, true, replay.results[0].reason);
  assert.equal(replay.results[0].duplicate, true, "the duplicate must still be recognized after a full runtime reconstruction");

  const aAfterReplay = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionA.recharge_session_id });
  assert.equal(aAfterReplay.value.status, "PAYMENT_PENDING", "A must remain untouched even after the entire runtime was rebuilt from persisted state");
});

// R3 independent review (HIGH/P0): the R1 targeting query filtered status
// (IN CREATED/PAYMENT_PENDING) BEFORE ordering/limiting to the contextual
// newest session. If the contextual-newest session (the one that actually
// existed when the Flow was opened) transitions out of that status set
// before CANCEL is ever submitted, the status filter silently excludes it
// and the query falls through to an OLDER row that still matches both the
// status filter and the created_at bound — cancelling a session the Flow
// context was never actually about, even on a genuine first-time (not a
// replay) submission.

// Test A (mandatory): contextual newest session B transitions to CREDITED
// via a real CHECK_PAYMENT before CANCEL is submitted for the first time.
test("R3 HIGH/P0 (Test A): a CANCEL Flow whose contextual newest recharge became CREDITED before submission must never fall through and cancel an older recharge", async () => {
  const f = await buildComposition({ balance: 0 });

  // 1. SELECT_PACK creates recharge A.
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, idempotencyKey: nextKey("falltrough-credited-select-a") });
  const sessionA = await latestSession(f);

  // 2. Another SELECT_PACK creates recharge B, newer than A.
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_2000", payment_reference: "" }, idempotencyKey: nextKey("falltrough-credited-select-b") });
  const sessionB = await latestSession(f);

  // 3. Open RECHARGE Flow/session C only after both A and B exist — B is
  // the contextual newest recharge at this exact moment.
  const cancelSessionId = await openSession(f, { idempotencyKey: nextKey("falltrough-credited-cancel-session") });

  // 4. Before submitting C/CANCEL, transition B out of CREATED/
  // PAYMENT_PENDING through a real, existing chain — CHECK_PAYMENT on B.
  await send(f, { action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: sessionB.provider_payment_id }, idempotencyKey: nextKey("falltrough-credited-check-b") });
  const bAfterCredit = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionB.recharge_session_id });
  assert.equal(bAfterCredit.value.status, "CREDITED");
  const balanceAfterCredit = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balanceAfterCredit.value, PACK_2000.credits);

  // 5. Submit C for the FIRST TIME with action=CANCEL — not a duplicate.
  const cancelMessage = nfmReply({ sessionId: cancelSessionId, action: "CANCEL", data: { pack_id: "", payment_reference: "" } });
  const result = await f.composition.webhookHandler({ messages: [cancelMessage] });
  assert.notEqual(result.results[0].duplicate, true, "this is a first-time submission, not a replay");
  assert.equal(result.results[0].accepted, false, "CANCEL must fail closed — the contextual newest recharge (B) is no longer cancellable, and must never fall through to an older one");
  assert.equal(result.results[0].reason, "RECHARGE_SESSION_NOT_CANCELLABLE");

  const bAfter = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionB.recharge_session_id });
  assert.equal(bAfter.value.status, "CREDITED", "B must remain exactly as the real CHECK_PAYMENT left it");
  const aAfter = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionA.recharge_session_id });
  assert.equal(aAfter.value.status, "PAYMENT_PENDING", "A must remain untouched — CANCEL must never fall through to it");
  const balanceAfter = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balanceAfter.value, PACK_2000.credits, "no credit change from the failed CANCEL attempt");
});

// Test B (mandatory): terminal/CANCELLED variant — contextual B already
// CANCELLED (e.g. by an earlier, unrelated CANCEL) before the stale Flow
// C is submitted for the first time.
test("R3 HIGH/P0 (Test B): a CANCEL Flow whose contextual newest recharge is already CANCELLED must never fall through and cancel an older recharge", async () => {
  const f = await buildComposition({ balance: 0 });

  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, idempotencyKey: nextKey("falltrough-cancelled-select-a") });
  const sessionA = await latestSession(f);
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_2000", payment_reference: "" }, idempotencyKey: nextKey("falltrough-cancelled-select-b") });
  const sessionB = await latestSession(f);

  const cancelSessionId = await openSession(f, { idempotencyKey: nextKey("falltrough-cancelled-cancel-session") });

  // B is cancelled through a separate, real CANCEL round-trip before the
  // stale session C above is ever submitted.
  await send(f, { action: "CANCEL", data: { pack_id: "", payment_reference: "" }, idempotencyKey: nextKey("falltrough-cancelled-cancel-b") });
  const bAfterCancel = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionB.recharge_session_id });
  assert.equal(bAfterCancel.value.status, "CANCELLED");

  const staleMessage = nfmReply({ sessionId: cancelSessionId, action: "CANCEL", data: { pack_id: "", payment_reference: "" } });
  const result = await f.composition.webhookHandler({ messages: [staleMessage] });
  assert.notEqual(result.results[0].duplicate, true);
  assert.equal(result.results[0].accepted, false, "CANCEL must fail closed — B is already terminal, must never fall through to A");
  assert.equal(result.results[0].reason, "RECHARGE_SESSION_NOT_CANCELLABLE");

  const aAfter = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionA.recharge_session_id });
  assert.equal(aAfter.value.status, "PAYMENT_PENDING", "A must remain untouched");
});

// Test C (mandatory): normal current cancel — B still active, must still
// be the one cancelled (no regression from the R3 targeting change).
test("R3 (Test C): a normal current CANCEL with B still active continues to cancel B only", async () => {
  const f = await buildComposition({ balance: 0 });
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" }, idempotencyKey: nextKey("falltrough-normal-select-a") });
  const sessionA = await latestSession(f);
  await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_2000", payment_reference: "" }, idempotencyKey: nextKey("falltrough-normal-select-b") });
  const sessionB = await latestSession(f);

  await send(f, { action: "CANCEL", data: { pack_id: "", payment_reference: "" }, idempotencyKey: nextKey("falltrough-normal-cancel") });

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
