"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isNonEmptyToken,
  secureTokenEquals,
  evaluateWebhookVerification,
} = require("../kadiRuntimeSecretBoundary");

test("secureTokenEquals accepts only exact non-empty strings", () => {
  const configured = "test-token-alpha";
  const longToken = `test-${"x".repeat(10000)}`;
  const cases = [
    { configured: undefined, received: configured, expected: false },
    { configured: "", received: configured, expected: false },
    { configured: "   ", received: configured, expected: false },
    { configured, received: undefined, expected: false },
    { configured, received: "test-token-beta", expected: false },
    { configured, received: configured, expected: true },
    { configured: "jeton-test-é", received: "jeton-test-é", expected: true },
    { configured: longToken, received: longToken, expected: true },
    { configured, received: {}, expected: false },
    { configured, received: [], expected: false },
  ];

  for (const entry of cases) {
    assert.equal(
      secureTokenEquals(entry.configured, entry.received),
      entry.expected
    );
  }
});

test("isNonEmptyToken rejects absent, empty, whitespace and non-string values", () => {
  for (const value of [undefined, null, "", " \t\n ", {}, []]) {
    assert.equal(isNonEmptyToken(value), false);
  }
  assert.equal(isNonEmptyToken("test-token"), true);
});

test("webhook verification is fail-closed and returns only a valid challenge", () => {
  const base = {
    mode: "subscribe",
    configuredToken: "configured-test-token",
    receivedToken: "configured-test-token",
    challenge: "challenge-test-value",
  };

  const rejectedCases = [
    { ...base, configuredToken: undefined },
    { ...base, configuredToken: "" },
    { ...base, configuredToken: "   " },
    { ...base, receivedToken: undefined },
    { ...base, receivedToken: "incorrect-test-token" },
    { ...base, mode: "unsubscribe" },
    { ...base, challenge: undefined },
  ];

  for (const input of rejectedCases) {
    assert.deepEqual(evaluateWebhookVerification(input), { accepted: false });
  }

  assert.deepEqual(evaluateWebhookVerification(base), {
    accepted: true,
    challenge: "challenge-test-value",
  });
});

test("webhook verification never throws on hostile input shapes", () => {
  const inputs = [
    undefined,
    null,
    [],
    { mode: {}, receivedToken: [], challenge: {}, configuredToken: [] },
  ];

  for (const input of inputs) {
    assert.doesNotThrow(() => evaluateWebhookVerification(input));
    assert.equal(evaluateWebhookVerification(input).accepted, false);
  }
});
