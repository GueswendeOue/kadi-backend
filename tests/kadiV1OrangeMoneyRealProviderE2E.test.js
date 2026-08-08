"use strict";

// T10/ORANGE-MONEY-TEST-001: production-composition proof that the REAL
// Orange Money payment provider (kadiV1ProductionInfrastructure.js's
// createManualOrangeMoneyPaymentProvider) works correctly end to end,
// through the real kadiV1RechargeService.js/createKadiV1RechargeRuntime,
// instead of always being substituted by a fake paymentProvider (as every
// earlier RECHARGE test file in this repo does). Only true external I/O —
// the Supabase client the real provider itself queries — is faked, as a
// minimal in-memory double of the exact two tables the real provider
// reads/writes: kadi_v1_recharge_sessions (a real, migrated V1 table) and
// kadi_topups (a legacy, pre-V1 table with no migration file in this repo
// — its schema is established here strictly from what the real provider
// code itself reads/writes, kadiPaymentsRepo.js's own usage, and
// docs/kadi_v1_legacy_data_migration_policy.md, which explicitly marks
// kadi_topups's exact remote schema as UNKNOWN_REQUIRES_RUNTIME_CHECK).
// No network, no real Supabase project, no real Orange Money API call
// anywhere in this file.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createInMemoryV1DocumentRepository } = require("../kadiV1DocumentRepository");
const { createRechargePackCatalog } = require("../kadiV1RechargeConfig");
const { createInMemoryRechargeRepository } = require("../kadiV1RechargeRepository");
const { createRechargeService } = require("../kadiV1RechargeService");
const {
  createManualOrangeMoneyPaymentProvider,
  createKadiV1RechargeRuntime,
  createKadiV1BalanceReader,
} = require("../kadiV1ProductionInfrastructure");
const { createKadiV1WalletRuntimeAdapter } = require("../kadiV1RuntimeAdapters");
const { createKadiV1FlowCommandRuntime } = require("../kadiV1FlowCommandRuntime");
const { createKadiV1FlowReplyRuntime } = require("../kadiV1FlowReplyRuntime");
const { createKadiV1ProductionPresenter } = require("../kadiV1ProductionPresenter");
const { createConversationSessionService, createMemoryConversationSessionRepository } = require("../kadiV1ConversationSession");
const { createKadiV1ProductionComposition } = require("../kadiV1ProductionComposition");

const OWNER = "22670000000";
const OTHER_OWNER = "22679999999";
const NOW = "2026-08-09T02:00:00.000Z";

const PACK_1000 = Object.freeze({ pack_id: "PACK_1000", amount: 1000, currency: "XOF", credits: 10, pricing_version: "legacy-v1", active: true });
const PACK_2000 = Object.freeze({ pack_id: "PACK_2000", amount: 2000, currency: "XOF", credits: 25, pricing_version: "legacy-v1", active: true });
const PACK_INACTIVE = Object.freeze({ pack_id: "PACK_RETIRED", amount: 9000, currency: "XOF", credits: 999, pricing_version: "legacy-v1", active: false });
// Hypothetical non-XOF pack, used only to prove the real provider's own
// XOF-only boundary fails closed — never a real, currently-configured
// pack (Kadi V1 only ever configures XOF packs; see T5 R1's LOW fix).
const PACK_USD = Object.freeze({ pack_id: "PACK_USD", amount: 5, currency: "USD", credits: 3, pricing_version: "legacy-v1", active: true });

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
function nextKey(prefix) { counter += 1; return `${prefix}:${counter}`; }

function clone(value) { return value == null ? value : structuredClone(value); }

// Advancing clock: distinct timestamps matter for kadi_topups.updated_at
// (see below — the real provider derives provider_event_id from
// reference:status:updated_at, so a stable updated_at across repeated
// reads is what makes the exactly-once dedup work; an advancing clock is
// only used when explicitly moving time forward for an approval).
function createAdvancingClock(startIso) {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.parse(startIso) + tick * 1000).toISOString();
  };
}

