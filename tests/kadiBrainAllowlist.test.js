"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BRAIN_ALLOWLIST_STATUSES,
  BRAIN_ALLOWLIST_REASONS,
  evaluateBrainActivationAllowlist,
} = require("../kadiBrainAllowlist");

function eligibility(overrides = {}) {
  return {
    status: "eligible",
    eligible: true,
    reason: "conversation_eligible",
    candidateId: "candidate_0123456789abcdef01234567",
    ...overrides,
  };
}

function activation(overrides = {}) {
  return {
    userId: null,
    userPhone: "22670000000",
    mode: "active_allowlist",
    allowlistedUserIds: [],
    allowlistedPhones: ["22670000000"],
    emergencyDisabled: false,
    ...overrides,
  };
}

function input(eligibilityOverrides = {}, activationOverrides = {}) {
  return {
    eligibilityDecision: eligibility(eligibilityOverrides),
    activationContext: activation(activationOverrides),
  };
}

test("exports exact immutable allowlist constants", () => {
  assert.deepEqual(BRAIN_ALLOWLIST_STATUSES, {
    ALLOWED: "allowed",
    REJECTED: "rejected",
  });
  assert.deepEqual(Object.values(BRAIN_ALLOWLIST_REASONS), [
    "activation_allowed", "invalid_input", "missing_eligibility_decision",
    "eligibility_not_ready", "invalid_activation_context", "emergency_disabled",
    "unsupported_mode", "mode_not_active", "global_active_not_enabled",
    "allowlist_required", "identity_required", "invalid_user_id",
    "invalid_phone", "user_not_allowlisted", "ambiguous_identity",
  ]);
  assert.equal(Object.isFrozen(BRAIN_ALLOWLIST_STATUSES), true);
  assert.equal(Object.isFrozen(BRAIN_ALLOWLIST_REASONS), true);
});

test("rejects invalid input and missing eligibility decision", () => {
  for (const value of [null, [], "input", 1]) {
    assert.equal(evaluateBrainActivationAllowlist(value).reason, "invalid_input");
  }
  for (const value of [undefined, null, [], "eligibility"]) {
    assert.equal(evaluateBrainActivationAllowlist({
      eligibilityDecision: value,
    }).reason, "missing_eligibility_decision");
  }
});

test("rejects every non-ready eligibility decision", () => {
  for (const overrides of [
    { status: "rejected" },
    { eligible: false },
    { reason: "confirmation_pending" },
    { candidateId: null },
    { candidateId: "" },
    { candidateId: "   " },
    { candidateId: 12 },
  ]) {
    assert.equal(
      evaluateBrainActivationAllowlist(input(overrides)).reason,
      "eligibility_not_ready",
    );
  }
});

test("returns a complete safe output for early failures", () => {
  const decision = evaluateBrainActivationAllowlist(null);
  assert.deepEqual(Object.keys(decision), [
    "status", "allowed", "reason", "candidateId", "userId",
    "normalizedPhone", "mode", "matchedBy", "metadata",
  ]);
  assert.deepEqual(decision, {
    status: "rejected",
    allowed: false,
    reason: "invalid_input",
    candidateId: null,
    userId: null,
    normalizedPhone: null,
    mode: null,
    matchedBy: null,
    metadata: {
      emergencyDisabled: false,
      hasUserId: false,
      hasPhone: false,
      userIdAllowlistSize: 0,
      phoneAllowlistSize: 0,
    },
  });
});

test("requires an explicit structurally valid activation context", () => {
  const base = activation();
  for (const value of [undefined, null, [], "context"]) {
    assert.equal(evaluateBrainActivationAllowlist({
      eligibilityDecision: eligibility(),
      activationContext: value,
    }).reason, "invalid_activation_context");
  }
  for (const field of Object.keys(base)) {
    const context = { ...base };
    delete context[field];
    assert.equal(evaluateBrainActivationAllowlist({
      eligibilityDecision: eligibility(),
      activationContext: context,
    }).reason, "invalid_activation_context", field);
  }
  for (const overrides of [
    { userId: 1 }, { userPhone: 1 }, { mode: null },
    { allowlistedUserIds: {} }, { allowlistedPhones: "22670000000" },
    { emergencyDisabled: "false" },
  ]) {
    assert.equal(
      evaluateBrainActivationAllowlist(input({}, overrides)).reason,
      "invalid_activation_context",
    );
  }
});

