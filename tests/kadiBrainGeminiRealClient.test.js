"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const real = require("../kadiBrainGeminiRealClient");
const provider = require("../kadiBrainGeminiProvider");
const providerContract = require("../kadiBrainProviderContract");
const privacyGateway = require("../kadiBrainPrivacyGateway");

const {
  KADI_GEMINI_REAL_CLIENT_VERSION,
  KADI_GEMINI_REAL_CLIENT_ERROR_KINDS,
  KADI_GEMINI_REAL_CLIENT_LIMITS,
  createGeminiRealClient,
  buildGoogleGenerateContentRequest,
  normalizeGoogleGenerateContentResponse,
  mapGoogleGeminiError,
} = real;

function request(overrides = {}) {
  return {
    model: "gemini-test-model",
    systemInstruction: "Return strict JSON.",
    contents: [
      { role: "user", parts: [{ text: "Bonjour PERSON_1, 25000 FCFA." }] },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputCodePoints: 4096,
      responseMimeType: "application/json",
    },
    ...overrides,
  };
}

function response(overrides = {}) {
  return {
    text: '{"schemaVersion":"kadi.intent.v1"}',
    modelVersion: "gemini-test-version",
    responseId: "response_test_1",
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      totalTokenCount: 120,
    },
    candidates: [{ finishReason: "STOP" }],
    ...overrides,
  };
}

function factory(generateContent, onFactory = () => {}) {
  return createGeminiRealClient({
    apiKey: "TEST_KEY",
    sdkFactory(input) {
      onFactory(input);
      return { models: { generateContent } };
    },
  });
}

function reverse(value) {
  if (Array.isArray(value)) return value.map(reverse);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const key of Object.keys(value).reverse()) output[key] = reverse(value[key]);
  return output;
}

test("scenarios 1-4: constants are exact, complete, and frozen", () => {
  assert.equal(KADI_GEMINI_REAL_CLIENT_VERSION, "kadi.gemini-real-client.v1");
  assert.deepEqual(KADI_GEMINI_REAL_CLIENT_ERROR_KINDS, {
    NETWORK: "NETWORK", TIMEOUT: "TIMEOUT", RATE_LIMIT: "RATE_LIMIT",
    AUTHENTICATION: "AUTHENTICATION", SAFETY: "SAFETY", CONTENT: "CONTENT",
    UNAVAILABLE: "UNAVAILABLE", BAD_RESPONSE: "BAD_RESPONSE",
    INTERNAL: "INTERNAL", CANCELLED: "CANCELLED", UNKNOWN: "UNKNOWN",
  });
  assert.deepEqual(Object.keys(KADI_GEMINI_REAL_CLIENT_LIMITS), [
    "maxApiKeyCodePoints", "maxModelCodePoints",
    "maxSystemInstructionCodePoints", "maxContentEntries",
    "maxContentCodePoints", "maxOutputTokens",
    "maxProviderRequestIdCodePoints",
  ]);
  for (const value of [
    KADI_GEMINI_REAL_CLIENT_ERROR_KINDS,
    KADI_GEMINI_REAL_CLIENT_LIMITS,
  ]) {
    assert.equal(Object.isFrozen(value), true);
    assert.throws(() => { value.x = 1; }, TypeError);
  }
});

test("scenarios 5-20: factory fails closed and exposes only generateContent", async () => {
  for (const options of [
    undefined, null, true, [], "x", 1, {}, { apiKey: "" },
    { apiKey: "   " }, { apiKey: 2 },
    { apiKey: "x", sdkFactory: null },
    { apiKey: "x", sdkFactory: () => ({}) },
    { apiKey: "x", sdkFactory: () => ({ models: {} }) },
    { apiKey: "x", sdkFactory: () => ({ models: { generateContent: "x" } }) },
    { apiKey: "x", sdkFactory: () => ({ models: { generateContent() {} } }), endpoint: "x" },
  ]) assert.equal(createGeminiRealClient(options), null);

  let factoryCalls = 0;
  let sawNonEmptyKey = false;
  const client = createGeminiRealClient({
    apiKey: "TEST_KEY",
    sdkFactory({ apiKey }) {
      factoryCalls += 1;
      sawNonEmptyKey = typeof apiKey === "string" && apiKey.length > 0;
      return { models: { generateContent: async () => response() } };
    },
  });
  assert.deepEqual(Object.keys(client), ["generateContent"]);
  assert.equal(JSON.stringify(client), "{}");
  assert.equal(factoryCalls, 1);
  assert.equal(sawNonEmptyKey, true);
  assert.equal((await client.generateContent(request())).text.includes("kadi.intent.v1"), true);
  assert.equal(factoryCalls, 1);
});