// The exact minimal Supabase double the REAL createManualOrangeMoneyPaymentProvider
// needs — schema traced directly from kadiV1ProductionInfrastructure.js's
// own read/write calls (see file header). kadi_v1_recharge_sessions is
// mirrored here from the real in-memory recharge repository's own
// createRechargeSession() output (never a second, independently-invented
// session shape) — see wireRechargeSessionMirror() below.
function createFakeSupabaseClient({ rechargeSessionsByReference, topups, clock }) {
  let topupSeq = 0;
  return {
    async rpc() { throw new Error("UNEXPECTED_CALL:rpc"); },
    storage: { from() { throw new Error("UNEXPECTED_CALL:storage"); } },
    from(table) {
      if (table === "kadi_v1_recharge_sessions") {
        return {
          select(columns) {
            if (columns !== "owner_wa_id,pack_snapshot") throw new Error(`UNEXPECTED_COLUMNS:${table}:${columns}`);
            return {
              eq(column, value) {
                if (column !== "merchant_reference") throw new Error(`UNEXPECTED_QUERY:${table}.${column}`);
                return {
                  async maybeSingle() {
                    const session = rechargeSessionsByReference.get(value);
                    return session
                      ? { data: { owner_wa_id: session.owner_wa_id, pack_snapshot: clone(session.pack_snapshot) }, error: null }
                      : { data: null, error: null };
                  },
                };
              },
            };
          },
        };
      }
      if (table === "kadi_topups") {
        return {
          select(columns) {
            if (columns !== "*") throw new Error(`UNEXPECTED_COLUMNS:${table}:${columns}`);
            return {
              eq(column, value) {
                if (column !== "reference") throw new Error(`UNEXPECTED_QUERY:${table}.${column}`);
                return {
                  async maybeSingle() {
                    const row = topups.get(value);
                    return row ? { data: clone(row), error: null } : { data: null, error: null };
                  },
                };
              },
            };
          },
          insert(payload) {
            return {
              select(columns) {
                if (columns !== "*") throw new Error(`UNEXPECTED_COLUMNS:${table}:${columns}`);
                return {
                  async single() {
                    topupSeq += 1;
                    const timestamp = clock();
                    const row = {
                      id: `topup:${topupSeq}`,
                      ...clone(payload),
                      created_at: timestamp,
                      updated_at: timestamp,
                      approved_at: null,
                    };
                    topups.set(row.reference, row);
                    return { data: clone(row), error: null };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`UNEXPECTED_TABLE:${table}`);
    },
  };
}

// Test-only helper simulating the manual, out-of-band Orange Money staff
// approval action — a genuine external-system boundary, never a V1 code
// path. Directly mutates the fake kadi_topups row the same way a human
// operator's legacy admin action would: status -> "approved",
// approved_at/updated_at set. approvedAt must be passed explicitly (never
// derived from a live clock reused elsewhere) so the resulting
// provider_event_id (derived from reference:status:updated_at) is stable
// across repeated reads, which is exactly what makes the real provider's
// exactly-once dedup work.
function approveTopup(topups, reference, approvedAt) {
  const row = topups.get(reference);
  assert.ok(row, `no topup found for reference ${reference}`);
  topups.set(reference, { ...row, status: "approved", approved_at: approvedAt, updated_at: approvedAt });
}

function wireRechargeSessionMirror(rechargeRepository, rechargeSessionsByReference, sessionIdsByOwner) {
  const wrapped = {};
  for (const key of Object.keys(rechargeRepository)) wrapped[key] = rechargeRepository[key];
  wrapped.createRechargeSession = async (args) => {
    const result = await rechargeRepository.createRechargeSession(args);
    if (result.ok) {
      rechargeSessionsByReference.set(result.value.merchant_reference, result.value);
      const list = sessionIdsByOwner.get(result.value.owner_wa_id) || [];
      list.push(result.value.recharge_session_id);
      sessionIdsByOwner.set(result.value.owner_wa_id, list);
    }
    return result;
  };
  return wrapped;
}

// buildComposition optionally accepts already-existing, already-persisted
// stores (rechargeRepository, its owner/reference indexes, the fake
// topups map, the session repository) instead of creating fresh ones —
// everything else (services, runtimes, presenter, composition) is always
// rebuilt from scratch. This lets a test simulate a real process restart
// faithfully: only what a real restart would actually keep (the
// database) survives.
function buildComposition({
  balances = { [OWNER]: 0, [OTHER_OWNER]: 0 },
  packs = [PACK_1000, PACK_2000],
  sharedClock = createAdvancingClock(NOW),
  sessionRepository = createMemoryConversationSessionRepository(),
  rechargeRepository: existingRechargeRepository = null,
  rechargeSessionsByReference: existingRechargeSessionsByReference = null,
  sessionIdsByOwner: existingSessionIdsByOwner = null,
  topups: existingTopups = null,
} = {}) {
  const packCatalog = createRechargePackCatalog({ packs });
  const documentRepository = createInMemoryV1DocumentRepository();

  const rechargeSessionsByReference = existingRechargeSessionsByReference || new Map();
  const sessionIdsByOwner = existingSessionIdsByOwner || new Map();
  const topups = existingTopups || new Map();

  let rechargeRepository = existingRechargeRepository;
  if (!rechargeRepository) {
    const realRechargeRepository = createInMemoryRechargeRepository({ balances: { ...balances } });
    rechargeRepository = wireRechargeSessionMirror(realRechargeRepository, rechargeSessionsByReference, sessionIdsByOwner);
  }

  // REAL Supabase double for the REAL payment provider — the exact two
  // tables it queries, nothing invented, nothing simplified away.
  const fakeSupabase = createFakeSupabaseClient({ rechargeSessionsByReference, topups, clock: sharedClock });

  // The REAL provider implementation — never substituted.
  const provider = createManualOrangeMoneyPaymentProvider({ client: fakeSupabase, clock: sharedClock });

  // T6: the same rechargeRepository instance is the single source of
  // truth for both recharge crediting (confirmPaymentAndCredit, exercised
  // below) and the canonical available-balance authority — never two
  // independent wallet stores. getAvailableBalance() is already built
  // into kadiV1RechargeRepository.js's real in-memory implementation
  // (reserved_credits defaults to 0 — no active generation reservation
  // scenario is exercised in this file).
  const balanceReader = createKadiV1BalanceReader({ rechargeRepository });
  const walletRuntime = createKadiV1WalletRuntimeAdapter({ balanceReader });

  const rechargeService = createRechargeService({
    repository: rechargeRepository,
    packCatalog,
    paymentProvider: provider,
    documentRepository,
    quoteService: { getGenerationQuote: async () => { throw new Error("UNEXPECTED_CALL:getGenerationQuote"); } },
    generationLifecycleService: { confirmGeneration: async () => { throw new Error("UNEXPECTED_CALL:confirmGeneration"); } },
    clock: sharedClock,
  });

  // A second, minimal fake Supabase client for createKadiV1RechargeRuntime's
  // own cancel() query (kadi_v1_recharge_sessions, a different query
  // shape) — never exercised in this file since RECHARGE/CANCEL is
  // unconditionally rejected before rechargeRuntime.cancel() is ever
  // called (T5 R2) — left throwing to prove it is never reached.
  const cancelClient = {
    async rpc() { throw new Error("UNEXPECTED_CALL:rpc"); },
    storage: { from() { throw new Error("UNEXPECTED_CALL:storage"); } },
    from() { throw new Error("UNEXPECTED_CALL:cancel_query_never_reached"); },
  };
  const rechargeRuntime = createKadiV1RechargeRuntime({
    rechargeService, rechargeRepository, paymentProvider: provider, client: cancelClient,
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
    walletRuntime,
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
    balanceReader, packCatalog,
  });
  const config = { enabled: true, features: { webhook: true }, rollout: { mode: "FULL", valid: true, canaryOwnerCount: 0, canaryWaIds: [] } };
  const composition = createKadiV1ProductionComposition({
    config,
    components: { orchestrator: stubPort(["handle"]), flowReplyRuntime, mediaResolver: stubPort(["resolveAudio", "resolveImage", "resolvePdf"]), presenter, deliveryRetryRuntime: stubPort(["handle"]) },
    logger: { warn() {}, log() {} },
  });
  assert.equal(composition.readiness.ready, true, JSON.stringify(composition.readiness));

  return {
    composition, sessionService, sent, rechargeRepository, rechargeSessionsByReference,
    sessionIdsByOwner, sessionRepository, topups, provider, packCatalog,
  };
}

function rebuildCompositionAroundSameRepositories(f, overrides = {}) {
  return buildComposition({
    sessionRepository: f.sessionRepository,
    rechargeRepository: f.rechargeRepository,
    rechargeSessionsByReference: f.rechargeSessionsByReference,
    sessionIdsByOwner: f.sessionIdsByOwner,
    topups: f.topups,
    ...overrides,
  });
}

function nfmReply({ sessionId, flowKey = "RECHARGE", action, data = {}, from = OWNER, id }) {
  return {
    id: id || `wamid:${flowKey}:${action}:${sessionId}:${nextKey("msg")}`, from, type: "interactive",
    interactive: { type: "nfm_reply", nfm_reply: { response_json: JSON.stringify({ session_id: sessionId, flow_key: flowKey, action, data, flow_token: sessionId }) } },
  };
}

async function openSession(f, { flowKey = "RECHARGE", ownerWaId = OWNER } = {}) {
  const opened = await f.sessionService.open({ ownerWaId, expectedFlowKey: flowKey, idempotencyKey: nextKey("session") });
  assert.equal(opened.ok, true, opened.error);
  return opened.value.session_id;
}

async function send(f, { flowKey = "RECHARGE", action, data = {}, ownerWaId = OWNER, expectAccepted = true, id } = {}) {
  const sessionId = await openSession(f, { flowKey, ownerWaId });
  const message = nfmReply({ sessionId, flowKey, action, data, from: ownerWaId, id });
  const result = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(result.handled, true);
  assert.equal(result.results[0].accepted, expectAccepted, result.results[0].reason);
  return result.results[0];
}

function lastFlowPayload(f) {
  const flow = f.sent.flows.slice(-1)[0];
  assert.ok(flow, "a Flow must have been sent");
  return flow.interactive.action.parameters;
}

function lastFlowData(f) { return lastFlowPayload(f).flow_action_payload.data; }

function lastText(f) {
  const entry = f.sent.texts.slice(-1)[0];
  assert.ok(entry, "a text must have been sent");
  return entry.text;
}

function latestSessionId(f, ownerWaId = OWNER) {
  const ids = f.sessionIdsByOwner.get(ownerWaId) || [];
  return ids[ids.length - 1];
}

async function latestSession(f, ownerWaId = OWNER) {
  const id = latestSessionId(f, ownerWaId);
  assert.ok(id, `no recharge session ever created for ${ownerWaId}`);
  const loaded = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: id });
  assert.equal(loaded.ok, true, loaded.error);
  return loaded.value;
}

async function selectPack(f, { packId = "PACK_1000", ownerWaId = OWNER, id } = {}) {
  const result = await send(f, { action: "SELECT_PACK", data: { pack_id: packId, payment_reference: "" }, ownerWaId, id });
  return { result, session: await latestSession(f, ownerWaId) };
}

// =====================================================================
// 1. SELECT_PACK with a valid active XOF pack — real provider called
// =====================================================================

test("1. SELECT_PACK with a valid active XOF pack calls the REAL Orange Money provider, creates its real topup row, and reaches PAYMENT_PENDING", async () => {
  const f = buildComposition();
  const { result, session } = await selectPack(f, { packId: "PACK_1000" });
  assert.equal(result.accepted, true, result.reason);
  assert.equal(session.status, "PAYMENT_PENDING");
  assert.equal(session.pack_snapshot.amount, PACK_1000.amount, "amount comes from the authoritative pack catalog");
  assert.equal(session.pack_snapshot.credits, PACK_1000.credits, "credits comes from the authoritative pack catalog");

  // The real provider genuinely created a kadi_topups row for this exact
  // merchant_reference.
  const topup = f.topups.get(session.merchant_reference);
  assert.ok(topup, "the real provider must have inserted a real kadi_topups row");
  assert.equal(topup.wa_id, OWNER);
  assert.equal(topup.amount_fcfa, PACK_1000.amount);
  assert.equal(topup.credits, PACK_1000.credits);
  assert.equal(topup.payment_method, "orange_money");
  assert.equal(topup.status, "pending");
  assert.equal(topup.reference, session.merchant_reference);

  // provider_payment_id (== topup.reference == merchant_reference) is
  // stable — the same value the session itself now carries.
  assert.equal(session.provider_payment_id, session.merchant_reference);
  assert.equal(session.provider, "MANUAL_ORANGE_MONEY");
});

// =====================================================================
// 2. Invalid pack — fail closed before financial mutation
// =====================================================================

test("2. SELECT_PACK with an inactive or unknown pack fails closed before any financial mutation, the real provider never called", async () => {
  const f = buildComposition({ packs: [PACK_1000, PACK_INACTIVE] });

  const inactive = await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_RETIRED", payment_reference: "" }, expectAccepted: false });
  assert.equal(inactive.reason, "RECHARGE_PACK_INACTIVE");

  const unknown = await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_DOES_NOT_EXIST", payment_reference: "" }, expectAccepted: false });
  assert.notEqual(unknown.reason, undefined);

  assert.equal(f.topups.size, 0, "the real provider must never have been reached, so no topup row exists");
  assert.equal((f.sessionIdsByOwner.get(OWNER) || []).length, 0, "no recharge session created for an invalid pack");
  const balance = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balance.value, 0);
});

// =====================================================================
// 3. Provider createPaymentRequest malformed input — direct proof
// =====================================================================

test("3. The real provider's createPaymentRequest rejects malformed input directly: bad merchant_reference, non-positive amount, non-XOF currency", async () => {
  const f = buildComposition();

  const badReference = await f.provider.createPaymentRequest({ merchant_reference: "", amount: 1000, currency: "XOF" });
  assert.equal(badReference.ok, false);
  assert.equal(badReference.error, "PAYMENT_REQUEST_INVALID");

  const zeroAmount = await f.provider.createPaymentRequest({ merchant_reference: "recharge:test-1", amount: 0, currency: "XOF" });
  assert.equal(zeroAmount.ok, false);
  assert.equal(zeroAmount.error, "PAYMENT_REQUEST_INVALID");

  const negativeAmount = await f.provider.createPaymentRequest({ merchant_reference: "recharge:test-2", amount: -500, currency: "XOF" });
  assert.equal(negativeAmount.ok, false);
  assert.equal(negativeAmount.error, "PAYMENT_REQUEST_INVALID");

  const nonIntegerAmount = await f.provider.createPaymentRequest({ merchant_reference: "recharge:test-3", amount: 10.5, currency: "XOF" });
  assert.equal(nonIntegerAmount.ok, false);
  assert.equal(nonIntegerAmount.error, "PAYMENT_REQUEST_INVALID");

  const nonXof = await f.provider.createPaymentRequest({ merchant_reference: "recharge:test-4", amount: 1000, currency: "USD" });
  assert.equal(nonXof.ok, false, "the real provider only ever supports XOF today");
  assert.equal(nonXof.error, "PAYMENT_REQUEST_INVALID");

  assert.equal(f.topups.size, 0, "no malformed request may ever create a topup row");
});

// =====================================================================
// 4. CHECK_PAYMENT while the real topup is still pending
// =====================================================================

test("4. CHECK_PAYMENT through the real provider while the topup is still pending: credited=false, wallet unchanged, recharge remains pending", async () => {
  const f = buildComposition();
  const { session } = await selectPack(f, { packId: "PACK_1000" });

  const check = await send(f, { action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: session.merchant_reference } });
  assert.equal(check.accepted, true, check.reason);
  assert.equal(lastText(f), "Le paiement n’est pas encore confirmé. Vérifiez la référence puis réessayez.");

  const after = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: session.recharge_session_id });
  assert.equal(after.value.status, "PAYMENT_PENDING", "must remain pending — no premature credit");
  const balance = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balance.value, 0, "wallet must remain unchanged");
  assert.equal(f.topups.get(session.merchant_reference).status, "pending");
});

