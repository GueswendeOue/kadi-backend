"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  RELEASE_MODES,
  evaluateKadiV1ReleaseGate,
} = require("./kadiV1ReleaseGate");

const EXPECTED_V1_MIGRATIONS = Object.freeze([
  "20260802_create_kadi_v1_document_persistence.sql",
  "20260802_add_kadi_v1_onboarding.sql",
  "20260802_add_kadi_v1_preview_generation.sql",
  "20260802_add_kadi_v1_generation_lifecycle.sql",
  "20260802_add_kadi_v1_recharge.sql",
  "20260802_zz_add_kadi_v1_history_search.sql",
]);

const MIGRATION_ERROR_CODES = Object.freeze({
  FILE_MISSING: "MIGRATION_FILE_MISSING",
  FILE_NOT_REGULAR: "MIGRATION_FILE_NOT_REGULAR",
  FILE_TOO_LARGE: "MIGRATION_FILE_TOO_LARGE",
  FILE_EMPTY: "MIGRATION_FILE_EMPTY",
  FILE_UNREADABLE: "MIGRATION_FILE_UNREADABLE",
  DESTRUCTIVE_SQL_FOUND: "MIGRATION_DESTRUCTIVE_SQL_FOUND",
});

const MAX_MIGRATION_BYTES = 1024 * 1024;
const DESTRUCTIVE_SQL_PATTERNS = Object.freeze([
  /\bdrop\s+table\b/i,
  /\btruncate\s+(?:table\s+)?/i,
  /\bdelete\s+from\b/i,
  /\balter\s+table\b[\s\S]{0,240}\bdrop\s+(?:column|constraint)\b/i,
]);

const MANUAL_ACTIVATION_SEQUENCE = Object.freeze([
  "RECORD_CURRENT_PRODUCTION_CONFIGURATION",
  "APPLY_ADDITIVE_MIGRATIONS_IN_LOCKED_ORDER",
  "CREATE_AND_VALIDATE_ALL_META_FLOW_DRAFTS",
  "CONFIGURE_PROVIDER_KEYS_FLOW_IDS_AND_CANARY_ALLOWLIST_WITH_V1_DISABLED",
  "RUN_ACTIVATION_GATE_IN_ISOLATED_CANDIDATE_ENVIRONMENT",
  "RECORD_ROLLBACK_OWNER_AND_CANARY_WINDOW",
  "ENABLE_MASTER_AND_WEBHOOK_FLAGS_IN_ONE_CONTROLLED_CHANGE",
  "RUN_POST_ACTIVATION_SMOKE_CHECKS",
]);

const ROLLBACK_SEQUENCE = Object.freeze([
  "DISABLE_V1_WEBHOOK_FIRST",
  "DISABLE_V1_MASTER_SECOND",
  "KEEP_ADDITIVE_MIGRATIONS_IN_PLACE",
  "KEEP_DOCUMENTS_LEDGER_AND_PRIVATE_FILES_INTACT",
  "VERIFY_LEGACY_ROUTING_AND_NO_DOUBLE_RESPONSE",
]);

const REQUIRED_OPERATOR_CONFIRMATIONS = Object.freeze([
  "PRODUCTION_CONFIGURATION_SNAPSHOT_RECORDED",
  "DATABASE_BACKUP_OR_RECOVERY_POINT_CONFIRMED",
  "ALL_META_FLOW_DRAFTS_VALIDATED",
  "ROLLBACK_OWNER_ASSIGNED",
  "CANARY_ALLOWLIST_RECORDED",
  "CANARY_WINDOW_APPROVED",
]);

