"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  FEATURE_ENV_KEYS,
  FLOW_ENV_KEYS,
  createKadiV1RuntimeConfig,
  parseBoolean,
} = require("./kadiV1RuntimeConfig");
const { KADI_V1_DRAFT_FLOW_CATALOG } = require("./kadiV1DraftFlowCatalog");
const { ROLLOUT_MODES } = require("./kadiV1CanaryIngress");
const {
  inspectKadiV1ProductionBootstrap,
} = require("./kadiV1ProductionBootstrap");

const RELEASE_MODES = Object.freeze({
  REHEARSAL: "REHEARSAL",
  ACTIVATION: "ACTIVATION",
});

const ASSET_ERROR_CODES = Object.freeze({
  CATALOG_KEY_MISSING: "CATALOG_KEY_MISSING",
  CATALOG_ENV_MISMATCH: "CATALOG_ENV_MISMATCH",
  CATALOG_PATH_INVALID: "CATALOG_PATH_INVALID",
  FLOW_FILE_MISSING: "FLOW_FILE_MISSING",
  FLOW_FILE_INVALID_JSON: "FLOW_FILE_INVALID_JSON",
  FLOW_FILE_CONTRACT_INVALID: "FLOW_FILE_CONTRACT_INVALID",
  FLOW_FILE_META_ID_EMBEDDED: "FLOW_FILE_META_ID_EMBEDDED",
});

function normalizeMode(mode) {
  const normalized = String(mode || RELEASE_MODES.REHEARSAL).trim().toUpperCase();
  return Object.hasOwn(RELEASE_MODES, normalized) ? normalized : null;
}

