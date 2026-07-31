"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const providerContract = require("../kadiBrainProviderContract");
const intentContract = require("../kadiBrainIntentContract");
const geminiProvider = require("../kadiBrainGeminiProvider");
const smoke = require("../scripts/runGeminiBrainIsolatedSmokeTest");

function resolutionJson() {
  const resolution = intentContract.createEmptyIntentResolution();
  resolution.intent = "CREATE_INVOICE";
  resolution.confidence = 0.99;
  resolution.language = "fr";
  resolution.entities.documentType = "invoice";
  resolution.entities.clientName = "PERSON_1";
  resolution.entities.amount = 25000;
  resolution.entities.currency = "XOF";
  resolution.requestedAction = {
    type: "CREATE_INVOICE",
    target: "invoice",
  };
  return JSON.stringify(resolution);
}

function successfulProviderResponse() {
  const response = providerContract.createEmptyProviderResponse();
  response.provider = "GEMINI";
  response.model = smoke.KADI_GEMINI_SMOKE_MODEL;
  response.status = "SUCCEEDED";
  response.ok = true;
  response.content = resolutionJson();
  response.errorCode = "NONE";
  response.failureKind = "NONE";
  response.usage = { inputUnits: 12, outputUnits: 8, totalUnits: 20 };
  response.metadata = { providerRequestId: null, finishReason: "STOP" };
  return response;
}

function harness(overrides = {}) {
  let clientCreations = 0;
  let providerCreations = 0;
  let invocations = 0;
  const outputs = [];
  const options = {
    apiKey: ["OBVIOUSLY", "FAKE", "TEST", "VALUE"].join("_"),
    createRealClient() {
      clientCreations += 1;
      return Object.freeze({ generateContent: async () => null });
    },
    createProvider() {
      providerCreations += 1;
      return {
        async invoke() {
          invocations += 1;
          return successfulProviderResponse();
        },
      };
    },
    output(value) {
      outputs.push(value);
    },
    ...overrides,
  };
  return {
    options,
    counts: () => ({ clientCreations, providerCreations, invocations }),
    outputs,
  };
}

const PUBLIC_FAILURE_KEYS = Object.freeze([
  "smokeVersion", "model", "privacySafe", "providerRequestValid",
  "providerStatus", "providerErrorCode", "providerFailureKind",
  "recoverable", "providerResponseValid", "parserValid", "execution",
]);

function completeSentinels() {
  return Object.freeze({
    content: "SENTINEL_CONTENT_01",
    providerRequestId: "SENTINEL_REQUEST_ID_02",
    unknownMetadata: "SENTINEL_UNKNOWN_METADATA_03",
    usage: 876543210,
    prompt: "SENTINEL_PROMPT_05",
    userMessage: "SENTINEL_USER_MESSAGE_06",
    restorationMap: "SENTINEL_RESTORATION_MAP_07",
    sanitizedUserMessage: "SENTINEL_SANITIZED_MESSAGE_08",
    sanitizedContext: "SENTINEL_SANITIZED_CONTEXT_09",
    privacyErrors: "SENTINEL_PRIVACY_ERRORS_10",
    privacyRedactions: "SENTINEL_PRIVACY_REDACTIONS_11",
    errorMessage: "SENTINEL_ERROR_MESSAGE_12",
    errorStack: "SENTINEL_ERROR_STACK_13",
    errorCause: "SENTINEL_ERROR_CAUSE_14",
    errorHeaders: "SENTINEL_ERROR_HEADERS_15",
    errorBody: "SENTINEL_ERROR_BODY_16",
    errorConfig: "SENTINEL_ERROR_CONFIG_17",
    errorRequest: "SENTINEL_ERROR_REQUEST_18",
    errorResponse: "SENTINEL_ERROR_RESPONSE_19",
    errorUrl: "SENTINEL_ERROR_URL_20",
    apiKey: "SENTINEL_FAKE_API_KEY_21",
  });
}

function cliEquivalentOptions(overrides = {}) {
  const setup = harness(overrides);
  const logs = [];
  const errors = [];
  setup.options.output = (result) => {
    logs.push(JSON.stringify(result));
  };
  return { setup, logs, errors };
}

