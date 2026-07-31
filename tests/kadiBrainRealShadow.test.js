"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const privacyGateway = require("../kadiBrainPrivacyGateway");
const promptBuilder = require("../kadiBrainPromptBuilder");
const providerContract = require("../kadiBrainProviderContract");
const responseParser = require("../kadiBrainResponseParser");
const intentContract = require("../kadiBrainIntentContract");
const {
  KADI_BRAIN_REAL_SHADOW_MODEL,
  KADI_BRAIN_REAL_SHADOW_LIMITS,
  createKadiBrainRealShadowRunner,
  runKadiBrainRealShadow,
} = require("../kadiBrainRealShadow");

const FIXED_TIME = "2026-08-01T00:00:00.000Z";
const RESULT_KEYS = [
  "shadowVersion", "status", "sourceType", "messageIdHash",
  "providerStatus", "providerFailureKind", "parserValid",
  "parserFailureCode", "intent", "confidenceBucket", "actionable",
  "missingFieldCount", "blockingAmbiguityCount", "safetyFlags",
  "latencyBucket", "execution", "timestamp",
];

function input(overrides = {}) {
  return {
    messageId: "wamid.fictitious-1",
    sourceType: "text",
    userMessage: "Créer une facture de 25000 FCFA",
    flowContext: {
      stepCategory: null,
      activeFlow: null,
      activeDocumentType: null,
      hasActiveDraft: false,
      expectedFieldNames: [],
      messageType: "text",
    },
    ...overrides,
  };
}

function clock() {
  let call = 0;
  return () => ({
    milliseconds: call++ === 0 ? 1000 : 1120,
    timestamp: FIXED_TIME,
  });
}

function canonicalResolution(overrides = {}) {
  const value = promptBuilder.createCanonicalIntentResponseExample();
  return {
    ...value,
    ...overrides,
    entities: { ...value.entities, ...(overrides.entities || {}) },
    conversation: {
      ...value.conversation,
      ...(overrides.conversation || {}),
    },
    safety: { ...value.safety, ...(overrides.safety || {}) },
  };
}

function providerResponse(content) {
  const response = providerContract.createEmptyProviderResponse();
  response.provider = "GEMINI";
  response.model = KADI_BRAIN_REAL_SHADOW_MODEL;
  response.status = "SUCCEEDED";
  response.ok = true;
  response.content = content;
  response.errorCode = "NONE";
  response.failureKind = "NONE";
  response.usage = { inputUnits: 10, outputUnits: 20, totalUnits: 30 };
  response.metadata = { providerRequestId: null, finishReason: "STOP" };
  return response;
}

function failedProviderResponse(kind = "AUTHENTICATION") {
  const response = providerContract.createEmptyProviderResponse();
  response.provider = "GEMINI";
  response.model = KADI_BRAIN_REAL_SHADOW_MODEL;
  response.status = "FAILED";
  response.ok = false;
  response.errorCode = kind === "RATE_LIMIT"
    ? "PROVIDER_RATE_LIMITED"
    : "PROVIDER_AUTH_FAILED";
  response.failureKind = kind;
  response.recoverable = kind === "RATE_LIMIT";
  return response;
}