test("scenarios 21-40: Google request build is exact, bounded, immutable, and deterministic", () => {
  const input = request({
    systemInstruction: "Système\nUnicode éè",
    contents: [
      { role: "user", parts: [{ text: "Ligne 1\nLigne 2 😀" }] },
      { role: "user", parts: [{ text: "Deuxième" }] },
    ],
  });
  const before = JSON.stringify(input);
  const built = buildGoogleGenerateContentRequest(input);
  assert.deepEqual(built, {
    model: "gemini-test-model",
    contents: [
      { role: "user", parts: [{ text: "Ligne 1\nLigne 2 😀" }] },
      { role: "user", parts: [{ text: "Deuxième" }] },
    ],
    config: {
      systemInstruction: "Système\nUnicode éè",
      temperature: 0,
      responseMimeType: "application/json",
      maxOutputTokens: 2048,
    },
  });
  assert.deepEqual(Object.keys(built), ["model", "contents", "config"]);
  assert.equal(JSON.stringify(built).match(/tools|grounding|metadata|restorationMap|privacyResult/g), null);
  assert.equal(JSON.stringify(input), before);
  assert.notStrictEqual(built.contents, input.contents);
  assert.notStrictEqual(built.contents[0], input.contents[0]);
  assert.notStrictEqual(built.contents[0].parts, input.contents[0].parts);
  assert.notStrictEqual(built.contents[0].parts[0], input.contents[0].parts[0]);
  assert.deepEqual(buildGoogleGenerateContentRequest(input), built);
  assert.deepEqual(buildGoogleGenerateContentRequest(reverse(input)), built);
  assert.equal(buildGoogleGenerateContentRequest(request({
    generationConfig: {
      temperature: 0,
      maxOutputCodePoints: 999999,
      responseMimeType: "application/json",
    },
  })).config.maxOutputTokens, KADI_GEMINI_REAL_CLIENT_LIMITS.maxOutputTokens);
  assert.equal(buildGoogleGenerateContentRequest(request({
    generationConfig: {
      temperature: 0,
      maxOutputCodePoints: 1,
      responseMimeType: "application/json",
    },
  })).config.maxOutputTokens, 1);
});

test("scenarios 41-58: malformed neutral requests never call the SDK", async () => {
  const tooMany = Array.from(
    { length: KADI_GEMINI_REAL_CLIENT_LIMITS.maxContentEntries + 1 },
    () => ({ role: "user", parts: [{ text: "x" }] })
  );
  const invalid = [
    null, "x", 2, [], {},
    request({ model: undefined }), request({ model: "" }),
    request({ systemInstruction: undefined }),
    request({ contents: undefined }), request({ contents: [] }),
    request({ contents: [{ role: "assistant", parts: [{ text: "x" }] }] }),
    request({ contents: [{ role: "tool", parts: [{ text: "x" }] }] }),
    request({ contents: [{ role: "user", parts: [{}] }] }),
    request({ contents: [{ role: "user", parts: [{ text: "" }] }] }),
    request({ generationConfig: undefined }),
    request({ generationConfig: { temperature: 1, maxOutputCodePoints: 2, responseMimeType: "application/json" } }),
    request({ generationConfig: { temperature: 0, maxOutputCodePoints: 2, responseMimeType: "text/plain" } }),
    { ...request(), unknown: true },
    request({ contents: [{ role: "user", parts: [{ text: "x".repeat(KADI_GEMINI_REAL_CLIENT_LIMITS.maxContentCodePoints + 1) }] }] }),
    request({ contents: tooMany }),
    request({ contents: [{ role: "user", parts: [{ text: "x", inlineData: {} }] }] }),
  ];
  let calls = 0;
  const client = factory(() => { calls += 1; return response(); });
  for (const value of invalid) {
    assert.equal(buildGoogleGenerateContentRequest(value), null);
    await assert.rejects(client.generateContent(value), (error) => {
      assert.deepEqual(error, { kind: "BAD_RESPONSE" });
      return true;
    });
  }
  assert.equal(calls, 0);
});

test("scenarios 59-70: SDK invocation is single, async-safe, minimized, and immutable", async () => {
  const input = request();
  const before = JSON.stringify(input);
  let calls = 0;
  let received;
  const client = factory((googleRequest) => {
    calls += 1;
    received = googleRequest;
    googleRequest.model = "mutated";
    googleRequest.contents[0].parts[0].text = "mutated";
    return Object.freeze(response());
  });
  const promise = client.generateContent(input);
  assert.equal(promise instanceof Promise, true);
  const output = await promise;
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(input), before);
  assert.equal(received.model, "mutated");
  assert.equal(output.text.includes("kadi.intent.v1"), true);

  for (const failure of [
    () => { throw Object.freeze({ kind: "NETWORK", message: "PRIVATE" }); },
    async () => { throw Object.freeze({ kind: "TIMEOUT", stack: "PRIVATE" }); },
  ]) {
    let failedCalls = 0;
    const failing = factory((value) => { failedCalls += 1; return failure(value); });
    await assert.rejects(failing.generateContent(input), (error) => {
      assert.deepEqual(Object.keys(error), ["kind"]);
      assert.equal(JSON.stringify(error).includes("PRIVATE"), false);
      return true;
    });
    assert.equal(failedCalls, 1);
  }
});

test("mocked SDK classes support prototype methods and the official text getter shape", async () => {
  class MockResponse {
    constructor() {
      this.modelVersion = "class-model";
      this.responseId = "class_response_1";
      this.usageMetadata = {
        promptTokenCount: 1,
        candidatesTokenCount: 2,
        totalTokenCount: 3,
      };
      this.candidates = [{ finishReason: "STOP" }];
    }

    get text() {
      return '{"schemaVersion":"kadi.intent.v1"}';
    }
  }
  class MockModels {
    generateContent() {
      return new MockResponse();
    }
  }
  class MockSdkClient {
    constructor() {
      this.models = new MockModels();
    }
  }
  const client = createGeminiRealClient({
    apiKey: "TEST_KEY",
    sdkFactory() {
      return new MockSdkClient();
    },
  });
  assert.deepEqual(await client.generateContent(request()), {
    text: '{"schemaVersion":"kadi.intent.v1"}',
    model: "class-model",
    finishReason: "STOP",
    usage: { inputUnits: 1, outputUnits: 2, totalUnits: 3 },
    providerRequestId: "class_response_1",
  });
});

