"use strict";

const RECHARGE_STATUSES = Object.freeze([
  "CREATED", "PAYMENT_PENDING", "PAYMENT_CONFIRMED", "CREDITED", "RESUME_PENDING", "RESUMED", "FAILED", "EXPIRED", "CANCELLED",
]);
const METHODS = Object.freeze([
  "createRechargeSession", "getRechargeSession", "findSessionByIdempotencyKey", "updateRechargeSession",
  "recordPaymentEvent", "getPaymentEvent", "confirmPaymentAndCredit", "getBalance", "getAvailableBalance",
  "createResumeLink", "getResumeLink", "updateResumeLink",
]);
const ID_PATTERN = /^[A-Za-z0-9:_.-]{1,200}$/;

const ok = (value, extra = {}) => ({ ok: true, value, ...extra });
const fail = (error) => ({ ok: false, error });
const clone = (value) => value == null ? value : structuredClone(value);
const validId = (value) => typeof value === "string" && ID_PATTERN.test(value);

function assertRechargeRepository(repository) {
  if (!repository || typeof repository !== "object") throw new TypeError("RECHARGE_REPOSITORY_REQUIRED");
  for (const method of METHODS) if (typeof repository[method] !== "function") throw new TypeError(`RECHARGE_REPOSITORY_METHOD_REQUIRED:${method}`);
  return repository;
}

