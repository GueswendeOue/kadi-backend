"use strict";

const BRAIN_ALLOWLIST_STATUSES = Object.freeze({
  ALLOWED: "allowed",
  REJECTED: "rejected",
});

const BRAIN_ALLOWLIST_REASONS = Object.freeze({
  ACTIVATION_ALLOWED: "activation_allowed",
  INVALID_INPUT: "invalid_input",
  MISSING_ELIGIBILITY_DECISION: "missing_eligibility_decision",
  ELIGIBILITY_NOT_READY: "eligibility_not_ready",
  INVALID_ACTIVATION_CONTEXT: "invalid_activation_context",
  EMERGENCY_DISABLED: "emergency_disabled",
  UNSUPPORTED_MODE: "unsupported_mode",
  MODE_NOT_ACTIVE: "mode_not_active",
  GLOBAL_ACTIVE_NOT_ENABLED: "global_active_not_enabled",
  ALLOWLIST_REQUIRED: "allowlist_required",
  IDENTITY_REQUIRED: "identity_required",
  INVALID_USER_ID: "invalid_user_id",
  INVALID_PHONE: "invalid_phone",
  USER_NOT_ALLOWLISTED: "user_not_allowlisted",
  AMBIGUOUS_IDENTITY: "ambiguous_identity",
});

const EXACT_MODES = new Set([
  "off",
  "shadow",
  "candidate",
  "active_allowlist",
  "active",
]);
const INACTIVE_MODES = new Set(["off", "shadow", "candidate"]);
const REQUIRED_ACTIVATION_FIELDS = [
  "userId",
  "userPhone",
  "mode",
  "allowlistedUserIds",
  "allowlistedPhones",
  "emergencyDisabled",
];

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function emptyMetadata() {
  return {
    emergencyDisabled: false,
    hasUserId: false,
    hasPhone: false,
    userIdAllowlistSize: 0,
    phoneAllowlistSize: 0,
  };
}

function makeDecision({
  status = BRAIN_ALLOWLIST_STATUSES.REJECTED,
  reason,
  candidateId = null,
  userId = null,
  normalizedPhone = null,
  mode = null,
  matchedBy = null,
  metadata = emptyMetadata(),
}) {
  return {
    status,
    allowed: status === BRAIN_ALLOWLIST_STATUSES.ALLOWED,
    reason,
    candidateId,
    userId,
    normalizedPhone,
    mode,
    matchedBy,
    metadata: { ...metadata },
  };
}

function isReadyEligibilityDecision(decision) {
  return (
    decision.status === "eligible"
    && decision.eligible === true
    && decision.reason === "conversation_eligible"
    && typeof decision.candidateId === "string"
    && Boolean(decision.candidateId.trim())
  );
}

function isCollection(value) {
  return Array.isArray(value) || value instanceof Set;
}

function hasValidActivationStructure(context) {
  if (!REQUIRED_ACTIVATION_FIELDS.every((field) => Object.hasOwn(context, field))) {
    return false;
  }
  return (
    (context.userId === null || typeof context.userId === "string")
    && (context.userPhone === null || typeof context.userPhone === "string")
    && typeof context.mode === "string"
    && isCollection(context.allowlistedUserIds)
    && isCollection(context.allowlistedPhones)
    && typeof context.emergencyDisabled === "boolean"
  );
}

function isValidUserId(value) {
  return (
    typeof value === "string"
    && Boolean(value)
    && value === value.trim()
  );
}

function normalizePhone(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || !/^\+?[0-9 ()-]+$/.test(text)) return null;

  let compact = text.replace(/[ ()-]/g, "");
  if (compact.startsWith("+")) {
    compact = compact.slice(1);
  } else if (compact.startsWith("00")) {
    compact = compact.slice(2);
  }

  if (!/^\d{8,15}$/.test(compact)) return null;
  return compact;
}

function copyUserIdAllowlist(collection) {
  const result = new Set();
  for (const value of collection) {
    if (!isValidUserId(value)) return null;
    result.add(value);
  }
  return result;
}

function copyPhoneAllowlist(collection) {
  const result = new Set();
  for (const value of collection) {
    const normalized = normalizePhone(value);
    if (!normalized) return null;
    result.add(normalized);
  }
  return result;
}

