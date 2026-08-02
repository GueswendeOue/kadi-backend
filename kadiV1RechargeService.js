"use strict";

const crypto = require("node:crypto");
const { DOCUMENT_EVENTS, createDocumentDomain } = require("./kadiV1DocumentDomain");
const { assertV1DocumentRepository } = require("./kadiV1DocumentRepository");
const { assertRechargeRepository } = require("./kadiV1RechargeRepository");
const { assertPaymentProvider, normalizePaymentResult } = require("./kadiV1PaymentProvider");

const RESUME_POLICIES = Object.freeze(["AUTO_RESUME_IF_VALID", "REQUIRE_CONFIRMATION"]);
const LATE_PAYMENT_POLICIES = Object.freeze(["REJECT", "ACCEPT_VERIFIED_BEFORE_EXPIRY"]);
const ID_PATTERN = /^[A-Za-z0-9:_.-]{1,200}$/;
const OWNER_PATTERN = /^\d{8,20}$/;

const ok = (value, extra = {}) => ({ ok: true, value, ...extra });
const fail = (error) => ({ ok: false, error });
const validId = (value) => typeof value === "string" && ID_PATTERN.test(value);
const validOwner = (value) => typeof value === "string" && OWNER_PATTERN.test(value);

function fingerprintPayment(event) {
  return crypto.createHash("sha256").update(JSON.stringify([
    event.provider, event.provider_event_id, event.provider_payment_id, event.merchant_reference,
    event.amount, event.currency, event.status, event.verified, event.occurred_at,
  ])).digest("hex");
}