test("scenarios 71-92: response normalization minimizes untrusted SDK data", () => {
  const input = request();
  const raw = response({
    promptFeedback: "PRIVATE",
    safetyRatings: "PRIVATE",
    reasoning: "PRIVATE",
    chainOfThought: "PRIVATE",
  });
  const output = normalizeGoogleGenerateContentResponse(raw, input);
  assert.deepEqual(output, {
    text: '{"schemaVersion":"kadi.intent.v1"}',
    model: "gemini-test-version",
    finishReason: "STOP",
    usage: { inputUnits: 100, outputUnits: 20, totalUnits: 120 },
    providerRequestId: "response_test_1",
  });
  assert.equal(JSON.stringify(output).includes("PRIVATE"), false);
  assert.equal(normalizeGoogleGenerateContentResponse(
    response({ modelVersion: null }), input
  ).model, input.model);
  assert.equal(normalizeGoogleGenerateContentResponse(
    response({ responseId: "awa@example.com" }), input
  ).providerRequestId, null);
  assert.deepEqual(normalizeGoogleGenerateContentResponse(
    response({ usageMetadata: undefined }), input
  ).usage, { inputUnits: null, outputUnits: null, totalUnits: null });
  const usages = [
    [{ promptTokenCount: -1, candidatesTokenCount: 2, totalTokenCount: 2 }, { inputUnits: null, outputUnits: 2, totalUnits: 2 }],
    [{ promptTokenCount: 1, candidatesTokenCount: 1.5, totalTokenCount: 2 }, { inputUnits: 1, outputUnits: null, totalUnits: 2 }],
    [{ promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: Infinity }, { inputUnits: 1, outputUnits: 2, totalUnits: null }],
  ];
  for (const [usageMetadata, expected] of usages) {
    assert.deepEqual(normalizeGoogleGenerateContentResponse(
      response({ usageMetadata }), input
    ).usage, expected);
  }
  for (const invalid of [null, "x", 2, [], response({ text: "" })]) {
    assert.throws(
      () => normalizeGoogleGenerateContentResponse(invalid, input),
      (error) => error.kind === "BAD_RESPONSE"
    );
  }
});

test("scenarios 93-104: every SDK finish reason maps without retaining raw unknowns", () => {
  const mappings = {
    STOP: "STOP", MAX_TOKENS: "MAX_OUTPUT", SAFETY: "SAFETY",
    BLOCKLIST: "CONTENT_FILTER", PROHIBITED_CONTENT: "CONTENT_FILTER",
    SPII: "CONTENT_FILTER", RECITATION: "CONTENT_FILTER",
    MALFORMED_FUNCTION_CALL: "TOOL_CALL",
    UNEXPECTED_TOOL_CALL: "TOOL_CALL", OTHER: "ERROR",
    UNKNOWN_RAW_VALUE: "UNKNOWN",
  };
  for (const [source, expected] of Object.entries(mappings)) {
    const output = normalizeGoogleGenerateContentResponse(response({
      candidates: [{ finishReason: source }],
    }), request());
    assert.equal(output.finishReason, expected);
    if (source === "UNKNOWN_RAW_VALUE") {
      assert.equal(JSON.stringify(output).includes(source), false);
    }
  }
  assert.equal(normalizeGoogleGenerateContentResponse(
    response({ candidates: [] }), request()
  ).finishReason, "UNKNOWN");
  assert.throws(
    () => normalizeGoogleGenerateContentResponse(
      response({ text: "", candidates: [{ finishReason: "SAFETY" }] }), request()
    ),
    (error) => error.kind === "SAFETY"
  );
  assert.throws(
    () => normalizeGoogleGenerateContentResponse(
      response({ text: "", candidates: [{ finishReason: "BLOCKLIST" }] }), request()
    ),
    (error) => error.kind === "CONTENT"
  );
});

test("scenarios 105-128: errors map canonically without raw values", () => {
  const cases = [
    [{ status: 400 }, "BAD_RESPONSE"], [{ status: 401 }, "AUTHENTICATION"],
    [{ status: 403 }, "AUTHENTICATION"], [{ status: 408 }, "TIMEOUT"],
    [{ status: 429 }, "RATE_LIMIT"], [{ status: 500 }, "INTERNAL"],
    [{ status: 502 }, "UNAVAILABLE"], [{ status: 503 }, "UNAVAILABLE"],
    [{ status: 504 }, "UNAVAILABLE"], [{ status: 409 }, "UNAVAILABLE"],
    [{ code: "ECONNRESET" }, "NETWORK"], [{ code: "ENOTFOUND" }, "NETWORK"],
    [{ code: "EAI_AGAIN" }, "NETWORK"], [{ code: "ECONNREFUSED" }, "NETWORK"],
    [{ code: "ETIMEDOUT" }, "TIMEOUT"], [{ name: "AbortError" }, "CANCELLED"],
    [{ kind: "SAFETY" }, "SAFETY"], [{ kind: "CONTENT" }, "CONTENT"],
    [null, "UNKNOWN"], [undefined, "UNKNOWN"], ["x", "UNKNOWN"],
    [2, "UNKNOWN"], [new Error("PRIVATE"), "UNKNOWN"],
    [{ message: "PRIVATE", stack: "PRIVATE", cause: "PRIVATE" }, "UNKNOWN"],
    [{ headers: "PRIVATE", body: "PRIVATE", config: "PRIVATE", apiKey: "PRIVATE" }, "UNKNOWN"],
  ];
  for (const [input, expected] of cases) {
    const output = mapGoogleGeminiError(input);
    assert.deepEqual(output, { kind: expected });
    assert.deepEqual(Object.keys(output), ["kind"]);
    assert.equal(JSON.stringify(output).includes("PRIVATE"), false);
  }
});