// =====================================================================
// 5. Confirmed topup -> CHECK_PAYMENT credits exactly once
// =====================================================================

test("5. A real confirmed topup, checked through the real provider, credits the recharge exactly once with the correct amount", async () => {
  const f = buildComposition();
  const { session } = await selectPack(f, { packId: "PACK_1000" });
  approveTopup(f.topups, session.merchant_reference, "2026-08-09T02:05:00.000Z");

  const check = await send(f, { action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: session.merchant_reference } });
  assert.equal(check.accepted, true, check.reason);
  assert.equal(lastText(f), "Votre paiement est confirmé et vos crédits ont été ajoutés.");
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.MENU, "credited CHECK_PAYMENT must go to MENU, not RECHARGE");

  const after = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: session.recharge_session_id });
  assert.equal(after.value.status, "CREDITED");
  const balance = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balance.value, PACK_1000.credits, "exactly the pack's own credit amount, exactly once");
});

// =====================================================================
// 6-7. Exactly-once gate: webhook replay, payment event replay, restart
// =====================================================================

test("6. Exact CHECK_PAYMENT webhook replay causes no second wallet credit, no second ledger entry, same final balance", async () => {
  const f = buildComposition();
  const { session } = await selectPack(f, { packId: "PACK_1000" });
  approveTopup(f.topups, session.merchant_reference, "2026-08-09T02:05:00.000Z");

  const sessionId = await openSession(f);
  const message = nfmReply({ sessionId, action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: session.merchant_reference } });
  const first = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(first.results[0].accepted, true, first.results[0].reason);
  const balanceAfterFirst = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balanceAfterFirst.value, PACK_1000.credits);

  const replay = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(replay.results[0].accepted, true, replay.results[0].reason);
  assert.equal(replay.results[0].duplicate, true, "an exact webhook replay must be recognized as a duplicate at the session layer");
  const balanceAfterReplay = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balanceAfterReplay.value, PACK_1000.credits, "must remain exactly the same — no second credit");
  const ledgerEntries = f.rechargeRepository.inspect().ledger.filter((entry) => entry.owner_wa_id === OWNER);
  assert.equal(ledgerEntries.length, 1, "exactly one ledger entry for this recharge");
});