function dependencies(overrides = {}) {
  return {
    mode: "shadow",
    clock: clock(),
    timeout: async (promise) => ({
      timedOut: false,
      value: await promise,
    }),
    provider: {
      invoke: async () => providerResponse(
        JSON.stringify(canonicalResolution())
      ),
    },
    ...overrides,
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

test("runner is disabled by default and for every non-shadow mode", async () => {
  let calls = 0;
  for (const mode of [undefined, "off", "invalid", "candidate", "active_allowlist", "active"]) {
    const options = mode === undefined
      ? { env: {}, provider: { invoke: async () => { calls += 1; } } }
      : dependencies({
        mode,
        provider: { invoke: async () => { calls += 1; } },
      });
    const result = await createKadiBrainRealShadowRunner(options).run(input());
    assert.equal(result.status, "SKIPPED");
    assert.equal(result.execution, "NONE");
  }
  assert.equal(calls, 0);
});

test("shadow mode validates input before Privacy or Provider", async () => {
  let privacyCalls = 0;
  let providerCalls = 0;
  const gateway = {
    ...privacyGateway,
    sanitizePrivacyInput(value) {
      privacyCalls += 1;
      return privacyGateway.sanitizePrivacyInput(value);
    },
  };
  const runner = createKadiBrainRealShadowRunner(dependencies({
    privacyGateway: gateway,
    provider: { invoke: async () => { providerCalls += 1; } },
  }));
  const cases = [
    null,
    input({ messageId: "" }),
    input({ sourceType: "image" }),
    input({ userMessage: " " }),
    input({ userMessage: "x".repeat(12001) }),
    input({ flowContext: { unknownSecret: "PRIVATE" } }),
    input({ flowContext: { expectedFieldNames: Array(21).fill("field") } }),
  ];
  for (const value of cases) {
    const result = await runner.run(value);
    assert.equal(result.status, "INPUT_INVALID");
    assert.equal(result.execution, "NONE");
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  }
  assert.equal(privacyCalls, 0);
  assert.equal(providerCalls, 0);
});

test("missing key is bounded before real Provider construction", async () => {
  let clients = 0;
  let providers = 0;
  const result = await createKadiBrainRealShadowRunner({
    mode: "shadow",
    clock: clock(),
    createRealClient() { clients += 1; },
    createProvider() { providers += 1; },
  }).run(input());
  assert.equal(result.status, "CONFIG_UNAVAILABLE");
  assert.equal(result.execution, "NONE");
  assert.equal(clients, 0);
  assert.equal(providers, 0);
  assert.equal(JSON.stringify(result).match(/key|env|gemini_api/giu), null);
});

test("Privacy precedes Prompt and Provider and raw values never cross", async () => {
  const order = [];
  let promptInput;
  let providerInput;
  const gateway = {
    ...privacyGateway,
    sanitizePrivacyInput(value) {
      order.push("privacy");
      return privacyGateway.sanitizePrivacyInput(value);
    },
  };
  const builder = {
    ...promptBuilder,
    buildIntentResolutionMessages(value) {
      order.push("prompt");
      promptInput = structuredClone(value);
      return promptBuilder.buildIntentResolutionMessages(value);
    },
  };
  const provider = {
    async invoke(value) {
      order.push("provider");
      providerInput = value;
      return providerResponse(JSON.stringify(canonicalResolution()));
    },
  };
  const result = await createKadiBrainRealShadowRunner(dependencies({
    privacyGateway: gateway,
    promptBuilder: builder,
    provider,
  })).run(input({
    messageId: "PRIVATE_MESSAGE_ID",
    userMessage: "Créer une facture pour Awa",
  }));
  assert.deepEqual(order, ["privacy", "prompt", "provider"]);
  assert.equal(promptInput.userMessage.includes("Awa"), false);
  assert.equal(promptInput.userMessage.includes("PERSON_1"), true);
  assert.equal(JSON.stringify(promptInput).includes("PRIVATE_MESSAGE_ID"), false);
  assert.equal(JSON.stringify(promptInput).includes("restorationMap"), false);
  assert.equal(JSON.stringify(providerInput.providerRequest).includes("Awa"), false);
  assert.equal(JSON.stringify(providerInput.providerRequest).includes("restorationMap"), false);
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(JSON.stringify(result).includes("Awa"), false);
});

test("Privacy rejection prevents Prompt and Provider", async () => {
  let promptCalls = 0;
  let providerCalls = 0;
  const builder = {
    ...promptBuilder,
    buildIntentResolutionMessages() { promptCalls += 1; },
  };
  const result = await createKadiBrainRealShadowRunner(dependencies({
    promptBuilder: builder,
    provider: { invoke: async () => { providerCalls += 1; } },
  })).run(input({ userMessage: "OTP 123456" }));
  assert.equal(result.status, "PRIVACY_BLOCKED");
  assert.equal(result.execution, "NONE");
  assert.equal(promptCalls, 0);
  assert.equal(providerCalls, 0);
  assert.equal(JSON.stringify(result).includes("123456"), false);
});

test("one canonical Gemini Provider call produces actionable success", async () => {
  let calls = 0;
  let captured;
  const result = await createKadiBrainRealShadowRunner(dependencies({
    provider: {
      async invoke(value) {
        calls += 1;
        captured = value;
        return providerResponse(JSON.stringify(canonicalResolution()));
      },
    },
  })).run(input());
  assert.equal(calls, 1);
  assert.equal(captured.providerRequest.model, "gemini-3.6-flash");
  assert.equal(captured.providerRequest.provider, "GEMINI");
  assert.deepEqual(captured.providerRequest.metadata.tags, ["real_shadow"]);
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.providerStatus, "SUCCEEDED");
  assert.equal(result.parserValid, true);
  assert.equal(result.intent, "CREATE_INVOICE");
  assert.equal(result.actionable, true);
  assert.equal(result.execution, "NONE");
});

test("incomplete invoice and greeting remain non-actionable", async () => {
  const incomplete = canonicalResolution({
    missingFields: ["clientName"],
  });
  const greeting = canonicalResolution({
    intent: "GREETING",
    confidence: 0.95,
    requestedAction: null,
    missingFields: [],
    entities: intentContract.createEmptyIntentResolution().entities,
  });
  for (const [resolution, intent, missing] of [
    [incomplete, "CREATE_INVOICE", 1],
    [greeting, "GREETING", 0],
  ]) {
    const result = await createKadiBrainRealShadowRunner(dependencies({
      provider: {
        invoke: async () => providerResponse(JSON.stringify(resolution)),
      },
    })).run(input());
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(result.intent, intent);
    assert.equal(result.actionable, false);
    assert.equal(result.missingFieldCount, missing);
    assert.equal(result.execution, "NONE");
  }
});

test("raw model actionable can never control local actionability", async () => {
  const raw = canonicalResolution({ missingFields: ["clientName"] });
  raw.actionable = true;
  const result = await createKadiBrainRealShadowRunner(dependencies({
    provider: {
      invoke: async () => providerResponse(JSON.stringify(raw)),
    },
  })).run(input());
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.actionable, false);
  assert.equal(result.missingFieldCount, 1);
  assert.equal(result.execution, "NONE");
});