async function captureCliEquivalent(cli) {
  const previousExitCode = process.exitCode;
  try {
    const result = await smoke.runGeminiIsolatedSmokeTest(cli.setup.options);
    process.exitCode = result.exitCode;
    if (result.code) {
      cli.errors.push(
        result.publicResult
          ? JSON.stringify(result.publicResult)
          : result.code
      );
    }
    return {
      result,
      exitCode: process.exitCode,
      logs: cli.logs.slice(),
      errors: cli.errors.slice(),
    };
  } finally {
    process.exitCode = previousExitCode;
  }
}

test("exports exact smoke constants and fresh dependencies", () => {
  assert.equal(smoke.KADI_GEMINI_SMOKE_VERSION, "kadi.gemini-isolated-smoke.v1");
  assert.equal(smoke.KADI_GEMINI_SMOKE_MODEL, "gemini-3.6-flash");
  assert.equal(
    smoke.KADI_GEMINI_SMOKE_MESSAGE,
    "Créer une facture de 25000 FCFA pour PERSON_1"
  );
  const first = smoke.createGeminiSmokeDependencies();
  const second = smoke.createGeminiSmokeDependencies();
  assert.notStrictEqual(first, second);
});

test("missing and empty keys fail before any client creation", async () => {
  for (const apiKey of [undefined, null, "", "   "]) {
    const setup = harness({ apiKey });
    const promise = smoke.runGeminiIsolatedSmokeTest(setup.options);
    assert.equal(promise instanceof Promise, true);
    assert.deepEqual(await promise, {
      exitCode: 1,
      code: "GEMINI_SMOKE_KEY_MISSING",
      publicResult: null,
    });
    assert.deepEqual(setup.counts(), {
      clientCreations: 0, providerCreations: 0, invocations: 0,
    });
  }
});

test("privacy passes before prompt and provider construction", async () => {
  const setup = harness();
  const result = await smoke.runGeminiIsolatedSmokeTest(setup.options);
  assert.equal(result.exitCode, 0);
  assert.equal(result.publicResult.privacySafe, true);
  assert.deepEqual(setup.counts(), {
    clientCreations: 1, providerCreations: 1, invocations: 1,
  });
});

test("real prompt builder pipeline reaches the injected fake Gemini client", async () => {
  let calls = 0;
  let captured = null;
  const setup = harness({
    createProvider({ client }) {
      return geminiProvider.createGeminiProvider({ client });
    },
    createRealClient() {
      return {
        generateContent(request) {
          calls += 1;
          captured = request;
          return {
            text: resolutionJson(),
            model: smoke.KADI_GEMINI_SMOKE_MODEL,
            finishReason: "STOP",
            usage: { inputUnits: 12, outputUnits: 8, totalUnits: 20 },
            providerRequestId: null,
          };
        },
      };
    },
  });
  const result = await smoke.runGeminiIsolatedSmokeTest(setup.options);
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 0);
  assert.equal(result.publicResult.providerResponseValid, true);
  assert.equal(result.publicResult.execution, "NONE");
  assert.equal(captured.model, smoke.KADI_GEMINI_SMOKE_MODEL);
  assert.equal(Object.hasOwn(captured, "privacyResult"), false);
  assert.equal(Object.hasOwn(captured, "restorationMap"), false);
  assert.equal(Object.hasOwn(captured, "apiKey"), false);
});

test("simulated privacy rejection prevents client and provider creation", async () => {
  const setup = harness({
    dependencies: {
      sanitizePrivacyInput() {
        return { allowed: false };
      },
      isPrivacySafeForProvider() {
        return false;
      },
    },
  });
  assert.equal(
    (await smoke.runGeminiIsolatedSmokeTest(setup.options)).code,
    "GEMINI_SMOKE_PRIVACY_REJECTED"
  );
  assert.deepEqual(setup.counts(), {
    clientCreations: 0, providerCreations: 0, invocations: 0,
  });
});

test("invalid prompt or provider request prevents all invocation", async () => {
  for (const dependencies of [
    { buildIntentResolutionMessages: () => ({ valid: false, messages: [] }) },
    { validateProviderRequest: () => ({ valid: false, errors: [] }) },
  ]) {
    const setup = harness({ dependencies });
    const result = await smoke.runGeminiIsolatedSmokeTest(setup.options);
    assert.equal(result.exitCode, 3);
    assert.equal(result.code, "GEMINI_SMOKE_REQUEST_INVALID");
    assert.deepEqual(setup.counts(), {
      clientCreations: 0, providerCreations: 0, invocations: 0,
    });
  }
});