test("7. A fresh CHECK_PAYMENT submission for an already-credited recharge (same underlying provider event, different webhook message) is caught by the service's own event-fingerprint dedup — no second credit", async () => {
  const f = buildComposition();
  const { session } = await selectPack(f, { packId: "PACK_1000" });
  approveTopup(f.topups, session.merchant_reference, "2026-08-09T02:05:00.000Z");

  const first = await send(f, { action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: session.merchant_reference } });
  assert.equal(first.accepted, true, first.reason);
  const balanceAfterFirst = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balanceAfterFirst.value, PACK_1000.credits);

  // A genuinely NEW webhook message (new session, new wamid) submitting
  // CHECK_PAYMENT again for the SAME reference — the topup row is
  // unchanged (same status/updated_at), so the real provider derives the
  // exact same provider_event_id, and kadiV1RechargeRepository.js's own
  // event-fingerprint dedup (recordPaymentEvent/confirmPaymentAndCredit)
  // recognizes it without a second credit — proven independently of the
  // session-layer webhook-replay short-circuit exercised in scenario 6.
  const secondFresh = await send(f, { action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: session.merchant_reference } });
  assert.equal(secondFresh.accepted, true, secondFresh.reason);
  const balanceAfterSecond = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balanceAfterSecond.value, PACK_1000.credits, "still exactly once — the provider-event fingerprint caught the duplicate");
  const ledgerEntries = f.rechargeRepository.inspect().ledger.filter((entry) => entry.owner_wa_id === OWNER);
  assert.equal(ledgerEntries.length, 1);
});