test("scenarios 129-144: key privacy, independence, freezing, and determinism", async () => {
  const keyParts = ["TEST", "GEMINI", "KEY", "NEVER", "EXPOSE"];
  const key = keyParts.join("_");
  let sdkCalls = 0;
  let sdkRequest;
  const client = createGeminiRealClient({
    apiKey: key,
    sdkFactory({ apiKey }) {
      assert.equal(typeof apiKey, "string");
      sdkCalls += 1;
      return {
        models: {
          generateContent(value) {
            sdkRequest = value;
            return response();
          },
        },
      };
    },
  });
  const input = request();
  Object.freeze(input.contents[0].parts[0]);
  Object.freeze(input.contents[0].parts);
  Object.freeze(input.contents[0]);
  Object.freeze(input.contents);
  Object.freeze(input.generationConfig);
  Object.freeze(input);
  const first = await client.generateContent(input);
  const second = await client.generateContent(input);
  assert.equal(sdkCalls, 1);
  for (const value of [client, sdkRequest, first, second]) {
    assert.equal(JSON.stringify(value).includes(key), false);
  }
  assert.deepEqual(first, second);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.usage, second.usage);
  const clientB = factory(() => response({ responseId: "b" }));
  assert.notStrictEqual(client, clientB);
  assert.equal((await clientB.generateContent(request())).providerRequestId, "b");
  assert.deepEqual(
    normalizeGoogleGenerateContentResponse(response(), request()),
    normalizeGoogleGenerateContentResponse(reverse(response()), reverse(request()))
  );
});

test("scenarios 145-158: source and repository surface remain isolated", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "kadiBrainGeminiRealClient.js"),
    "utf8"
  );
  assert.equal(source.includes('import("@google/genai")'), true);
  assert.equal(source.includes('require("@google/genai")'), false);
  for (const forbidden of [
    "@google/generative-ai", "GoogleGenerativeAI", "process.env",
    "GEMINI_API_KEY", "GOOGLE_API_KEY", "fetch(", "axios",
    "require(\"http\")", "require(\"https\")", "require(\"net\")",
    "require(\"tls\")", "node:http", "node:https", "node:net",
    "node:tls", "http://", "https://", "console.", "logger",
    "telemetry", "analytics", "setTimeout", "setInterval",
    "AbortController", "retry", "backoff", "supabase", "writeFile",
    "appendFile", "Date.now", "Math.random", "randomUUID", "uuid",
    "webhook", "dispatch", "executeIntent", "createInvoice",
    "createQuote", "createReceipt", "debitCredit", "sendMessage",
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  const dependencies = require("../package.json").dependencies;
  assert.equal(typeof dependencies["@google/genai"], "string");
});

test("hardening: sensitive model versions always fall back to the validated request model", async () => {
  const unsafe = [
    undefined, null, "", "   ", "x".repeat(KADI_GEMINI_REAL_CLIENT_LIMITS.maxModelCodePoints + 1),
    "awa@example.com", "70 12 34 56", "+22670123456",
    "Adresse Ouagadougou secteur 15", "Adresse-Ouagadougou-secteur-15",
    "secret-value", "password-value", "private-key-value", "api-key-value",
    "access-token-value", "bearer-token-value", "OTP-123456", "PIN-4321",
    "waId-22670123456", "IFU-00012345", "RCCM-BF-OUA",
    "Passeport-A123456", "Nom-Awa-Kabore", "Signature-Awa",
  ];
  for (const modelVersion of unsafe) {
    const output = normalizeGoogleGenerateContentResponse(
      response({ modelVersion }), request()
    );
    assert.equal(output.model, request().model);
    if (typeof modelVersion === "string" && modelVersion.trim()) {
      assert.equal(JSON.stringify(output).includes(modelVersion), false);
    }
  }
  for (const modelVersion of [
    "gemini-2.5-flash", "gemini-2.0-flash", "test-model-version",
    "models/gemini-test", "gemini_test_v1", "model-001",
  ]) {
    assert.equal(normalizeGoogleGenerateContentResponse(
      response({ modelVersion }), request()
    ).model, modelVersion);
  }

  const providerRequest = providerContract.createEmptyProviderRequest();
  providerRequest.provider = "GEMINI";
  providerRequest.model = "safe-provider-model";
  providerRequest.messages = [
    { role: "system", content: "Return strict JSON." },
    { role: "user", content: "Bonjour" },
  ];
  const privacyResult = privacyGateway.sanitizePrivacyInput({
    ...privacyGateway.createEmptyPrivacyInput(),
    userMessage: "Bonjour",
  });
  const client = factory(() => response({ modelVersion: "awa@example.com" }));
  const finalResponse = await provider.createGeminiProvider({ client }).invoke({
    providerRequest,
    privacyResult,
  });
  assert.equal(finalResponse.model, providerRequest.model);
  assert.equal(JSON.stringify(finalResponse).includes("awa@example.com"), false);
});