test("canonical request is minimized, valid, and invokes the provider once", async () => {
  let captured;
  const setup = harness({
    createProvider() {
      return {
        async invoke(input) {
          captured = input;
          return successfulProviderResponse();
        },
      };
    },
  });
  const result = await smoke.runGeminiIsolatedSmokeTest(setup.options);
  assert.equal(result.exitCode, 0);
  assert.equal(providerContract.validateProviderRequest(captured.providerRequest).valid, true);
  assert.equal(captured.providerRequest.provider, "GEMINI");
  assert.equal(captured.providerRequest.model, "gemini-3.6-flash");
  assert.equal(captured.providerRequest.generation.temperature, 0);
  assert.deepEqual(captured.providerRequest.responseFormat, { type: "json_object" });
  assert.equal(Object.hasOwn(captured, "restorationMap"), false);
  assert.equal(Object.hasOwn(captured.providerRequest, "apiKey"), false);
});

test("provider failure is minimized and is never retried", async () => {
  let calls = 0;
  const setup = harness({
    createProvider() {
      return {
        async invoke() {
          calls += 1;
          const response = successfulProviderResponse();
          response.status = "FAILED";
          response.ok = false;
          response.content = null;
          response.errorCode = "PROVIDER_UNAVAILABLE";
          response.failureKind = "PROVIDER";
          response.recoverable = true;
          response.metadata.finishReason = "ERROR";
          return response;
        },
      };
    },
  });
  const result = await smoke.runGeminiIsolatedSmokeTest(setup.options);
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    exitCode: 4,
    code: "GEMINI_SMOKE_PROVIDER_FAILED",
    publicResult: {
      smokeVersion: "kadi.gemini-isolated-smoke.v1",
      model: "gemini-3.6-flash",
      privacySafe: true,
      providerRequestValid: true,
      providerStatus: "FAILED",
      providerErrorCode: "PROVIDER_UNAVAILABLE",
      providerFailureKind: "PROVIDER",
      recoverable: true,
      providerResponseValid: true,
      parserValid: false,
      execution: "NONE",
    },
  });
});

