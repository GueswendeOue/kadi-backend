"use strict";

const crypto = require("node:crypto");
const { BRAIN_STATUSES } = require("./kadiBrainContract");
const { evaluateBrainMvpPolicy } = require("./kadiBrainPolicy");

const BRAIN_CANDIDATE_STATUSES = Object.freeze({
  CANDIDATE: "candidate",
  REJECTED: "rejected",
});

const BRAIN_CANDIDATE_REASONS = Object.freeze({
  CANDIDATE_READY: "candidate_ready",
  INVALID_INPUT: "invalid_input",
  MISSING_BRAIN_RESULT: "missing_brain_result",
  INVALID_BRAIN_STATUS: "invalid_brain_status",
  BRAIN_RESULT_NOT_ACTIONABLE: "brain_result_not_actionable",
  POLICY_REJECTED: "policy_rejected",
  UNSUPPORTED_OPERATION: "unsupported_operation",
  MALFORMED_BRAIN_RESULT: "malformed_brain_result",
});

const ACTIONABLE_STATUSES = new Set(["understood", "needs_clarification"]);
const NON_ACTIONABLE_STATUSES = new Set(["unsupported", "unsafe", "failed"]);
const KNOWN_STATUSES = new Set(BRAIN_STATUSES);
const DOCUMENT_OPERATIONS = new Set(["create", "edit"]);
const PATCH_OPERATIONS = new Set(["add", "replace", "remove"]);
const MAX_LIST_LENGTH = 50;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function makeCandidateId(decision) {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(decision))
    .digest("hex")
    .slice(0, 24);
  return `candidate_${digest}`;
}

function makeDecision({
  status = BRAIN_CANDIDATE_STATUSES.REJECTED,
  reason,
  policyReason = null,
  mode = null,
  intent = null,
  documentType = null,
  operations = [],
  missingFields = [],
  ambiguities = [],
  warnings = [],
  hasText = false,
  isLocalCommand = false,
  isAdminCommand = false,
}) {
  const decision = {
    status,
    eligible: status === BRAIN_CANDIDATE_STATUSES.CANDIDATE,
    reason,
    policyReason,
    mode,
    intent,
    documentType,
    operations,
    missingFields,
    ambiguities,
    warnings,
    metadata: {
      hasText,
      isLocalCommand,
      isAdminCommand,
      operationCount: operations.length,
      missingFieldCount: missingFields.length,
      ambiguityCount: ambiguities.length,
      warningCount: warnings.length,
    },
  };

  return { candidateId: makeCandidateId(decision), ...decision };
}

function normalizeStringList(value) {
  if (!Array.isArray(value) || value.length > MAX_LIST_LENGTH) return null;
  if (value.some((entry) => typeof entry !== "string")) return null;
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function extractOperations(brainResult) {
  const operations = [];
  const documentOperation = brainResult.document?.operation;

  if (documentOperation !== null && documentOperation !== undefined) {
    if (!DOCUMENT_OPERATIONS.has(documentOperation)) return null;
    operations.push(documentOperation);
  }

  for (const patch of brainResult.patches) {
    if (!isPlainObject(patch) || !PATCH_OPERATIONS.has(patch.op)) return null;
    operations.push(patch.op);
  }

  return operations;
}

function buildBrainCandidateDecision(input) {
  if (!isPlainObject(input)) {
    return makeDecision({ reason: BRAIN_CANDIDATE_REASONS.INVALID_INPUT });
  }

  const baseMetadata = {
    hasText: typeof input.text === "string" && Boolean(input.text.trim()),
    isLocalCommand: input.isLocalCommand === true,
    isAdminCommand: input.isAdminCommand === true,
  };
  const brainResult = input.brainResult;
  const reject = (reason, extra = {}) =>
    makeDecision({ reason, ...baseMetadata, ...extra });

  if (!isPlainObject(brainResult)) {
    return reject(BRAIN_CANDIDATE_REASONS.MISSING_BRAIN_RESULT);
  }
  if (brainResult.providerFailed === true) {
    return reject(BRAIN_CANDIDATE_REASONS.BRAIN_RESULT_NOT_ACTIONABLE);
  }
  if (typeof brainResult.status !== "string" || !KNOWN_STATUSES.has(brainResult.status)) {
    return reject(BRAIN_CANDIDATE_REASONS.INVALID_BRAIN_STATUS);
  }
  if (NON_ACTIONABLE_STATUSES.has(brainResult.status)) {
    return reject(BRAIN_CANDIDATE_REASONS.BRAIN_RESULT_NOT_ACTIONABLE);
  }
  if (!ACTIONABLE_STATUSES.has(brainResult.status)) {
    return reject(BRAIN_CANDIDATE_REASONS.INVALID_BRAIN_STATUS);
  }

  const validIntent = isPlainObject(brainResult.intent)
    && typeof brainResult.intent.name === "string";
  const validDocument = brainResult.document === null
    || isPlainObject(brainResult.document);
  const missingFields = normalizeStringList(brainResult.missingFields);
  const ambiguities = normalizeStringList(brainResult.ambiguities);
  const warnings = normalizeStringList(brainResult.warnings);
  if (
    !validIntent
    || !validDocument
    || !Array.isArray(brainResult.patches)
    || brainResult.patches.length > MAX_LIST_LENGTH
    || !missingFields
    || !ambiguities
    || !warnings
  ) {
    return reject(BRAIN_CANDIDATE_REASONS.MALFORMED_BRAIN_RESULT);
  }

  const operations = extractOperations(brainResult);
  if (!operations) {
    return reject(BRAIN_CANDIDATE_REASONS.UNSUPPORTED_OPERATION, {
      missingFields,
      ambiguities,
      warnings,
    });
  }

  const policy = evaluateBrainMvpPolicy({
    mode: input.mode,
    text: input.text,
    isLocalCommand: input.isLocalCommand,
    isAdminCommand: input.isAdminCommand,
    intent: brainResult.intent.name,
    documentType: brainResult.document?.documentType,
  });
  const decisionFields = {
    policyReason: policy.reason,
    mode: policy.mode,
    intent: policy.intent,
    documentType: policy.documentType,
    operations,
    missingFields,
    ambiguities,
    warnings,
    hasText: policy.metadata.hasText,
    isLocalCommand: policy.metadata.isLocalCommand,
    isAdminCommand: policy.metadata.isAdminCommand,
  };

  if (!policy.eligible) {
    return makeDecision({
      reason: BRAIN_CANDIDATE_REASONS.POLICY_REJECTED,
      ...decisionFields,
    });
  }

  return makeDecision({
    status: BRAIN_CANDIDATE_STATUSES.CANDIDATE,
    reason: BRAIN_CANDIDATE_REASONS.CANDIDATE_READY,
    ...decisionFields,
  });
}

module.exports = {
  BRAIN_CANDIDATE_STATUSES,
  BRAIN_CANDIDATE_REASONS,
  buildBrainCandidateDecision,
};
