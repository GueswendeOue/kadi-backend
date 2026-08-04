"use strict";

const crypto = require("node:crypto");

const OWNER_PATTERN = /^\d{8,20}$/;
const IDEMPOTENCY_PATTERN = /^flow_command:[A-Za-z0-9:_.-]{1,187}$/;

function ok(value, extra = {}) {
  return { ok: true, value, ...extra };
}

function fail(error) {
  return { ok: false, error };
}

function isPlainObject(value) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function cleanText(value) {
  return value.trim().replace(/\s+/g, " ");
}

function validateProfileData(data) {
  if (!isPlainObject(data)) {
    return fail("KADI_V1_ONBOARDING_PROFILE_INVALID");
  }

  const allowed = new Set(["owner_name", "business_name"]);
  if (Object.keys(data).some((key) => !allowed.has(key))) {
    return fail("KADI_V1_ONBOARDING_PROFILE_FIELD_FORBIDDEN");
  }

  if (typeof data.owner_name !== "string") {
    return fail("KADI_V1_ONBOARDING_OWNER_NAME_REQUIRED");
  }

  if (
    data.business_name != null &&
    typeof data.business_name !== "string"
  ) {
    return fail("KADI_V1_ONBOARDING_BUSINESS_NAME_INVALID");
  }

  const ownerName = cleanText(data.owner_name);
  const businessName = data.business_name == null
    ? ""
    : cleanText(data.business_name);

  if (ownerName.length < 2) {
    return fail("KADI_V1_ONBOARDING_OWNER_NAME_REQUIRED");
  }

  if (ownerName.length > 80) {
    return fail("KADI_V1_ONBOARDING_OWNER_NAME_INVALID");
  }

  if (businessName && (
    businessName.length < 2 ||
    businessName.length > 120
  )) {
    return fail("KADI_V1_ONBOARDING_BUSINESS_NAME_INVALID");
  }

  return ok(Object.freeze({
    owner_name: ownerName,
    business_name: businessName || null,
  }));
}

function operationKey(source) {
  const digest = crypto
    .createHash("sha256")
    .update(String(source || ""))
    .digest("hex")
    .slice(0, 40);
  return `onboarding_profile:${digest}`;
}

function rpcValue(data) {
  return Array.isArray(data) && data.length === 1 ? data[0] : data;
}

function createSupabaseOnboardingProfileCompleter({ client } = {}) {
  if (!client || typeof client.rpc !== "function") {
    throw new TypeError("KADI_V1_ONBOARDING_PROFILE_CLIENT_REQUIRED");
  }

  async function complete({
    ownerWaId,
    profileData,
    idempotencyKey,
  } = {}) {
    if (!OWNER_PATTERN.test(ownerWaId || "")) {
      return fail("KADI_V1_ONBOARDING_PROFILE_OWNER_INVALID");
    }

    if (!IDEMPOTENCY_PATTERN.test(idempotencyKey || "")) {
      return fail("KADI_V1_ONBOARDING_PROFILE_IDEMPOTENCY_INVALID");
    }

    const checked = validateProfileData(profileData);
    if (!checked.ok) return checked;

    const { data, error } = await client.rpc(
      "kadi_v1_complete_onboarding_profile",
      {
        p_wa_id: ownerWaId,
        p_owner_name: checked.value.owner_name,
        p_business_name: checked.value.business_name,
        p_idempotency_key: operationKey(idempotencyKey),
      }
    );

    if (error) {
      return fail("KADI_V1_ONBOARDING_PROFILE_STORAGE_ERROR");
    }

    const value = rpcValue(data);
    if (!value || value.ok === false || !value.profile) {
      return fail(
        typeof value?.error === "string"
          ? value.error
          : "KADI_V1_ONBOARDING_PROFILE_RESULT_INVALID"
      );
    }

    return ok(Object.freeze({
      profile: structuredClone(value.profile),
      next_flow_key: "MENU",
    }), {
      duplicate: value.duplicate === true,
    });
  }

  return Object.freeze({ complete });
}

module.exports = {
  createSupabaseOnboardingProfileCompleter,
  operationKey,
  validateProfileData,
};
