"use strict";

const ROLLOUT_MODES = Object.freeze({
  OFF: "OFF",
  CANARY: "CANARY",
  FULL: "FULL",
});

const MAX_CANARY_OWNERS = 20;
const OWNER_PATTERN = /^\d{8,20}$/;

function normalizeOwnerWaId(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim().replace(/^\+/, "");
  return OWNER_PATTERN.test(normalized) ? normalized : null;
}

function parseCanaryOwnerList(value, { maxOwners = MAX_CANARY_OWNERS } = {}) {
  if (!Number.isSafeInteger(maxOwners) || maxOwners < 1 || maxOwners > 100) {
    throw new TypeError("KADI_V1_CANARY_MAX_OWNERS_INVALID");
  }
  if (value == null || String(value).trim() === "") {
    return Object.freeze({ ok: true, owners: Object.freeze([]), error: null });
  }
  if (typeof value !== "string") {
    return Object.freeze({ ok: false, owners: Object.freeze([]), error: "KADI_V1_CANARY_OWNER_LIST_INVALID" });
  }

  const tokens = value.split(/[,;\s]+/).filter(Boolean);
  const owners = [];
  const seen = new Set();
  for (const token of tokens) {
    const owner = normalizeOwnerWaId(token);
    if (!owner) {
      return Object.freeze({ ok: false, owners: Object.freeze([]), error: "KADI_V1_CANARY_OWNER_INVALID" });
    }
    if (!seen.has(owner)) {
      seen.add(owner);
      owners.push(owner);
    }
  }
  if (owners.length > maxOwners) {
    return Object.freeze({ ok: false, owners: Object.freeze([]), error: "KADI_V1_CANARY_OWNER_LIMIT_EXCEEDED" });
  }
  return Object.freeze({ ok: true, owners: Object.freeze(owners), error: null });
}

function createKadiV1RolloutConfig(env = process.env) {
  const rawMode = String(env?.KADI_V1_ROLLOUT_MODE || ROLLOUT_MODES.OFF).trim().toUpperCase();
  const mode = Object.hasOwn(ROLLOUT_MODES, rawMode) ? rawMode : ROLLOUT_MODES.OFF;
  const owners = parseCanaryOwnerList(env?.KADI_V1_CANARY_WA_IDS);
  let error = rawMode === mode ? null : "KADI_V1_ROLLOUT_MODE_INVALID";

  if (!owners.ok) error = owners.error;
  if (!error && mode === ROLLOUT_MODES.CANARY && owners.owners.length === 0) {
    error = "KADI_V1_CANARY_OWNER_REQUIRED";
  }

  return Object.freeze({
    mode,
    valid: error == null,
    error,
    canaryOwnerCount: owners.owners.length,
    canaryWaIds: owners.owners,
  });
}

function isKadiV1OwnerAllowed(rollout, ownerWaId) {
  const owner = normalizeOwnerWaId(ownerWaId);
  if (!owner || !rollout || rollout.valid !== true) return false;
  if (rollout.mode === ROLLOUT_MODES.FULL) return true;
  if (rollout.mode !== ROLLOUT_MODES.CANARY) return false;
  return Array.isArray(rollout.canaryWaIds) && rollout.canaryWaIds.includes(owner);
}

// Independent allowlist for KADI_CONVERSATIONAL_MULTIMODAL_V1. Deliberately
// separate from KADI_V1_CANARY_WA_IDS/ROLLOUT_MODES above: a user in the
// general Kadi V1 CANARY list is not automatically eligible for the
// conversational-multimodal integration — eligibility requires explicit
// membership in KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS on top of
// the existing KADI V1 CANARY gate (checked separately by the caller).
// Reuses normalizeOwnerWaId/parseCanaryOwnerList rather than a second
// parser. Default (unset/empty) is zero eligible owners — not an error,
// since an empty conversational allowlist is the expected default state,
// unlike an empty general KADI_V1_CANARY_WA_IDS in CANARY mode.
function createKadiV1ConversationalMultimodalCanaryConfig(env = process.env) {
  const owners = parseCanaryOwnerList(env?.KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS);
  return Object.freeze({
    valid: owners.ok,
    error: owners.error,
    ownerCount: owners.owners.length,
    waIds: owners.owners,
  });
}

function isKadiV1ConversationalMultimodalOwnerAllowed(conversationalConfig, ownerWaId) {
  const owner = normalizeOwnerWaId(ownerWaId);
  if (!owner || !conversationalConfig || conversationalConfig.valid !== true) return false;
  return Array.isArray(conversationalConfig.waIds) && conversationalConfig.waIds.includes(owner);
}

module.exports = {
  MAX_CANARY_OWNERS,
  ROLLOUT_MODES,
  createKadiV1ConversationalMultimodalCanaryConfig,
  createKadiV1RolloutConfig,
  isKadiV1ConversationalMultimodalOwnerAllowed,
  isKadiV1OwnerAllowed,
  normalizeOwnerWaId,
  parseCanaryOwnerList,
};
