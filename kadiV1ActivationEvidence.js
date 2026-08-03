"use strict";

const crypto = require("node:crypto");

const AUTHORIZATION_PHRASE = "AUTHORIZE_KADI_V1_CONTROLLED_ACTIVATION";
const MAX_REFERENCE_LENGTH = 160;

const REQUIRED_EVIDENCE_FIELDS = Object.freeze([
  "tested_commit_sha",
  "production_configuration_snapshot_ref",
  "database_recovery_point_ref",
  "meta_flow_validation_ref",
  "rollback_owner_ref",
  "canary_allowlist_ref",
  "canary_window_ref",
  "smoke_test_operator_ref",
  "approved_at",
]);

const PRE_ACTIVATION_FLAG_FIELDS = Object.freeze([
  "kadi_v1_enabled_before",
  "kadi_v1_webhook_enabled_before",
]);

const POST_ACTIVATION_SMOKE_CHECKS = Object.freeze([
  "WEBHOOK_VERIFICATION_STILL_VALID",
  "NFM_REPLY_HANDLED_BEFORE_LEGACY",
  "NON_CANARY_OWNER_REMAINS_ON_LEGACY",
  "NO_DOUBLE_USER_RESPONSE",
  "WELCOME_CREDITS_GRANTED_ONCE",
  "DRAFT_CREATION_HAS_NO_DEBIT_OR_FINAL_PDF",
  "PREVIEW_USES_REAL_PAGE_COUNT",
  "GENERATION_REQUIRES_EXPLICIT_CONFIRMATION",
  "GENERATION_DEBITS_EXACTLY_ONCE",
  "HISTORY_REMAINS_OWNER_SCOPED",
  "LEGACY_ROUTE_REMAINS_AVAILABLE_AFTER_ROLLBACK",
]);

const IMMEDIATE_ROLLBACK_TRIGGERS = Object.freeze([
  "DOUBLE_USER_RESPONSE_DETECTED",
  "CROSS_OWNER_DATA_ACCESS_DETECTED",
  "DUPLICATE_WALLET_CAPTURE_DETECTED",
  "FINAL_PDF_VERSION_OR_QUOTE_MISMATCH",
  "WELCOME_CREDITS_GRANTED_MORE_THAN_ONCE",
  "NFM_REPLY_FALLS_THROUGH_TO_LEGACY",
  "NON_CANARY_OWNER_REACHED_V1",
  "FLOW_KEY_OR_META_ID_MISMATCH",
  "LEGACY_ROUTE_UNAVAILABLE_AFTER_V1_FAILURE",
]);

const MANUAL_ROLLBACK_DRILL = Object.freeze([
  "DISABLE_KADI_V1_WEBHOOK_ENABLED",
  "DISABLE_KADI_V1_ENABLED",
  "VERIFY_ONE_LEGACY_TEXT_MESSAGE",
  "VERIFY_ONE_RECOGNIZED_NFM_REPLY_IS_NOT_DOUBLE_HANDLED",
  "VERIFY_NO_NEW_V1_WALLET_CAPTURE",
  "KEEP_ADDITIVE_DATABASE_OBJECTS_AND_IMMUTABLE_FILES",
  "RECORD_INCIDENT_REFERENCE_AND_OBSERVED_TRIGGER",
]);

const ALLOWED_EVIDENCE_KEYS = Object.freeze(new Set([
  ...REQUIRED_EVIDENCE_FIELDS,
  ...PRE_ACTIVATION_FLAG_FIELDS,
  "operator_authorization",
]));

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeReference(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_REFERENCE_LENGTH) return null;
  if (/\s{2,}/.test(normalized)) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/.test(normalized)) return null;
  return normalized;
}