test("Exactly-once gate: process-restart semantics survive a full runtime reconstruction around the same persisted stores", async () => {
  const f = buildComposition();
  const { session } = await selectPack(f, { packId: "PACK_1000" });
  approveTopup(f.topups, session.merchant_reference, "2026-08-09T02:05:00.000Z");

  const sessionId = await openSession(f);
  const message = nfmReply({ sessionId, action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: session.merchant_reference } });
  const first = await f.composition.webhookHandler({ messages: [message] });
  assert.equal(first.results[0].accepted, true, first.results[0].reason);
  assert.equal((await f.rechargeRepository.getBalance({ ownerWaId: OWNER })).value, PACK_1000.credits);

  // Simulate a real process restart: rebuild every in-process object
  // (services, runtimes, presenter, composition) from scratch, wired only
  // to the same underlying stores a real restart would actually keep.
  const restarted = rebuildCompositionAroundSameRepositories(f);
  const replay = await restarted.composition.webhookHandler({ messages: [message] });
  assert.equal(replay.results[0].accepted, true, replay.results[0].reason);
  assert.equal(replay.results[0].duplicate, true, "duplicate detection must survive a full runtime reconstruction");
  const balanceAfterRestart = await restarted.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balanceAfterRestart.value, PACK_1000.credits, "no second credit after restart + replay");
});

