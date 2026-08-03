"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  IMMEDIATE_ROLLBACK_TRIGGERS,
  MANUAL_ROLLBACK_DRILL,
  POST_ACTIVATION_SMOKE_CHECKS,
} = require("../kadiV1ActivationEvidence");
const {
  createKadiV1CanarySmokeTemplate,
  evaluateKadiV1CanarySmoke,
} = require("../kadiV1CanarySmokeGate");

const SHA = "b".repeat(40);
const RUN_REF = "canary/run-2026-08-03T01:30Z";
const OBSERVED_AT = "2026-08-03T01:40:00Z";

function allChecks(value = true) {
  return Object.fromEntries(POST_ACTIVATION_SMOKE_CHECKS.map((key) => [key, value]));
}

function allTriggers(value = false) {
  return Object.fromEntries(IMMEDIATE_ROLLBACK_TRIGGERS.map((key) => [key, value]));
}

function validInput() {
  return {
    tested_commit_sha: SHA,
    canary_run_ref: RUN_REF,
    observed_at: OBSERVED_AT,
    checks: allChecks(),
    rollback_triggers: allTriggers(),
  };
}

test("canary smoke template is manual-only and covers the complete evidence contract", () => {
  const template = createKadiV1CanarySmokeTemplate();
  assert.equal(template.ok, true);
  assert.equal(template.verdict, "KADI_V1_CANARY_SMOKE_TEMPLATE_READY");
  assert.equal(template.execution_policy, "MANUAL_OBSERVATION_ONLY");
  assert.deepEqual(template.required_smoke_checks, POST_ACTIVATION_SMOKE_CHECKS);
  assert.deepEqual(template.required_rollback_trigger_observations, IMMEDIATE_ROLLBACK_TRIGGERS);
  assert.deepEqual(template.automatic_actions, []);
});

test("all smoke checks true and all rollback triggers false produce a sanitized pass", () => {
  const result = evaluateKadiV1CanarySmoke(validInput());
  assert.equal(result.ok, true);
  assert.equal(result.verdict, "KADI_V1_CANARY_SMOKE_PASS");
  assert.equal(result.rollback_required, false);
  assert.equal(result.summary.passed_smoke_check_count, POST_ACTIVATION_SMOKE_CHECKS.length);
  assert.equal(result.summary.clear_rollback_trigger_count, IMMEDIATE_ROLLBACK_TRIGGERS.length);
  assert.equal(JSON.stringify(result).includes(SHA), false);
  assert.equal(JSON.stringify(result).includes(RUN_REF), false);
});

test("one failed smoke check requires rollback and exposes only the controlled code", () => {
  const input = validInput();
  input.checks.NO_DOUBLE_USER_RESPONSE = false;
  const result = evaluateKadiV1CanarySmoke(input);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "KADI_V1_CANARY_ROLLBACK_REQUIRED");
  assert.equal(result.rollback_required, true);
  assert.deepEqual(result.failed_smoke_checks, ["NO_DOUBLE_USER_RESPONSE"]);
  assert.deepEqual(result.rollback_drill, MANUAL_ROLLBACK_DRILL);
});

test("one observed rollback trigger takes precedence over otherwise successful checks", () => {
  const input = validInput();
  input.rollback_triggers.DUPLICATE_WALLET_CAPTURE_DETECTED = true;
  const result = evaluateKadiV1CanarySmoke(input);
  assert.equal(result.verdict, "KADI_V1_CANARY_ROLLBACK_REQUIRED");
  assert.deepEqual(result.triggered_rollback_conditions, ["DUPLICATE_WALLET_CAPTURE_DETECTED"]);
});

test("missing or non-boolean observations fail closed without claiming rollback execution", () => {
  const input = validInput();
  delete input.checks.HISTORY_REMAINS_OWNER_SCOPED;
  input.rollback_triggers.NON_CANARY_OWNER_REACHED_V1 = "false";
  const result = evaluateKadiV1CanarySmoke(input);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "KADI_V1_CANARY_SMOKE_BLOCKED");
  assert.equal(result.rollback_required, false);
  assert.ok(result.blockers.includes("SMOKE_CHECKS_INCOMPLETE"));
  assert.ok(result.blockers.includes("ROLLBACK_TRIGGER_OBSERVATIONS_INCOMPLETE"));
});

test("unknown top-level and matrix fields are rejected", () => {
  const input = validInput();
  input.secret = "hidden";
  input.checks.EXTRA_CHECK = true;
  input.rollback_triggers.EXTRA_TRIGGER = false;
  const result = evaluateKadiV1CanarySmoke(input);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("UNKNOWN_CANARY_SMOKE_FIELD"));
  assert.ok(result.blockers.includes("SMOKE_UNKNOWN_BOOLEAN_MATRIX_FIELD"));
  assert.ok(result.blockers.includes("ROLLBACK_UNKNOWN_BOOLEAN_MATRIX_FIELD"));
  assert.equal(JSON.stringify(result).includes("hidden"), false);
});

test("commit, run reference and timezone-aware timestamp are mandatory", () => {
  const input = validInput();
  input.tested_commit_sha = "abc";
  input.canary_run_ref = "bad ref with spaces";
  input.observed_at = "2026-08-03T01:40:00";
  const result = evaluateKadiV1CanarySmoke(input);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("TESTED_COMMIT_SHA_INVALID"));
  assert.ok(result.blockers.includes("CANARY_RUN_REF_INVALID"));
  assert.ok(result.blockers.includes("OBSERVED_AT_INVALID"));
});

test("non-record input fails closed with no automatic action", () => {
  for (const value of [null, [], "x", 1]) {
    const result = evaluateKadiV1CanarySmoke(value);
    assert.equal(result.ok, false);
    assert.equal(result.verdict, "KADI_V1_CANARY_SMOKE_BLOCKED");
    assert.deepEqual(result.automatic_actions, []);
  }
});

test("rollback drill disables ingress before master and preserves additive data", () => {
  assert.equal(MANUAL_ROLLBACK_DRILL[0], "DISABLE_KADI_V1_WEBHOOK_ENABLED");
  assert.equal(MANUAL_ROLLBACK_DRILL[1], "DISABLE_KADI_V1_ENABLED");
  assert.ok(MANUAL_ROLLBACK_DRILL.includes("KEEP_ADDITIVE_DATABASE_OBJECTS_AND_IMMUTABLE_FILES"));
});

test("canary smoke template CLI prints a sanitized no-action report", () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/kadiV1CanarySmokeTemplate.js")], {
    encoding: "utf8",
    env: {
      ...process.env,
      KADI_V1_CANARY_WA_IDS: "22670000000",
      KADI_V1_FLOW_MENU_ID: "123456789012345",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.verdict, "KADI_V1_CANARY_SMOKE_TEMPLATE_READY");
  assert.equal(parsed.execution_policy, "MANUAL_OBSERVATION_ONLY");
  assert.equal(result.stdout.includes("22670000000"), false);
  assert.equal(result.stdout.includes("123456789012345"), false);
});