test("Provider failures and invalid responses stay isolated", async () => {
  for (const response of [
    failedProviderResponse("AUTHENTICATION"),
    failedProviderResponse("RATE_LIMIT"),
    { raw: "PRIVATE_PROVIDER_RESPONSE" },
  ]) {
    const result = await createKadiBrainRealShadowRunner(dependencies({
      provider: { invoke: async () => response },
    })).run(input());
    assert.equal(result.status, "PROVIDER_FAILED");
    assert.equal(result.execution, "NONE");
    assert.equal(JSON.stringify(result).includes("PRIVATE_PROVIDER_RESPONSE"), false);
  }
});

test("timeout is local, bounded, non-retrying, and non-executing", async () => {
  let calls = 0;
  const result = await createKadiBrainRealShadowRunner(dependencies({
    provider: {
      invoke() {
        calls += 1;
        return new Promise(() => {});
      },
    },
    timeout: async () => ({ timedOut: true }),
  })).run(input());
  assert.equal(calls, 1);
  assert.equal(result.status, "TIMEOUT");
  assert.equal(result.providerStatus, "TIMED_OUT");
  assert.equal(result.providerFailureKind, "TIMEOUT");
  assert.equal(result.execution, "NONE");
});

test("strict parse failure is bounded and never retries", async () => {
  let calls = 0;
  const result = await createKadiBrainRealShadowRunner(dependencies({
    provider: {
      invoke: async () => {
        calls += 1;
        return providerResponse("not-json PRIVATE_MODEL_CONTENT");
      },
    },
  })).run(input());
  assert.equal(calls, 1);
  assert.equal(result.status, "PARSE_FAILED");
  assert.equal(result.parserFailureCode, "INVALID_JSON");
  assert.equal(result.execution, "NONE");
  assert.equal(JSON.stringify(result).includes("PRIVATE_MODEL_CONTENT"), false);
});

