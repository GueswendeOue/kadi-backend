"use strict";

const { createKadiV1RolloutConfig } = require("./kadiV1CanaryIngress");

const FEATURE_ENV_KEYS = Object.freeze({
  brain: "KADI_V1_BRAIN_ENABLED",
  vision: "KADI_V1_VISION_ENABLED",
  transcription: "KADI_V1_TRANSCRIPTION_ENABLED",
  voice: "KADI_V1_VOICE_ENABLED",
  private_storage: "KADI_V1_PRIVATE_STORAGE_ENABLED",
  generation: "KADI_V1_GENERATION_ENABLED",
  recharge: "KADI_V1_RECHARGE_ENABLED",
  history: "KADI_V1_HISTORY_ENABLED",
  webhook: "KADI_V1_WEBHOOK_ENABLED",
});

const FLOW_ENV_KEYS = Object.freeze({
  ONBOARDING: "KADI_V1_FLOW_ONBOARDING_ID",
  MENU: "KADI_V1_FLOW_MENU_ID",
  DOCUMENT_TYPE: "KADI_V1_FLOW_DOCUMENT_TYPE_ID",
  INVOICE_TYPE: "KADI_V1_FLOW_INVOICE_TYPE_ID",
  RECEIPT_DETAILS: "KADI_V1_FLOW_RECEIPT_DETAILS_ID",
  DOCUMENT_CLIENT: "KADI_V1_FLOW_DOCUMENT_CLIENT_ID",
  DOCUMENT_CONTENT: "KADI_V1_FLOW_DOCUMENT_CONTENT_ID",
  ARTICLE_FORM: "KADI_V1_FLOW_ARTICLE_FORM_ID",
  DOCUMENT_OPTIONS: "KADI_V1_FLOW_DOCUMENT_OPTIONS_ID",
  DOCUMENT_REVIEW: "KADI_V1_FLOW_DOCUMENT_REVIEW_ID",
  EDIT_CLIENT: "KADI_V1_FLOW_EDIT_CLIENT_ID",
  EDIT_CONTENT: "KADI_V1_FLOW_EDIT_CONTENT_ID",
  EDIT_OPTIONS: "KADI_V1_FLOW_EDIT_OPTIONS_ID",
  DOCUMENT_PREVIEW: "KADI_V1_FLOW_DOCUMENT_PREVIEW_ID",
  GENERATION_CONFIRMATION: "KADI_V1_FLOW_GENERATION_CONFIRMATION_ID",
  RECHARGE: "KADI_V1_FLOW_RECHARGE_ID",
  HISTORY_SEARCH: "KADI_V1_FLOW_HISTORY_SEARCH_ID",
  DISCHARGE_DETAILS: "KADI_V1_FLOW_DISCHARGE_DETAILS_ID",
});

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off", ""]);
const FLOW_ID_PATTERN = /^\d{5,30}$/;

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return false;
}

function readFlowId(env, envKey) {
  const raw = String(env?.[envKey] ?? "").trim();
  return FLOW_ID_PATTERN.test(raw) ? raw : null;
}

function createKadiV1RuntimeConfig(env = process.env) {
  const enabled = parseBoolean(env?.KADI_V1_ENABLED, false);
  const features = Object.fromEntries(
    Object.entries(FEATURE_ENV_KEYS).map(([feature, envKey]) => [
      feature,
      enabled && parseBoolean(env?.[envKey], false),
    ])
  );
  const rollout = createKadiV1RolloutConfig(env);
  const flowIds = Object.fromEntries(
    Object.entries(FLOW_ENV_KEYS).map(([flowKey, envKey]) => [flowKey, readFlowId(env, envKey)])
  );

  return Object.freeze({
    enabled,
    features: Object.freeze(features),
    rollout,
    flowIds: Object.freeze(flowIds),
  });
}

function resolveConfiguredFlowId(config, flowKey) {
  if (!config?.enabled) return { ok: false, error: "KADI_V1_DISABLED" };
  if (!Object.hasOwn(FLOW_ENV_KEYS, flowKey)) return { ok: false, error: "KADI_V1_FLOW_KEY_UNKNOWN" };
  const flowId = config.flowIds?.[flowKey];
  if (!FLOW_ID_PATTERN.test(flowId || "")) return { ok: false, error: "KADI_V1_FLOW_ID_MISSING" };
  return { ok: true, value: flowId };
}

module.exports = {
  FEATURE_ENV_KEYS,
  FLOW_ENV_KEYS,
  createKadiV1RuntimeConfig,
  parseBoolean,
  resolveConfiguredFlowId,
};