function isPathInside(rootDir, candidate) {
  const root = path.resolve(rootDir);
  const relative = path.relative(root, path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function inspectKadiV1MigrationAssets({
  rootDir = __dirname,
  fileSystem = fs,
  expectedFiles = EXPECTED_V1_MIGRATIONS,
  maxBytes = MAX_MIGRATION_BYTES,
} = {}) {
  const errors = [];
  let validCount = 0;
  const migrationsDir = path.resolve(rootDir, "migrations");

  for (const file of expectedFiles) {
    const absolute = path.resolve(migrationsDir, file);
    if (!isPathInside(rootDir, absolute)) {
      errors.push({ file, code: MIGRATION_ERROR_CODES.FILE_UNREADABLE });
      continue;
    }

    let stat;
    try {
      stat = fileSystem.statSync(absolute);
    } catch {
      errors.push({ file, code: MIGRATION_ERROR_CODES.FILE_MISSING });
      continue;
    }

    if (!stat.isFile()) {
      errors.push({ file, code: MIGRATION_ERROR_CODES.FILE_NOT_REGULAR });
      continue;
    }
    if (!Number.isSafeInteger(stat.size) || stat.size <= 0) {
      errors.push({ file, code: MIGRATION_ERROR_CODES.FILE_EMPTY });
      continue;
    }
    if (stat.size > maxBytes) {
      errors.push({ file, code: MIGRATION_ERROR_CODES.FILE_TOO_LARGE });
      continue;
    }

    let sql;
    try {
      sql = fileSystem.readFileSync(absolute, "utf8");
    } catch {
      errors.push({ file, code: MIGRATION_ERROR_CODES.FILE_UNREADABLE });
      continue;
    }

    if (!sql.trim()) {
      errors.push({ file, code: MIGRATION_ERROR_CODES.FILE_EMPTY });
      continue;
    }
    if (DESTRUCTIVE_SQL_PATTERNS.some((pattern) => pattern.test(sql))) {
      errors.push({ file, code: MIGRATION_ERROR_CODES.DESTRUCTIVE_SQL_FOUND });
      continue;
    }
    validCount += 1;
  }

  return Object.freeze({
    ok: errors.length === 0 && validCount === expectedFiles.length,
    expected_migration_count: expectedFiles.length,
    valid_migration_count: validCount,
    ordered_files: Object.freeze([...expectedFiles]),
    errors: Object.freeze(errors.map((error) => Object.freeze(error))),
  });
}

function createKadiV1ActivationPreparationReport({
  env = process.env,
  rootDir = __dirname,
  fileSystem = fs,
  releaseGateEvaluator = evaluateKadiV1ReleaseGate,
} = {}) {
  const releaseGate = releaseGateEvaluator({
    env,
    mode: RELEASE_MODES.REHEARSAL,
    rootDir,
    fileSystem,
  });
  const migrations = inspectKadiV1MigrationAssets({ rootDir, fileSystem });
  const checks = Object.freeze([
    Object.freeze({
      code: "RELEASE_REHEARSAL_GATE_PASS",
      ok: releaseGate?.ok === true,
      detail: releaseGate?.verdict || "KADI_V1_RELEASE_GATE_BLOCKED",
    }),
    Object.freeze({
      code: "ADDITIVE_MIGRATION_INVENTORY_VALID",
      ok: migrations.ok,
      detail: `${migrations.valid_migration_count}/${migrations.expected_migration_count}`,
    }),
    Object.freeze({
      code: "PREPARATION_IS_DRY_RUN_ONLY",
      ok: true,
      detail: "PASS",
    }),
  ]);
  const blockers = Object.freeze(checks.filter((check) => !check.ok).map((check) => check.code));
  const ok = blockers.length === 0;

  return Object.freeze({
    ok,
    mode: "PREPARATION",
    verdict: ok
      ? "KADI_V1_ACTIVATION_PREPARATION_PASS"
      : "KADI_V1_ACTIVATION_PREPARATION_BLOCKED",
    execution_policy: "DRY_RUN_ONLY",
    blockers,
    checks,
    summary: Object.freeze({
      expected_migration_count: migrations.expected_migration_count,
      valid_migration_count: migrations.valid_migration_count,
      expected_flow_count: releaseGate?.summary?.expected_flow_count || 0,
      valid_draft_flow_count: releaseGate?.summary?.valid_draft_flow_count || 0,
    }),
    diagnostics: Object.freeze({
      migration_errors: migrations.errors,
      release_blockers: Object.freeze([...(releaseGate?.blockers || [])]),
    }),
    migration_order: migrations.ordered_files,
    operator_confirmations: REQUIRED_OPERATOR_CONFIRMATIONS,
    manual_activation_sequence: MANUAL_ACTIVATION_SEQUENCE,
    rollback_sequence: ROLLBACK_SEQUENCE,
    prohibited_automatic_actions: Object.freeze([
      "NO_DATABASE_MIGRATION_EXECUTION",
      "NO_META_FLOW_CREATION_OR_PUBLICATION",
      "NO_RENDER_CONFIGURATION_CHANGE",
      "NO_REMOTE_FLAG_ACTIVATION",
      "NO_PRODUCTION_TRAFFIC",
    ]),
  });
}

module.exports = {
  EXPECTED_V1_MIGRATIONS,
  MANUAL_ACTIVATION_SEQUENCE,
  MAX_MIGRATION_BYTES,
  MIGRATION_ERROR_CODES,
  REQUIRED_OPERATOR_CONFIRMATIONS,
  ROLLBACK_SEQUENCE,
  createKadiV1ActivationPreparationReport,
  inspectKadiV1MigrationAssets,
};