function createRechargeService({
  repository,
  packCatalog,
  paymentProvider,
  documentRepository,
  quoteService,
  generationLifecycleService,
  domain = createDocumentDomain(),
  resumePolicy = "REQUIRE_CONFIRMATION",
  latePaymentPolicy = "REJECT",
  sessionLifetimeSeconds = 1800,
  clock = () => new Date().toISOString(),
  idFactory,
  observer = () => {},
} = {}) {
  const store = assertRechargeRepository(repository);
  const provider = assertPaymentProvider(paymentProvider);
  const documents = assertV1DocumentRepository(documentRepository);
  if (typeof packCatalog?.getPack !== "function") throw new TypeError("RECHARGE_PACK_CATALOG_REQUIRED");
  if (typeof quoteService?.getGenerationQuote !== "function") throw new TypeError("RECHARGE_QUOTE_SERVICE_REQUIRED");
  if (typeof generationLifecycleService?.confirmGeneration !== "function") throw new TypeError("RECHARGE_GENERATION_SERVICE_REQUIRED");
  if (!RESUME_POLICIES.includes(resumePolicy)) throw new TypeError("RECHARGE_RESUME_POLICY_INVALID");
  if (!LATE_PAYMENT_POLICIES.includes(latePaymentPolicy)) throw new TypeError("RECHARGE_LATE_PAYMENT_POLICY_INVALID");
  if (!Number.isSafeInteger(sessionLifetimeSeconds) || sessionLifetimeSeconds < 60) throw new TypeError("RECHARGE_SESSION_LIFETIME_INVALID");
  if (typeof observer !== "function") throw new TypeError("RECHARGE_OBSERVER_INVALID");
  const makeId = idFactory || ((kind, key) => `${kind}:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}`);
  const queues = new Map();

  function emit(event, details = {}) {
    try { observer(Object.freeze({ event, ...details })); } catch { /* diagnostics never alter financial state */ }
  }

  function now() {
    const value = clock();
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? { ok: true, value: new Date(milliseconds).toISOString(), milliseconds } : fail("RECHARGE_CLOCK_INVALID");
  }

  async function serial(key, operation) {
    const prior = queues.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    queues.set(key, current);
    await prior;
    try { return await operation(); } finally {
      release();
      if (queues.get(key) === current) queues.delete(key);
    }
  }

  async function createRechargeSession(command) {
    if (!validOwner(command?.ownerWaId) || !validId(command?.packId) || !validId(command?.idempotencyKey) ||
        Object.hasOwn(command, "amount") || Object.hasOwn(command, "currency") || Object.hasOwn(command, "credits")) {
      return fail("RECHARGE_CREATE_COMMAND_INVALID");
    }
    const replay = await store.findSessionByIdempotencyKey(command.idempotencyKey);
    if (!replay.ok) return replay;
    if (replay.value) return ok(replay.value, { duplicate: true });
    const selected = packCatalog.getPack(command.packId);
    if (!selected.ok) return selected;
    if (!selected.value.active) return fail("RECHARGE_PACK_INACTIVE");
    const time = now();
    if (!time.ok) return time;
    const sessionId = makeId("recharge", command.idempotencyKey);
    if (!validId(sessionId)) return fail("RECHARGE_SESSION_ID_INVALID");
    let resumeLink = null;
    if (command.document != null) {
      const link = command.document;
      if (!validId(link.documentId) || !Number.isSafeInteger(link.documentVersion) || link.documentVersion < 1 ||
          !validId(link.quoteId) || !validId(link.generationConfirmationId) ||
          !Number.isSafeInteger(link.missingCredits) || link.missingCredits < 1) return fail("RECHARGE_DOCUMENT_LINK_INVALID");
      const document = await documents.getDocumentById({ documentId: link.documentId, ownerWaId: command.ownerWaId });
      if (!document.ok || document.value.status !== "RECHARGE_REQUIRED" || document.value.version !== link.documentVersion) {
        return fail("RECHARGE_DOCUMENT_NOT_ELIGIBLE");
      }
      const quote = await quoteService.getGenerationQuote({ quoteId: link.quoteId, ownerWaId: command.ownerWaId });
      if (!quote.ok || quote.value.document_id !== link.documentId || quote.value.document_version !== link.documentVersion ||
          quote.value.status !== "ACTIVE" || !Number.isSafeInteger(quote.value.total_credits) || quote.value.total_credits < 1) {
        return fail("RECHARGE_QUOTE_NOT_ELIGIBLE");
      }
      resumeLink = {
        recharge_session_id: sessionId,
        document_id: link.documentId,
        document_version: link.documentVersion,
        quote_id: link.quoteId,
        generation_confirmation_id: link.generationConfirmationId,
        missing_credits: link.missingCredits,
        generation_cost: quote.value.total_credits,
        pricing_version: quote.value.pricing_version,
        resume_status: "WAITING_FOR_CREDIT",
        generation_started: false,
        created_at: time.value,
      };
    }
    const session = {
      recharge_session_id: sessionId,
      owner_wa_id: command.ownerWaId,
      pack_id: selected.value.pack_id,
      pack_snapshot: selected.value,
      status: "CREATED",
      provider: null,
      provider_payment_id: null,
      merchant_reference: sessionId,
      document_id: resumeLink?.document_id || null,
      created_at: time.value,
      expires_at: new Date(time.milliseconds + sessionLifetimeSeconds * 1000).toISOString(),
    };
    const stored = await store.createRechargeSession({ session, resumeLink, idempotencyKey: command.idempotencyKey });
    if (!stored.ok) return stored;
    emit("recharge_session_created", { recharge_session_id: sessionId, source: resumeLink ? "DOCUMENT" : "MENU" });
    return stored;
  }

  async function getRechargeSession({ rechargeSessionId, ownerWaId }) {
    if (!validId(rechargeSessionId) || !validOwner(ownerWaId)) return fail("RECHARGE_LOOKUP_INVALID");
    const session = await store.getRechargeSession({ rechargeSessionId });
    return session.ok && session.value.owner_wa_id === ownerWaId ? session : fail("RECHARGE_SESSION_NOT_FOUND");
  }

  async function initiatePayment({ rechargeSessionId, ownerWaId }) {
    return serial(rechargeSessionId, async () => {
      const loaded = await getRechargeSession({ rechargeSessionId, ownerWaId });
      if (!loaded.ok) return loaded;
      if (loaded.value.status === "PAYMENT_PENDING") return ok(loaded.value, { duplicate: true });
      if (loaded.value.status !== "CREATED") return fail("RECHARGE_PAYMENT_INIT_STATE_INVALID");
      const time = now();
      if (!time.ok) return time;
      if (time.milliseconds >= Date.parse(loaded.value.expires_at)) return expireRechargeSession({ rechargeSessionId, ownerWaId });
      const response = await provider.createPaymentRequest(Object.freeze({
        merchant_reference: loaded.value.merchant_reference,
        amount: loaded.value.pack_snapshot.amount,
        currency: loaded.value.pack_snapshot.currency,
        metadata: { pack_id: loaded.value.pack_id },
      }));
      if (!response?.ok) return fail(response?.error || "PAYMENT_PROVIDER_UNAVAILABLE");
      const normalized = normalizePaymentResult(response.value);
      if (!normalized.ok || normalized.value.provider !== provider.name || normalized.value.merchant_reference !== loaded.value.merchant_reference ||
          normalized.value.amount !== loaded.value.pack_snapshot.amount || normalized.value.currency !== loaded.value.pack_snapshot.currency ||
          normalized.value.status !== "PENDING" || normalized.value.verified !== true) return fail("PAYMENT_REQUEST_RESULT_INVALID");
      const updated = await store.updateRechargeSession({
        rechargeSessionId,
        expectedStatuses: ["CREATED"],
        changes: { status: "PAYMENT_PENDING", provider: provider.name, provider_payment_id: normalized.value.provider_payment_id, payment_requested_at: time.value },
      });
      if (updated.ok) emit("payment_request_created", { provider: provider.name, recharge_session_id: rechargeSessionId });
      return updated;
    });
  }

  function eventIsLate(session, event, time) {
    const expiry = Date.parse(session.expires_at);
    if (time.milliseconds < expiry) return false;
    return latePaymentPolicy === "REJECT" || Date.parse(event.occurred_at) >= expiry;
  }

  async function confirmPaymentEvent({ rechargeSessionId, rawEvent }) {
    return serial(rechargeSessionId, async () => {
      emit("payment_event_received", { provider: provider.name, recharge_session_id: rechargeSessionId });
      const loaded = await store.getRechargeSession({ rechargeSessionId });
      if (!loaded.ok) return loaded;
      const response = await provider.verifyPaymentEvent(rawEvent);
      if (!response?.ok) {
        emit("payment_event_rejected", { provider: provider.name, reason_code: response?.error || "UNVERIFIED" });
        return fail(response?.error || "PAYMENT_EVENT_UNVERIFIED");
      }
      const normalized = normalizePaymentResult(response.value, { eventRequired: true });
      if (!normalized.ok) return normalized;
      const event = normalized.value;
      const fingerprint = fingerprintPayment(event);
      const previous = await store.getPaymentEvent({ provider: event.provider, providerEventId: event.provider_event_id });
      if (previous.ok && previous.value) {
        if (previous.value.accepted === false) return fail("PAYMENT_EVENT_PREVIOUSLY_REJECTED");
        const duplicate = await store.confirmPaymentAndCredit({
          rechargeSessionId, event, fingerprint,
          idempotencyKey: `recharge_credit:${event.provider}:${event.provider_payment_id}`,
          creditedAt: loaded.value.credited_at || event.occurred_at,
          allowLate: latePaymentPolicy === "ACCEPT_VERIFIED_BEFORE_EXPIRY",
        });
        return duplicate.ok ? ok(duplicate.value, { duplicate: true, balance: duplicate.balance }) : duplicate;
      }
      const time = now();
      if (!time.ok) return time;
      const matches = event.verified === true && event.status === "CONFIRMED" && event.provider === provider.name &&
        loaded.value.status === "PAYMENT_PENDING" && loaded.value.provider === event.provider &&
        loaded.value.provider_payment_id === event.provider_payment_id && loaded.value.merchant_reference === event.merchant_reference &&
        loaded.value.pack_snapshot.amount === event.amount && loaded.value.pack_snapshot.currency === event.currency;
      if (!matches || eventIsLate(loaded.value, event, time)) {
        await store.recordPaymentEvent({ event: { ...event, recharge_session_id: rechargeSessionId, accepted: false }, fingerprint });
        emit("payment_event_rejected", { provider: provider.name, reason_code: eventIsLate(loaded.value, event, time) ? "PAYMENT_EVENT_LATE" : "PAYMENT_EVENT_MISMATCH" });
        return fail(eventIsLate(loaded.value, event, time) ? "PAYMENT_EVENT_LATE" : "PAYMENT_EVENT_MISMATCH");
      }
      emit("payment_confirmed", { provider: provider.name, recharge_session_id: rechargeSessionId });
      const credited = await store.confirmPaymentAndCredit({
        rechargeSessionId, event, fingerprint,
        idempotencyKey: `recharge_credit:${event.provider}:${event.provider_payment_id}`,
        creditedAt: time.value,
        allowLate: latePaymentPolicy === "ACCEPT_VERIFIED_BEFORE_EXPIRY",
      });
      if (!credited.ok) return credited;
      emit("recharge_credited", { provider: provider.name, recharge_session_id: rechargeSessionId, credits: loaded.value.pack_snapshot.credits });
      if (!loaded.value.document_id) return credited;
      const resumed = await resumePendingGeneration({ rechargeSessionId, ownerWaId: loaded.value.owner_wa_id });
      return resumed.ok ? ok(resumed.value, { balance: credited.balance, resume: resumed.resume }) : ok(credited.value, { balance: credited.balance, resume_error: resumed.error });
    });
  }

  async function markPaymentFailed({ rechargeSessionId, ownerWaId, reasonCode = "PAYMENT_FAILED" }) {
    if (!/^[A-Z][A-Z0-9_]{1,79}$/.test(reasonCode)) return fail("PAYMENT_FAILURE_CODE_INVALID");
    const loaded = await getRechargeSession({ rechargeSessionId, ownerWaId });
    if (!loaded.ok) return loaded;
    return store.updateRechargeSession({ rechargeSessionId, expectedStatuses: ["PAYMENT_PENDING"], changes: { status: "FAILED", failure_code: reasonCode } });
  }

  async function expireRechargeSession({ rechargeSessionId, ownerWaId }) {
    const loaded = await getRechargeSession({ rechargeSessionId, ownerWaId });
    if (!loaded.ok) return loaded;
    const time = now();
    if (!time.ok) return time;
    if (time.milliseconds < Date.parse(loaded.value.expires_at)) return fail("RECHARGE_SESSION_NOT_EXPIRED");
    return store.updateRechargeSession({ rechargeSessionId, expectedStatuses: ["CREATED", "PAYMENT_PENDING", "FAILED"], changes: { status: "EXPIRED", expired_at: time.value } });
  }

  async function cancelRechargeSession({ rechargeSessionId, ownerWaId }) {
    const loaded = await getRechargeSession({ rechargeSessionId, ownerWaId });
    if (!loaded.ok) return loaded;
    const time = now();
    if (!time.ok) return time;
    return store.updateRechargeSession({ rechargeSessionId, expectedStatuses: ["CREATED", "PAYMENT_PENDING", "FAILED"], changes: { status: "CANCELLED", cancelled_at: time.value } });
  }

  async function resumePendingGeneration({ rechargeSessionId, ownerWaId }) {
    const session = await getRechargeSession({ rechargeSessionId, ownerWaId });
    if (!session.ok) return session;
    if (!session.value.document_id) return fail("RECHARGE_HAS_NO_DOCUMENT");
    if (!["RESUME_PENDING", "RESUMED"].includes(session.value.status)) return fail("RECHARGE_NOT_CREDITED");
    if (session.value.status === "RESUMED") return ok(session.value, { duplicate: true });
    const link = await store.getResumeLink({ rechargeSessionId });
    if (!link.ok) return link;
    if (resumePolicy !== "AUTO_RESUME_IF_VALID") return ok(session.value, { resume: { automatic: false, reason: "CONFIRMATION_REQUIRED" } });
    emit("generation_resume_started", { recharge_session_id: rechargeSessionId });
    let generationStarted = link.value.generation_started === true;
    if (!generationStarted) {
      const document = await documents.getDocumentById({ documentId: link.value.document_id, ownerWaId });
      const quote = await quoteService.getGenerationQuote({ quoteId: link.value.quote_id, ownerWaId });
      const time = now();
      const balance = await store.getBalance({ ownerWaId });
      const valid = document.ok && quote.ok && time.ok && balance.ok && document.value.status === "RECHARGE_REQUIRED" &&
        document.value.version === link.value.document_version && quote.value.status === "ACTIVE" &&
        quote.value.document_id === link.value.document_id && quote.value.document_version === link.value.document_version &&
        quote.value.total_credits === link.value.generation_cost && quote.value.pricing_version === link.value.pricing_version &&
        Date.parse(quote.value.expires_at) > time.milliseconds && balance.value >= quote.value.total_credits;
      if (!valid) {
        const reason = !document.ok || document.value.version !== link.value.document_version ? "DOCUMENT_CHANGED" :
          !quote.ok || quote.value.status !== "ACTIVE" || Date.parse(quote.value.expires_at) <= (time.milliseconds || 0) ? "QUOTE_NOT_ACTIVE" :
            quote.value.total_credits !== link.value.generation_cost || quote.value.pricing_version !== link.value.pricing_version ? "COST_CHANGED" : "BALANCE_INSUFFICIENT";
        await store.updateResumeLink({ rechargeSessionId, expectedStatuses: ["WAITING_FOR_CREDIT", "PENDING", "FAILED"], changes: { resume_status: "PENDING", last_error_code: reason } });
        return ok(session.value, { resume: { automatic: false, reason } });
      }
      const transitioned = domain.transitionDocument(document.value, DOCUMENT_EVENTS.RECHARGE_CONFIRMED);
      if (!transitioned.ok) return transitioned;
      const persisted = await documents.persistTransition({
        document: transitioned.value,
        ownerWaId,
        expectedVersion: document.value.version,
        fromState: "RECHARGE_REQUIRED",
        eventType: "RECHARGE_CONFIRMED",
        idempotencyKey: `${link.value.generation_confirmation_id}:recharge-confirmed`,
      });
      if (!persisted.ok) return persisted;
      const marked = await store.updateResumeLink({
        rechargeSessionId,
        expectedStatuses: ["WAITING_FOR_CREDIT", "PENDING", "FAILED"],
        changes: { resume_status: "STARTED", generation_started: true, started_at: time.value, last_error_code: null },
      });
      if (!marked.ok) return marked;
      generationStarted = true;
    }
    const generated = await generationLifecycleService.confirmGeneration({
      documentId: link.value.document_id,
      ownerWaId,
      documentVersion: link.value.document_version,
      quoteId: link.value.quote_id,
      idempotencyKey: link.value.generation_confirmation_id,
    });
    if (!generated.ok) {
      await store.updateResumeLink({ rechargeSessionId, expectedStatuses: ["STARTED", "FAILED"], changes: { resume_status: "FAILED", last_error_code: generated.error } });
      emit("generation_resume_failed", { recharge_session_id: rechargeSessionId, reason_code: generated.error });
      return fail("GENERATION_RESUME_FAILED");
    }
    await store.updateResumeLink({ rechargeSessionId, expectedStatuses: ["STARTED", "FAILED"], changes: { resume_status: "RESUMED", resumed_at: now().value, last_error_code: null } });
    const updated = await store.updateRechargeSession({ rechargeSessionId, expectedStatuses: ["RESUME_PENDING"], changes: { status: "RESUMED", resumed_at: now().value } });
    emit("generation_resume_succeeded", { recharge_session_id: rechargeSessionId });
    return updated.ok ? ok(updated.value, { resume: { automatic: true, generation: generated.value } }) : updated;
  }

  return Object.freeze({
    createRechargeSession,
    getRechargeSession,
    initiatePayment,
    confirmPaymentEvent,
    markPaymentFailed,
    expireRechargeSession,
    cancelRechargeSession,
    resumePendingGeneration,
  });
}

module.exports = { LATE_PAYMENT_POLICIES, RESUME_POLICIES, createRechargeService, fingerprintPayment };