test("sink receives one bounded result and sink failure is absorbed", async () => {
  const received = [];
  const result = await createKadiBrainRealShadowRunner(dependencies({
    resultSink(value) {
      received.push(structuredClone(value));
      throw new Error("PRIVATE_SINK_ERROR");
    },
  })).run(input());
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(received.length, 1);
  assert.deepEqual(Object.keys(received[0]), RESULT_KEYS);
  assert.equal(JSON.stringify(received[0]).includes("PRIVATE"), false);
});

test("malicious and rejecting sinks cannot mutate the returned result", async () => {
  let retained;
  const malicious = await createKadiBrainRealShadowRunner(dependencies({
    resultSink(value) {
      retained = value;
      Reflect.set(value, "status", "INJECTED");
      Reflect.set(value, "rawMessage", "PRIVATE_RAW");
      Reflect.set(value.safetyFlags, "foo", true);
      Reflect.set(value, "safetyFlags", { injected: true });
      Reflect.deleteProperty(value.safetyFlags, "containsSensitiveData");
      Reflect.set(value.safetyFlags, "containsSensitiveData", true);
      Reflect.set(value.safetyFlags, "requiresHumanReview", true);
      Reflect.deleteProperty(value, "execution");
    },
  })).run(input());
  assert.equal(malicious.status, "SUCCEEDED");
  assert.deepEqual(Object.keys(malicious), RESULT_KEYS);
  assert.equal(Object.hasOwn(malicious, "rawMessage"), false);
  assert.equal(Object.hasOwn(malicious.safetyFlags, "foo"), false);
  assert.deepEqual(Object.keys(malicious.safetyFlags), [
    "containsSensitiveData", "requiresHumanReview",
  ]);
  assert.notStrictEqual(retained, malicious);
  assert.notStrictEqual(retained.safetyFlags, malicious.safetyFlags);
  assert.equal(Object.isFrozen(retained), true);
  assert.equal(Object.isFrozen(retained.safetyFlags), true);

  const rejected = await createKadiBrainRealShadowRunner(dependencies({
    resultSink: async () => {
      throw new Error("PRIVATE_ASYNC_SINK");
    },
  })).run(input({ messageId: "sink-reject" }));
  assert.equal(rejected.status, "SUCCEEDED");
  assert.deepEqual(Object.keys(rejected), RESULT_KEYS);
});

test("a late resolving sink is awaited once without sharing or mutation", async () => {
  let release;
  let sinkCalls = 0;
  let retained;
  let settled = false;
  const gate = new Promise((resolve) => { release = resolve; });
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const runPromise = createKadiBrainRealShadowRunner(dependencies({
    resultSink: async (value) => {
      sinkCalls += 1;
      retained = value;
      notifyStarted();
      await gate;
      Reflect.set(value, "status", "INJECTED_LATE");
      Reflect.set(value.safetyFlags, "rawMessage", "PRIVATE_RAW");
    },
  })).run(input({ messageId: "late-sink" }));
  runPromise.then(() => { settled = true; });
  await started;
  assert.equal(settled, false);
  release();
  const result = await runPromise;
  assert.equal(sinkCalls, 1);
  assert.notStrictEqual(retained, result);
  assert.notStrictEqual(retained.safetyFlags, result.safetyFlags);
  assert.equal(Object.isFrozen(retained), true);
  assert.equal(Object.isFrozen(retained.safetyFlags), true);
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(Object.hasOwn(result.safetyFlags, "rawMessage"), false);
  assert.deepEqual(Object.keys(result), RESULT_KEYS);
});

test("late Provider outcomes stay observed after timeout", async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    let sinks = 0;
    for (const lateOutcome of ["reject", "resolve"]) {
      const result = await createKadiBrainRealShadowRunner(dependencies({
        provider: {
          invoke: () => new Promise((resolve, reject) => {
            setTimeout(() => {
              if (lateOutcome === "reject") reject(new Error("PRIVATE_LATE"));
              else resolve(providerResponse(JSON.stringify(canonicalResolution())));
            }, 5);
          }),
        },
        timeout: async () => ({ timedOut: true }),
        resultSink: () => { sinks += 1; },
      })).run(input({ messageId: `late-${lateOutcome}` }));
      assert.equal(result.status, "TIMEOUT");
      assert.equal(result.execution, "NONE");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(unhandled.length, 0);
    assert.equal(sinks, 2);
  } finally {
    process.removeListener("unhandledRejection", listener);
  }
});