function evaluateBrainActivationAllowlist(input) {
  if (!isPlainObject(input)) {
    return makeDecision({ reason: BRAIN_ALLOWLIST_REASONS.INVALID_INPUT });
  }

  const eligibility = input.eligibilityDecision;
  if (!isPlainObject(eligibility)) {
    return makeDecision({
      reason: BRAIN_ALLOWLIST_REASONS.MISSING_ELIGIBILITY_DECISION,
    });
  }
  if (!isReadyEligibilityDecision(eligibility)) {
    return makeDecision({ reason: BRAIN_ALLOWLIST_REASONS.ELIGIBILITY_NOT_READY });
  }

  const candidateFields = { candidateId: eligibility.candidateId };
  const context = input.activationContext;
  const reject = (reason, fields = {}) => makeDecision({
    reason,
    ...candidateFields,
    ...fields,
  });
  if (!isPlainObject(context) || !hasValidActivationStructure(context)) {
    return reject(BRAIN_ALLOWLIST_REASONS.INVALID_ACTIVATION_CONTEXT);
  }

  const structuralMetadata = {
    emergencyDisabled: context.emergencyDisabled,
    hasUserId: context.userId !== null,
    hasPhone: context.userPhone !== null,
    userIdAllowlistSize: 0,
    phoneAllowlistSize: 0,
  };
  const structuralFields = {
    userId: context.userId,
    mode: context.mode,
    metadata: structuralMetadata,
  };
  const rejectStructural = (reason, fields = {}) => reject(reason, {
    ...structuralFields,
    ...fields,
  });

  if (context.emergencyDisabled) {
    return rejectStructural(BRAIN_ALLOWLIST_REASONS.EMERGENCY_DISABLED);
  }
  if (!EXACT_MODES.has(context.mode)) {
    return rejectStructural(BRAIN_ALLOWLIST_REASONS.UNSUPPORTED_MODE);
  }
  if (INACTIVE_MODES.has(context.mode)) {
    return rejectStructural(BRAIN_ALLOWLIST_REASONS.MODE_NOT_ACTIVE);
  }
  if (context.mode === "active") {
    return rejectStructural(BRAIN_ALLOWLIST_REASONS.GLOBAL_ACTIVE_NOT_ENABLED);
  }
  if (context.mode !== "active_allowlist") {
    return rejectStructural(BRAIN_ALLOWLIST_REASONS.UNSUPPORTED_MODE);
  }

  const userIdAllowlist = copyUserIdAllowlist(context.allowlistedUserIds);
  const phoneAllowlist = copyPhoneAllowlist(context.allowlistedPhones);
  if (!userIdAllowlist || !phoneAllowlist) {
    return rejectStructural(BRAIN_ALLOWLIST_REASONS.INVALID_ACTIVATION_CONTEXT);
  }

  const metadata = {
    ...structuralMetadata,
    userIdAllowlistSize: userIdAllowlist.size,
    phoneAllowlistSize: phoneAllowlist.size,
  };
  const validatedFields = { ...structuralFields, metadata };
  const rejectValidated = (reason, fields = {}) => reject(reason, {
    ...validatedFields,
    ...fields,
  });

  if (userIdAllowlist.size === 0 && phoneAllowlist.size === 0) {
    return rejectValidated(BRAIN_ALLOWLIST_REASONS.ALLOWLIST_REQUIRED);
  }
  if (context.userId === null && context.userPhone === null) {
    return rejectValidated(BRAIN_ALLOWLIST_REASONS.IDENTITY_REQUIRED);
  }
  if (context.userId !== null && !isValidUserId(context.userId)) {
    return rejectValidated(BRAIN_ALLOWLIST_REASONS.INVALID_USER_ID);
  }

  const normalizedPhone = context.userPhone === null
    ? null
    : normalizePhone(context.userPhone);
  if (context.userPhone !== null && !normalizedPhone) {
    return rejectValidated(BRAIN_ALLOWLIST_REASONS.INVALID_PHONE);
  }

  const identityFields = { ...validatedFields, normalizedPhone };
  const userIdMatches = context.userId === null
    ? null
    : userIdAllowlist.has(context.userId);
  const phoneMatches = normalizedPhone === null
    ? null
    : phoneAllowlist.has(normalizedPhone);

  if (
    userIdMatches !== null
    && phoneMatches !== null
    && userIdMatches !== phoneMatches
  ) {
    return reject(BRAIN_ALLOWLIST_REASONS.AMBIGUOUS_IDENTITY, identityFields);
  }
  if (userIdMatches !== true && phoneMatches !== true) {
    return reject(BRAIN_ALLOWLIST_REASONS.USER_NOT_ALLOWLISTED, identityFields);
  }

  const matchedBy = userIdMatches === true && phoneMatches === true
    ? "both"
    : userIdMatches === true
      ? "user_id"
      : "phone";
  return makeDecision({
    status: BRAIN_ALLOWLIST_STATUSES.ALLOWED,
    reason: BRAIN_ALLOWLIST_REASONS.ACTIVATION_ALLOWED,
    ...identityFields,
    matchedBy,
  });
}

module.exports = {
  BRAIN_ALLOWLIST_STATUSES,
  BRAIN_ALLOWLIST_REASONS,
  evaluateBrainActivationAllowlist,
};
