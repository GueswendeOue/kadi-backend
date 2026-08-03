"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  EXPECTED_V1_MIGRATIONS,
  MANUAL_ACTIVATION_SEQUENCE,
  MIGRATION_ERROR_CODES,
  ROLLBACK_SEQUENCE,
  createKadiV1ActivationPreparationReport,
  inspectKadiV1MigrationAssets,
} = require("../kadiV1ActivationPreparation");

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kadi-v1-activation-"));
  fs.mkdirSync(path.join(root, "migrations"), { recursive: true });
  for (const file of EXPECTED_V1_MIGRATIONS) {
    fs.writeFileSync(
      path.join(root, "migrations", file),
      "-- additive only\ncreate table if not exists kadi_v1_fixture (id text primary key);\n",
      "utf8"
    );
  }
  return root;
}

function passingReleaseGate() {
  return {
    ok: true,
    verdict: "KADI_V1_RELEASE_REHEARSAL_PASS",
    blockers: [],
    summary: { expected_flow_count: 15, valid_draft_flow_count: 15 },
  };
}

test("migration preparation locks the seven additive files in dependency order", () => {
  const root = makeRoot();
  const result = inspectKadiV1MigrationAssets({ rootDir: root });
  assert.equal(result.ok, true);
  assert.equal(result.valid_migration_count, 7);
  assert.deepEqual(result.ordered_files, EXPECTED_V1_MIGRATIONS);
});

test("a missing migration blocks preparation without reading another path", () => {
  const root = makeRoot();
  fs.unlinkSync(path.join(root, "migrations", EXPECTED_V1_MIGRATIONS[2]));
  const result = inspectKadiV1MigrationAssets({ rootDir: root });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{
    file: EXPECTED_V1_MIGRATIONS[2],
    code: MIGRATION_ERROR_CODES.FILE_MISSING,
  }]);
});

test("destructive SQL is rejected before any operator action", () => {
  const root = makeRoot();
  fs.appendFileSync(
    path.join(root, "migrations", EXPECTED_V1_MIGRATIONS[0]),
    "drop table legacy_invoices;\n",
    "utf8"
  );
  const result = inspectKadiV1MigrationAssets({ rootDir: root });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, MIGRATION_ERROR_CODES.DESTRUCTIVE_SQL_FOUND);
});

test("activation preparation passes only after release rehearsal and migration inspection", () => {
  const root = makeRoot();
  const report = createKadiV1ActivationPreparationReport({
    env: { KADI_V1_ENABLED: "false", KADI_V1_WEBHOOK_ENABLED: "false" },
    rootDir: root,
    releaseGateEvaluator: passingReleaseGate,
  });
  assert.equal(report.ok, true);
  assert.equal(report.verdict, "KADI_V1_ACTIVATION_PREPARATION_PASS");
  assert.equal(report.execution_policy, "DRY_RUN_ONLY");
  assert.equal(report.summary.valid_migration_count, 7);
  assert.equal(report.summary.valid_draft_flow_count, 15);
});

test("a blocked release rehearsal keeps the activation preparation blocked", () => {
  const root = makeRoot();
  const report = createKadiV1ActivationPreparationReport({
    rootDir: root,
    releaseGateEvaluator: () => ({
      ok: false,
      verdict: "KADI_V1_RELEASE_GATE_BLOCKED",
      blockers: ["WEBHOOK_FLAG_DISABLED"],
      summary: { expected_flow_count: 15, valid_draft_flow_count: 15 },
    }),
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers, ["RELEASE_REHEARSAL_GATE_PASS"]);
  assert.deepEqual(report.diagnostics.release_blockers, ["WEBHOOK_FLAG_DISABLED"]);
});

test("the manual sequence forbids partial activation and enables flags only at the final control point", () => {
  const enableSteps = MANUAL_ACTIVATION_SEQUENCE.filter((step) => step.includes("ENABLE_"));
  assert.deepEqual(enableSteps, ["ENABLE_MASTER_AND_WEBHOOK_FLAGS_IN_ONE_CONTROLLED_CHANGE"]);
  assert.ok(
    MANUAL_ACTIVATION_SEQUENCE.indexOf(enableSteps[0])
      > MANUAL_ACTIVATION_SEQUENCE.indexOf("RUN_ACTIVATION_GATE_IN_ISOLATED_CANDIDATE_ENVIRONMENT")
  );
});

test("rollback disables ingress first and never rolls back additive data", () => {
  assert.equal(ROLLBACK_SEQUENCE[0], "DISABLE_V1_WEBHOOK_FIRST");
  assert.equal(ROLLBACK_SEQUENCE[1], "DISABLE_V1_MASTER_SECOND");
  assert.ok(ROLLBACK_SEQUENCE.includes("KEEP_ADDITIVE_MIGRATIONS_IN_PLACE"));
  assert.ok(ROLLBACK_SEQUENCE.includes("KEEP_DOCUMENTS_LEDGER_AND_PRIVATE_FILES_INTACT"));
});

test("preparation reports never expose environment values, Flow IDs or SQL", () => {
  const root = makeRoot();
  const secret = "secret-provider-token-123";
  const flowId = "12345678901234567890";
  const report = createKadiV1ActivationPreparationReport({
    env: {
      KADI_V1_ENABLED: "false",
      KADI_V1_WEBHOOK_ENABLED: "false",
      OPENAI_API_KEY: secret,
      KADI_V1_FLOW_MENU_ID: flowId,
    },
    rootDir: root,
    releaseGateEvaluator: passingReleaseGate,
  });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(flowId), false);
  assert.equal(serialized.toLowerCase().includes("create table"), false);
});

test("the repository CLI remains a dry-run preparation command", () => {
  const result = spawnSync(process.execPath, ["scripts/kadiV1ActivationPreparation.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      KADI_V1_ENABLED: "false",
      KADI_V1_WEBHOOK_ENABLED: "false",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verdict, "KADI_V1_ACTIVATION_PREPARATION_PASS");
  assert.equal(report.execution_policy, "DRY_RUN_ONLY");
  assert.deepEqual(report.prohibited_automatic_actions, [
    "NO_DATABASE_MIGRATION_EXECUTION",
    "NO_META_FLOW_CREATION_OR_PUBLICATION",
    "NO_RENDER_CONFIGURATION_CHANGE",
    "NO_REMOTE_FLAG_ACTIVATION",
    "NO_PRODUCTION_TRAFFIC",
  ]);
});