function isPathInside(rootDir, candidate) {
  const root = path.resolve(rootDir);
  const relative = path.relative(root, path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// DOCUMENT_CONTENT is the only Flow allowed to relax the locked one-screen
// contract: exactly two terminal, complete-only screens (DOCUMENT_CONTENT,
// ARTICLE_FORM), resolved by id, never by array position. Every other Flow
// keeps the original single-screen contract unchanged.
const MULTI_SCREEN_ENTRIES = Object.freeze({
  DOCUMENT_CONTENT: Object.freeze(["DOCUMENT_CONTENT", "ARTICLE_FORM"]),
});

function validateFlowJson(flowKey, json) {
  const expectedScreenIds = MULTI_SCREEN_ENTRIES[flowKey] || [flowKey];
  if (
    !json
    || json.version !== "7.3"
    || Object.hasOwn(json, "data_api_version")
    || !json.routing_model
    || !Array.isArray(json.screens)
    || json.screens.length !== expectedScreenIds.length
  ) {
    return false;
  }
  const routingKeys = Object.keys(json.routing_model);
  if (routingKeys.length !== expectedScreenIds.length) return false;
  const screensById = {};
  for (const screen of json.screens) {
    if (screen && typeof screen === "object" && typeof screen.id === "string") {
      screensById[screen.id] = screen;
    }
  }
  if (Object.keys(screensById).length !== expectedScreenIds.length) return false;
  return expectedScreenIds.every((id) => (
    Object.hasOwn(screensById, id)
    && screensById[id]?.terminal === true
    && routingKeys.includes(id)
    && Array.isArray(json.routing_model[id])
    && json.routing_model[id].length === 0
  ));
}

function inspectDraftFlowAssets({
  rootDir = __dirname,
  fileSystem = fs,
  catalog = KADI_V1_DRAFT_FLOW_CATALOG,
  flowEnvKeys = FLOW_ENV_KEYS,
} = {}) {
  const errors = [];
  const flowKeys = Object.keys(flowEnvKeys);
  let validFileCount = 0;

  for (const flowKey of flowKeys) {
    const entry = catalog?.[flowKey];
    if (!entry) {
      errors.push({ flow_key: flowKey, code: ASSET_ERROR_CODES.CATALOG_KEY_MISSING });
      continue;
    }
    if (entry.environment_variable !== flowEnvKeys[flowKey]) {
      errors.push({ flow_key: flowKey, code: ASSET_ERROR_CODES.CATALOG_ENV_MISMATCH });
    }

    const absolute = path.resolve(rootDir, entry.file || "");
    if (!entry.file || !isPathInside(rootDir, absolute)) {
      errors.push({ flow_key: flowKey, code: ASSET_ERROR_CODES.CATALOG_PATH_INVALID });
      continue;
    }
    if (!fileSystem.existsSync(absolute)) {
      errors.push({ flow_key: flowKey, code: ASSET_ERROR_CODES.FLOW_FILE_MISSING });
      continue;
    }

    let raw;
    let json;
    try {
      raw = fileSystem.readFileSync(absolute, "utf8");
      json = JSON.parse(raw);
    } catch {
      errors.push({ flow_key: flowKey, code: ASSET_ERROR_CODES.FLOW_FILE_INVALID_JSON });
      continue;
    }

    if (!validateFlowJson(flowKey, json)) {
      errors.push({ flow_key: flowKey, code: ASSET_ERROR_CODES.FLOW_FILE_CONTRACT_INVALID });
      continue;
    }
    if (/\b\d{15,30}\b/.test(raw)) {
      errors.push({ flow_key: flowKey, code: ASSET_ERROR_CODES.FLOW_FILE_META_ID_EMBEDDED });
      continue;
    }
    validFileCount += 1;
  }

  return Object.freeze({
    ok: errors.length === 0,
    expected_flow_count: flowKeys.length,
    valid_flow_count: validFileCount,
    errors: Object.freeze(errors.map((error) => Object.freeze(error))),
  });
}

function duplicateFlowKeys(flowIds) {
  const byId = new Map();
  for (const [flowKey, flowId] of Object.entries(flowIds || {})) {
    if (!flowId) continue;
    const keys = byId.get(flowId) || [];
    keys.push(flowKey);
    byId.set(flowId, keys);
  }
  return [...byId.values()].filter((keys) => keys.length > 1).flat().sort();
}

function evaluateKadiV1ReleaseGate({
  env = process.env,
  mode = RELEASE_MODES.REHEARSAL,
  rootDir = __dirname,
  fileSystem = fs,
  catalog = KADI_V1_DRAFT_FLOW_CATALOG,
  flowEnvKeys = FLOW_ENV_KEYS,
  featureEnvKeys = FEATURE_ENV_KEYS,
  compositionInspector = inspectKadiV1ProductionBootstrap,
} = {}) {
  const normalizedMode = normalizeMode(mode);
  if (!normalizedMode) {
    return Object.freeze({
      ok: false,
      mode: null,
      verdict: "KADI_V1_RELEASE_GATE_BLOCKED",
      blockers: Object.freeze(["KADI_V1_RELEASE_MODE_INVALID"]),
      checks: Object.freeze([]),
      diagnostics: Object.freeze({}),
    });
  }

  const config = createKadiV1RuntimeConfig(env);
  const rawGlobalEnabled = parseBoolean(env?.KADI_V1_ENABLED, false);
  const rawWebhookEnabled = parseBoolean(env?.KADI_V1_WEBHOOK_ENABLED, false);
  const assets = inspectDraftFlowAssets({ rootDir, fileSystem, catalog, flowEnvKeys });
  const requiredFeatures = Object.keys(featureEnvKeys);
  const missingFeatures = requiredFeatures.filter((feature) => config.features?.[feature] !== true);
  const missingFlowKeys = Object.keys(flowEnvKeys).filter((flowKey) => !config.flowIds?.[flowKey]);
  const duplicateKeys = duplicateFlowKeys(config.flowIds);
  const configuredFlowCount = Object.values(config.flowIds || {}).filter(Boolean).length;
  let composition;
  try {
    composition = typeof compositionInspector === "function"
      ? compositionInspector({ config, env, rootDir })
      : {
          ready: false,
          missing_capabilities: ["compositionInspector"],
        };
  } catch {
    composition = {
      ready: false,
      missing_capabilities: ["compositionInspector"],
    };
  }

  const productionCompositionMissing = Object.freeze([
    ...new Set([
      ...(Array.isArray(composition?.missing_ports)
        ? composition.missing_ports
        : []),
      ...(Array.isArray(composition?.missing_capabilities)
        ? composition.missing_capabilities
        : []),
    ]),
  ]);
  const checks = [];

  function addCheck(code, ok, detail) {
    checks.push(Object.freeze({ code, ok: Boolean(ok), detail }));
  }

  if (normalizedMode === RELEASE_MODES.REHEARSAL) {
    addCheck("MASTER_FLAG_DISABLED", !rawGlobalEnabled, rawGlobalEnabled ? "BLOCKED" : "PASS");
    addCheck("WEBHOOK_FLAG_DISABLED", !rawWebhookEnabled, rawWebhookEnabled ? "BLOCKED" : "PASS");
    addCheck("ROLLOUT_CONFIG_VALID", config.rollout?.valid === true, config.rollout?.valid === true ? "PASS" : "BLOCKED");
    addCheck("ROLLOUT_MODE_OFF", config.rollout?.mode === ROLLOUT_MODES.OFF, config.rollout?.mode === ROLLOUT_MODES.OFF ? "PASS" : "BLOCKED");
  } else {
    addCheck("MASTER_FLAG_ENABLED", rawGlobalEnabled, rawGlobalEnabled ? "PASS" : "BLOCKED");
    addCheck("WEBHOOK_FLAG_ENABLED", rawWebhookEnabled, rawWebhookEnabled ? "PASS" : "BLOCKED");
    addCheck(
      "REQUIRED_FEATURES_ENABLED",
      missingFeatures.length === 0,
      `${requiredFeatures.length - missingFeatures.length}/${requiredFeatures.length}`
    );
    addCheck(
      "ALL_FLOW_IDS_CONFIGURED",
      missingFlowKeys.length === 0,
      `${configuredFlowCount}/${Object.keys(flowEnvKeys).length}`
    );
    addCheck("FLOW_IDS_UNIQUE", duplicateKeys.length === 0, duplicateKeys.length === 0 ? "PASS" : "BLOCKED");
    addCheck("ROLLOUT_CONFIG_VALID", config.rollout?.valid === true, config.rollout?.valid === true ? "PASS" : "BLOCKED");
    addCheck("ROLLOUT_MODE_CANARY", config.rollout?.mode === ROLLOUT_MODES.CANARY, config.rollout?.mode === ROLLOUT_MODES.CANARY ? "PASS" : "BLOCKED");
    addCheck("CANARY_OWNER_CONFIGURED", Number.isSafeInteger(config.rollout?.canaryOwnerCount) && config.rollout.canaryOwnerCount > 0, `${config.rollout?.canaryOwnerCount || 0}`);
    addCheck(
      "PRODUCTION_COMPOSITION_READY",
      composition?.ready === true,
      composition?.ready === true
        ? "PASS"
        : `MISSING:${productionCompositionMissing.length || 1}`
    );
  }

  addCheck(
    "DRAFT_FLOW_ASSETS_VALID",
    assets.ok,
    `${assets.valid_flow_count}/${assets.expected_flow_count}`
  );

  const blockers = checks.filter((check) => !check.ok).map((check) => check.code);
  const ok = blockers.length === 0;
  const verdict = ok
    ? normalizedMode === RELEASE_MODES.REHEARSAL
      ? "KADI_V1_RELEASE_REHEARSAL_PASS"
      : "KADI_V1_ACTIVATION_GATE_PASS"
    : "KADI_V1_RELEASE_GATE_BLOCKED";

  return Object.freeze({
    ok,
    mode: normalizedMode,
    verdict,
    blockers: Object.freeze(blockers),
    checks: Object.freeze(checks),
    diagnostics: Object.freeze({
      missing_features: Object.freeze([...missingFeatures]),
      missing_flow_keys: Object.freeze([...missingFlowKeys]),
      duplicate_flow_keys: Object.freeze([...duplicateKeys]),
      rollout_error: config.rollout?.error || null,
      asset_errors: assets.errors,
      production_composition_missing:
        productionCompositionMissing,
    }),
    summary: Object.freeze({
      required_feature_count: requiredFeatures.length,
      enabled_required_feature_count: requiredFeatures.length - missingFeatures.length,
      expected_flow_count: Object.keys(flowEnvKeys).length,
      configured_flow_count: configuredFlowCount,
      valid_draft_flow_count: assets.valid_flow_count,
      rollout_mode: config.rollout?.mode || null,
      canary_owner_count: config.rollout?.canaryOwnerCount || 0,
      production_composition_ready: composition?.ready === true,
    }),
  });
}

module.exports = {
  ASSET_ERROR_CODES,
  RELEASE_MODES,
  evaluateKadiV1ReleaseGate,
  inspectDraftFlowAssets,
};