test("emergency disable has priority after structural validation", () => {
  const decision = evaluateBrainActivationAllowlist(input({}, {
    emergencyDisabled: true,
    mode: "UNKNOWN",
    allowlistedPhones: ["invalid#phone"],
  }));
  assert.equal(decision.reason, "emergency_disabled");
  assert.equal(decision.metadata.emergencyDisabled, true);
});

test("validates raw modes by exact equality without normalization", () => {
  for (const mode of [
    " active_allowlist", "active_allowlist ", "ACTIVE_ALLOWLIST",
    "activ_allowlist", "", "unknown",
  ]) {
    const decision = evaluateBrainActivationAllowlist(input({}, { mode }));
    assert.equal(decision.reason, "unsupported_mode", JSON.stringify(mode));
    assert.notEqual(decision.reason, "mode_not_active");
  }
});

test("keeps off, shadow and candidate inactive", () => {
  for (const mode of ["off", "shadow", "candidate"]) {
    assert.equal(
      evaluateBrainActivationAllowlist(input({}, { mode })).reason,
      "mode_not_active",
    );
  }
});

test("keeps global active closed during the MVP", () => {
  assert.equal(
    evaluateBrainActivationAllowlist(input({}, { mode: "active" })).reason,
    "global_active_not_enabled",
  );
});

test("accepts arrays and Sets and deduplicates copied allowlists", () => {
  const userIds = new Set(["user-1", "user-1"]);
  const phones = ["+226 70 00 00 00", "0022670000000", "22670000000"];
  const decision = evaluateBrainActivationAllowlist(input({}, {
    userId: "user-1",
    userPhone: "22670000000",
    allowlistedUserIds: userIds,
    allowlistedPhones: phones,
  }));
  assert.equal(decision.reason, "activation_allowed");
  assert.equal(decision.matchedBy, "both");
  assert.equal(decision.metadata.userIdAllowlistSize, 1);
  assert.equal(decision.metadata.phoneAllowlistSize, 1);
  assert.equal(userIds.size, 1);
  assert.equal(phones.length, 3);
});

test("rejects invalid content anywhere in either allowlist", () => {
  for (const allowlistedUserIds of [[""], [" user-1"], ["user-1 "], [1]]) {
    assert.equal(evaluateBrainActivationAllowlist(input({}, {
      allowlistedUserIds,
    })).reason, "invalid_activation_context");
  }
  for (const allowlistedPhones of [
    [""], ["phone"], ["+226/70000000"], [22670000000], ["+226#70000000"],
  ]) {
    assert.equal(evaluateBrainActivationAllowlist(input({}, {
      allowlistedPhones,
    })).reason, "invalid_activation_context");
  }
});

test("refuses when both normalized allowlists are empty", () => {
  assert.equal(evaluateBrainActivationAllowlist(input({}, {
    allowlistedPhones: [],
  })).reason, "allowlist_required");
});

test("requires at least one explicit identity", () => {
  assert.equal(evaluateBrainActivationAllowlist(input({}, {
    userPhone: null,
    allowlistedUserIds: ["user-1"],
    allowlistedPhones: [],
  })).reason, "identity_required");
});

test("validates user IDs without trimming or case conversion", () => {
  for (const userId of ["", " user-1", "user-1 "]) {
    assert.equal(evaluateBrainActivationAllowlist(input({}, {
      userId,
      userPhone: null,
      allowlistedUserIds: ["user-1"],
      allowlistedPhones: [],
    })).reason, "invalid_user_id");
  }
  for (const userId of ["USER-1", "user-10", "user"]) {
    assert.equal(evaluateBrainActivationAllowlist(input({}, {
      userId,
      userPhone: null,
      allowlistedUserIds: ["user-1"],
      allowlistedPhones: [],
    })).reason, "user_not_allowlisted");
  }
});

test("allows an exact user ID match only", () => {
  const candidateId = "candidate_UserId-EXACT_value";
  const decision = evaluateBrainActivationAllowlist(input(
    { candidateId },
    {
      userId: "user-1",
      userPhone: null,
      allowlistedUserIds: ["user-1"],
      allowlistedPhones: [],
    },
  ));
  assert.equal(decision.reason, "activation_allowed");
  assert.equal(decision.matchedBy, "user_id");
  assert.equal(decision.candidateId, candidateId);
});