// =====================================================================
// 8-10. Wrong amount, wrong currency, unknown reference — all fail closed
// =====================================================================

test("8. A tampered topup amount fails closed at CHECK_PAYMENT time — zero credit", async () => {
  const f = buildComposition();
  const { session } = await selectPack(f, { packId: "PACK_1000" });
  const topup = f.topups.get(session.merchant_reference);
  f.topups.set(session.merchant_reference, { ...topup, amount_fcfa: 500, status: "approved", approved_at: "2026-08-09T02:05:00.000Z", updated_at: "2026-08-09T02:05:00.000Z" });

  const check = await send(f, { action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: session.merchant_reference }, expectAccepted: false });
  assert.equal(check.reason, "PAYMENT_EVENT_MISMATCH");
  const after = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: session.recharge_session_id });
  assert.equal(after.value.status, "PAYMENT_PENDING", "must remain pending, never wrongly credited");
  const balance = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balance.value, 0, "zero credit from a wrong-amount event");
});

test("9. A non-XOF pack fails closed at SELECT_PACK time itself — the real provider only ever supports XOF, so this recharge can never reach a credited state", async () => {
  const f = buildComposition({ packs: [PACK_1000, PACK_USD] });
  const result = await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_USD", payment_reference: "" }, expectAccepted: false });
  assert.equal(result.reason, "PAYMENT_REQUEST_INVALID");

  const session = await latestSession(f).catch(() => null);
  if (session) assert.notEqual(session.status, "PAYMENT_PENDING", "a non-XOF pack must never reach PAYMENT_PENDING");
  assert.equal(f.topups.size, 0, "the real provider must have rejected this before ever creating a topup");
  const balance = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balance.value, 0);
});