test("invalid or rejecting timeout results fail closed", async () => {
  const invalidValues = [
    undefined,
    null,
    "invalid",
    42,
    true,
    [],
    {},
    { timedOut: "true" },
    { timedOut: false },
    { unknownOnly: true },
    { timedOut: false, value: null },
    { timedOut: false, value: { kind: "UNKNOWN" } },
  ];
  for (const [index, invalidValue] of invalidValues.entries()) {
    let providerCalls = 0;
    let sinkCalls = 0;
    const result = await createKadiBrainRealShadowRunner(dependencies({
      provider: {
        invoke: async () => {
          providerCalls += 1;
          return providerResponse(JSON.stringify(canonicalResolution()));
        },
      },
      timeout: async () => invalidValue,
      resultSink: () => { sinkCalls += 1; },
    })).run(input({ messageId: `timeout-invalid-${index}` }));
    assert.equal(result.status, "INTERNAL_FAILED");
    assert.equal(result.execution, "NONE");
    assert.equal(providerCalls, 1);
    assert.equal(sinkCalls, 1);
    assert.equal(JSON.stringify(result).includes("invalid"), false);
  }

  for (const timeout of [
    async () => { throw new Error("PRIVATE_TIMEOUT_THROW"); },
    async () => Promise.reject(new Error("PRIVATE_TIMEOUT_REJECT")),
  ]) {
    const result = await createKadiBrainRealShadowRunner(dependencies({
      timeout,
    })).run(input({ messageId: "timeout-exception" }));
    assert.equal(result.status, "INTERNAL_FAILED");
    assert.equal(result.execution, "NONE");
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  }

  const rejectedProvider = await createKadiBrainRealShadowRunner(dependencies({
    provider: {
      invoke: async () => { throw new Error("PRIVATE_PROVIDER_REJECTION"); },
    },
  })).run(input({ messageId: "provider-reject" }));
  assert.equal(rejectedProvider.status, "PROVIDER_FAILED");
  assert.equal(rejectedProvider.providerFailureKind, "INTERNAL");
  assert.equal(rejectedProvider.execution, "NONE");
});

test("distinct Provider rejections are observed and bounded", async () => {
  const strangeError = {};
  Object.defineProperty(strangeError, "message", {
    get() { throw new Error("PRIVATE_GETTER"); },
  });
  const cases = [
    () => { throw new Error("PRIVATE_SYNC_THROW"); },
    () => Promise.reject(new Error("PRIVATE_IMMEDIATE_REJECT")),
    () => new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error("PRIVATE_ASYNC_REJECT")), 1);
    }),
    () => Promise.reject({
      status: "FAILED",
      failureKind: "AUTHENTICATION",
      raw: "PRIVATE_CANONICAL_LIKE_ERROR",
    }),
    () => Promise.reject("PRIVATE_NON_CANONICAL"),
    () => Promise.reject(strangeError),
  ];
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    for (const [index, invoke] of cases.entries()) {
      const result = await createKadiBrainRealShadowRunner(dependencies({
        provider: { invoke },
      })).run(input({ messageId: `provider-rejection-${index}` }));
      assert.equal(result.status, "PROVIDER_FAILED");
      assert.equal(result.providerFailureKind, "INTERNAL");
      assert.equal(result.execution, "NONE");
      assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
      assert.equal(Object.hasOwn(result, "stack"), false);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(unhandled.length, 0);
  } finally {
    process.removeListener("unhandledRejection", listener);
  }
});

