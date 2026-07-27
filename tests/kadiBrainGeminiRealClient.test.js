"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const real = require("../kadiBrainGeminiRealClient");

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
  assert.equal(source.includes('require("@google/genai")'), true);
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
