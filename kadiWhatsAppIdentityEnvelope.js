"use strict";

const WHATSAPP_IDENTITY_STATUSES = Object.freeze({
  VALID: "valid",
  INVALID: "invalid",
});

const WHATSAPP_IDENTITY_EVENT_TYPES = Object.freeze({
  MESSAGE: "message",
  STATUS: "status",
  SYSTEM: "system",
  IDENTITY_UPDATE: "identity_update",
  UNKNOWN: "unknown",
});

const WHATSAPP_IDENTITY_SOURCES = Object.freeze({
  CONTACT_WA_ID: "contact_wa_id",
  MESSAGE_FROM: "message_from",
  STATUS_RECIPIENT_ID: "status_recipient_id",
  CONTACT_USER_ID: "contact_user_id",
  MESSAGE_FROM_USER_ID: "message_from_user_id",
  STATUS_RECIPIENT_USER_ID: "status_recipient_user_id",
  MIXED: "mixed",
  UNKNOWN: "unknown",
});

const WHATSAPP_IDENTITY_REASONS = Object.freeze({
  IDENTITY_VALID: "identity_valid",
  INVALID_INPUT: "invalid_input",
  INVALID_EVENT_TYPE: "invalid_event_type",
  INVALID_IDENTITY_SOURCE: "invalid_identity_source",
  MISSING_PRIMARY_IDENTITY: "missing_primary_identity",
  INVALID_FIELD_TYPE: "invalid_field_type",
  CONFLICTING_IDENTITY_STATE: "conflicting_identity_state",
});

const INPUT_KEYS = Object.freeze([
  "businessPortfolioId",
  "phoneNumberId",
  "waId",
  "bsuid",
  "parentBsuid",
  "username",
  "profileName",
  "eventType",
  "identitySource",
]);

const NULLABLE_IDENTITY_KEYS = INPUT_KEYS.slice(0, 7);
const EVENT_TYPES = new Set(Object.values(WHATSAPP_IDENTITY_EVENT_TYPES));
const IDENTITY_SOURCES = new Set(Object.values(WHATSAPP_IDENTITY_SOURCES));

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeString(value) {
  if (value === null) return null;
  const normalized = value.trim();
  return normalized || null;
}

function emptyIdentity() {
  return {
    businessPortfolioId: null,
    phoneNumberId: null,
    waId: null,
    bsuid: null,
    parentBsuid: null,
    username: null,
    profileName: null,
  };
}

function buildEnvelope(reason, identity = emptyIdentity(), eventType = null, identitySource = null) {
  const hasWaId = identity.waId !== null;
  const hasBsuid = identity.bsuid !== null;
  const hasParentBsuid = identity.parentBsuid !== null;
  const hasUsername = identity.username !== null;
  const hasProfileName = identity.profileName !== null;
  const valid = reason === WHATSAPP_IDENTITY_REASONS.IDENTITY_VALID;

  return {
    status: valid ? WHATSAPP_IDENTITY_STATUSES.VALID : WHATSAPP_IDENTITY_STATUSES.INVALID,
    valid,
    reason,
    identity: { ...identity },
    classification: {
      hasWaId,
      hasBsuid,
      hasParentBsuid,
      hasUsername,
      hasProfileName,
      isPhoneBacked: hasWaId,
      isBsuidBacked: hasBsuid,
      isDualIdentity: hasWaId && hasBsuid,
      isBsuidOnly: hasBsuid && !hasWaId,
      isWaIdOnly: hasWaId && !hasBsuid,
    },
    eventType,
    identitySource,
    metadata: {
      canResolveByWaId: hasWaId,
      canResolveByBsuid: hasBsuid,
      canResolveByUsername: false,
      requiresPortfolioScope: hasBsuid,
      requiresExplicitReconciliation:
        hasParentBsuid || (hasWaId && hasBsuid) || eventType === WHATSAPP_IDENTITY_EVENT_TYPES.IDENTITY_UPDATE,
    },
  };
}

function createWhatsAppIdentityEnvelope(input) {
  if (!isPlainObject(input)) {
    return buildEnvelope(WHATSAPP_IDENTITY_REASONS.INVALID_INPUT);
  }

  if (!INPUT_KEYS.every((key) => Object.prototype.hasOwnProperty.call(input, key))) {
    return buildEnvelope(WHATSAPP_IDENTITY_REASONS.INVALID_INPUT);
  }

  if (
    NULLABLE_IDENTITY_KEYS.some((key) => input[key] !== null && typeof input[key] !== "string") ||
    typeof input.eventType !== "string" ||
    typeof input.identitySource !== "string"
  ) {
    return buildEnvelope(WHATSAPP_IDENTITY_REASONS.INVALID_FIELD_TYPE);
  }

  const identity = {};
  for (const key of NULLABLE_IDENTITY_KEYS) identity[key] = normalizeString(input[key]);
  const eventType = normalizeString(input.eventType);
  const identitySource = normalizeString(input.identitySource);

  if (!EVENT_TYPES.has(eventType)) {
    return buildEnvelope(WHATSAPP_IDENTITY_REASONS.INVALID_EVENT_TYPE, identity, eventType, identitySource);
  }
  if (!IDENTITY_SOURCES.has(identitySource)) {
    return buildEnvelope(WHATSAPP_IDENTITY_REASONS.INVALID_IDENTITY_SOURCE, identity, eventType, identitySource);
  }
  if (!identity.waId && !identity.bsuid) {
    return buildEnvelope(WHATSAPP_IDENTITY_REASONS.MISSING_PRIMARY_IDENTITY, identity, eventType, identitySource);
  }
  if (identity.parentBsuid && identity.parentBsuid === identity.bsuid) {
    return buildEnvelope(WHATSAPP_IDENTITY_REASONS.CONFLICTING_IDENTITY_STATE, identity, eventType, identitySource);
  }

  return buildEnvelope(WHATSAPP_IDENTITY_REASONS.IDENTITY_VALID, identity, eventType, identitySource);
}

module.exports = {
  WHATSAPP_IDENTITY_STATUSES,
  WHATSAPP_IDENTITY_EVENT_TYPES,
  WHATSAPP_IDENTITY_SOURCES,
  WHATSAPP_IDENTITY_REASONS,
  createWhatsAppIdentityEnvelope,
};
