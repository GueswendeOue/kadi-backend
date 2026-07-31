"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  KADI_BRAIN_SHADOW_VERSION,
  KADI_BRAIN_SHADOW_STATUSES,
  KADI_BRAIN_CONFIDENCE_BUCKETS,
  KADI_BRAIN_LATENCY_BUCKETS,
  confidenceBucket,
  latencyBucket,
  hashMessageId,
  createKadiBrainShadowResult,
} = require("../kadiBrainShadowResult");

const RESULT_KEYS = [
  "shadowVersion", "status", "sourceType", "messageIdHash",
  "providerStatus", "providerFailureKind", "parserValid",
  "parserFailureCode", "intent", "confidenceBucket", "actionable",
  "missingFieldCount", "blockingAmbiguityCount", "safetyFlags",
  "latencyBucket", "execution", "timestamp",
];

test("shadow result exports exact frozen constants and bounded keys", () => {
  assert.equal(KADI_BRAIN_SHADOW_VERSION, "kadi.brain-real-shadow.v1");
  for (const value of [
    KADI_BRAIN_SHADOW_STATUSES,
    KADI_BRAIN_CONFIDENCE_BUCKETS,
    KADI_BRAIN_LATENCY_BUCKETS,
  ]) assert.equal(Object.isFrozen(value), true);
  const result = createKadiBrainShadowResult({
    status: "SUCCEEDED",
    sourceType: "text",
    messageId: "raw-private-message-id",
    providerStatus: "SUCCEEDED",
    providerFailureKind: "NONE",
    parserValid: true,
    intent: "CREATE_INVOICE",
    confidence: 0.9,
    actionable: true,
    missingFieldCount: 0,
    blockingAmbiguityCount: 0,
    safetyFlags: {
      containsSensitiveData: false,
      requiresHumanReview: false,
    },
    latencyMs: 249,
    timestamp: "2026-08-01T00:00:00.000Z",
  });
  assert.deepEqual(Object.keys(result), RESULT_KEYS);
  assert.equal(result.execution, "NONE");
  assert.equal(JSON.stringify(result).includes("raw-private-message-id"), false);
});

test("shadow result projects every failure without raw input", () => {
  for (const status of Object.values(KADI_BRAIN_SHADOW_STATUSES)) {
    const result = createKadiBrainShadowResult({
      status,
      sourceType: "voice",
      messageId: "PRIVATE_MESSAGE_ID",
      providerStatus: "FAILED",
      providerFailureKind: "AUTHENTICATION",
      parserFailureCode: "INVALID_JSON",
      intent: "UNKNOWN",
      timestamp: "2026-08-01T00:00:00.000Z",
      raw: "PRIVATE_RAW",
      content: "PRIVATE_CONTENT",
      restorationMap: { PERSON_1: "PRIVATE_NAME" },
    });
    const serialized = JSON.stringify(result);
    for (const sentinel of [
      "PRIVATE_MESSAGE_ID", "PRIVATE_RAW", "PRIVATE_CONTENT", "PRIVATE_NAME",
    ]) assert.equal(serialized.includes(sentinel), false);
    assert.equal(result.execution, "NONE");
  }
});

test("confidence and latency bucket boundaries are exact", () => {
  assert.deepEqual(
    [undefined, -1, 0, 0.499, 0.5, 0.749, 0.75, 1]
      .map(confidenceBucket),
    ["NONE", "LOW", "LOW", "LOW", "MEDIUM", "MEDIUM", "HIGH", "HIGH"]
  );
  assert.deepEqual(
    [undefined, -1, 0, 249, 250, 999, 1000, 2999, 3000]
      .map(latencyBucket),
    [
      "NONE", "NONE", "LT_250MS", "LT_250MS", "LT_1S", "LT_1S",
      "LT_3S", "LT_3S", "GTE_3S",
    ]
  );
});

test("safety flags and counts are canonical and bounded", () => {
  const result = createKadiBrainShadowResult({
    status: "SUCCEEDED",
    safetyFlags: {
      containsSensitiveData: true,
      requiresHumanReview: true,
      reason: "PRIVATE_REASON",
    },
    missingFieldCount: 999,
    blockingAmbiguityCount: -1,
  });
  assert.deepEqual(result.safetyFlags, {
    containsSensitiveData: true,
    requiresHumanReview: true,
  });
  assert.equal(result.missingFieldCount, 100);
  assert.equal(result.blockingAmbiguityCount, 0);
  assert.equal(JSON.stringify(result).includes("PRIVATE_REASON"), false);
});

test("message id hashing is deterministic, short, and injectable", () => {
  const first = hashMessageId("message-1");
  const second = hashMessageId("message-1");
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{16}$/u);
  assert.equal(first.includes("message-1"), false);
  assert.equal(
    hashMessageId("message-1", () => "abcdef0123456789abcdef"),
    "abcdef0123456789"
  );
  assert.equal(hashMessageId("", () => "abcdef0123456789"), null);
});

test("mapper accepts frozen input and is deterministic with injected time", () => {
  const input = Object.freeze({
    status: "SUCCEEDED",
    sourceType: "text",
    messageId: "message-2",
    confidence: 0.75,
    latencyMs: 250,
    timestamp: "2026-08-01T00:00:00.000Z",
    safetyFlags: Object.freeze({
      containsSensitiveData: false,
      requiresHumanReview: false,
    }),
  });
  const before = JSON.stringify(input);
  const first = createKadiBrainShadowResult(input);
  const second = createKadiBrainShadowResult(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), before);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.safetyFlags, second.safetyFlags);
});
