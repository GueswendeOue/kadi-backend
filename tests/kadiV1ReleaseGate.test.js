"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { FEATURE_ENV_KEYS, FLOW_ENV_KEYS } = require("../kadiV1RuntimeConfig");
const { KADI_V1_DRAFT_FLOW_CATALOG } = require("../kadiV1DraftFlowCatalog");
const {
  ASSET_ERROR_CODES,
  RELEASE_MODES,
  evaluateKadiV1ReleaseGate,
  inspectDraftFlowAssets,
} = require("../kadiV1ReleaseGate");

const ROOT = path.resolve(__dirname, "..");

function readyComposition() {
  return Object.freeze({
    ready: true,
    missing_capabilities: Object.freeze([]),
  });
}

function activationEnv() {
  const env = {
    KADI_V1_ENABLED: "true",
    KADI_V1_WEBHOOK_ENABLED: "true",
    KADI_V1_ROLLOUT_MODE: "CANARY",
    KADI_V1_CANARY_WA_IDS: "22670000000",
  };
  for (const envKey of Object.values(FEATURE_ENV_KEYS)) env[envKey] = "true";
  let sequence = 100000000000000;
  for (const envKey of Object.values(FLOW_ENV_KEYS)) env[envKey] = String(sequence++);
  return env;
}

function copyDraftAssets() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kadi-v1-release-gate-"));
  for (const entry of Object.values(KADI_V1_DRAFT_FLOW_CATALOG)) {
    const source = path.join(ROOT, entry.file);
    const target = path.join(root, entry.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return root;
}

test("release rehearsal passes only with master and webhook flags disabled", () => {
  const report = evaluateKadiV1ReleaseGate({ env: {}, mode: RELEASE_MODES.REHEARSAL, rootDir: ROOT });
  assert.equal(report.ok, true);
  assert.equal(report.verdict, "KADI_V1_RELEASE_REHEARSAL_PASS");
  assert.deepEqual(report.blockers, []);
  assert.equal(report.summary.valid_draft_flow_count, 15);
  assert.equal(report.summary.configured_flow_count, 0);
});

test("release rehearsal blocks a hidden webhook flag even while the global flag is false", () => {
  const report = evaluateKadiV1ReleaseGate({
    env: { KADI_V1_ENABLED: "false", KADI_V1_WEBHOOK_ENABLED: "true" },
    mode: RELEASE_MODES.REHEARSAL,
    rootDir: ROOT,
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers, ["WEBHOOK_FLAG_DISABLED"]);
});

test("activation blocks partial feature and Flow configuration without exposing values", () => {
  const secretFlowId = "999999999999999";
  const report = evaluateKadiV1ReleaseGate({
    env: {
      KADI_V1_ENABLED: "true",
      KADI_V1_WEBHOOK_ENABLED: "true",
      KADI_V1_BRAIN_ENABLED: "true",
      KADI_V1_FLOW_MENU_ID: secretFlowId,
    },
    mode: RELEASE_MODES.ACTIVATION,
    rootDir: ROOT,
  });
  assert.equal(report.ok, false);
  assert.ok(report.blockers.includes("REQUIRED_FEATURES_ENABLED"));
  assert.ok(report.blockers.includes("ALL_FLOW_IDS_CONFIGURED"));
  assert.ok(report.diagnostics.missing_features.includes("generation"));
  assert.ok(report.diagnostics.missing_flow_keys.includes("ONBOARDING"));
  assert.equal(JSON.stringify(report).includes(secretFlowId), false);
});

test("activation gate passes only for the complete V1 feature and Flow matrix", () => {
  const report = evaluateKadiV1ReleaseGate({
    env: activationEnv(),
    mode: RELEASE_MODES.ACTIVATION,
    rootDir: ROOT,
    compositionInspector: readyComposition,
  });
  assert.equal(report.ok, true);
  assert.equal(report.verdict, "KADI_V1_ACTIVATION_GATE_PASS");
  assert.equal(report.summary.enabled_required_feature_count, Object.keys(FEATURE_ENV_KEYS).length);
  assert.equal(report.summary.configured_flow_count, Object.keys(FLOW_ENV_KEYS).length);
  assert.deepEqual(report.diagnostics.missing_features, []);
  assert.deepEqual(report.diagnostics.missing_flow_keys, []);
});

test("activation fails closed when the real production composition is not supplied", () => {
  const report = evaluateKadiV1ReleaseGate({
    env: activationEnv(),
    mode: RELEASE_MODES.ACTIVATION,
    rootDir: ROOT,
  });
  assert.equal(report.ok, false);
  assert.ok(
    report.blockers.includes("PRODUCTION_COMPOSITION_READY")
  );
  assert.equal(report.summary.production_composition_ready, false);
  assert.ok(
    report.diagnostics.production_composition_missing.length >= 1
  );
  assert.equal(
    report.diagnostics.production_composition_missing.every(
      (entry) => typeof entry === "string" && entry.length > 0
    ),
    true
  );
});

test("activation rejects a BLOCKED boot readiness report with explicit missing ports", () => {
  const report = evaluateKadiV1ReleaseGate({
    env: activationEnv(),
    mode: RELEASE_MODES.ACTIVATION,
    rootDir: ROOT,
    compositionInspector: () => ({
      ready: false,
      missing_ports: ["presenter"],
      missing_capabilities: [],
    }),
  });
  assert.equal(report.ok, false);
  assert.ok(
    report.blockers.includes("PRODUCTION_COMPOSITION_READY")
  );
  assert.deepEqual(
    report.diagnostics.production_composition_missing,
    ["presenter"]
  );
});

test("activation blocks two logical Flow keys mapped to the same Meta Flow", () => {
  const env = activationEnv();
  env.KADI_V1_FLOW_MENU_ID = env.KADI_V1_FLOW_ONBOARDING_ID;
  const report = evaluateKadiV1ReleaseGate({ env, mode: RELEASE_MODES.ACTIVATION, rootDir: ROOT });
  assert.equal(report.ok, false);
  assert.ok(report.blockers.includes("FLOW_IDS_UNIQUE"));
  assert.deepEqual(report.diagnostics.duplicate_flow_keys, ["MENU", "ONBOARDING"]);
  assert.equal(JSON.stringify(report).includes(env.KADI_V1_FLOW_MENU_ID), false);
});


test("activation gate rejects FULL rollout and an empty canary", () => {
  const full = activationEnv();
  full.KADI_V1_ROLLOUT_MODE = "FULL";
  delete full.KADI_V1_CANARY_WA_IDS;
  const fullReport = evaluateKadiV1ReleaseGate({ env: full, mode: RELEASE_MODES.ACTIVATION, rootDir: ROOT });
  assert.equal(fullReport.ok, false);
  assert.ok(fullReport.blockers.includes("ROLLOUT_MODE_CANARY"));
  assert.equal(fullReport.summary.canary_owner_count, 0);

  const empty = activationEnv();
  delete empty.KADI_V1_CANARY_WA_IDS;
  const emptyReport = evaluateKadiV1ReleaseGate({ env: empty, mode: RELEASE_MODES.ACTIVATION, rootDir: ROOT });
  assert.equal(emptyReport.ok, false);
  assert.ok(emptyReport.blockers.includes("ROLLOUT_CONFIG_VALID"));
  assert.ok(emptyReport.blockers.includes("CANARY_OWNER_CONFIGURED"));
  assert.equal(emptyReport.diagnostics.rollout_error, "KADI_V1_CANARY_OWNER_REQUIRED");
});

test("rehearsal blocks a hidden canary or full rollout mode", () => {
  for (const mode of ["CANARY", "FULL"]) {
    const report = evaluateKadiV1ReleaseGate({
      env: {
        KADI_V1_ENABLED: "false",
        KADI_V1_WEBHOOK_ENABLED: "false",
        KADI_V1_ROLLOUT_MODE: mode,
        KADI_V1_CANARY_WA_IDS: mode === "CANARY" ? "22670000000" : "",
      },
      mode: RELEASE_MODES.REHEARSAL,
      rootDir: ROOT,
    });
    assert.equal(report.ok, false);
    assert.ok(report.blockers.includes("ROLLOUT_MODE_OFF"));
  }
});

test("draft asset inspection fails closed for a missing or malformed file", () => {
  const root = copyDraftAssets();
  const missingEntry = KADI_V1_DRAFT_FLOW_CATALOG.MENU;
  fs.unlinkSync(path.join(root, missingEntry.file));
  fs.writeFileSync(
    path.join(root, KADI_V1_DRAFT_FLOW_CATALOG.ONBOARDING.file),
    "{not-json",
    "utf8"
  );
  const result = inspectDraftFlowAssets({ rootDir: root });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.flow_key === "MENU" && error.code === ASSET_ERROR_CODES.FLOW_FILE_MISSING));
  assert.ok(result.errors.some((error) => error.flow_key === "ONBOARDING" && error.code === ASSET_ERROR_CODES.FLOW_FILE_INVALID_JSON));
});