test("10. CHECK_PAYMENT with a reference that was never created (unknown reference) fails closed — zero credit", async () => {
  const f = buildComposition();
  const check = await send(f, { action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: "recharge:never-existed" }, expectAccepted: false });
  assert.equal(check.reason, "RECHARGE_SESSION_NOT_FOUND");
  const balance = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balance.value, 0);
});

// =====================================================================
// 11-12. Owner isolation, multiple pending recharges
// =====================================================================

test("11. Owner isolation: Owner B can never verify or receive credit for Owner A's recharge", async () => {
  const f = buildComposition();
  const { session } = await selectPack(f, { packId: "PACK_1000", ownerWaId: OWNER });
  approveTopup(f.topups, session.merchant_reference, "2026-08-09T02:05:00.000Z");

  const check = await send(f, {
    action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: session.merchant_reference },
    ownerWaId: OTHER_OWNER, expectAccepted: false,
  });
  assert.equal(check.reason, "RECHARGE_SESSION_NOT_FOUND");

  const after = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: session.recharge_session_id });
  assert.equal(after.value.status, "PAYMENT_PENDING", "A's session must remain untouched by B's attempt");
  const ownerBalance = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(ownerBalance.value, 0, "A must not be credited by B's failed attempt");
  const otherBalance = await f.rechargeRepository.getBalance({ ownerWaId: OTHER_OWNER });
  assert.equal(otherBalance.value, 0, "B must never be credited for A's recharge");
});