test("normalizes only safe phone syntax", () => {
  const candidateId = "candidate_Phone-EXACT_value";
  for (const userPhone of [
    "22670000000", "+22670000000", "0022670000000",
    "+226 70 00 00 00", "+226-70-00-00-00", "+226 (70) 00 00 00",
  ]) {
    const decision = evaluateBrainActivationAllowlist(input(
      { candidateId },
      { userPhone },
    ));
    assert.equal(decision.reason, "activation_allowed", userPhone);
    assert.equal(decision.candidateId, candidateId);
    assert.equal(decision.normalizedPhone, "22670000000");
    assert.equal(decision.matchedBy, "phone");
  }
});

test("rejects invalid phones and never accepts JavaScript numbers", () => {
  for (const userPhone of [
    "phone", "+226/70000000", "+226#70000000", "++22670000000",
    "226+70000000", "1234567", "1234567890123456", 22670000000,
  ]) {
    const decision = evaluateBrainActivationAllowlist(input({}, { userPhone }));
    const expected = typeof userPhone === "string"
      ? "invalid_phone"
      : "invalid_activation_context";
    assert.equal(decision.reason, expected, String(userPhone));
  }
});

test("never infers a country code for local numbers", () => {
  const localOnly = evaluateBrainActivationAllowlist(input({}, {
    userPhone: "70000000",
  }));
  assert.equal(localOnly.reason, "user_not_allowlisted");
  assert.equal(localOnly.normalizedPhone, "70000000");

  const explicitlyLocal = evaluateBrainActivationAllowlist(input({}, {
    userPhone: "70000000",
    allowlistedPhones: ["70000000"],
  }));
  assert.equal(explicitlyLocal.reason, "activation_allowed");
  assert.equal(explicitlyLocal.normalizedPhone, "70000000");
});

test("applies exact dual-identity consistency rules", () => {
  const both = evaluateBrainActivationAllowlist(input({}, {
    userId: "user-1",
    allowlistedUserIds: ["user-1"],
  }));
  assert.equal(both.reason, "activation_allowed");
  assert.equal(both.matchedBy, "both");

  const userOnly = evaluateBrainActivationAllowlist(input({}, {
    userId: "user-1",
    allowlistedUserIds: ["user-1"],
    allowlistedPhones: ["22671111111"],
  }));
  assert.equal(userOnly.reason, "ambiguous_identity");

  const phoneOnly = evaluateBrainActivationAllowlist(input({}, {
    userId: "user-1",
    allowlistedUserIds: ["user-2"],
  }));
  assert.equal(phoneOnly.reason, "ambiguous_identity");

  const neither = evaluateBrainActivationAllowlist(input({}, {
    userId: "user-1",
    allowlistedUserIds: ["user-2"],
    allowlistedPhones: ["22671111111"],
  }));
  assert.equal(neither.reason, "user_not_allowlisted");
});

test("does not expose allowlist contents in output", () => {
  const decision = evaluateBrainActivationAllowlist(input({}, {
    userId: "private-user-id",
    allowlistedUserIds: ["private-user-id", "another-private-id"],
  }));
  const serialized = JSON.stringify(decision);
  assert.doesNotMatch(serialized, /another-private-id/);
  assert.equal(decision.metadata.userIdAllowlistSize, 2);
});

test("preserves candidateId unchanged on allowed and rejected decisions", () => {
  const candidateId = " candidate_Keep-Case-And-Spaces ";
  const allowed = evaluateBrainActivationAllowlist(input(
    { candidateId },
    { userPhone: "22670000000" },
  ));
  assert.equal(allowed.reason, "activation_allowed");
  assert.equal(allowed.candidateId, candidateId);

  const rejected = evaluateBrainActivationAllowlist(input(
    { candidateId },
    { userPhone: "22671111111" },
  ));
  assert.equal(rejected.reason, "user_not_allowlisted");
  assert.equal(rejected.candidateId, candidateId);
});

test("accepts frozen inputs without mutation and is deterministic", () => {
  const userIds = Object.freeze(["user-1"]);
  const phones = Object.freeze(["22670000000"]);
  const activationContext = Object.freeze(activation({
    userId: "user-1",
    allowlistedUserIds: userIds,
    allowlistedPhones: phones,
  }));
  const eligibilityDecision = Object.freeze(eligibility());
  const frozenInput = Object.freeze({ eligibilityDecision, activationContext });
  const first = evaluateBrainActivationAllowlist(frozenInput);
  const second = evaluateBrainActivationAllowlist(frozenInput);
  assert.deepEqual(first, second);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.metadata, second.metadata);
  assert.equal(first.candidateId, eligibilityDecision.candidateId);
  assert.deepEqual(userIds, ["user-1"]);
  assert.deepEqual(phones, ["22670000000"]);
});
