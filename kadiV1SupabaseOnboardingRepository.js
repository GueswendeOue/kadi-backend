"use strict";

const {
  assertOnboardingRepository,
} = require("./kadiV1OnboardingRepository");
const {
  normalizePhone,
  normalizeWaId,
  restoreMinimalProfile,
} = require("./kadiV1UserProfile");

function ok(value, extra = {}) {
  return { ok: true, value, ...extra };
}

function fail(error) {
  return { ok: false, error };
}

function mapProfile(row) {
  if (!row || typeof row !== "object") return fail("V1_PROFILE_NOT_FOUND");
  const granted = row.welcome_credits_granted === true;
  const eligibility = granted
    ? "GRANTED"
    : (row.welcome_credits_eligibility || "HISTORICAL_UNKNOWN");
  return restoreMinimalProfile({
    wa_id: row.wa_id,
    phone_normalized: row.phone_normalized ?? null,
    onboarding_status: row.onboarding_status || "HISTORICAL_UNKNOWN",
    welcome_credits_granted: granted,
    welcome_credits_eligibility: eligibility,
    voice_response_mode: row.voice_response_mode || "VOICE_WHEN_HELPFUL",
    locale: row.locale || "fr-BF",
    created_at: row.v1_created_at || row.created_at,
    updated_at: row.v1_updated_at || row.updated_at,
  });
}

function rpcValue(data) {
  return Array.isArray(data) && data.length === 1 ? data[0] : data;
}

function createSupabaseOnboardingRepository({ client }) {
  if (!client || typeof client.rpc !== "function" || typeof client.from !== "function") {
    throw new TypeError("SUPABASE_CLIENT_REQUIRED");
  }

  async function callRpc(name, parameters) {
    const { data, error } = await client.rpc(name, parameters);
    if (error) return fail(`V1_ONBOARDING_STORAGE_ERROR:${name}`);
    return ok(rpcValue(data));
  }

  async function createOrGetMinimalProfile({ waId, phoneNormalized = null }) {
    const normalized = normalizeWaId(waId);
    if (!normalized) return fail("V1_PROFILE_WA_ID_INVALID");
    const phone = normalizePhone(phoneNormalized);
    if (phoneNormalized != null && !phone) return fail("V1_PROFILE_PHONE_INVALID");
    const result = await callRpc("kadi_v1_create_or_get_minimal_profile", {
      p_wa_id: normalized,
      p_phone_normalized: phone,
    });
    if (!result.ok || result.value?.ok === false) return result.ok ? fail(result.value.error) : result;
    const profile = mapProfile(result.value.profile);
    return profile.ok ? ok(profile.value, { created: result.value.created === true }) : profile;
  }

  async function grantWelcomeCreditsAtomically({ waId, idempotencyKey }) {
    const normalized = normalizeWaId(waId);
    if (!normalized || idempotencyKey !== `welcome_credits:${normalized}`) {
      return fail("WELCOME_CREDITS_KEY_INVALID");
    }
    const result = await callRpc("kadi_v1_grant_welcome_credits", {
      p_wa_id: normalized,
      p_idempotency_key: idempotencyKey,
    });
    if (!result.ok || result.value?.ok === false) return result.ok ? fail(result.value.error) : result;
    return ok(result.value, {
      granted_now: result.value.granted_now === true,
      duplicate: result.value.duplicate === true,
    });
  }

  async function recordOnboardingEvent({ waId, eventType, idempotencyKey, status = "SUCCEEDED" }) {
    const result = await callRpc("kadi_v1_record_onboarding_event", {
      p_wa_id: waId,
      p_event_type: eventType,
      p_idempotency_key: idempotencyKey,
      p_status: status,
    });
    if (!result.ok || result.value?.ok === false) return result.ok ? fail(result.value.error) : result;
    return ok(result.value, { duplicate: result.value.duplicate === true });
  }

  async function setOnboardingStatus({ waId, status, eventType, idempotencyKey }) {
    const result = await callRpc("kadi_v1_set_onboarding_status", {
      p_wa_id: waId,
      p_status: status,
      p_event_type: eventType,
      p_idempotency_key: idempotencyKey,
    });
    if (!result.ok || result.value?.ok === false) return result.ok ? fail(result.value.error) : result;
    const profile = mapProfile(result.value.profile);
    return profile.ok ? ok(profile.value, { duplicate: result.value.duplicate === true }) : profile;
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
    const { data, error } = await client
      .from("business_profiles")
      .select("wa_id,phone_normalized,onboarding_status,welcome_credits_granted,welcome_credits_eligibility,voice_response_mode,locale,v1_created_at,v1_updated_at,created_at,updated_at")
      .eq("wa_id", normalized)
      .maybeSingle();
    if (error) return fail("V1_ONBOARDING_STORAGE_ERROR:get_state");
    return mapProfile(data);
  }

  return Object.freeze(assertOnboardingRepository({
    completeOnboarding,
    createOrGetMinimalProfile,
    getOnboardingState,
    grantWelcomeCreditsAtomically,
    recordOnboardingEvent,
    resumeOnboarding,
    startOnboarding,
  }));
}

module.exports = {
  createSupabaseOnboardingRepository,
  mapProfile,
};
