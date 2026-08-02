"use strict";

const ONBOARDING_STATUSES = Object.freeze(["IN_PROGRESS", "COMPLETED", "HISTORICAL_UNKNOWN"]);
const VOICE_RESPONSE_MODES = Object.freeze(["TEXT_ONLY", "TEXT_AND_VOICE", "VOICE_WHEN_HELPFUL"]);
const WELCOME_ELIGIBILITY = Object.freeze(["ELIGIBLE", "GRANTED", "HISTORICAL_UNKNOWN"]);

function ok(value) {
  return { ok: true, value };
}

function fail(error) {
  return { ok: false, error };
}

function normalizeWaId(value) {
  const waId = typeof value === "string" ? value.trim() : "";
  return /^\d{8,20}$/.test(waId) ? waId : null;
}

function normalizePhone(value) {
  if (value == null || value === "") return null;
  const phone = String(value).replace(/\D/g, "");
  return /^\d{8,20}$/.test(phone) ? phone : null;
}

function validIsoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function restoreMinimalProfile(rawProfile) {
  if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) return fail("V1_PROFILE_INVALID");
  const waId = normalizeWaId(rawProfile.wa_id);
  if (!waId) return fail("V1_PROFILE_WA_ID_INVALID");
  const phone = normalizePhone(rawProfile.phone_normalized);
  if (rawProfile.phone_normalized != null && !phone) return fail("V1_PROFILE_PHONE_INVALID");
  if (!ONBOARDING_STATUSES.includes(rawProfile.onboarding_status)) return fail("V1_ONBOARDING_STATUS_INVALID");
  if (!VOICE_RESPONSE_MODES.includes(rawProfile.voice_response_mode)) return fail("V1_VOICE_MODE_INVALID");
  if (!WELCOME_ELIGIBILITY.includes(rawProfile.welcome_credits_eligibility)) return fail("V1_WELCOME_ELIGIBILITY_INVALID");
  if (typeof rawProfile.locale !== "string" || !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(rawProfile.locale)) {
    return fail("V1_PROFILE_LOCALE_INVALID");
  }
  if (!validIsoTimestamp(rawProfile.created_at) || !validIsoTimestamp(rawProfile.updated_at)) {
    return fail("V1_PROFILE_TIMESTAMP_INVALID");
  }
  if (typeof rawProfile.welcome_credits_granted !== "boolean") return fail("V1_WELCOME_MARKER_INVALID");
  if (rawProfile.welcome_credits_granted !== (rawProfile.welcome_credits_eligibility === "GRANTED")) {
    return fail("V1_WELCOME_STATE_INCONSISTENT");
  }
  return ok(Object.freeze({
    wa_id: waId,
    phone_normalized: phone,
    onboarding_status: rawProfile.onboarding_status,
    welcome_credits_granted: rawProfile.welcome_credits_granted,
    welcome_credits_eligibility: rawProfile.welcome_credits_eligibility,
    voice_response_mode: rawProfile.voice_response_mode,
    locale: rawProfile.locale,
    created_at: new Date(rawProfile.created_at).toISOString(),
    updated_at: new Date(rawProfile.updated_at).toISOString(),
  }));
}

function createMinimalProfile({ waId, phoneNormalized = null, now, historical = false }) {
  const normalizedWaId = normalizeWaId(waId);
  if (!normalizedWaId) return fail("V1_PROFILE_WA_ID_INVALID");
  const phone = normalizePhone(phoneNormalized);
  if (phoneNormalized != null && !phone) return fail("V1_PROFILE_PHONE_INVALID");
  const timestamp = typeof now === "string" && Number.isFinite(Date.parse(now))
    ? new Date(now).toISOString()
    : null;
  if (!timestamp) return fail("V1_PROFILE_CLOCK_INVALID");
  return restoreMinimalProfile({
    wa_id: normalizedWaId,
    phone_normalized: phone,
    onboarding_status: historical ? "HISTORICAL_UNKNOWN" : "IN_PROGRESS",
    welcome_credits_granted: false,
    welcome_credits_eligibility: historical ? "HISTORICAL_UNKNOWN" : "ELIGIBLE",
    voice_response_mode: "VOICE_WHEN_HELPFUL",
    locale: "fr-BF",
    created_at: timestamp,
    updated_at: timestamp,
  });
}

module.exports = {
  ONBOARDING_STATUSES,
  VOICE_RESPONSE_MODES,
  WELCOME_ELIGIBILITY,
  createMinimalProfile,
  normalizePhone,
  normalizeWaId,
  restoreMinimalProfile,
};