function normalizeCommitSha(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(normalized) ? normalized : null;
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

function createKadiV1ActivationEvidenceTemplate({ preparationReport } = {}) {
  const preparationOk = preparationReport?.ok === true;
  return Object.freeze({
    ok: preparationOk,
    mode: "EVIDENCE_TEMPLATE",
    verdict: preparationOk
      ? "KADI_V1_ACTIVATION_EVIDENCE_TEMPLATE_READY"
      : "KADI_V1_ACTIVATION_EVIDENCE_TEMPLATE_BLOCKED",
    execution_policy: "NO_REMOTE_ACTION",
    required_fields: REQUIRED_EVIDENCE_FIELDS,
    required_pre_activation_flags: Object.freeze({
      kadi_v1_enabled_before: false,
      kadi_v1_webhook_enabled_before: false,
    }),
    required_operator_authorization: AUTHORIZATION_PHRASE,
    post_activation_smoke_checks: POST_ACTIVATION_SMOKE_CHECKS,
    immediate_rollback_triggers: IMMEDIATE_ROLLBACK_TRIGGERS,
    rollback_drill: MANUAL_ROLLBACK_DRILL,
    preparation_verdict: preparationReport?.verdict || "PREPARATION_REPORT_MISSING",
  });
}

function validateKadiV1ActivationEvidence({ preparationReport, evidence } = {}) {
  const blockers = [];
  const normalized = {};

  if (preparationReport?.ok !== true) {
    blockers.push("ACTIVATION_PREPARATION_NOT_PASSED");
  }
  if (!isPlainRecord(evidence)) {
    blockers.push("EVIDENCE_RECORD_REQUIRED");
    return Object.freeze({
      ok: false,
      verdict: "KADI_V1_ACTIVATION_EVIDENCE_BLOCKED",
      blockers: Object.freeze(blockers),
      evidence_status: Object.freeze({}),
      execution_policy: "NO_REMOTE_ACTION",
    });
  }

  const unknownKeys = Object.keys(evidence).filter((key) => !ALLOWED_EVIDENCE_KEYS.has(key));
  if (unknownKeys.length > 0) blockers.push("UNKNOWN_EVIDENCE_FIELD");

  const commitSha = normalizeCommitSha(evidence.tested_commit_sha);
  if (!commitSha) blockers.push("TESTED_COMMIT_SHA_INVALID");
  else normalized.tested_commit_sha = commitSha;

  for (const field of REQUIRED_EVIDENCE_FIELDS) {
    if (field === "tested_commit_sha" || field === "approved_at") continue;
    const reference = normalizeReference(evidence[field]);
    if (!reference) blockers.push(`${field.toUpperCase()}_INVALID`);
    else normalized[field] = reference;
  }

  const approvedAt = normalizeIsoTimestamp(evidence.approved_at);
  if (!approvedAt) blockers.push("APPROVED_AT_INVALID");
  else normalized.approved_at = approvedAt;

  for (const field of PRE_ACTIVATION_FLAG_FIELDS) {
    if (evidence[field] !== false) blockers.push(`${field.toUpperCase()}_MUST_BE_FALSE`);
    else normalized[field] = false;
  }

  if (evidence.operator_authorization !== AUTHORIZATION_PHRASE) {
    blockers.push("EXPLICIT_OPERATOR_AUTHORIZATION_REQUIRED");
  }

  const evidenceStatus = {};
  for (const field of REQUIRED_EVIDENCE_FIELDS) {
    const value = normalized[field];
    evidenceStatus[field] = Object.freeze({
      present: typeof value === "string" && value.length > 0,
      fingerprint: typeof value === "string" && value.length > 0 ? fingerprint(value) : null,
    });
  }

  const ok = blockers.length === 0;
  return Object.freeze({
    ok,
    verdict: ok
      ? "KADI_V1_ACTIVATION_EVIDENCE_READY_FOR_MANUAL_EXECUTION"
      : "KADI_V1_ACTIVATION_EVIDENCE_BLOCKED",
    blockers: Object.freeze([...new Set(blockers)]),
    evidence_status: Object.freeze(evidenceStatus),
    required_smoke_checks: POST_ACTIVATION_SMOKE_CHECKS,
    immediate_rollback_triggers: IMMEDIATE_ROLLBACK_TRIGGERS,
    rollback_drill: MANUAL_ROLLBACK_DRILL,
    execution_policy: "MANUAL_EXECUTION_ONLY",
    automatic_actions: Object.freeze([]),
  });
}

module.exports = {
  AUTHORIZATION_PHRASE,
  IMMEDIATE_ROLLBACK_TRIGGERS,
  MANUAL_ROLLBACK_DRILL,
  MAX_REFERENCE_LENGTH,
  POST_ACTIVATION_SMOKE_CHECKS,
  PRE_ACTIVATION_FLAG_FIELDS,
  REQUIRED_EVIDENCE_FIELDS,
  createKadiV1ActivationEvidenceTemplate,
  validateKadiV1ActivationEvidence,
};
