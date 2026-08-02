"use strict";

const {
  createMinimalProfile,
  normalizeWaId,
  restoreMinimalProfile,
} = require("./kadiV1UserProfile");

const WELCOME_CREDIT_AMOUNT = 5;
const WELCOME_LEDGER_TYPE = "WELCOME_CREDITS";
const ONBOARDING_REPOSITORY_METHODS = Object.freeze([
  "createOrGetMinimalProfile",
  "grantWelcomeCreditsAtomically",
  "recordOnboardingEvent",
  "startOnboarding",
  "resumeOnboarding",
  "completeOnboarding",
  "getOnboardingState",
]);
const EVENT_TYPES = new Set([
  "USER_PROFILE_CREATED",
  "WELCOME_CREDITS_GRANTED",
  "WELCOME_TEXT_READY",
  "WELCOME_VOICE_REQUESTED",
  "WELCOME_VOICE_FAILED",
  "ONBOARDING_STARTED",
  "ONBOARDING_RESUMED",
  "ONBOARDING_COMPLETED",
  "USER_REACTIVATED",
]);
const EVENT_STATUSES = new Set(["SUCCEEDED", "FAILED", "REQUESTED"]);

function ok(value, extra = {}) {
  return { ok: true, value, ...extra };
}

function fail(error) {
  return { ok: false, error };
}

function assertOnboardingRepository(repository) {
  if (!repository || typeof repository !== "object") throw new TypeError("ONBOARDING_REPOSITORY_REQUIRED");
  for (const method of ONBOARDING_REPOSITORY_METHODS) {
    if (typeof repository[method] !== "function") throw new TypeError(`ONBOARDING_REPOSITORY_METHOD_REQUIRED:${method}`);
  }
  return repository;
}