test("every canonical provider failure exposes only the safe diagnostic category", async () => {
  const sentinel = ["PRIVATE", "SDK", "SENTINEL"].join("_");
  const cases = [
    ["PROVIDER_AUTH_FAILED", "AUTHENTICATION", "REJECTED", false],
    ["PROVIDER_RATE_LIMITED", "RATE_LIMIT", "FAILED", true],
    ["PROVIDER_NETWORK_ERROR", "NETWORK", "FAILED", true],
    ["PROVIDER_TIMEOUT", "TIMEOUT", "TIMED_OUT", true],
    ["PROVIDER_UNAVAILABLE", "PROVIDER", "FAILED", true],
    ["PROVIDER_SAFETY_BLOCK", "SAFETY", "REJECTED", false],
    ["PROVIDER_CONTENT_BLOCK", "CONTENT", "REJECTED", false],
    ["PROVIDER_BAD_RESPONSE", "PROVIDER", "FAILED", true],
    ["PROVIDER_MODEL_NOT_FOUND", "PROVIDER", "FAILED", false],
    ["PROVIDER_INTERNAL_ERROR", "INTERNAL", "FAILED", true],
    ["INVALID_REQUEST", "CLIENT", "REJECTED", false],
  ];
  const expectedKeys = [
    "smokeVersion", "model", "privacySafe", "providerRequestValid",
    "providerStatus", "providerErrorCode", "providerFailureKind",
    "recoverable", "providerResponseValid", "parserValid", "execution",
  ];
  for (const [errorCode, failureKind, status, recoverable] of cases) {
    let calls = 0;
    const setup = harness({
      createProvider: () => ({
        async invoke() {
          calls += 1;
          const response = providerContract.createEmptyProviderResponse();
          response.provider = "GEMINI";
          response.model = smoke.KADI_GEMINI_SMOKE_MODEL;
          response.status = status;
          response.ok = false;
          response.content = null;
          response.errorCode = errorCode;
          response.failureKind = failureKind;
          response.recoverable = recoverable;
          response.usage = {
            inputUnits: null, outputUnits: null, totalUnits: null,
          };
          response.metadata = {
            providerRequestId: sentinel,
            finishReason: "ERROR",
          };
          return response;
        },
      }),
    });
    const first = await smoke.runGeminiIsolatedSmokeTest(setup.options);
    const second = await smoke.runGeminiIsolatedSmokeTest(setup.options);
    assert.equal(calls, 2);
    assert.equal(first.exitCode, 4);
    assert.equal(first.code, "GEMINI_SMOKE_PROVIDER_FAILED");
    assert.deepEqual(Object.keys(first.publicResult), expectedKeys);
    assert.equal(first.publicResult.providerErrorCode, errorCode);
    assert.equal(first.publicResult.providerFailureKind, failureKind);
    assert.equal(first.publicResult.providerStatus, status);
    assert.equal(first.publicResult.recoverable, recoverable);
    assert.equal(first.publicResult.execution, "NONE");
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    const serialized = JSON.stringify(first.publicResult);
    for (const forbidden of [
      sentinel, setup.options.apiKey, "content", "metadata", "providerRequestId",
      "prompt", "messages", "usage", "stack", "headers", "body",
    ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("invalid raw provider fields and simulated SDK details never enter diagnostics", async () => {
  const sentinel = ["RAW", "PRIVATE", "FAILURE"].join("_");
  const setup = harness({
    createProvider: () => ({
      invoke: async () => ({
        ...successfulProviderResponse(),
        content: sentinel,
        metadata: {
          providerRequestId: sentinel,
          finishReason: sentinel,
          message: sentinel,
          stack: sentinel,
          body: sentinel,
          headers: sentinel,
        },
        error: {
          message: sentinel,
          stack: sentinel,
          body: sentinel,
          headers: sentinel,
        },
      }),
    }),
  });
  const result = await smoke.runGeminiIsolatedSmokeTest(setup.options);
  assert.deepEqual(result, {
    exitCode: 5,
    code: "GEMINI_SMOKE_RESPONSE_INVALID",
    publicResult: null,
  });
  assert.equal(JSON.stringify(result).includes(sentinel), false);
});

test("invalid provider response is rejected before parsing", async () => {
  const setup = harness({
    createProvider: () => ({ invoke: async () => ({ raw: "PRIVATE" }) }),
  });
  assert.deepEqual(await smoke.runGeminiIsolatedSmokeTest(setup.options), {
    exitCode: 5,
    code: "GEMINI_SMOKE_RESPONSE_INVALID",
    publicResult: null,
  });
});

test("parser success reports CREATE_INVOICE but execution remains NONE", async () => {
  const setup = harness();
  const result = await smoke.runGeminiIsolatedSmokeTest(setup.options);
  assert.equal(result.publicResult.parserValid, true);
  assert.equal(result.publicResult.intent, "CREATE_INVOICE");
  assert.equal(result.publicResult.actionable, false);
  assert.equal(result.publicResult.execution, "NONE");
});

test("parser failure is minimized with exit code six", async () => {
  const setup = harness({
    dependencies: {
      parseIntentResolutionResponse: () => ({
        ok: false, validation: null, resolution: null,
      }),
    },
  });
  assert.deepEqual(await smoke.runGeminiIsolatedSmokeTest(setup.options), {
    exitCode: 6,
    code: "GEMINI_SMOKE_PARSE_FAILED",
    publicResult: null,
  });
});

test("public success output is exact, minimized, and contains no private pipeline data", async () => {
  const setup = harness();
  const result = await smoke.runGeminiIsolatedSmokeTest(setup.options);
  assert.deepEqual(result.publicResult, {
    smokeVersion: "kadi.gemini-isolated-smoke.v1",
    model: "gemini-3.6-flash",
    privacySafe: true,
    providerRequestValid: true,
    providerStatus: "SUCCEEDED",
    providerResponseValid: true,
    parserValid: true,
    intent: "CREATE_INVOICE",
    actionable: false,
    execution: "NONE",
    usage: { inputUnits: 12, outputUnits: 8, totalUnits: 20 },
  });
  const serialized = JSON.stringify(result.publicResult);
  for (const forbidden of [
    smoke.KADI_GEMINI_SMOKE_MESSAGE, "PERSON_1", "system", "prompt",
    "restorationMap", "sanitizedInput", "providerRequestId",
    setup.options.apiKey,
  ]) assert.equal(serialized.includes(forbidden), false);
  assert.deepEqual(setup.outputs, [result.publicResult]);
});

test("usage accepts only the already canonical provider usage", async () => {
  const setup = harness({
    createProvider: () => ({
      invoke: async () => {
        const response = successfulProviderResponse();
        response.usage = { inputUnits: null, outputUnits: null, totalUnits: null };
        return response;
      },
    }),
  });
  assert.deepEqual(
    (await smoke.runGeminiIsolatedSmokeTest(setup.options)).publicResult.usage,
    { inputUnits: null, outputUnits: null, totalUnits: null }
  );
});

test("same frozen inputs produce deterministic independent results without mutation", async () => {
  const options = harness().options;
  Object.freeze(options);
  const before = JSON.stringify(options);
  const first = await smoke.runGeminiIsolatedSmokeTest(options);
  const second = await smoke.runGeminiIsolatedSmokeTest(options);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.publicResult, second.publicResult);
  assert.notStrictEqual(first.publicResult.usage, second.publicResult.usage);
  assert.equal(JSON.stringify(options), before);
});

test("internal exceptions expose only the public code and never the fake key", async () => {
  const setup = harness({
    createRealClient() {
      throw new Error(setup.options.apiKey);
    },
  });
  const result = await smoke.runGeminiIsolatedSmokeTest(setup.options);
  assert.deepEqual(result, {
    exitCode: 7,
    code: "GEMINI_SMOKE_INTERNAL_FAILURE",
    publicResult: null,
  });
  assert.equal(JSON.stringify(result).includes(setup.options.apiKey), false);
});

test("distinct private sentinels never escape provider failure, success, or internal failure", async () => {
  const sentinels = completeSentinels();
  assert.equal(new Set(Object.values(sentinels).map(String)).size, 21);
  const privateStrings = Object.values(sentinels).map(String);
  const privacyResult = {
    allowed: true,
    restorationMap: { value: sentinels.restorationMap },
    sanitizedInput: {
      userMessage: sentinels.sanitizedUserMessage,
      context: { value: sentinels.sanitizedContext },
    },
    errors: [sentinels.privacyErrors],
    redactions: [{ value: sentinels.privacyRedactions }],
  };
  const dependencies = {
    createEmptyPrivacyInput: () => ({ userMessage: sentinels.userMessage }),
    sanitizePrivacyInput: () => privacyResult,
    isPrivacySafeForProvider: () => true,
    createEmptyPromptInput: () => ({
      channel: null,
      languageHint: null,
      userMessage: null,
      capabilities: [],
      businessContext: { defaultCurrency: null },
      metadata: { messageType: null },
    }),
    buildIntentResolutionMessages: () => ({
      valid: true,
      messages: [
        { role: "system", content: sentinels.prompt },
        { role: "user", content: sentinels.userMessage },
      ],
    }),
    validateProviderRequest: () => ({ valid: true, errors: [] }),
    validateProviderResponse: () => ({ valid: true, errors: [] }),
  };
  const failedResponse = successfulProviderResponse();
  failedResponse.status = "FAILED";
  failedResponse.ok = false;
  failedResponse.content = sentinels.content;
  failedResponse.errorCode = "PROVIDER_UNAVAILABLE";
  failedResponse.failureKind = "PROVIDER";
  failedResponse.recoverable = true;
  failedResponse.usage = {
    inputUnits: sentinels.usage,
    outputUnits: sentinels.usage,
    totalUnits: sentinels.usage,
  };
  failedResponse.metadata = {
    providerRequestId: sentinels.providerRequestId,
    finishReason: "ERROR",
    unknown: sentinels.unknownMetadata,
  };
  const failureSetup = harness({
    apiKey: sentinels.apiKey,
    dependencies,
    createProvider: () => ({ invoke: async () => failedResponse }),
  });
  const failure = await smoke.runGeminiIsolatedSmokeTest(failureSetup.options);
  assert.deepEqual(Object.keys(failure.publicResult), PUBLIC_FAILURE_KEYS);
  assert.equal(failure.publicResult.execution, "NONE");
  const serializedFailure = JSON.stringify(failure.publicResult);
  for (const sentinel of privateStrings) {
    assert.equal(serializedFailure.includes(sentinel), false);
  }

  const successResponse = successfulProviderResponse();
  successResponse.content = sentinels.content;
  successResponse.metadata = {
    providerRequestId: sentinels.providerRequestId,
    finishReason: "STOP",
    unknown: sentinels.unknownMetadata,
  };
  successResponse.usage = {
    inputUnits: 101,
    outputUnits: 102,
    totalUnits: 203,
  };
  const successSetup = harness({
    apiKey: sentinels.apiKey,
    dependencies: {
      ...dependencies,
      parseIntentResolutionResponse: () => ({
        ok: true,
        validation: { valid: true },
        resolution: { intent: "CREATE_INVOICE" },
      }),
    },
    createProvider: () => ({ invoke: async () => successResponse }),
  });
  const success = await smoke.runGeminiIsolatedSmokeTest(successSetup.options);
  assert.deepEqual(Object.keys(success.publicResult), [
    "smokeVersion", "model", "privacySafe", "providerRequestValid",
    "providerStatus", "providerResponseValid", "parserValid", "intent",
    "actionable", "execution", "usage",
  ]);
  assert.equal(success.publicResult.execution, "NONE");
  const serializedSuccess = JSON.stringify(success.publicResult);
  for (const sentinel of privateStrings) {
    assert.equal(serializedSuccess.includes(sentinel), false);
  }

  const privateError = new Error(sentinels.errorMessage);
  privateError.stack = sentinels.errorStack;
  privateError.cause = sentinels.errorCause;
  privateError.headers = sentinels.errorHeaders;
  privateError.body = sentinels.errorBody;
  privateError.config = sentinels.errorConfig;
  privateError.request = sentinels.errorRequest;
  privateError.response = sentinels.errorResponse;
  privateError.url = sentinels.errorUrl;
  const internalSetup = harness({
    apiKey: sentinels.apiKey,
    createRealClient() {
      throw privateError;
    },
  });
  const internal = await smoke.runGeminiIsolatedSmokeTest(internalSetup.options);
  assert.deepEqual(internal, {
    exitCode: 7,
    code: "GEMINI_SMOKE_INTERNAL_FAILURE",
    publicResult: null,
  });
  const serializedInternal = JSON.stringify(internal);
  for (const sentinel of privateStrings) {
    assert.equal(serializedInternal.includes(sentinel), false);
  }
});

test("CLI-equivalent capture emits exactly one public output for exit codes zero through seven", async () => {
  const cases = [
    {
      exitCode: 0,
      code: null,
      cli: () => cliEquivalentOptions(),
      expectedCounts: { clientCreations: 1, providerCreations: 1, invocations: 1 },
    },
    {
      exitCode: 1,
      code: "GEMINI_SMOKE_KEY_MISSING",
      cli: () => cliEquivalentOptions({ apiKey: undefined }),
      expectedCounts: { clientCreations: 0, providerCreations: 0, invocations: 0 },
    },
    {
      exitCode: 2,
      code: "GEMINI_SMOKE_PRIVACY_REJECTED",
      cli: () => cliEquivalentOptions({
        dependencies: {
          sanitizePrivacyInput: () => ({ allowed: false }),
          isPrivacySafeForProvider: () => false,
        },
      }),
      expectedCounts: { clientCreations: 0, providerCreations: 0, invocations: 0 },
    },
    {
      exitCode: 3,
      code: "GEMINI_SMOKE_REQUEST_INVALID",
      cli: () => cliEquivalentOptions({
        dependencies: {
          buildIntentResolutionMessages: () => ({ valid: false, messages: [] }),
        },
      }),
      expectedCounts: { clientCreations: 0, providerCreations: 0, invocations: 0 },
    },
    {
      exitCode: 4,
      code: "GEMINI_SMOKE_PROVIDER_FAILED",
      cli: () => cliEquivalentOptions({
        createProvider: () => ({
          invoke: async () => {
            const response = successfulProviderResponse();
            response.status = "FAILED";
            response.ok = false;
            response.content = null;
            response.errorCode = "PROVIDER_UNAVAILABLE";
            response.failureKind = "PROVIDER";
            response.recoverable = true;
            response.metadata.finishReason = "ERROR";
            return response;
          },
        }),
      }),
      expectedCounts: { clientCreations: 1, providerCreations: 0, invocations: 0 },
    },
    {
      exitCode: 5,
      code: "GEMINI_SMOKE_RESPONSE_INVALID",
      cli: () => cliEquivalentOptions({
        createProvider: () => ({ invoke: async () => ({ invalid: true }) }),
      }),
      expectedCounts: { clientCreations: 1, providerCreations: 0, invocations: 0 },
    },
    {
      exitCode: 6,
      code: "GEMINI_SMOKE_PARSE_FAILED",
      cli: () => cliEquivalentOptions({
        dependencies: {
          parseIntentResolutionResponse: () => ({
            ok: false, validation: null, resolution: null,
          }),
        },
      }),
      expectedCounts: { clientCreations: 1, providerCreations: 1, invocations: 1 },
    },
    {
      exitCode: 7,
      code: "GEMINI_SMOKE_INTERNAL_FAILURE",
      cli: () => cliEquivalentOptions({
        createRealClient() {
          throw new Error("SIMULATED_INTERNAL_FAILURE");
        },
      }),
      expectedCounts: { clientCreations: 0, providerCreations: 0, invocations: 0 },
    },
  ];
  const originalExitCode = process.exitCode;
  for (const scenario of cases) {
    const cli = scenario.cli();
    const captured = await captureCliEquivalent(cli);
    assert.equal(captured.exitCode, scenario.exitCode);
    assert.equal(captured.result.code, scenario.code);
    assert.equal(captured.logs.length + captured.errors.length, 1);
    assert.deepEqual(cli.setup.counts(), scenario.expectedCounts);
    assert.equal(process.exitCode, originalExitCode);
    const output = captured.logs[0] || captured.errors[0];
    if (scenario.exitCode === 0 || scenario.exitCode === 4) {
      const parsed = JSON.parse(output);
      assert.equal(parsed.execution, "NONE");
      assert.equal(JSON.stringify(parsed), output);
      assert.equal(output.includes("apiKey"), false);
      assert.equal(output.includes("prompt"), false);
      assert.equal(output.includes("content"), false);
      assert.equal(output.includes("metadata"), false);
    } else {
      assert.equal(output, scenario.code);
    }
  }
});

test("CLI-equivalent output is byte deterministic for success and provider failures", async () => {
  const providerCases = [
    null,
    ["PROVIDER_AUTH_FAILED", "AUTHENTICATION", "REJECTED", false],
    ["PROVIDER_RATE_LIMITED", "RATE_LIMIT", "FAILED", true],
    ["PROVIDER_NETWORK_ERROR", "NETWORK", "FAILED", true],
    ["PROVIDER_UNAVAILABLE", "PROVIDER", "FAILED", true],
    ["PROVIDER_BAD_RESPONSE", "PROVIDER", "FAILED", true],
  ];
  for (const providerCase of providerCases) {
    const run = async () => {
      const overrides = providerCase
        ? {
          createProvider: () => ({
            invoke: async () => {
              const response = successfulProviderResponse();
              response.status = providerCase[2];
              response.ok = false;
              response.content = null;
              response.errorCode = providerCase[0];
              response.failureKind = providerCase[1];
              response.recoverable = providerCase[3];
              response.metadata.finishReason = "ERROR";
              return response;
            },
          }),
        }
        : {};
      const cli = cliEquivalentOptions(overrides);
      const captured = await captureCliEquivalent(cli);
      assert.equal(captured.logs.length + captured.errors.length, 1);
      return captured.logs[0] || captured.errors[0];
    };
    assert.equal(await run(), await run());
  }
});

test("source remains isolated, storage-free, network-free, and execution-free", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "runGeminiBrainIsolatedSmokeTest.js"),
    "utf8"
  );
  for (const forbidden of [
    "Supabase", "createClient(", 'require("fs")', "writeFile", "appendFile",
    "readFile", "Redis", "database", "webhook", "sendMessage", "WhatsApp",
    "createInvoice", "createQuote", "createReceipt", "debitCredit",
    "executeIntent", "dispatch", "axios", "fetch(", 'require("http")',
    'require("https")', "retry", "backoff", "setInterval", "child_process",
    "eval(", "new Function", "Date.now", "Math.random", "UUID",
    "dotenv", "GOOGLE_API_KEY", "console.dir", "console.table", "logger",
    "telemetry", "analytics",
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  assert.equal(
    (source.match(/process\.env\.GEMINI_API_KEY/g) || []).length,
    1
  );
  assert.equal(
    source.replace("process.env.GEMINI_API_KEY", "").includes("process.env"),
    false
  );
  assert.equal(source.includes("if (require.main === module)"), true);
  assert.equal(source.includes("execution: \"NONE\""), true);
});

test("tests use only an obviously fictitious injected key and never construct the real SDK", () => {
  const source = fs.readFileSync(__filename, "utf8");
  const googleKeyPrefix = ["AI", "za"].join("");
  const sdkPackage = ["@google", "genai"].join("/");
  assert.equal(source.includes(googleKeyPrefix), false);
  assert.equal(source.includes(sdkPackage), false);
});
