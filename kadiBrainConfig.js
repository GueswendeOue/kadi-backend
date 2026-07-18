"use strict";

const BRAIN_MODES = Object.freeze({
  OFF: "off",
  SHADOW: "shadow",
  CANDIDATE: "candidate",
  ACTIVE_ALLOWLIST: "active_allowlist",
  ACTIVE: "active",
});

const VALID_BRAIN_MODES = new Set(Object.values(BRAIN_MODES));

function normalizeBrainMode(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return VALID_BRAIN_MODES.has(normalized) ? normalized : null;
}

function parseLegacyShadowFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function resolveBrainMode(env = process.env) {
  const source = env && typeof env === "object" ? env : {};
  const configuredMode = String(source.KADI_BRAIN_MODE ?? "").trim();

  if (configuredMode) {
    return normalizeBrainMode(configuredMode) || BRAIN_MODES.OFF;
  }

  return parseLegacyShadowFlag(source.KADI_BRAIN_SHADOW_ENABLED)
    ? BRAIN_MODES.SHADOW
    : BRAIN_MODES.OFF;
}

function isShadowObservationEnabled(mode) {
  return normalizeBrainMode(mode) === BRAIN_MODES.SHADOW;
}

module.exports = {
  BRAIN_MODES,
  normalizeBrainMode,
  parseLegacyShadowFlag,
  resolveBrainMode,
  isShadowObservationEnabled,
};