function createInMemoryOnboardingRepository({
  clock = () => new Date().toISOString(),
  initialProfiles = [],
  initialBalances = {},
  grantFailpoint = null,
} = {}) {
  if (typeof clock !== "function") throw new TypeError("ONBOARDING_CLOCK_REQUIRED");
  if (grantFailpoint != null && typeof grantFailpoint !== "function") throw new TypeError("WELCOME_FAILPOINT_INVALID");
  const profiles = new Map();
  const balances = new Map(Object.entries(initialBalances).map(([key, value]) => [key, Number(value) || 0]));
  const ledger = new Map();
  const events = new Map();
  const locks = new Map();

  for (const raw of initialProfiles) {
    const now = clock();
    const profile = raw.onboarding_status
      ? restoreMinimalProfile(raw)
      : createMinimalProfile({ waId: raw.wa_id, phoneNormalized: raw.phone_normalized, now, historical: true });
    if (!profile.ok) throw new TypeError(profile.error);
    profiles.set(profile.value.wa_id, profile.value);
  }

  async function withWaIdLock(waId, operation) {
    const previous = locks.get(waId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    locks.set(waId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(waId) === queued) locks.delete(waId);
    }
  }

  function getProfile(waId) {
    return profiles.get(waId) || null;
  }

  function replaceProfile(profile, patch) {
    const restored = restoreMinimalProfile({ ...profile, ...patch, updated_at: clock() });
    if (!restored.ok) return restored;
    profiles.set(profile.wa_id, restored.value);
    return restored;
  }

  async function recordOnboardingEvent({ waId, eventType, idempotencyKey, status = "SUCCEEDED" }) {
    const normalized = normalizeWaId(waId);
    if (!normalized || !EVENT_TYPES.has(eventType) || !EVENT_STATUSES.has(status)) {
      return fail("ONBOARDING_EVENT_INVALID");
    }
    if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9:_.-]{1,200}$/.test(idempotencyKey)) {
      return fail("ONBOARDING_IDEMPOTENCY_KEY_INVALID");
    }
    if (!profiles.has(normalized)) return fail("V1_PROFILE_NOT_FOUND");
    const existing = events.get(idempotencyKey);
    if (existing) {
      if (existing.wa_id !== normalized || existing.event_type !== eventType) return fail("ONBOARDING_IDEMPOTENCY_CONFLICT");
      return ok(existing, { duplicate: true });
    }
    const event = Object.freeze({
      wa_id: normalized,
      event_type: eventType,
      idempotency_key: idempotencyKey,
      status,
      occurred_at: clock(),
    });
    events.set(idempotencyKey, event);
    return ok(event, { duplicate: false });
  }

  async function createOrGetMinimalProfile({ waId, phoneNormalized = null }) {
    const normalized = normalizeWaId(waId);
    if (!normalized) return fail("V1_PROFILE_WA_ID_INVALID");
    return withWaIdLock(normalized, async () => {
      const existing = getProfile(normalized);
      if (existing) return ok(existing, { created: false });
      const created = createMinimalProfile({ waId: normalized, phoneNormalized, now: clock() });
      if (!created.ok) return created;
      profiles.set(normalized, created.value);
      await recordOnboardingEvent({
        waId: normalized,
        eventType: "USER_PROFILE_CREATED",
        idempotencyKey: `user_profile:${normalized}`,
      });
      return ok(created.value, { created: true });
    });
  }

  async function grantWelcomeCreditsAtomically({ waId, idempotencyKey }) {
    const normalized = normalizeWaId(waId);
    const expectedKey = normalized ? `welcome_credits:${normalized}` : null;
    if (!normalized || idempotencyKey !== expectedKey) return fail("WELCOME_CREDITS_KEY_INVALID");
    return withWaIdLock(normalized, async () => {
      const profile = getProfile(normalized);
      if (!profile) return fail("V1_PROFILE_NOT_FOUND");
      const existing = ledger.get(idempotencyKey);
      if (existing) return ok(existing, { granted_now: false, duplicate: true });
      if (profile.welcome_credits_granted && profile.welcome_credits_eligibility === "GRANTED") {
        return ok(Object.freeze({
          wa_id: normalized,
          idempotency_key: idempotencyKey,
        }), { granted_now: false, duplicate: true });
      }
      if (profile.welcome_credits_eligibility === "HISTORICAL_UNKNOWN") {
        return fail("WELCOME_CREDITS_ELIGIBILITY_UNKNOWN");
      }
      if (profile.welcome_credits_granted || profile.welcome_credits_eligibility === "GRANTED") {
        return fail("WELCOME_CREDITS_STATE_INCONSISTENT");
      }
      const nextLedger = Object.freeze({
        wa_id: normalized,
        ledger_type: WELCOME_LEDGER_TYPE,
        delta: WELCOME_CREDIT_AMOUNT,
        idempotency_key: idempotencyKey,
        created_at: clock(),
      });
      if (grantFailpoint) await grantFailpoint({ waId: normalized, stage: "before_commit" });
      const updated = replaceProfile(profile, {
        welcome_credits_granted: true,
        welcome_credits_eligibility: "GRANTED",
      });
      if (!updated.ok) return updated;
      ledger.set(idempotencyKey, nextLedger);
      balances.set(normalized, (balances.get(normalized) || 0) + WELCOME_CREDIT_AMOUNT);
      await recordOnboardingEvent({
        waId: normalized,
        eventType: "WELCOME_CREDITS_GRANTED",
        idempotencyKey,
      });
      return ok(Object.freeze({
        ...nextLedger,
        balance: balances.get(normalized),
      }), { granted_now: true, duplicate: false });
    });
  }

  async function setOnboardingStatus({ waId, status, eventType, idempotencyKey }) {
    const normalized = normalizeWaId(waId);
    if (!normalized) return fail("V1_PROFILE_WA_ID_INVALID");
    return withWaIdLock(normalized, async () => {
      const profile = getProfile(normalized);
      if (!profile) return fail("V1_PROFILE_NOT_FOUND");
      const event = await recordOnboardingEvent({ waId: normalized, eventType, idempotencyKey });
      if (!event.ok) return event;
      if (event.duplicate) return ok(profile, { duplicate: true });
      const updated = replaceProfile(profile, { onboarding_status: status });
      return updated.ok ? ok(updated.value, { duplicate: false }) : updated;
    });
  }

  const startOnboarding = ({ waId }) => setOnboardingStatus({
    waId, status: "IN_PROGRESS", eventType: "ONBOARDING_STARTED", idempotencyKey: `onboarding_start:${waId}:v1`,
  });
  const resumeOnboarding = ({ waId }) => setOnboardingStatus({
    waId, status: "IN_PROGRESS", eventType: "ONBOARDING_RESUMED", idempotencyKey: `onboarding_resume:${waId}:v1`,
  });
  const completeOnboarding = ({ waId }) => setOnboardingStatus({
    waId, status: "COMPLETED", eventType: "ONBOARDING_COMPLETED", idempotencyKey: `onboarding_complete:${waId}:v1`,
  });

  async function getOnboardingState({ waId }) {
    const normalized = normalizeWaId(waId);
    if (!normalized) return fail("V1_PROFILE_WA_ID_INVALID");
    const profile = getProfile(normalized);
    return profile ? ok(profile) : fail("V1_PROFILE_NOT_FOUND");
  }

  function inspect() {
    return {
      profiles: [...profiles.values()],
      ledger: [...ledger.values()],
      events: [...events.values()],
      balances: Object.fromEntries(balances),
    };
  }

  return Object.freeze(assertOnboardingRepository({
    completeOnboarding,
    createOrGetMinimalProfile,
    getOnboardingState,
    grantWelcomeCreditsAtomically,
    recordOnboardingEvent,
    resumeOnboarding,
    startOnboarding,
    inspect,
  }));
}

module.exports = {
  EVENT_STATUSES,
  EVENT_TYPES,
  ONBOARDING_REPOSITORY_METHODS,
  WELCOME_CREDIT_AMOUNT,
  WELCOME_LEDGER_TYPE,
  assertOnboardingRepository,
  createInMemoryOnboardingRepository,
};
