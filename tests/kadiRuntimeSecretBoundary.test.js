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

test("webhook verification safely handles hostile containers permanently", () => {
  const valid = {
    mode: "subscribe",
    configuredToken: "fake-token-alpha",
    receivedToken: "fake-token-alpha",
    challenge: "fake-challenge",
  };
  const frozenInput = Object.freeze({ ...valid });
  const nullPrototypeInput = Object.assign(Object.create(null), valid);
  let getterCalls = 0;
  const getterInput = {};
  Object.defineProperty(getterInput, "mode", {
    get() {
      getterCalls += 1;
      throw new Error("getter must not run");
    },
  });
  const trapCalls = { get: 0, descriptor: 0, has: 0, ownKeys: 0 };
  const proxyInput = new Proxy(
    {},
    {
      get() {
        trapCalls.get += 1;
        throw new Error("get trap must not escape");
      },
      getOwnPropertyDescriptor() {
        trapCalls.descriptor += 1;
        throw new Error("descriptor trap must not escape");
      },
      has() {
        trapCalls.has += 1;
        throw new Error("has trap must not escape");
      },
      ownKeys() {
        trapCalls.ownKeys += 1;
        throw new Error("ownKeys trap must not escape");
      },
    }
  );

  assert.equal(evaluateWebhookVerification(frozenInput).accepted, true);
  assert.equal(evaluateWebhookVerification(nullPrototypeInput).accepted, true);
  assert.equal(evaluateWebhookVerification(getterInput).accepted, false);
  assert.equal(evaluateWebhookVerification(proxyInput).accepted, false);
  assert.equal(getterCalls, 0);
  assert.equal(trapCalls.descriptor > 0, true);
  assert.equal(trapCalls.get, 0);
  assert.equal(trapCalls.has, 0);
  assert.equal(trapCalls.ownKeys, 0);

  for (const input of [function inputFunction() {}, Symbol("fake"), 1n]) {
    assert.doesNotThrow(() => evaluateWebhookVerification(input));
    assert.equal(evaluateWebhookVerification(input).accepted, false);
  }
});
