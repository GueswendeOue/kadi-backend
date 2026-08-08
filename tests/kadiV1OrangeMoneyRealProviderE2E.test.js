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
// kadi_topups (a legacy, pre-V1 table with no migration file in this repo).
//
// R1 (independent review, ORANGE_TOPUP_REFERENCE_CONCURRENCY_001): an
// authorized read-only runtime inspection of the real Supabase project
// confirmed kadi_topups's column contract (id, wa_id, reference,
// amount_fcfa, credits, includes_stamp, status, proof_text,
// proof_image_url, payment_method, created_at, updated_at, approved_at,
// rejection_reason — RLS enabled), superseding the prior
// UNKNOWN_REQUIRES_RUNTIME_CHECK characterization for column existence.
// The inspection also found `reference` has NO unique constraint — only
// the primary key on `id` is unique — and exactly one pre-existing
// duplicated-reference group (2 rows, both legacy/non-V1, both pending;
// the actual reference value is never recorded here or anywhere in this
// repository). See
// migrations/20260809_add_kadi_v1_topups_recharge_reference_unique.sql
// for the forward-only fix (not applied to any real database by this
// mission) and docs/KADI_ENGINEERING_MEMORY.md for the full record.
//
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

// R1 (independent review, ORANGE_TOPUP_REFERENCE_CONCURRENCY_001): an
// authorized read-only runtime inspection of the real Supabase project
// confirmed public.kadi_topups has NO unique constraint on `reference` —
// only the primary key on `id` is unique. topups is therefore modeled
// here as a real row collection keyed by id (never Map<reference, row>,
// which structurally permits only one row per reference and would mask
// exactly this defect), so multiple rows CAN share a reference, exactly
// like the real table. maybeSingle() mirrors real PostgREST semantics:
// 0 matching rows -> {data:null,error:null}; exactly 1 -> {data:row,
// error:null}; more than 1 -> an error (never returning an arbitrary row).
//
// enforceV1UniqueReference simulates the new partial unique index this
// R1 mission adds (migrations/20260809_add_kadi_v1_topups_recharge_reference_unique.sql,
// NOT applied to any real database by this mission) — scoped only to the
// `recharge:` reference namespace, exactly matching the real predicate.
// onTopupReferenceRead is an optional hook (defaults to a no-op) letting
// a test synchronize concurrent reads at the exact point a real
// concurrent request would race, without ever using a sleep.
function createFakeSupabaseClient({
  rechargeSessionsByReference,
  topups,
  clock,
  enforceV1UniqueReference = false,
  onTopupReferenceRead = async () => {},
}) {
  let topupSeq = 0;
  function rowsForReference(reference) {
    return [...topups.values()].filter((row) => row.reference === reference);
  }
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
                    await onTopupReferenceRead(value);
                    const rows = rowsForReference(value);
                    if (rows.length === 0) return { data: null, error: null };
                    if (rows.length === 1) return { data: clone(rows[0]), error: null };
                    // Real PostgREST/postgrest-js .maybeSingle() errors
                    // when a query unexpectedly matches more than one row
                    // — it never picks one arbitrarily.
                    return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
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
                  // Deliberately synchronous body (no internal await)
                  // before the state mutation: JS run-to-completion
                  // semantics make the conflict-check-then-insert below
                  // atomic with respect to any other pending microtask —
                  // exactly the atomicity a single real Postgres INSERT
                  // statement (and its unique index check) provides.
                  async single() {
                    if (enforceV1UniqueReference && payload.reference.startsWith("recharge:") && rowsForReference(payload.reference).length > 0) {
                      return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "kadi_topups_v1_recharge_reference_unique"` } };
                    }
                    topupSeq += 1;
                    const timestamp = clock();
                    const row = {
                      id: `topup:${topupSeq}`,
                      ...clone(payload),
                      created_at: timestamp,
                      updated_at: timestamp,
                      approved_at: null,
                    };
                    topups.set(row.id, row);
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
// exactly-once dedup work. Requires the reference to currently resolve to
// exactly one row (matching what a real approval action would act on).
function approveTopup(topups, reference, approvedAt) {
  const matches = [...topups.entries()].filter(([, row]) => row.reference === reference);
  assert.equal(matches.length, 1, `expected exactly one topup for reference ${reference}, found ${matches.length}`);
  const [id, row] = matches[0];
  topups.set(id, { ...row, status: "approved", approved_at: approvedAt, updated_at: approvedAt });
}

// Test-only helper mirroring the fake client's own rowsForReference: the
// row collection is keyed by `id` (matching the real table, where
// `reference` is not unique), so test bodies asserting on "the" topup for
// a given reference must go through this instead of topups.get(reference).
// Requires the reference to currently resolve to exactly one row.
function findTopupByReference(topups, reference) {
  const matches = [...topups.values()].filter((row) => row.reference === reference);
  assert.equal(matches.length, 1, `expected exactly one topup for reference ${reference}, found ${matches.length}`);
  return matches[0];
}

// Test-only helper for seeding a raw topup row directly (legacy rows,
// incompatible pre-existing rows) — bypasses the real provider entirely,
// simulating data that already existed in the real table before this
// call, exactly like a real concurrent/legacy row would.
function seedTopup(topups, overrides) {
  const id = overrides.id || `topup:seed:${nextKey("seed")}`;
  const row = {
    id, wa_id: "00000000000", reference: "legacy:unset", amount_fcfa: 1, credits: 1,
    payment_method: "orange_money", includes_stamp: false, status: "pending",
    proof_text: null, proof_image_url: null, rejection_reason: null,
    created_at: NOW, updated_at: NOW, approved_at: null,
    ...overrides,
  };
  topups.set(id, row);
  return row;
}

// Deterministic rendezvous barrier for exactly `parties` concurrent
// callers — no sleeps. Each caller calls arrive() and suspends until
// every party has arrived, at which point all are released together, in
// the order they arrived (JS's microtask FIFO on the same resolved
// promise), simulating two real concurrent requests both observing "no
// existing row" before either write commits.
function createRendezvousBarrier(parties) {
  let arrived = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    async arrive() {
      arrived += 1;
      if (arrived >= parties) release();
      await gate;
    },
  };
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
  // R1: enforceV1UniqueReference simulates the new partial unique index
  // (NOT applied to any real database by this mission — see the
  // migration file). Defaults to true so every test proves the FIXED,
  // post-migration behavior by default; the dedicated pre-fix
  // reproduction test explicitly passes false to exercise the real,
  // currently-deployed schema (no unique constraint at all).
  enforceV1UniqueReference = true,
  onTopupReferenceRead = undefined,
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
  const fakeSupabase = createFakeSupabaseClient({
    rechargeSessionsByReference, topups, clock: sharedClock, enforceV1UniqueReference,
    ...(onTopupReferenceRead ? { onTopupReferenceRead } : {}),
  });

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
    generationLifecycleService: {
      confirmGeneration: async () => { throw new Error("UNEXPECTED_CALL:confirmGeneration"); },
      getGenerationStatus: async () => { throw new Error("UNEXPECTED_CALL:getGenerationStatus"); },
    },
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
  const topup = findTopupByReference(f.topups, session.merchant_reference);
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
  assert.equal(findTopupByReference(f.topups, session.merchant_reference).status, "pending");
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

// R1 wording-accuracy note (independent review): this test rebuilds every
// in-process runtime/service object around the SAME persisted-store
// objects (rechargeRepository, topups, session maps) — it proves the
// service-layer event-fingerprint dedup survives a full in-process object
// reconstruction, i.e. that no in-memory cache or closure state is the
// thing preventing a double credit. It does NOT exercise, and must never
// be cited as proving, the real Supabase-backed recharge repository's
// cross-process atomicity under genuine concurrent Postgres connections —
// that guarantee is instead provided in production by
// kadi_v1_confirm_recharge_credit()'s own pg_advisory_xact_lock +
// `for update` row lock (migrations/20260802_add_kadi_v1_recharge.sql),
// whose grants/privileges are checked in
// tests/kadiV1MigrationPrivileges.test.js. No test in this repository runs
// against a live Postgres connection, so that RPC's live concurrent
// behavior itself remains unverified here — a live-DB verification, not an
// in-process one, would be required to close that gap.
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
  const topup = findTopupByReference(f.topups, session.merchant_reference);
  f.topups.set(topup.id, { ...topup, amount_fcfa: 500, status: "approved", approved_at: "2026-08-09T02:05:00.000Z", updated_at: "2026-08-09T02:05:00.000Z" });

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
  assert.equal(findTopupByReference(f.topups, sessionB.merchant_reference).status, "pending", "B's own topup must remain unapproved");

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

// =====================================================================
// R1 (ORANGE_TOPUP_REFERENCE_CONCURRENCY_001): concurrency-safety of the
// real provider's createPaymentRequest() against public.kadi_topups — a
// legacy table with NO unique constraint on `reference` (confirmed via an
// authorized read-only runtime inspection of the real Supabase project;
// only the primary key on `id` is unique). Kadi V1 owns the `recharge:`
// reference namespace exclusively — see kadiV1RechargeService.js's
// createRechargeSession(), which always derives merchant_reference as
// sessionId = makeId("recharge", ...), the only such call site in that
// file, with idFactory never overridden in production
// (kadiV1ProductionBootstrap.js). This namespace exclusivity is exactly
// what migrations/20260809_add_kadi_v1_topups_recharge_reference_unique.sql
// (NOT applied to any real database by this mission) protects, and what
// these tests below assume when seeding `recharge:`-prefixed references.
// =====================================================================

// Directly seeds a kadi_v1_recharge_sessions row by merchant_reference —
// bypassing the full RECHARGE Flow/session machinery — so these tests can
// call the real provider's createPaymentRequest()/getPaymentStatus()
// directly, exactly as kadiV1RechargeService.js itself does, without the
// unrelated session-layer plumbing every other test in this file exists to
// exercise.
function seedRechargeSessionByReference(f, reference, { ownerWaId = OWNER, packSnapshot } = {}) {
  f.rechargeSessionsByReference.set(reference, {
    owner_wa_id: ownerWaId,
    merchant_reference: reference,
    pack_snapshot: packSnapshot,
  });
}

function countTopupsForReference(topups, reference) {
  return [...topups.values()].filter((row) => row.reference === reference).length;
}

test("R1-A. Pre-fix reproduction: without the partial unique index, two concurrent createPaymentRequest calls for the same V1 reference both insert, producing two physical rows, after which getPaymentStatus can no longer resolve a unique topup", async () => {
  const barrier = createRendezvousBarrier(2);
  const f = buildComposition({ enforceV1UniqueReference: false, onTopupReferenceRead: () => barrier.arrive() });
  const reference = "recharge:concurrency-pre-fix-1";
  seedRechargeSessionByReference(f, reference, { packSnapshot: { credits: PACK_1000.credits } });
  const request = { merchant_reference: reference, amount: PACK_1000.amount, currency: "XOF" };

  const [a, b] = await Promise.all([
    f.provider.createPaymentRequest(request),
    f.provider.createPaymentRequest(request),
  ]);

  assert.equal(a.ok, true, a.error);
  assert.equal(b.ok, true, b.error);
  assert.equal(countTopupsForReference(f.topups, reference), 2, "pre-fix: both concurrent inserts succeed, producing two rows sharing one reference — the real, currently-deployed schema defect");

  const status = await f.provider.getPaymentStatus({ merchantReference: reference });
  assert.equal(status.ok, false, "a reference with two matching rows can no longer resolve to a unique topup — maybeSingle() fails rather than picking one arbitrarily");
  assert.equal(status.error, "PAYMENT_STATUS_NOT_FOUND");
});

test("R1-B. Post-fix: with the V1 partial unique index enforced, two concurrent createPaymentRequest calls for the same reference create exactly one physical row and converge on the same payment identity — the loser recovers via 23505", async () => {
  const barrier = createRendezvousBarrier(2);
  const f = buildComposition({ enforceV1UniqueReference: true, onTopupReferenceRead: () => barrier.arrive() });
  const reference = "recharge:concurrency-post-fix-1";
  seedRechargeSessionByReference(f, reference, { packSnapshot: { credits: PACK_1000.credits } });
  const request = { merchant_reference: reference, amount: PACK_1000.amount, currency: "XOF" };

  const [a, b] = await Promise.all([
    f.provider.createPaymentRequest(request),
    f.provider.createPaymentRequest(request),
  ]);

  assert.equal(a.ok, true, a.error);
  assert.equal(b.ok, true, b.error);
  assert.equal(countTopupsForReference(f.topups, reference), 1, "exactly one physical V1 topup row must exist after the race");
  assert.equal(a.value.provider_payment_id, b.value.provider_payment_id, "both concurrent calls must converge on the SAME payment identity");
  assert.equal(a.value.provider_payment_id, reference);
  assert.equal(a.value.amount, PACK_1000.amount);
  assert.equal(b.value.amount, PACK_1000.amount);

  // CHECK_PAYMENT still works after the race: exactly one row, unambiguous.
  const status = await f.provider.getPaymentStatus({ merchantReference: reference });
  assert.equal(status.ok, true, status.error);
  assert.equal(status.value.status, "PENDING");

  approveTopup(f.topups, reference, "2026-08-09T02:05:00.000Z");
  seedRechargeSessionByReference(f, reference, { packSnapshot: { credits: PACK_1000.credits } });
  const confirmed = await f.provider.getPaymentStatus({ merchantReference: reference });
  assert.equal(confirmed.ok, true, confirmed.error);
  assert.equal(confirmed.value.status, "CONFIRMED");
});

test("R1-C. Concurrent race, confirmed through the real recharge session flow, credits the wallet exactly once with exactly one ledger entry", async () => {
  // The barrier must not gate selectPack's own, non-concurrent
  // createPaymentRequest() call — a 2-party barrier fed by a single
  // sequential call would hang forever waiting for a second arrival that
  // never comes. Route the hook through a reassignable holder so it stays
  // a no-op during selectPack, and only starts gating once the deliberate
  // race below begins.
  const hook = { current: async () => {} };
  const f = buildComposition({ onTopupReferenceRead: (value) => hook.current(value) });
  const { session } = await selectPack(f, { packId: "PACK_1000" });

  // Simulate a genuinely concurrent RETRY for the same reference (e.g. a
  // duplicated SELECT_PACK webhook arriving while the first request is
  // still in flight): two more concurrent createPaymentRequest() calls
  // must still converge on the one existing row rather than racing a
  // second insert.
  const barrier = createRendezvousBarrier(2);
  hook.current = () => barrier.arrive();
  const request = { merchant_reference: session.merchant_reference, amount: PACK_1000.amount, currency: "XOF" };
  const [a, b] = await Promise.all([
    f.provider.createPaymentRequest(request),
    f.provider.createPaymentRequest(request),
  ]);
  assert.equal(a.ok, true, a.error);
  assert.equal(b.ok, true, b.error);
  assert.equal(countTopupsForReference(f.topups, session.merchant_reference), 1);

  approveTopup(f.topups, session.merchant_reference, "2026-08-09T02:05:00.000Z");
  const check = await send(f, { action: "CHECK_PAYMENT", data: { pack_id: "", payment_reference: session.merchant_reference } });
  assert.equal(check.accepted, true, check.reason);

  const balance = await f.rechargeRepository.getBalance({ ownerWaId: OWNER });
  assert.equal(balance.value, PACK_1000.credits, "exactly one wallet credit, despite the earlier concurrent createPaymentRequest race");
  const ledgerEntries = f.rechargeRepository.inspect().ledger.filter((entry) => entry.owner_wa_id === OWNER);
  assert.equal(ledgerEntries.length, 1, "exactly one recharge ledger entry");
});

test("R1-D. Sequential idempotence: calling createPaymentRequest again for the same reference returns the same payment identity with only one topup row", async () => {
  const f = buildComposition();
  const reference = "recharge:sequential-idempotence-1";
  seedRechargeSessionByReference(f, reference, { packSnapshot: { credits: PACK_1000.credits } });
  const request = { merchant_reference: reference, amount: PACK_1000.amount, currency: "XOF" };

  const first = await f.provider.createPaymentRequest(request);
  const second = await f.provider.createPaymentRequest(request);

  assert.equal(first.ok, true, first.error);
  assert.equal(second.ok, true, second.error);
  assert.equal(first.value.provider_payment_id, second.value.provider_payment_id);
  assert.equal(countTopupsForReference(f.topups, reference), 1);
});

test("R1-E. Legacy duplicate non-regression: two pre-existing legacy rows sharing a non-recharge reference are never rejected, merged or altered by the V1 partial-unique enforcement", async () => {
  const f = buildComposition();
  const legacyReference = "legacy:pre-existing-duplicate-group";
  const rowOne = seedTopup(f.topups, { reference: legacyReference, wa_id: "22600000001", amount_fcfa: 500, credits: 5, status: "pending" });
  const rowTwo = seedTopup(f.topups, { reference: legacyReference, wa_id: "22600000002", amount_fcfa: 750, credits: 7, status: "pending" });

  assert.equal(countTopupsForReference(f.topups, legacyReference), 2, "both legacy rows must remain present, untouched");
  assert.deepEqual(f.topups.get(rowOne.id), rowOne);
  assert.deepEqual(f.topups.get(rowTwo.id), rowTwo);

  // A real V1 code path never queries a legacy (non-`recharge:`)
  // reference, but the fake DB must still behave exactly like the real
  // table would: an ambiguous (>1 row) reference fails closed via
  // maybeSingle() — never picking one arbitrarily, never merging, never
  // deleting either row.
  const status = await f.provider.getPaymentStatus({ merchantReference: legacyReference });
  assert.equal(status.ok, false);
  assert.equal(status.error, "PAYMENT_STATUS_NOT_FOUND");
  assert.equal(countTopupsForReference(f.topups, legacyReference), 2, "querying an ambiguous legacy reference must never delete, merge or alter either row");
  assert.deepEqual(f.topups.get(rowOne.id), rowOne, "row one byte-for-byte unchanged");
  assert.deepEqual(f.topups.get(rowTwo.id), rowTwo, "row two byte-for-byte unchanged");
});

function seedIncompatibleExistingRow(f, reference, overrides) {
  seedRechargeSessionByReference(f, reference, { ownerWaId: OWNER, packSnapshot: { credits: PACK_1000.credits } });
  seedTopup(f.topups, {
    reference, wa_id: OWNER, amount_fcfa: PACK_1000.amount, credits: PACK_1000.credits,
    payment_method: "orange_money", status: "pending", ...overrides,
  });
  return { merchant_reference: reference, amount: PACK_1000.amount, currency: "XOF" };
}

test("R1-F. Incompatible existing row (A) wrong owner: createPaymentRequest fails closed, never adopting an unrelated topup merely because the reference matches", async () => {
  const f = buildComposition();
  const request = seedIncompatibleExistingRow(f, "recharge:existing-row-wrong-owner", { wa_id: OTHER_OWNER });
  const result = await f.provider.createPaymentRequest(request);
  assert.equal(result.ok, false);
  assert.equal(result.error, "PAYMENT_REQUEST_EXISTING_MISMATCH");
});

test("R1-G. Incompatible existing row (B) wrong amount: createPaymentRequest fails closed", async () => {
  const f = buildComposition();
  const request = seedIncompatibleExistingRow(f, "recharge:existing-row-wrong-amount", { amount_fcfa: PACK_1000.amount + 1 });
  const result = await f.provider.createPaymentRequest(request);
  assert.equal(result.ok, false);
  assert.equal(result.error, "PAYMENT_REQUEST_EXISTING_MISMATCH");
});

test("R1-H. Incompatible existing row (C) wrong credits: createPaymentRequest fails closed", async () => {
  const f = buildComposition();
  const request = seedIncompatibleExistingRow(f, "recharge:existing-row-wrong-credits", { credits: PACK_1000.credits + 1 });
  const result = await f.provider.createPaymentRequest(request);
  assert.equal(result.ok, false);
  assert.equal(result.error, "PAYMENT_REQUEST_EXISTING_MISMATCH");
});

test("R1-I. Incompatible existing row (D) wrong payment_method: createPaymentRequest fails closed", async () => {
  const f = buildComposition();
  const request = seedIncompatibleExistingRow(f, "recharge:existing-row-wrong-method", { payment_method: "wave" });
  const result = await f.provider.createPaymentRequest(request);
  assert.equal(result.ok, false);
  assert.equal(result.error, "PAYMENT_REQUEST_EXISTING_MISMATCH");
});
