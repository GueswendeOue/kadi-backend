"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  AUTHORIZATION_PHRASE,
  IMMEDIATE_ROLLBACK_TRIGGERS,
  MANUAL_ROLLBACK_DRILL,
  POST_ACTIVATION_SMOKE_CHECKS,
  REQUIRED_EVIDENCE_FIELDS,
  createKadiV1ActivationEvidenceTemplate,
  validateKadiV1ActivationEvidence,
} = require("../kadiV1ActivationEvidence");

function passedPreparation() {
  return Object.freeze({
    ok: true,
    verdict: "KADI_V1_ACTIVATION_PREPARATION_PASS",
  });
}

function validEvidence() {
  return {
    tested_commit_sha: "b1e9108b1e9108b1e9108b1e9108b1e9108b1e91",
    production_configuration_snapshot_ref: "cfg-snapshot-20260803T010000Z",
    database_recovery_point_ref: "db-recovery-20260803T010100Z",
    meta_flow_validation_ref: "meta-flow-validation-15of15",
    rollback_owner_ref: "operator-primary",
    canary_allowlist_ref: "canary-allowlist-recorded",
    canary_window_ref: "canary-window-approved",
    smoke_test_operator_ref: "operator-smoke",
    approved_at: "2026-08-03T01:05:00Z",
    kadi_v1_enabled_before: false,
    kadi_v1_webhook_enabled_before: false,
    operator_authorization: AUTHORIZATION_PHRASE,
  };
}

test("activation evidence template exposes every manual control without executing anything", () => {
  const template = createKadiV1ActivationEvidenceTemplate({
    preparationReport: passedPreparation(),
  });

  assert.equal(template.ok, true);
  assert.equal(template.execution_policy, "NO_REMOTE_ACTION");
  assert.deepEqual(template.required_fields, REQUIRED_EVIDENCE_FIELDS);
  assert.equal(template.required_pre_activation_flags.kadi_v1_enabled_before, false);
  assert.equal(template.required_pre_activation_flags.kadi_v1_webhook_enabled_before, false);
  assert.deepEqual(template.post_activation_smoke_checks, POST_ACTIVATION_SMOKE_CHECKS);
  assert.deepEqual(template.immediate_rollback_triggers, IMMEDIATE_ROLLBACK_TRIGGERS);
  assert.deepEqual(template.rollback_drill, MANUAL_ROLLBACK_DRILL);
});

test("complete evidence becomes ready for manual execution only", () => {
  const result = validateKadiV1ActivationEvidence({
    preparationReport: passedPreparation(),
    evidence: validEvidence(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.verdict, "KADI_V1_ACTIVATION_EVIDENCE_READY_FOR_MANUAL_EXECUTION");
  assert.equal(result.execution_policy, "MANUAL_EXECUTION_ONLY");
  assert.deepEqual(result.automatic_actions, []);
  for (const field of REQUIRED_EVIDENCE_FIELDS) {
    assert.equal(result.evidence_status[field].present, true);
    assert.match(result.evidence_status[field].fingerprint, /^[0-9a-f]{16}$/);
  }
});

test("raw evidence references and authorization phrase never appear in the result", () => {
  const evidence = validEvidence();
  const result = validateKadiV1ActivationEvidence({
    preparationReport: passedPreparation(),
    evidence,
  });
  const serialized = JSON.stringify(result);

  for (const field of REQUIRED_EVIDENCE_FIELDS) {
    assert.equal(serialized.includes(evidence[field]), false);
  }
  assert.equal(serialized.includes(AUTHORIZATION_PHRASE), false);
});

test("missing preparation report blocks every activation evidence package", () => {
  const result = validateKadiV1ActivationEvidence({ evidence: validEvidence() });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("ACTIVATION_PREPARATION_NOT_PASSED"));
});

test("both production flags must be explicitly false before evidence approval", () => {
  const evidence = validEvidence();
  evidence.kadi_v1_enabled_before = true;
  evidence.kadi_v1_webhook_enabled_before = "false";

  const result = validateKadiV1ActivationEvidence({
    preparationReport: passedPreparation(),
    evidence,
  });

  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("KADI_V1_ENABLED_BEFORE_MUST_BE_FALSE"));
  assert.ok(result.blockers.includes("KADI_V1_WEBHOOK_ENABLED_BEFORE_MUST_BE_FALSE"));
});

test("authorization, commit sha and timezone-aware approval are mandatory", () => {
  const evidence = validEvidence();
  evidence.operator_authorization = "yes";
  evidence.tested_commit_sha = "b1e9108";
  evidence.approved_at = "2026-08-03 01:05:00";

  const result = validateKadiV1ActivationEvidence({
    preparationReport: passedPreparation(),
    evidence,
  });

  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("EXPLICIT_OPERATOR_AUTHORIZATION_REQUIRED"));
  assert.ok(result.blockers.includes("TESTED_COMMIT_SHA_INVALID"));
  assert.ok(result.blockers.includes("APPROVED_AT_INVALID"));
});

test("unknown, empty and oversized evidence fields fail closed", () => {
  const evidence = validEvidence();
  evidence.unknown = "value";
  evidence.rollback_owner_ref = "";
  evidence.canary_window_ref = "x".repeat(200);

  const result = validateKadiV1ActivationEvidence({
    preparationReport: passedPreparation(),
    evidence,
  });

  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("UNKNOWN_EVIDENCE_FIELD"));
  assert.ok(result.blockers.includes("ROLLBACK_OWNER_REF_INVALID"));
  assert.ok(result.blockers.includes("CANARY_WINDOW_REF_INVALID"));
});

test("rollback triggers cover financial, ownership and double-response failures", () => {
  assert.ok(IMMEDIATE_ROLLBACK_TRIGGERS.includes("DOUBLE_USER_RESPONSE_DETECTED"));
  assert.ok(IMMEDIATE_ROLLBACK_TRIGGERS.includes("CROSS_OWNER_DATA_ACCESS_DETECTED"));
  assert.ok(IMMEDIATE_ROLLBACK_TRIGGERS.includes("DUPLICATE_WALLET_CAPTURE_DETECTED"));
  assert.ok(IMMEDIATE_ROLLBACK_TRIGGERS.includes("NFM_REPLY_FALLS_THROUGH_TO_LEGACY"));
  assert.ok(IMMEDIATE_ROLLBACK_TRIGGERS.includes("NON_CANARY_OWNER_REACHED_V1"));
  assert.equal(new Set(IMMEDIATE_ROLLBACK_TRIGGERS).size, IMMEDIATE_ROLLBACK_TRIGGERS.length);
});

test("evidence template CLI remains a sanitized dry-run", () => {
  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, "../scripts/kadiV1ActivationEvidenceTemplate.js"),
  ], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      KADI_V1_ENABLED: "false",
      KADI_V1_WEBHOOK_ENABLED: "false",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verdict, "KADI_V1_ACTIVATION_EVIDENCE_TEMPLATE_READY");
  assert.equal(report.execution_policy, "NO_REMOTE_ACTION");
  assert.equal(JSON.stringify(report).includes("META_FLOW_ID"), false);
});