test("hardening: sensitive response IDs become null while technical IDs survive", () => {
  const unsafe = [
    "secret-123", "SECRET_123", "password-123", "mot-de-passe-123",
    "private-key-123", "api-key-123", "access-token-123",
    "bearer-token-123", "service-role-key-123", "OTP-123456", "PIN-4321",
    "awa@example.com", "70-12-34-56", "+22670123456",
    "Adresse Ouagadougou secteur 15", "Adresse-Ouagadougou-secteur-15",
    "carte-identite-12345", "signature-Awa", "nom-Awa-Kabore",
    "IFU-00012345", "RCCM-BF-OUA", "waId-22670123456",
    "Passeport-A123456", "x".repeat(KADI_GEMINI_REAL_CLIENT_LIMITS.maxProviderRequestIdCodePoints + 1),
    "", "   ",
  ];
  for (const responseId of unsafe) {
    const output = normalizeGoogleGenerateContentResponse(
      response({ responseId }), request()
    );
    assert.equal(output.providerRequestId, null, responseId);
    if (responseId.trim()) {
      assert.equal(JSON.stringify(output).includes(responseId), false);
    }
  }
  for (const responseId of [
    "response_test_1", "req_001", "gemini-response-42",
    "call-prod-02", "trace_abc123", "abc123",
  ]) {
    assert.equal(normalizeGoogleGenerateContentResponse(
      response({ responseId }), request()
    ).providerRequestId, responseId);
  }
});

test("hardening: hostile SDK getters never expose raw exceptions", () => {
  const sentinel = ["HOSTILE", "GETTER", "PRIVATE"].join("_");
  function hostile(target, key) {
    Object.defineProperty(target, key, {
      configurable: true,
      get() {
        throw new Error(sentinel);
      },
    });
    return target;
  }
  const cases = [
    ["text", hostile(response(), "text"), "BAD_RESPONSE"],
    ["modelVersion", hostile(response(), "modelVersion"), null],
    ["responseId", hostile(response(), "responseId"), null],
    ["usageMetadata", hostile(response(), "usageMetadata"), null],
    ["candidates", hostile(response(), "candidates"), null],
  ];
  for (const [name, raw, expectedError] of cases) {
    if (expectedError) {
      assert.throws(
        () => normalizeGoogleGenerateContentResponse(raw, request()),
        (error) => {
          assert.deepEqual(error, { kind: expectedError });
          assert.deepEqual(Object.keys(error), ["kind"]);
          assert.equal(JSON.stringify(error).includes(sentinel), false);
          return true;
        },
        name
      );
    } else {
      const output = normalizeGoogleGenerateContentResponse(raw, request());
      assert.equal(JSON.stringify(output).includes(sentinel), false);
    }
  }

  for (const field of [
    "promptTokenCount", "candidatesTokenCount", "totalTokenCount",
  ]) {
    const usageMetadata = hostile({
      promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3,
    }, field);
    const output = normalizeGoogleGenerateContentResponse(
      response({ usageMetadata }), request()
    );
    assert.equal(output.usage[
      field === "promptTokenCount"
        ? "inputUnits"
        : field === "candidatesTokenCount"
          ? "outputUnits"
          : "totalUnits"
    ], null);
    assert.equal(JSON.stringify(output).includes(sentinel), false);
  }

  const candidatesWithHostileIndex = [];
  hostile(candidatesWithHostileIndex, "0");
  candidatesWithHostileIndex.length = 1;
  assert.equal(normalizeGoogleGenerateContentResponse(
    response({ candidates: candidatesWithHostileIndex }), request()
  ).finishReason, "UNKNOWN");
  const candidate = hostile({}, "finishReason");
  assert.equal(normalizeGoogleGenerateContentResponse(
    response({ candidates: [candidate] }), request()
  ).finishReason, "UNKNOWN");
});

test("hardening: canonical errors never retain the key or hostile SDK internals", async () => {
  const key = ["LOCAL", "KEY", "PRIVATE", "VALUE"].join("_");
  const privateValues = [
    key, `message-${key}`, `stack-${key}`, `cause-${key}`,
    `body-${key}`, `headers-${key}`, `config-${key}`,
    `response-${key}`, `request-${key}`, `url-${key}`,
  ];
  const rawError = {
    kind: "NETWORK",
    message: privateValues[1],
    stack: privateValues[2],
    cause: privateValues[3],
    body: privateValues[4],
    headers: privateValues[5],
    config: privateValues[6],
    response: privateValues[7],
    request: privateValues[8],
    url: privateValues[9],
    apiKey: key,
  };
  const client = createGeminiRealClient({
    apiKey: key,
    sdkFactory() {
      return {
        models: {
          generateContent() {
            throw Object.freeze(rawError);
          },
        },
      };
    },
  });
  await assert.rejects(client.generateContent(request()), (error) => {
    assert.deepEqual(error, { kind: "NETWORK" });
    assert.deepEqual(Object.keys(error), ["kind"]);
    for (const value of privateValues) {
      assert.equal(JSON.stringify(error).includes(value), false);
    }
    return true;
  });
  const getterError = {};
  Object.defineProperty(getterError, "kind", {
    get() {
      throw new Error(key);
    },
  });
  assert.deepEqual(mapGoogleGeminiError(getterError), { kind: "UNKNOWN" });
  assert.equal(JSON.stringify(client).includes(key), false);
});