test("concurrent duplicates invoke one Provider and caches stay isolated", async () => {
  let calls = 0;
  let privacyCalls = 0;
  let promptCalls = 0;
  let parserCalls = 0;
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const options = dependencies({
    privacyGateway: {
      ...privacyGateway,
      sanitizePrivacyInput(value) {
        privacyCalls += 1;
        return privacyGateway.sanitizePrivacyInput(value);
      },
    },
    promptBuilder: {
      ...promptBuilder,
      buildIntentResolutionMessages(value) {
        promptCalls += 1;
        return promptBuilder.buildIntentResolutionMessages(value);
      },
    },
    responseParser: {
      ...responseParser,
      parseIntentResolutionResponse(value) {
        parserCalls += 1;
        return responseParser.parseIntentResolutionResponse(value);
      },
    },
    provider: {
      async invoke() {
        calls += 1;
        await delayed;
        return providerResponse(JSON.stringify(canonicalResolution()));
      },
    },
  });
  const runner = createKadiBrainRealShadowRunner(options);
  const first = runner.run(input({ messageId: "concurrent-id" }));
  const second = runner.run(input({ messageId: "concurrent-id" }));
  release();
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(privacyCalls, 1);
  assert.equal(promptCalls, 1);
  assert.equal(parserCalls, 1);
  assert.deepEqual(
    results.map((result) => result.status).sort(),
    ["SKIPPED_DUPLICATE", "SUCCEEDED"]
  );
  assert.equal(results.every((result) => result.execution === "NONE"), true);

  let independentCalls = 0;
  const independent = dependencies({
    provider: {
      invoke: async () => {
        independentCalls += 1;
        return providerResponse(JSON.stringify(canonicalResolution()));
      },
    },
  });
  await Promise.all([
    createKadiBrainRealShadowRunner(independent).run(
      input({ messageId: "shared-id" })
    ),
    createKadiBrainRealShadowRunner(independent).run(
      input({ messageId: "shared-id" })
    ),
  ]);
  assert.equal(independentCalls, 2);
});

