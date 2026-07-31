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
    assert.deepEqual(Object.keys(result), RESULT_KEYS);
    assert.deepEqual(Object.keys(result.safetyFlags), [
      "containsSensitiveData", "requiresHumanReview",
    ]);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.safetyFlags), true);
    assert.match(result.messageIdHash, /^[a-f0-9]{16}$/u);
    assert.equal(result.execution, "NONE");
  }
});

test("mapper drops every unknown field and keeps no external reference", () => {
  const external = {
    rawMessage: "PRIVATE_RAW",
    prompt: { content: "PRIVATE_PROMPT" },
    providerResponse: { content: "PRIVATE_PROVIDER" },
    parserResult: { rawJson: "PRIVATE_JSON" },
    restorationMap: { PERSON_1: "PRIVATE_NAME" },
    stack: "PRIVATE_STACK",
    arbitraryNestedObject: { secret: "PRIVATE_NESTED" },
  };
  const result = createKadiBrainShadowResult({
    status: "SUCCEEDED",
    sourceType: "text",
    messageId: "PRIVATE_MESSAGE_ID",
    safetyFlags: {
      containsSensitiveData: false,
      requiresHumanReview: false,
    },
    ...external,
  });
  assert.deepEqual(Object.keys(result), RESULT_KEYS);
  for (const key of Object.keys(external)) {
    assert.equal(Object.hasOwn(result, key), false);
  }
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.safetyFlags), true);
  assert.equal(result.execution, "NONE");
});

test("confidence and latency bucket boundaries are exact", () => {
  assert.deepEqual(
    [
      null, undefined, NaN, -Infinity, Infinity, -1, -Number.EPSILON,
      0, 0.499999, 0.5, 0.749999, 0.75, 1, 1 + Number.EPSILON, 2,
      "0.75",
    ]
      .map(confidenceBucket),
    [
      "NONE", "NONE", "NONE", "NONE", "NONE", "NONE", "NONE",
      "LOW", "LOW", "MEDIUM", "MEDIUM", "HIGH", "HIGH", "NONE",
      "NONE", "NONE",
    ]
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
  const injected = hashMessageId(
    "message-1",
    () => "abcdef0123456789abcdef"
  );
  assert.match(injected, /^[a-f0-9]{16}$/u);
  assert.notEqual(injected, "abcdef0123456789");
  assert.equal(hashMessageId("", () => "abcdef0123456789"), null);
});

test("hostile hash functions cannot expose the raw message id", () => {
  for (const messageId of [
    "abcdef0123456789",
    "wamid.unicode-é-消息",
    "f".repeat(256),
  ]) {
    const outputs = [
      hashMessageId(messageId, () => messageId),
      hashMessageId(messageId, () => `prefix-${messageId}-suffix`),
      hashMessageId(messageId, () => "x".repeat(10000)),
      hashMessageId(messageId, () => ""),
      hashMessageId(messageId, () => null),
      hashMessageId(messageId, () => ({})),
      hashMessageId(messageId, () => { throw new Error("PRIVATE"); }),
      hashMessageId(messageId, () => "constant"),
    ];
    for (const output of outputs) {
      assert.match(output, /^[a-f0-9]{16}$/u);
      assert.notEqual(output, messageId);
      assert.equal(output.includes(messageId), false);
    }
    assert.equal(outputs[0], hashMessageId(messageId, () => messageId));
  }
  assert.notEqual(
    hashMessageId("message-a", () => "constant"),
    hashMessageId("message-b", () => "constant")
  );
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
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.safetyFlags), true);
  assert.throws(() => { first.status = "INJECTED"; }, TypeError);
  assert.throws(() => { first.injected = "raw-data"; }, TypeError);
  assert.throws(() => { first.safetyFlags.foo = true; }, TypeError);
  assert.throws(() => {
    first.safetyFlags = { injected: true };
  }, TypeError);
  assert.throws(() => {
    delete first.safetyFlags.containsSensitiveData;
  }, TypeError);
  assert.throws(() => {
    first.safetyFlags.containsSensitiveData = true;
  }, TypeError);
  assert.throws(() => {
    first.safetyFlags.requiresHumanReview = true;
  }, TypeError);
  assert.throws(() => { delete first.execution; }, TypeError);
  assert.deepEqual(Object.keys(first), RESULT_KEYS);
});