test("draft asset inspection rejects the exact routing_model shape Meta refused for DOCUMENT_CONTENT", () => {
  const root = copyDraftAssets();
  const target = path.join(root, KADI_V1_DRAFT_FLOW_CATALOG.DOCUMENT_CONTENT.file);
  const json = JSON.parse(fs.readFileSync(target, "utf8"));
  // Meta's rejection: "ARTICLE_FORM n'est pas connecté au reste des écrans".
  json.routing_model.DOCUMENT_CONTENT = [];
  fs.writeFileSync(target, JSON.stringify(json), "utf8");
  const result = inspectDraftFlowAssets({ rootDir: root });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.flow_key === "DOCUMENT_CONTENT" && error.code === ASSET_ERROR_CODES.FLOW_FILE_CONTRACT_INVALID));
});

test("draft asset inspection accepts DOCUMENT_CONTENT -> ARTICLE_FORM as the only non-empty routing_model entry", () => {
  const root = copyDraftAssets();
  const target = path.join(root, KADI_V1_DRAFT_FLOW_CATALOG.DOCUMENT_CONTENT.file);
  const json = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(json.routing_model, { DOCUMENT_CONTENT: ["ARTICLE_FORM"], ARTICLE_FORM: [] });
  const result = inspectDraftFlowAssets({ rootDir: root });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("draft asset inspection rejects paths outside the repository boundary", () => {
  const catalog = {
    ...KADI_V1_DRAFT_FLOW_CATALOG,
    MENU: { ...KADI_V1_DRAFT_FLOW_CATALOG.MENU, file: path.join("..", "outside.json") },
  };
  const result = inspectDraftFlowAssets({ rootDir: ROOT, catalog });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.flow_key === "MENU" && error.code === ASSET_ERROR_CODES.CATALOG_PATH_INVALID));
});

test("the release rehearsal CLI is dry-run only and returns a sanitized PASS report", () => {
  const script = path.join(ROOT, "scripts", "kadiV1ReleaseRehearsal.js");
  const result = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      KADI_V1_RELEASE_MODE: "REHEARSAL",
      KADI_V1_ENABLED: "false",
      KADI_V1_WEBHOOK_ENABLED: "false",
      KADI_V1_FLOW_MENU_ID: "888888888888888",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verdict, "KADI_V1_RELEASE_REHEARSAL_PASS");
  assert.equal(result.stdout.includes("888888888888888"), false);
  assert.equal(/publish|deploy|migration/i.test(result.stdout), false);
});
