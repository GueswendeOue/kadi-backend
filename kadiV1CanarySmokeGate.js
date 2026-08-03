"use strict";

const crypto = require("node:crypto");

const {
  IMMEDIATE_ROLLBACK_TRIGGERS,
  MANUAL_ROLLBACK_DRILL,
  POST_ACTIVATION_SMOKE_CHECKS,
} = require("./kadiV1ActivationEvidence");

const MAX_REFERENCE_LENGTH = 160;
const ALLOWED_INPUT_KEYS = Object.freeze(new Set([
  "tested_commit_sha",
  "canary_run_ref",
  "observed_at",
  "checks",
  "rollback_triggers",
]));

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeCommitSha(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(normalized) ? normalized : null;
}

function normalizeReference(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_REFERENCE_LENGTH) return null;
  if (/\s{2,}/.test(normalized)) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/.test(normalized) ? normalized : null;
}

function normalizeIsoTimestamp(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const timestamp = Date.parse(normalized);
  if (!normalized || !Number.isFinite(timestamp)) return null;
  if (!/(?:z|[+-]\d{2}:\d{2})$/i.test(normalized)) return null;
  return new Date(timestamp).toISOString();
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function inspectBooleanMatrix({ value, requiredKeys, trueMeansFailure }) {
  const blockers = [];
  const failed = [];
  const missing = [];

  if (!isPlainRecord(value)) {
    return Object.freeze({
      blockers: Object.freeze(["BOOLEAN_MATRIX_REQUIRED"]),
      failed: Object.freeze([]),
      missing: Object.freeze([...requiredKeys]),
    });
  }

  const required = new Set(requiredKeys);
  if (Object.keys(value).some((key) => !required.has(key))) {
    blockers.push("UNKNOWN_BOOLEAN_MATRIX_FIELD");
  }

  for (const key of requiredKeys) {
    if (typeof value[key] !== "boolean") {
      missing.push(key);
      continue;
    }
    if (trueMeansFailure ? value[key] : !value[key]) failed.push(key);
  }

  return Object.freeze({
    blockers: Object.freeze(blockers),
    failed: Object.freeze(failed),
    missing: Object.freeze(missing),
  });
}

function createKadiV1CanarySmokeTemplate() {
  return Object.freeze({
    ok: true,
    mode: "CANARY_SMOKE_TEMPLATE",
    verdict: "KADI_V1_CANARY_SMOKE_TEMPLATE_READY",
    execution_policy: "MANUAL_OBSERVATION_ONLY",
    required_fields: Object.freeze([
      "tested_commit_sha",
      "canary_run_ref",
      "observed_at",
      "checks",
      "rollback_triggers",
    ]),
    required_smoke_checks: POST_ACTIVATION_SMOKE_CHECKS,
    required_rollback_trigger_observations: IMMEDIATE_ROLLBACK_TRIGGERS,
    pass_rule: "ALL_SMOKE_CHECKS_TRUE_AND_ALL_ROLLBACK_TRIGGERS_FALSE",
    automatic_actions: Object.freeze([]),
  });
}

function evaluateKadiV1CanarySmoke(input = {}) {
  const blockers = [];
  const record = isPlainRecord(input) ? input : null;
  if (!record) {
    return Object.freeze({
      ok: false,
      verdict: "KADI_V1_CANARY_SMOKE_BLOCKED",
      rollback_required: false,
      blockers: Object.freeze(["CANARY_SMOKE_RECORD_REQUIRED"]),
      execution_policy: "NO_AUTOMATIC_REMOTE_ACTION",
      automatic_actions: Object.freeze([]),
    });
  }

  if (Object.keys(record).some((key) => !ALLOWED_INPUT_KEYS.has(key))) {
    blockers.push("UNKNOWN_CANARY_SMOKE_FIELD");
  }

  const commitSha = normalizeCommitSha(record.tested_commit_sha);
  const runRef = normalizeReference(record.canary_run_ref);
  const observedAt = normalizeIsoTimestamp(record.observed_at);
  if (!commitSha) blockers.push("TESTED_COMMIT_SHA_INVALID");
  if (!runRef) blockers.push("CANARY_RUN_REF_INVALID");
  if (!observedAt) blockers.push("OBSERVED_AT_INVALID");

  const checks = inspectBooleanMatrix({
    value: record.checks,
    requiredKeys: POST_ACTIVATION_SMOKE_CHECKS,
    trueMeansFailure: false,
  });
  const triggers = inspectBooleanMatrix({
    value: record.rollback_triggers,
    requiredKeys: IMMEDIATE_ROLLBACK_TRIGGERS,
    trueMeansFailure: true,
  });

  blockers.push(...checks.blockers.map((code) => `SMOKE_${code}`));
  blockers.push(...triggers.blockers.map((code) => `ROLLBACK_${code}`));
  if (checks.missing.length > 0) blockers.push("SMOKE_CHECKS_INCOMPLETE");
  if (triggers.missing.length > 0) blockers.push("ROLLBACK_TRIGGER_OBSERVATIONS_INCOMPLETE");

  const rollbackRequired = checks.failed.length > 0 || triggers.failed.length > 0;
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const ok = uniqueBlockers.length === 0 && !rollbackRequired;
  const verdict = rollbackRequired
    ? "KADI_V1_CANARY_ROLLBACK_REQUIRED"
    : ok
      ? "KADI_V1_CANARY_SMOKE_PASS"
      : "KADI_V1_CANARY_SMOKE_BLOCKED";

  return Object.freeze({
    ok,
    verdict,
    rollback_required: rollbackRequired,
    blockers: uniqueBlockers,
    failed_smoke_checks: checks.failed,
    triggered_rollback_conditions: triggers.failed,
    missing_smoke_checks: checks.missing,
    missing_rollback_trigger_observations: triggers.missing,
    evidence: Object.freeze({
      tested_commit_fingerprint: commitSha ? fingerprint(commitSha) : null,
      canary_run_fingerprint: runRef ? fingerprint(runRef) : null,
      observed_at: observedAt,
    }),
    summary: Object.freeze({
      expected_smoke_check_count: POST_ACTIVATION_SMOKE_CHECKS.length,
      passed_smoke_check_count: POST_ACTIVATION_SMOKE_CHECKS.length - checks.failed.length - checks.missing.length,
      expected_rollback_trigger_count: IMMEDIATE_ROLLBACK_TRIGGERS.length,
      clear_rollback_trigger_count: IMMEDIATE_ROLLBACK_TRIGGERS.length - triggers.failed.length - triggers.missing.length,
    }),
    rollback_drill: rollbackRequired ? MANUAL_ROLLBACK_DRILL : Object.freeze([]),
    execution_policy: "NO_AUTOMATIC_REMOTE_ACTION",
    automatic_actions: Object.freeze([]),
  });
}

module.exports = {
  MAX_REFERENCE_LENGTH,
  createKadiV1CanarySmokeTemplate,
  evaluateKadiV1CanarySmoke,
};
