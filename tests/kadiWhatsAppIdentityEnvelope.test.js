"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  WHATSAPP_IDENTITY_STATUSES,
  WHATSAPP_IDENTITY_EVENT_TYPES,
  WHATSAPP_IDENTITY_SOURCES,
  WHATSAPP_IDENTITY_REASONS,
  createWhatsAppIdentityEnvelope,
} = require("../kadiWhatsAppIdentityEnvelope");

function identity(overrides = {}) {
  return {
    businessPortfolioId: null,
    phoneNumberId: null,
    waId: "wa-1",
    bsuid: null,
    parentBsuid: null,
    username: null,
    profileName: null,
    eventType: "message",
    identitySource: "message_from",
    ...overrides,
  };
}

test("exports exact frozen constants", () => {
  assert.deepEqual(WHATSAPP_IDENTITY_STATUSES, { VALID: "valid", INVALID: "invalid" });
  assert.deepEqual(Object.values(WHATSAPP_IDENTITY_EVENT_TYPES), ["message", "status", "system", "identity_update", "unknown"]);
  assert.deepEqual(Object.values(WHATSAPP_IDENTITY_SOURCES), ["contact_wa_id", "message_from", "status_recipient_id", "contact_user_id", "message_from_user_id", "status_recipient_user_id", "mixed", "unknown"]);
  assert.deepEqual(Object.values(WHATSAPP_IDENTITY_REASONS), ["identity_valid", "invalid_input", "invalid_event_type", "invalid_identity_source", "missing_primary_identity", "invalid_field_type", "conflicting_identity_state"]);
  for (const value of [WHATSAPP_IDENTITY_STATUSES, WHATSAPP_IDENTITY_EVENT_TYPES, WHATSAPP_IDENTITY_SOURCES, WHATSAPP_IDENTITY_REASONS]) assert.equal(Object.isFrozen(value), true);
});

test("accepts a waId-only identity", () => {
  const result = createWhatsAppIdentityEnvelope(identity());
  assert.equal(result.status, "valid");
  assert.equal(result.valid, true);
  assert.equal(result.reason, "identity_valid");
  assert.deepEqual(result.classification, { hasWaId: true, hasBsuid: false, hasParentBsuid: false, hasUsername: false, hasProfileName: false, isPhoneBacked: true, isBsuidBacked: false, isDualIdentity: false, isBsuidOnly: false, isWaIdOnly: true });
  assert.deepEqual(result.metadata, { canResolveByWaId: true, canResolveByBsuid: false, canResolveByUsername: false, requiresPortfolioScope: false, requiresExplicitReconciliation: false });
});

test("accepts a BSUID-only identity and requires portfolio scope", () => {
  const result = createWhatsAppIdentityEnvelope(identity({ waId: null, bsuid: "bsuid-1", identitySource: "contact_user_id" }));
  assert.equal(result.valid, true);
  assert.equal(result.classification.isBsuidOnly, true);
  assert.equal(result.classification.isBsuidBacked, true);
  assert.equal(result.metadata.canResolveByBsuid, true);
  assert.equal(result.metadata.requiresPortfolioScope, true);
});

test("accepts dual identity and requires explicit reconciliation", () => {
  const result = createWhatsAppIdentityEnvelope(identity({ bsuid: "bsuid-1", identitySource: "mixed" }));
  assert.equal(result.classification.isDualIdentity, true);
  assert.equal(result.metadata.requiresExplicitReconciliation, true);
});

test("username is informational and never resolvable", () => {
  const result = createWhatsAppIdentityEnvelope(identity({ username: "artisan" }));
  assert.equal(result.classification.hasUsername, true);
  assert.equal(result.metadata.canResolveByUsername, false);
});

test("rejects username, parent, profile name or portfolio without a primary identity", () => {
  for (const overrides of [{ username: "artisan" }, { parentBsuid: "parent" }, { profileName: "Awa" }, { businessPortfolioId: "portfolio" }]) {
    const result = createWhatsAppIdentityEnvelope(identity({ waId: null, ...overrides }));
    assert.equal(result.reason, "missing_primary_identity");
    assert.equal(result.valid, false);
  }
});

test("trims strings and converts empty strings to null without phone normalization", () => {
  const result = createWhatsAppIdentityEnvelope(identity({ businessPortfolioId: "  portfolio  ", phoneNumberId: "  ", waId: "  +226 70-00  ", username: "  artisan  ", eventType: " message ", identitySource: " message_from " }));
  assert.equal(result.valid, true);
  assert.deepEqual(result.identity, { businessPortfolioId: "portfolio", phoneNumberId: null, waId: "+226 70-00", bsuid: null, parentBsuid: null, username: "artisan", profileName: null });
  assert.equal(result.eventType, "message");
  assert.equal(result.identitySource, "message_from");
});

test("rejects non-plain inputs and missing top-level keys", () => {
  for (const value of [null, [], "identity", 1]) assert.equal(createWhatsAppIdentityEnvelope(value).reason, "invalid_input");
  const incomplete = identity();
  delete incomplete.username;
  assert.equal(createWhatsAppIdentityEnvelope(incomplete).reason, "invalid_input");
});

test("rejects invalid field types", () => {
  for (const overrides of [{ waId: 123 }, { bsuid: {} }, { eventType: null }, { identitySource: 1 }]) {
    assert.equal(createWhatsAppIdentityEnvelope(identity(overrides)).reason, "invalid_field_type");
  }
});

test("rejects invalid event types and identity sources", () => {
  assert.equal(createWhatsAppIdentityEnvelope(identity({ eventType: "delivery" })).reason, "invalid_event_type");
  assert.equal(createWhatsAppIdentityEnvelope(identity({ identitySource: "username" })).reason, "invalid_identity_source");
});

test("parent BSUID and identity updates require explicit reconciliation", () => {
  assert.equal(createWhatsAppIdentityEnvelope(identity({ parentBsuid: "parent" })).metadata.requiresExplicitReconciliation, true);
  assert.equal(createWhatsAppIdentityEnvelope(identity({ eventType: "identity_update" })).metadata.requiresExplicitReconciliation, true);
});

test("rejects a parent BSUID equal to the current BSUID", () => {
  const result = createWhatsAppIdentityEnvelope(identity({ waId: null, bsuid: "same", parentBsuid: " same ", identitySource: "contact_user_id" }));
  assert.equal(result.reason, "conflicting_identity_state");
});

test("accepts frozen inputs without mutation", () => {
  const input = Object.freeze(identity({ bsuid: " bsuid-1 ", identitySource: "mixed" }));
  const snapshot = { ...input };
  assert.doesNotThrow(() => createWhatsAppIdentityEnvelope(input));
  assert.deepEqual(input, snapshot);
});

test("is deterministic and returns independent output structures", () => {
  const input = identity({ bsuid: "bsuid-1", identitySource: "mixed" });
  const first = createWhatsAppIdentityEnvelope(input);
  const second = createWhatsAppIdentityEnvelope(input);
  assert.deepEqual(first, second);
  first.identity.waId = "changed";
  first.classification.hasWaId = false;
  first.metadata.canResolveByWaId = false;
  assert.deepEqual(createWhatsAppIdentityEnvelope(input), second);
});

test("does not generate internal or Brain identifiers", () => {
  const result = createWhatsAppIdentityEnvelope(identity());
  assert.equal(Object.hasOwn(result, "candidateId"), false);
  assert.equal(Object.hasOwn(result, "profileId"), false);
  assert.equal(Object.hasOwn(result.identity, "id"), false);
});