test("hardening: injected factories keep the official SDK unloaded", async () => {
  const sdkCacheBefore = Object.keys(require.cache).filter(
    (entry) => entry.includes(`${path.sep}@google${path.sep}genai${path.sep}`)
  );
  let calls = 0;
  const injected = factory(() => {
    calls += 1;
    return response();
  });
  assert.equal((await injected.generateContent(request())).finishReason, "STOP");
  assert.equal(calls, 1);
  const sdkCacheAfter = Object.keys(require.cache).filter(
    (entry) => entry.includes(`${path.sep}@google${path.sep}genai${path.sep}`)
  );
  assert.deepEqual(sdkCacheAfter, sdkCacheBefore);

  const source = fs.readFileSync(
    path.join(__dirname, "..", "kadiBrainGeminiRealClient.js"),
    "utf8"
  );
  assert.equal(source.includes('require("@google/genai")'), false);
  assert.equal(source.includes('import("@google/genai")'), true);
  const lazyClient = createGeminiRealClient({ apiKey: "LOCAL_FAKE_KEY" });
  assert.deepEqual(Object.keys(lazyClient), ["generateContent"]);
  assert.deepEqual(
    Object.keys(require.cache).filter(
      (entry) => entry.includes(`${path.sep}@google${path.sep}genai${path.sep}`)
    ),
    sdkCacheBefore
  );
});

test("hardening: deeply frozen inputs and repeated mutated SDK calls stay independent", async () => {
  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
  }
  const options = deepFreeze({
    apiKey: "LOCAL_FAKE_KEY",
    sdkFactory() {
      return {
        models: {
          generateContent(googleRequest) {
            googleRequest.model = "mutated";
            googleRequest.contents[0].parts[0].text = "mutated";
            googleRequest.config.temperature = 1;
            return deepFreeze(response());
          },
        },
      };
    },
  });
  const neutralRequest = deepFreeze(request());
  const firstBuild = buildGoogleGenerateContentRequest(neutralRequest);
  const secondBuild = buildGoogleGenerateContentRequest(neutralRequest);
  assert.notStrictEqual(firstBuild, secondBuild);
  assert.notStrictEqual(firstBuild.contents, secondBuild.contents);
  assert.notStrictEqual(firstBuild.contents[0], secondBuild.contents[0]);
  assert.notStrictEqual(firstBuild.contents[0].parts, secondBuild.contents[0].parts);
  assert.notStrictEqual(firstBuild.contents[0].parts[0], secondBuild.contents[0].parts[0]);
  assert.notStrictEqual(firstBuild.config, secondBuild.config);
  const client = createGeminiRealClient(options);
  const first = await client.generateContent(neutralRequest);
  const second = await client.generateContent(neutralRequest);
  assert.deepEqual(first, second);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.usage, second.usage);
  assert.equal(JSON.stringify(neutralRequest), JSON.stringify(request()));
});

test("coverage closure: model versions and response IDs are filtered through the full provider", async () => {
  const modelCases = [
    "awa@example.com", "70 12 34 56", "+22670123456",
    "Adresse Ouagadougou secteur 15", "Adresse-Ouagadougou-secteur-15",
    "secret-123", "password-123", "mot-de-passe-123", "private-key-123",
    "api-key-123", "access-token-123", "bearer-token-123",
    "service-role-key-123", "OTP-123456", "PIN-4321", "waId-22670123456",
    "IFU-00012345", "RCCM-BF-OUA", "Passeport-A123456",
    "Carte-Identite-12345", "Nom-Awa-Kabore", "Signature-Awa", "", "   ",
    "x".repeat(KADI_GEMINI_REAL_CLIENT_LIMITS.maxModelCodePoints + 1),
    null, undefined, 42, false, [], {},
    "gemini-2.5-flash", "gemini-2.0-flash", "models/gemini-test",
    "test-model-version", "gemini_test_v1", "model-001",
  ];
  const idCases = [
    "secret-123", "SECRET_123", "password-123", "mot-de-passe-123",
    "private-key-123", "api-key-123", "access-token-123", "bearer-token-123",
    "service-role-key-123", "OTP-123456", "PIN-4321", "awa@example.com",
    "70-12-34-56", "+22670123456", "Adresse Ouagadougou secteur 15",
    "Adresse-Ouagadougou-secteur-15", "carte-identite-12345",
    "signature-Awa", "nom-Awa-Kabore", "IFU-00012345", "RCCM-BF-OUA",
    "waId-22670123456", "Passeport-A123456", "", "   ",
    "x".repeat(KADI_GEMINI_REAL_CLIENT_LIMITS.maxProviderRequestIdCodePoints + 1),
    "response_test_1", "req_001", "gemini-response-42",
    "call-prod-02", "trace_abc123", "abc123",
  ];
  const safeModels = new Set([
    "gemini-2.5-flash", "gemini-2.0-flash", "models/gemini-test",
    "test-model-version", "gemini_test_v1", "model-001",
  ]);
  const safeIds = new Set([
    "response_test_1", "req_001", "gemini-response-42",
    "call-prod-02", "trace_abc123", "abc123",
  ]);
  function providerInput() {
    const providerRequest = providerContract.createEmptyProviderRequest();
    providerRequest.provider = "GEMINI";
    providerRequest.model = "safe-provider-model";
    providerRequest.messages = [
      { role: "system", content: "Return strict JSON." },
      { role: "user", content: "Bonjour" },
    ];
    return {
      providerRequest,
      privacyResult: privacyGateway.sanitizePrivacyInput({
        ...privacyGateway.createEmptyPrivacyInput(),
        userMessage: "Bonjour",
      }),
    };
  }
  for (const modelVersion of modelCases) {
    let calls = 0;
    const output = await provider.createGeminiProvider({
      client: factory(() => {
        calls += 1;
        return response({ modelVersion });
      }),
    }).invoke(providerInput());
    assert.equal(calls, 1);
    assert.equal(providerContract.validateProviderResponse(output).valid, true);
    if (safeModels.has(modelVersion)) {
      assert.equal(output.model, modelVersion);
    } else {
      assert.equal(output.model, "safe-provider-model");
      if (typeof modelVersion === "string" && modelVersion) {
        assert.equal(JSON.stringify(output).includes(modelVersion), false);
      }
    }
  }
  for (const responseId of idCases) {
    let calls = 0;
    const output = await provider.createGeminiProvider({
      client: factory(() => {
        calls += 1;
        return response({ responseId });
      }),
    }).invoke(providerInput());
    assert.equal(calls, 1);
    assert.equal(providerContract.validateProviderResponse(output).valid, true);
    if (safeIds.has(responseId)) {
      assert.equal(output.metadata.providerRequestId, responseId);
    } else {
      assert.equal(output.metadata.providerRequestId, null);
      if (responseId) assert.equal(JSON.stringify(output).includes(responseId), false);
    }
  }
});