test("12. Multiple pending recharges for the same owner: a payment/reference for recharge A never credits recharge B", async () => {
  const f = buildComposition();
  const { session: sessionA } = await selectPack(f, { packId: "PACK_1000" });
  const { session: sessionB } = await selectPack(f, { packId: "PACK_2000" });
  assert.notEqual(sessionA.recharge_session_id, sessionB.recharge_session_id);

  approveTopup(f.topups, sessionA.merchant_reference, "2026-08-09T02:05:00.000Z");

  const check = await send(f, { action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: sessionA.merchant_reference } });
  assert.equal(check.accepted, true, check.reason);

  const aAfter = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionA.recharge_session_id });
  assert.equal(aAfter.value.status, "CREDITED");
  const bAfter = await f.rechargeRepository.getRechargeSession({ rechargeSessionId: sessionB.recharge_session_id });
  assert.equal(bAfter.value.status, "PAYMENT_PENDING", "B must remain untouched by A's confirmation");
  assert.equal(f.topups.get(sessionB.merchant_reference).status, "pending", "B's own topup must remain unapproved");

  const balance = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balance.value, PACK_1000.credits, "only A's credits, never B's");
});

// =====================================================================
// 13. T5 presentation continuity, using the REAL provider path
// =====================================================================

test("13. T5 presentation continuity through the real provider: SELECT_PACK instructions, CHECK_PAYMENT pending/credited copy, RECHARGE/CANCEL still not exposed", async () => {
  const f = buildComposition();
  const select = await send(f, { action: "SELECT_PACK", data: { pack_id: "PACK_1000", payment_reference: "" } });
  assert.equal(select.accepted, true, select.reason);
  assert.match(lastText(f), /Pack sélectionné : 1 000 FCFA pour 10 crédits\./);
  assert.match(lastText(f), /Orange Money/);
  assert.match(lastText(f), /Vérifier mon paiement/);
  const session = await latestSession(f);
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.RECHARGE, "SELECT_PACK must reopen RECHARGE, authoritative");
  assert.deepEqual(lastFlowData(f).recharge_actions.map((entry) => entry.id), ["SELECT_PACK", "CHECK_PAYMENT"], "RECHARGE/CANCEL remains not exposed (T5 R2)");

  const pending = await send(f, { action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: session.merchant_reference } });
  assert.equal(pending.accepted, true, pending.reason);
  assert.equal(lastText(f), "Le paiement n’est pas encore confirmé. Vérifiez la référence puis réessayez.");
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.RECHARGE);
  assert.deepEqual(lastFlowData(f).recharge_actions.map((entry) => entry.id), ["SELECT_PACK", "CHECK_PAYMENT"]);

  approveTopup(f.topups, session.merchant_reference, "2026-08-09T02:05:00.000Z");
  const credited = await send(f, { action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: session.merchant_reference } });
  assert.equal(credited.accepted, true, credited.reason);
  assert.equal(lastText(f), "Votre paiement est confirmé et vos crédits ont été ajoutés.");
  assert.equal(lastFlowPayload(f).flow_id, FLOW_IDS.MENU, "credited CHECK_PAYMENT keeps going to MENU, not RECHARGE");

  // RECHARGE/CANCEL remains unconditionally rejected, even through the
  // real provider path.
  const cancelSessionId = await openSession(f);
  const cancelResult = await f.composition.webhookHandler({ messages: [nfmReply({ sessionId: cancelSessionId, action: "CANCEL", data: { pack_id: "", payment_reference: "" } })] });
  assert.equal(cancelResult.results[0].accepted, false);
  assert.equal(cancelResult.results[0].reason, "KADI_V1_RECHARGE_CANCEL_NOT_EXPOSED");
});

// =====================================================================
// 14. T6 balance parity, after a real confirmed credit
// =====================================================================

test("14. T6 balance parity: after the confirmed credit, BALANCE reflects it through the canonical available-balance model", async () => {
  const f = buildComposition();
  const { session } = await selectPack(f, { packId: "PACK_2000" });
  approveTopup(f.topups, session.merchant_reference, "2026-08-09T02:05:00.000Z");
  const check = await send(f, { action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: session.merchant_reference } });
  assert.equal(check.accepted, true, check.reason);

  const menuSessionId = await openSession(f, { flowKey: "MENU" });
  const result = await f.composition.webhookHandler({ messages: [nfmReply({ sessionId: menuSessionId, flowKey: "MENU", action: "BALANCE", data: {} })] });
  assert.equal(result.results[0].accepted, true);
  assert.equal(lastText(f), `Vous avez ${PACK_2000.credits} crédits disponibles.`, "the canonical available-balance model must reflect the real credited amount");
});