test("timeout first settlement wins and later settlement has no effect", async () => {
  let sinkCalls = 0;
  let parserCalls = 0;
  let providerCalls = 0;
  const timeout = (providerPromise) => new Promise((resolve) => {
    resolve({ timedOut: true });
    providerPromise.then((value) => {
      resolve({ timedOut: false, value });
    });
  });
  const result = await createKadiBrainRealShadowRunner(dependencies({
    provider: {
      invoke: async () => {
        providerCalls += 1;
        return providerResponse(JSON.stringify(canonicalResolution()));
      },
    },
    responseParser: {
      ...responseParser,
      parseIntentResolutionResponse(value) {
        parserCalls += 1;
        return responseParser.parseIntentResolutionResponse(value);
      },
    },
    timeout,
    resultSink: () => { sinkCalls += 1; },
  })).run(input({ messageId: "multiple-timeout-resolution" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.status, "TIMEOUT");
  assert.equal(result.execution, "NONE");
  assert.equal(providerCalls, 1);
  assert.equal(parserCalls, 0);
  assert.equal(sinkCalls, 1);
});

test("timeout mutation attempts cannot alter the canonical result", async () => {
  let retainedPromise;
  const result = await createKadiBrainRealShadowRunner(dependencies({
    timeout(providerPromise) {
      retainedPromise = providerPromise;
      Reflect.set(providerPromise, "rawMessage", "PRIVATE_RAW");
      Reflect.set(providerPromise, "status", "INJECTED");
      return { timedOut: false, value: { kind: "UNKNOWN" } };
    },
  })).run(input({ messageId: "timeout-mutation" }));
  assert.equal(Object.hasOwn(retainedPromise, "rawMessage"), true);
  assert.equal(result.status, "INTERNAL_FAILED");
  assert.equal(result.execution, "NONE");
  assert.deepEqual(Object.keys(result), RESULT_KEYS);
  assert.equal(JSON.stringify(result).includes("PRIVATE_RAW"), false);
});

test("failed attempts remain deduplicated within one runner instance", async () => {
  for (const scenario of [
    {
      firstStatus: "PRIVACY_BLOCKED",
      input: input({ userMessage: "OTP 123456" }),
      overrides: {},
    },
    {
      firstStatus: "PROVIDER_FAILED",
      input: input(),
      overrides: { provider: { invoke: async () => failedProviderResponse() } },
    },
    {
      firstStatus: "TIMEOUT",
      input: input(),
      overrides: { timeout: async () => ({ timedOut: true }) },
    },
    {
      firstStatus: "PARSE_FAILED",
      input: input(),
      overrides: {
        provider: { invoke: async () => providerResponse("invalid-json") },
      },
    },
    {
      firstStatus: "INTERNAL_FAILED",
      input: input(),
      overrides: { timeout: async () => null },
    },
  ]) {
    let privacyCalls = 0;
    let promptCalls = 0;
    let providerCalls = 0;
    let parserCalls = 0;
    const originalProvider = scenario.overrides.provider || {
      invoke: async () => providerResponse(
        JSON.stringify(canonicalResolution())
      ),
    };
    const runner = createKadiBrainRealShadowRunner(dependencies({
      ...scenario.overrides,
      privacyGateway: {
        ...privacyGateway,
        sanitizePrivacyInput(value) {
          privacyCalls += 1;
          return privacyGateway.sanitizePrivacyInput(value);
        },
      },
      promptBuilder: {
        ...promptBuilder,
        buildIntentResolutionMessages(value) {
          promptCalls += 1;
          return promptBuilder.buildIntentResolutionMessages(value);
        },
      },
      provider: {
        async invoke(value) {
          providerCalls += 1;
          return originalProvider.invoke(value);
        },
      },
      responseParser: {
        ...responseParser,
        parseIntentResolutionResponse(value) {
          parserCalls += 1;
          return responseParser.parseIntentResolutionResponse(value);
        },
      },
    }));
    const first = await runner.run(scenario.input);
    assert.equal(first.status, scenario.firstStatus);
    assert.equal(first.execution, "NONE");
    const countsAfterFirst = {
      privacyCalls, promptCalls, providerCalls, parserCalls,
    };
    assert.equal(
      (await runner.run(scenario.input)).status,
      "SKIPPED_DUPLICATE"
    );
    assert.deepEqual(
      { privacyCalls, promptCalls, providerCalls, parserCalls },
      countsAfterFirst
    );
  }
});

test("INPUT_INVALID is not cached and the corrected message runs normally", async () => {
  let providerCalls = 0;
  const runner = createKadiBrainRealShadowRunner(dependencies({
    provider: {
      invoke: async () => {
        providerCalls += 1;
        return providerResponse(JSON.stringify(canonicalResolution()));
      },
    },
  }));
  const invalid = await runner.run(input({
    messageId: "correctable-id",
    userMessage: " ",
  }));
  assert.equal(invalid.status, "INPUT_INVALID");
  assert.equal(invalid.execution, "NONE");
  assert.equal(providerCalls, 0);

  const corrected = await runner.run(input({ messageId: "correctable-id" }));
  assert.equal(corrected.status, "SUCCEEDED");
  assert.equal(corrected.execution, "NONE");
  assert.equal(providerCalls, 1);
});

test("deduplication is bounded, deterministic, and instance-local", async () => {
  let calls = 0;
  const options = dependencies({
    cacheEntries: 2,
    provider: {
      invoke: async () => {
        calls += 1;
        return providerResponse(JSON.stringify(canonicalResolution()));
      },
    },
  });
  const runner = createKadiBrainRealShadowRunner(options);
  assert.equal((await runner.run(input({ messageId: "id-1" }))).status, "SUCCEEDED");
  assert.equal(
    (await runner.run(input({ messageId: "id-1" }))).status,
    "SKIPPED_DUPLICATE"
  );
  await runner.run(input({ messageId: "id-2" }));
  await runner.run(input({ messageId: "id-3" }));
  await runner.run(input({ messageId: "id-1" }));
  assert.equal(calls, 4);

  let isolatedCalls = 0;
  const isolatedOptions = dependencies({
    provider: {
      invoke: async () => {
        isolatedCalls += 1;
        return providerResponse(JSON.stringify(canonicalResolution()));
      },
    },
  });
  await createKadiBrainRealShadowRunner(isolatedOptions).run(input());
  await createKadiBrainRealShadowRunner(isolatedOptions).run(input());
  assert.equal(isolatedCalls, 2);
});

test("frozen dependencies and intermediate results remain unmodified", async () => {
  let privacyBefore;
  let privacyAfter;
  let promptBefore;
  let promptAfter;
  let requestBefore;
  let requestAfter;
  let providerBefore;
  let providerAfter;
  let parserBefore;
  let parserAfter;

  const frozenGateway = {
    ...privacyGateway,
    sanitizePrivacyInput(value) {
      const result = privacyGateway.sanitizePrivacyInput(value);
      privacyBefore = JSON.stringify(result);
      deepFreeze(result);
      privacyAfter = () => JSON.stringify(result);
      return result;
    },
  };
  const frozenPromptBuilder = {
    ...promptBuilder,
    buildIntentResolutionMessages(value) {
      const result = promptBuilder.buildIntentResolutionMessages(value);
      promptBefore = JSON.stringify(result);
      deepFreeze(result);
      promptAfter = () => JSON.stringify(result);
      return result;
    },
  };
  const frozenResponse = providerResponse(
    JSON.stringify(canonicalResolution())
  );
  providerBefore = JSON.stringify(frozenResponse);
  deepFreeze(frozenResponse);
  providerAfter = () => JSON.stringify(frozenResponse);
  const frozenParser = {
    ...responseParser,
    parseIntentResolutionResponse(value) {
      const result = responseParser.parseIntentResolutionResponse(value);
      parserBefore = JSON.stringify(result);
      deepFreeze(result);
      parserAfter = () => JSON.stringify(result);
      return result;
    },
  };
  const frozenDependencies = Object.freeze(dependencies({
    privacyGateway: frozenGateway,
    promptBuilder: frozenPromptBuilder,
    responseParser: frozenParser,
    provider: {
      invoke: async ({ providerRequest }) => {
        requestBefore = JSON.stringify(providerRequest);
        deepFreeze(providerRequest);
        requestAfter = () => JSON.stringify(providerRequest);
        return frozenResponse;
      },
    },
  }));
  const frozenInput = deepFreeze(input({
    messageId: "frozen-pipeline",
    flowContext: {
      stepCategory: "review",
      activeFlow: "invoice",
      activeDocumentType: "facture",
      hasActiveDraft: true,
      expectedFieldNames: ["clientName", "items"],
      messageType: "text",
    },
  }));
  const inputBefore = JSON.stringify(frozenInput);
  const result = await createKadiBrainRealShadowRunner(
    frozenDependencies
  ).run(frozenInput);
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(JSON.stringify(frozenInput), inputBefore);
  assert.equal(privacyAfter(), privacyBefore);
  assert.equal(promptAfter(), promptBefore);
  assert.equal(requestAfter(), requestBefore);
  assert.equal(providerAfter(), providerBefore);
  assert.equal(parserAfter(), parserBefore);
  assert.equal(result.execution, "NONE");
});

test("frozen inputs remain unchanged and output is deterministic", async () => {
  const value = input();
  Object.freeze(value.flowContext.expectedFieldNames);
  Object.freeze(value.flowContext);
  Object.freeze(value);
  const before = JSON.stringify(value);
  const options = dependencies({
    hashFunction: () => "abcdef0123456789abcdef",
  });
  const first = await runKadiBrainRealShadow(value, options);
  const second = await runKadiBrainRealShadow(value, options);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(value), before);
  assert.match(first.messageIdHash, /^[a-f0-9]{16}$/u);
  assert.notEqual(first.messageIdHash, value.messageId);
  assert.equal(first.timestamp, FIXED_TIME);
});

test("source is isolated from business, network, logging, retry, and OpenAI", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "kadiBrainRealShadow.js"),
    "utf8"
  );
  const imports = Array.from(
    source.matchAll(/require\((["'])(.*?)\1\)/gu),
    (match) => match[2]
  );
  assert.equal(imports.some((value) =>
    /KadiEngine|Draft|Pdf|credit|payment|supabase|whatsapp|webhook/iu
      .test(value)
  ), false);
  assert.doesNotMatch(source, /sendMessage|saveDocument|consumeCredit|executeIntent|dispatch/iu);
  assert.doesNotMatch(source, /console\.|fetch\(|axios|openai|Math\.random/iu);
  assert.doesNotMatch(source, /retry|fallback/iu);
  assert.match(source, /gemini-3\.6-flash/u);
  assert.equal(KADI_BRAIN_REAL_SHADOW_LIMITS.maxCacheEntries, 1000);
});