test("coverage closure: every hostile response getter is contained at all three boundaries", async () => {
  const sentinel = ["HOSTILE", "BOUNDARY", "PRIVATE"].join("_");
  const cases = [
    ["text", "root"], ["modelVersion", "root"], ["responseId", "root"],
    ["usageMetadata", "root"], ["promptTokenCount", "usage"],
    ["candidatesTokenCount", "usage"], ["totalTokenCount", "usage"],
    ["candidates", "root"], ["0", "candidates"], ["finishReason", "candidate"],
  ];
  function hostileResponse(field, location) {
    const raw = response();
    let target = raw;
    if (location === "usage") target = raw.usageMetadata;
    if (location === "candidates") target = raw.candidates;
    if (location === "candidate") target = raw.candidates[0];
    Object.defineProperty(target, field, {
      configurable: true,
      get() {
        throw new Error(sentinel);
      },
    });
    return raw;
  }
  function providerInput() {
    const providerRequest = providerContract.createEmptyProviderRequest();
    providerRequest.provider = "GEMINI";
    providerRequest.model = "safe-provider-model";
    providerRequest.messages = [
      { role: "system", content: "Return strict JSON." },
      { role: "user", content: "Bonjour" },
    ];
    return {
      providerRequest,
      privacyResult: privacyGateway.sanitizePrivacyInput({
        ...privacyGateway.createEmptyPrivacyInput(), userMessage: "Bonjour",
      }),
    };
  }
  for (const [field, location] of cases) {
    const isRequiredText = field === "text";
    const direct = () => normalizeGoogleGenerateContentResponse(
      hostileResponse(field, location), request()
    );
    if (isRequiredText) {
      assert.throws(direct, (error) => {
        assert.deepEqual(error, { kind: "BAD_RESPONSE" });
        return true;
      });
    } else {
      assert.equal(JSON.stringify(direct()).includes(sentinel), false);
    }

    let directClientCalls = 0;
    const client = factory(() => {
      directClientCalls += 1;
      return hostileResponse(field, location);
    });
    if (isRequiredText) {
      await assert.rejects(client.generateContent(request()), { kind: "BAD_RESPONSE" });
    } else {
      assert.equal(JSON.stringify(await client.generateContent(request())).includes(sentinel), false);
    }
    assert.equal(directClientCalls, 1);

    let providerCalls = 0;
    const finalResponse = await provider.createGeminiProvider({
      client: factory(() => {
        providerCalls += 1;
        return hostileResponse(field, location);
      }),
    }).invoke(providerInput());
    assert.equal(providerCalls, 1);
    assert.equal(providerContract.validateProviderResponse(finalResponse).valid, true);
    assert.equal(JSON.stringify(finalResponse).includes(sentinel), false);
    if (isRequiredText) assert.equal(finalResponse.errorCode, "PROVIDER_BAD_RESPONSE");
  }
});

test("coverage closure: API keys never escape client ownership or canonical outputs", async () => {
  const key = ["PRIVATE", "API", "KEY", "VALUE"].join("_");
  let sdkInput;
  let googleRequest;
  const client = createGeminiRealClient({
    apiKey: key,
    sdkFactory(input) {
      sdkInput = input;
      return {
        models: {
          generateContent(inputRequest) {
            googleRequest = inputRequest;
            return response();
          },
        },
      };
    },
  });
  assert.deepEqual(Object.keys(client), ["generateContent"]);
  assert.deepEqual(Object.getOwnPropertyNames(client), ["generateContent"]);
  assert.equal(JSON.stringify(client).includes(key), false);
  const output = await client.generateContent(request());
  assert.equal(sdkInput.apiKey, key);
  assert.equal(JSON.stringify(googleRequest).includes(key), false);
  assert.equal(JSON.stringify(output).includes(key), false);

  const providerRequest = providerContract.createEmptyProviderRequest();
  providerRequest.provider = "GEMINI";
  providerRequest.model = "safe-provider-model";
  providerRequest.messages = [
    { role: "system", content: "Return strict JSON." },
    { role: "user", content: "Bonjour" },
  ];
  const finalResponse = await provider.createGeminiProvider({ client }).invoke({
    providerRequest,
    privacyResult: privacyGateway.sanitizePrivacyInput({
      ...privacyGateway.createEmptyPrivacyInput(), userMessage: "Bonjour",
    }),
  });
  assert.equal(JSON.stringify(finalResponse).includes(key), false);
  assert.equal(JSON.stringify(finalResponse.metadata).includes(key), false);
  assert.equal(JSON.stringify(finalResponse.usage).includes(key), false);
  assert.equal(JSON.stringify(finalResponse.content).includes(key), false);

  const rawError = Object.freeze({
    status: 503,
    message: key, stack: key, cause: key, headers: key, body: key,
    config: key, request: key, response: key, url: key,
  });
  const errorClient = createGeminiRealClient({
    apiKey: key,
    sdkFactory() {
      return { models: { generateContent() { throw rawError; } } };
    },
  });
  await assert.rejects(errorClient.generateContent(request()), (error) => {
    assert.deepEqual(Object.keys(error), ["kind"]);
    assert.equal(JSON.stringify(error).includes(key), false);
    return true;
  });
  const providerError = await provider.createGeminiProvider({
    client: errorClient,
  }).invoke({
    providerRequest,
    privacyResult: privacyGateway.sanitizePrivacyInput({
      ...privacyGateway.createEmptyPrivacyInput(), userMessage: "Bonjour",
    }),
  });
  assert.equal(providerContract.validateProviderResponse(providerError).valid, true);
  assert.equal(JSON.stringify(providerError).includes(key), false);

  const getterError = {};
  Object.defineProperty(getterError, "status", {
    get() {
      throw new Error(key);
    },
  });
  const getterClient = createGeminiRealClient({
    apiKey: key,
    sdkFactory() {
      return { models: { generateContent() { throw getterError; } } };
    },
  });
  await assert.rejects(getterClient.generateContent(request()), (error) => {
    assert.deepEqual(Object.keys(error), ["kind"]);
    assert.equal(JSON.stringify(error).includes(key), false);
    return true;
  });
});