// T6/BALANCE-001: reservedAmountProvider is an optional injected function
// ({ownerWaId}) => number, mirroring the exact live semantics
// kadi_v1_reserve_generation_credits already uses (sum of amounts where
// status = 'RESERVED') — never a second, independent meaning of
// "reserved". Defaults to a constant 0, so every pre-existing fixture
// that constructs this repository without wallet-reservation data
// continues to behave exactly as before. A caller that needs a real
// reserved amount (e.g. a production-composition E2E test wiring this
// repository together with kadiV1GenerationLifecycleRepository.js's
// in-memory store) supplies it explicitly.
function createInMemoryRechargeRepository({ balances = {}, failpoint = async () => {}, reservedAmountProvider = async () => 0 } = {}) {
  const wallets = new Map(Object.entries(balances));
  const sessions = new Map();
  const events = new Map();
  const resumeLinks = new Map();
  const ledger = [];
  const createKeys = new Map();
  let queue = Promise.resolve();

  async function serial(operation) {
    const prior = queue;
    let release;
    queue = new Promise((resolve) => { release = resolve; });
    await prior;
    try { return await operation(); } finally { release(); }
  }

  async function createRechargeSession({ session, resumeLink = null, idempotencyKey }) {
    return serial(async () => {
      if (!validId(session?.recharge_session_id) || !validId(idempotencyKey)) return fail("RECHARGE_SESSION_INPUT_INVALID");
      const prior = createKeys.get(idempotencyKey);
      if (prior) return ok(clone(sessions.get(prior)), { duplicate: true });
      if (sessions.has(session.recharge_session_id)) return fail("RECHARGE_SESSION_ALREADY_EXISTS");
      if (resumeLink && (resumeLink.recharge_session_id !== session.recharge_session_id || resumeLinks.has(session.recharge_session_id))) {
        return fail("RECHARGE_RESUME_LINK_INVALID");
      }
      await failpoint("before_recharge_session", clone(session));
      const stored = { ...clone(session), revision: 1 };
      sessions.set(stored.recharge_session_id, stored);
      if (resumeLink) resumeLinks.set(stored.recharge_session_id, { ...clone(resumeLink), revision: 1 });
      createKeys.set(idempotencyKey, stored.recharge_session_id);
      return ok(clone(stored));
    });
  }

  async function getRechargeSession({ rechargeSessionId }) {
    const value = sessions.get(rechargeSessionId);
    return value ? ok(clone(value)) : fail("RECHARGE_SESSION_NOT_FOUND");
  }

  async function findSessionByIdempotencyKey(idempotencyKey) {
    const id = createKeys.get(idempotencyKey);
    return ok(id ? clone(sessions.get(id)) : null);
  }

  async function updateRechargeSession({ rechargeSessionId, expectedStatuses, changes }) {
    return serial(async () => {
      const session = sessions.get(rechargeSessionId);
      if (!session) return fail("RECHARGE_SESSION_NOT_FOUND");
      if (!Array.isArray(expectedStatuses) || !expectedStatuses.includes(session.status)) return fail("RECHARGE_SESSION_STATUS_CONFLICT");
      if (changes.status != null && !RECHARGE_STATUSES.includes(changes.status)) return fail("RECHARGE_SESSION_STATUS_INVALID");
      if (changes.provider && changes.provider_payment_id) {
        const conflict = [...sessions.values()].find((entry) => entry.recharge_session_id !== rechargeSessionId &&
          entry.provider === changes.provider && entry.provider_payment_id === changes.provider_payment_id);
        if (conflict) return fail("PAYMENT_PROVIDER_REFERENCE_CONFLICT");
      }
      await failpoint("before_recharge_session_update", clone(changes));
      Object.assign(session, clone(changes), { revision: session.revision + 1 });
      return ok(clone(session));
    });
  }

  async function recordPaymentEvent({ event, fingerprint }) {
    return serial(async () => {
      const key = `${event.provider}:${event.provider_event_id}`;
      const prior = events.get(key);
      if (prior) return prior.fingerprint === fingerprint ? ok(clone(prior.event), { duplicate: true }) : fail("PAYMENT_EVENT_REPLAY_CONFLICT");
      events.set(key, { event: clone(event), fingerprint });
      return ok(clone(event));
    });
  }

  async function getPaymentEvent({ provider, providerEventId }) {
    const prior = events.get(`${provider}:${providerEventId}`);
    return ok(prior ? clone(prior.event) : null);
  }

  async function confirmPaymentAndCredit({ rechargeSessionId, event, fingerprint, idempotencyKey, creditedAt, allowLate = false }) {
    return serial(async () => {
      const session = sessions.get(rechargeSessionId);
      if (!session) return fail("RECHARGE_SESSION_NOT_FOUND");
      const eventKey = `${event.provider}:${event.provider_event_id}`;
      const prior = events.get(eventKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint || prior.event.recharge_session_id !== rechargeSessionId) return fail("PAYMENT_EVENT_REPLAY_CONFLICT");
        if (["CREDITED", "RESUME_PENDING", "RESUMED"].includes(session.status)) return ok(clone(session), { duplicate: true });
      }
      if (session.status !== "PAYMENT_PENDING") return fail("RECHARGE_SESSION_NOT_CREDITABLE");
      const exactMatch = event.verified === true && event.status === "CONFIRMED" &&
        session.provider === event.provider && session.provider_payment_id === event.provider_payment_id &&
        session.merchant_reference === event.merchant_reference && session.pack_snapshot.amount === event.amount &&
        session.pack_snapshot.currency === event.currency;
      if (!exactMatch) return fail("PAYMENT_EVENT_MISMATCH");
      const creditedMs = Date.parse(creditedAt);
      const expiryMs = Date.parse(session.expires_at);
      const occurredMs = Date.parse(event.occurred_at);
      if (creditedMs >= expiryMs && !(allowLate === true && occurredMs < expiryMs)) return fail("PAYMENT_EVENT_LATE");
      await failpoint("before_recharge_credit", { recharge_session_id: rechargeSessionId });
      events.set(eventKey, { event: clone({ ...event, recharge_session_id: rechargeSessionId }), fingerprint });
      const balance = wallets.get(session.owner_wa_id) ?? 0;
      wallets.set(session.owner_wa_id, balance + session.pack_snapshot.credits);
      ledger.push({ ledger_type: "RECHARGE", amount: session.pack_snapshot.credits, owner_wa_id: session.owner_wa_id, idempotency_key: idempotencyKey, provider: event.provider, provider_payment_id: event.provider_payment_id });
      Object.assign(session, {
        status: session.document_id ? "RESUME_PENDING" : "CREDITED",
        payment_confirmed_at: event.occurred_at,
        credited_at: creditedAt,
        credit_idempotency_key: idempotencyKey,
        revision: session.revision + 1,
      });
      return ok(clone(session), { balance: wallets.get(session.owner_wa_id) });
    });
  }

  async function getBalance({ ownerWaId }) {
    return ok(wallets.get(ownerWaId) ?? 0);
  }

  // T6/BALANCE-001: additive method, never replacing getBalance() above —
  // getBalance() remains available for its other callers.
  // RECHARGE_RESUME_AVAILABLE_BALANCE_001 (R0) switched
  // kadiV1RechargeService.js's resumePendingGeneration precheck from
  // getBalance() to THIS method — the raw wallet total ignored credits
  // another live generation already held. total_credits is the exact
  // same raw wallet balance getBalance() returns; reserved_credits/
  // available_credits are derived from reservedAmountProvider. Fails
  // closed (never clamps or fabricates) on any impossible financial
  // state, matching the real SQL RPC's fail-closed contract.
  async function getAvailableBalance({ ownerWaId }) {
    const total = wallets.get(ownerWaId) ?? 0;
    const reserved = await reservedAmountProvider({ ownerWaId });
    if (
      !Number.isSafeInteger(total) || total < 0 ||
      !Number.isSafeInteger(reserved) || reserved < 0 ||
      reserved > total
    ) {
      return fail("KADI_V1_BALANCE_INVALID");
    }
    return ok({ total_credits: total, reserved_credits: reserved, available_credits: total - reserved });
  }

  async function createResumeLink({ link }) {
    return serial(async () => {
      if (resumeLinks.has(link.recharge_session_id)) return ok(clone(resumeLinks.get(link.recharge_session_id)), { duplicate: true });
      resumeLinks.set(link.recharge_session_id, { ...clone(link), revision: 1 });
      return ok(clone(resumeLinks.get(link.recharge_session_id)));
    });
  }

  async function getResumeLink({ rechargeSessionId }) {
    const link = resumeLinks.get(rechargeSessionId);
    return link ? ok(clone(link)) : fail("RECHARGE_RESUME_LINK_NOT_FOUND");
  }

  async function updateResumeLink({ rechargeSessionId, expectedStatuses, changes }) {
    return serial(async () => {
      const link = resumeLinks.get(rechargeSessionId);
      if (!link) return fail("RECHARGE_RESUME_LINK_NOT_FOUND");
      if (!expectedStatuses.includes(link.resume_status)) return fail("RECHARGE_RESUME_STATUS_CONFLICT");
      Object.assign(link, clone(changes), { revision: link.revision + 1 });
      return ok(clone(link));
    });
  }

  return Object.freeze(assertRechargeRepository({
    createRechargeSession, getRechargeSession, findSessionByIdempotencyKey, updateRechargeSession,
    recordPaymentEvent, getPaymentEvent, confirmPaymentAndCredit, getBalance, getAvailableBalance,
    createResumeLink, getResumeLink, updateResumeLink,
    inspect: () => clone({ balances: Object.fromEntries(wallets), sessions: [...sessions.values()], events: [...events.values()].map((entry) => entry.event), resumeLinks: [...resumeLinks.values()], ledger }),
  }));
}

module.exports = { RECHARGE_STATUSES, assertRechargeRepository, createInMemoryRechargeRepository };