test("coverage closure: exhaustive SDK mutations cannot affect later calls or caller inputs", async () => {
  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
  }
  const neutralRequest = deepFreeze(request());
  const before = JSON.stringify(neutralRequest);
  const builds = [];
  const client = factory((sdkRequest) => {
    builds.push(JSON.parse(JSON.stringify(sdkRequest)));
    const contents = sdkRequest.contents;
    const firstContent = contents[0];
    const parts = firstContent.parts;
    const firstPart = parts[0];
    const config = sdkRequest.config;
    sdkRequest.model = "mutated";
    sdkRequest.systemInstruction = "mutated";
    sdkRequest.contents = [];
    contents.push({ role: "user", parts: [{ text: "injected" }] });
    contents[0] = { role: "model", parts: [] };
    firstContent.role = "model";
    firstContent.parts = [];
    parts.push({ text: "injected" });
    parts[0] = { text: "replaced" };
    firstPart.text = "mutated";
    sdkRequest.config = {};
    config.systemInstruction = "mutated";
    config.temperature = 1;
    config.maxOutputTokens = 1;
    config.responseMimeType = "text/plain";
    return deepFreeze(response());
  });
  const first = await client.generateContent(neutralRequest);
  const second = await client.generateContent(neutralRequest);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.usage, second.usage);
  assert.equal(JSON.stringify(neutralRequest), before);
  assert.equal(builds.length, 2);
  assert.deepEqual(builds[0], builds[1]);

  const buildOne = buildGoogleGenerateContentRequest(neutralRequest);
  const buildTwo = buildGoogleGenerateContentRequest(neutralRequest);
  const buildTwoBefore = JSON.stringify(buildTwo);
  buildOne.model = "changed";
  buildOne.contents[0].role = "model";
  buildOne.contents[0].parts[0].text = "changed";
  buildOne.config.temperature = 1;
  assert.equal(JSON.stringify(buildTwo), buildTwoBefore);
  assert.equal(JSON.stringify(neutralRequest), before);
});

test("coverage closure: promises, reordered values, Unicode, partial usage, and failures are deterministic", async () => {
  const unicodeRequest = request({
    systemInstruction: "Répondre en JSON.\nDeuxième ligne.",
    contents: [{ role: "user", parts: [{ text: "Awa 👩🏿‍💼\nFacture n° 42" }] }],
  });
  const successClient = factory(() => response({
    text: '{"message":"Création ✅\\nterminée"}',
    usageMetadata: { promptTokenCount: 7 },
    candidates: [{ finishReason: "UNRECOGNIZED_FUTURE_REASON" }],
  }));
  const promise = successClient.generateContent(unicodeRequest);
  assert.equal(promise instanceof Promise, true);
  const first = await promise;
  const second = await successClient.generateContent(reverse(unicodeRequest));
  assert.deepEqual(first, second);
  assert.deepEqual(first.usage, { inputUnits: 7, outputUnits: null, totalUnits: null });
  assert.equal(first.finishReason, "UNKNOWN");

  const invalidPromise = successClient.generateContent(null);
  assert.equal(invalidPromise instanceof Promise, true);
  await assert.rejects(invalidPromise, { kind: "BAD_RESPONSE" });
  const exceptionClient = factory(() => {
    throw Object.freeze({ status: 429, message: "rate limited" });
  });
  const exceptionPromise = exceptionClient.generateContent(request());
  assert.equal(exceptionPromise instanceof Promise, true);
  await assert.rejects(exceptionPromise, { kind: "RATE_LIMIT" });
  assert.deepEqual(
    mapGoogleGeminiError({ status: 429, message: "rate limited" }),
    mapGoogleGeminiError(reverse({ status: 429, message: "rate limited" }))
  );

  const hostile = response();
  Object.defineProperty(hostile, "text", {
    get() {
      throw new Error("PRIVATE_GETTER_VALUE");
    },
  });
  const hostilePromise = factory(() => hostile).generateContent(request());
  assert.equal(hostilePromise instanceof Promise, true);
  await assert.rejects(hostilePromise, { kind: "BAD_RESPONSE" });
});
