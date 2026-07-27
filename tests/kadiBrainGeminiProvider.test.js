"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const providerContract = require("../kadiBrainProviderContract");
const privacyGateway = require("../kadiBrainPrivacyGateway");
const gemini = require("../kadiBrainGeminiProvider");

const {
  createEmptyProviderRequest,
  validateProviderResponse,
} = providerContract;
const {
  createEmptyPrivacyInput,
  sanitizePrivacyInput,
} = privacyGateway;
const {
  KADI_GEMINI_PROVIDER_VERSION,
  KADI_GEMINI_CLIENT_ERROR_KINDS,
  KADI_GEMINI_FINISH_REASONS,
  createGeminiProvider,
  buildGeminiClientRequest,
  normalizeGeminiClientResult,
  mapGeminiClientError,
} = gemini;

function validProviderRequest() {
  const request = createEmptyProviderRequest();
  request.provider = "GEMINI";
  request.model = "test-model";
  request.messages = [
    { role: "system", content: "Return strict JSON." },
    { role: "user", content: "Créer une facture de 125000 FCFA." },
  ];
  return request;
}

function safePrivacyResult() {
  return sanitizePrivacyInput({
    ...createEmptyPrivacyInput(),
    userMessage: "Créer une facture de 125000 FCFA.",
  });
}

function clientResult(overrides = {}) {
  return {
    text: '{"schemaVersion":"kadi.intent.v1","intent":"CREATE_INVOICE"}',
    model: "test-model",
    finishReason: "STOP",
    usage: { inputUnits: 100, outputUnits: 30, totalUnits: 130 },
    providerRequestId: "req_test_1",
    ...overrides,
  };
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const key of Object.keys(value).reverse()) output[key] = reverseKeys(value[key]);
  return output;
}

function assertCanonical(response) {
  assert.equal(validateProviderResponse(response).valid, true);
  assert.deepEqual(Object.keys(response), [
    "schemaVersion", "provider", "model", "status", "ok", "content",
    "errorCode", "failureKind", "recoverable", "usage", "metadata",
  ]);
}

test("scenarios 1-4: exact frozen adapter constants", () => {
  assert.equal(KADI_GEMINI_PROVIDER_VERSION, "kadi.gemini-provider.v1");
  assert.deepEqual(KADI_GEMINI_CLIENT_ERROR_KINDS, {
    NETWORK: "NETWORK", TIMEOUT: "TIMEOUT", RATE_LIMIT: "RATE_LIMIT",
    AUTHENTICATION: "AUTHENTICATION", SAFETY: "SAFETY", CONTENT: "CONTENT",
    UNAVAILABLE: "UNAVAILABLE", BAD_RESPONSE: "BAD_RESPONSE", INTERNAL: "INTERNAL",
    CANCELLED: "CANCELLED", UNKNOWN: "UNKNOWN",
  });
  assert.deepEqual(KADI_GEMINI_FINISH_REASONS, {
    STOP: "STOP", MAX_OUTPUT: "MAX_OUTPUT", SAFETY: "SAFETY",
    CONTENT_FILTER: "CONTENT_FILTER", TOOL_CALL: "TOOL_CALL", ERROR: "ERROR",
    CANCELLED: "CANCELLED", UNKNOWN: "UNKNOWN",
  });
  for (const value of [
    KADI_GEMINI_CLIENT_ERROR_KINDS,
    KADI_GEMINI_FINISH_REASONS,
  ]) {
    assert.equal(Object.isFrozen(value), true);
    const key = Object.keys(value)[0];
    assert.throws(() => { value[key] = "MUTATED"; }, TypeError);
  }
});

test("scenarios 5-13: factory is total, isolated, and stateless", async () => {
  for (const options of [undefined, null, "x", 2, {}, { client: {} }, {
    client: { generateContent: "bad" },
  }]) {
    const provider = createGeminiProvider(options);
    assert.equal(typeof provider.invoke, "function");
    const response = await provider.invoke({
      providerRequest: validProviderRequest(),
      privacyResult: safePrivacyResult(),
    });
    assertCanonical(response);
    assert.equal(response.errorCode, "PROVIDER_UNAVAILABLE");
  }
  const client = { generateContent: () => clientResult() };
  const first = createGeminiProvider({ client });
  const second = createGeminiProvider({ client });
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.invoke, second.invoke);
  assert.equal((await first.invoke({
    providerRequest: validProviderRequest(), privacyResult: safePrivacyResult(),
  })).ok, true);
});

test("scenarios 14-26: invalid invocations fail before the simulated client", async () => {
  let calls = 0;
  const provider = createGeminiProvider({
    client: { generateContent() { calls += 1; return clientResult(); } },
  });
  const valid = {
    providerRequest: validProviderRequest(),
    privacyResult: safePrivacyResult(),
  };
  const invalidRequest = validProviderRequest(); invalidRequest.messages = [];
  const wrongProvider = validProviderRequest(); wrongProvider.provider = "OPENAI";
  const nullModel = validProviderRequest(); nullModel.model = null;
  const emptyModel = validProviderRequest(); emptyModel.model = " ";
  const blocked = sanitizePrivacyInput({
    ...createEmptyPrivacyInput(), userMessage: "OTP 123456",
  });
  const forgedPrivacy = { ...safePrivacyResult(), summary: {
    ...safePrivacyResult().summary, containsSecrets: true,
  } };
  const cases = [
    [null, "INVALID_REQUEST"],
    [{}, "INVALID_REQUEST"],
    [{ providerRequest: validProviderRequest() }, "INVALID_REQUEST"],
    [{ privacyResult: safePrivacyResult() }, "INVALID_REQUEST"],
    [{ ...valid, providerRequest: invalidRequest }, "INVALID_REQUEST"],
    [{ ...valid, providerRequest: wrongProvider }, "INVALID_PROVIDER"],
    [{ ...valid, providerRequest: nullModel }, "INVALID_MODEL"],
    [{ ...valid, providerRequest: emptyModel }, "INVALID_REQUEST"],
    [{ ...valid, privacyResult: blocked }, "INVALID_REQUEST"],
    [{ ...valid, privacyResult: forgedPrivacy }, "INVALID_REQUEST"],
  ];
  for (const [input, errorCode] of cases) {
    const response = await provider.invoke(input);
    assertCanonical(response);
    assert.equal(response.ok, false);
    assert.equal(response.errorCode, errorCode);
  }
  assert.equal(calls, 0);
});

test("scenarios 27-44: neutral request build is exact, private, immutable, and deterministic", () => {
  const request = validProviderRequest();
  request.messages.push({ role: "user", content: "Deuxième demande 😀" });
  const before = JSON.stringify(request);
  const built = buildGeminiClientRequest(request);
  assert.deepEqual(built, {
    model: "test-model",
    systemInstruction: "Return strict JSON.",
    contents: [
      { role: "user", parts: [{ text: "Créer une facture de 125000 FCFA." }] },
      { role: "user", parts: [{ text: "Deuxième demande 😀" }] },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputCodePoints: 32000,
      responseMimeType: "application/json",
    },
  });
  assert.equal(JSON.stringify(request), before);
  assert.equal(JSON.stringify(built).includes("restorationMap"), false);
  assert.equal(JSON.stringify(built).includes("privacyResult"), false);
  assert.deepEqual(Object.keys(built), [
    "model", "systemInstruction", "contents", "generationConfig",
  ]);
  const second = buildGeminiClientRequest(request);
  assert.equal(JSON.stringify(built), JSON.stringify(second));
  assert.notStrictEqual(built, second);
  assert.notStrictEqual(built.contents, second.contents);
  assert.notStrictEqual(built.contents[0], second.contents[0]);
  assert.notStrictEqual(built.contents[0].parts, second.contents[0].parts);
  assert.notStrictEqual(built.contents[0].parts[0], second.contents[0].parts[0]);
  assert.notStrictEqual(built.generationConfig, second.generationConfig);

  const badRole = validProviderRequest();
  badRole.messages[1].role = "assistant";
  assert.equal(buildGeminiClientRequest(badRole), null);
  const systems = validProviderRequest();
  systems.messages.splice(1, 0, { role: "system", content: "Other." });
  assert.equal(buildGeminiClientRequest(systems), null);
});

test("scenarios 45-53: sync and async clients are called once without retries or mutation", async () => {
  for (const asynchronous of [false, true]) {
    let calls = 0;
    let received;
    const raw = clientResult();
    const before = JSON.stringify(raw);
    const client = {
      generateContent(request) {
        calls += 1;
        received = request;
        return asynchronous ? Promise.resolve(raw) : raw;
      },
    };
    const response = await createGeminiProvider({ client }).invoke({
      providerRequest: validProviderRequest(),
      privacyResult: safePrivacyResult(),
    });
    assert.equal(calls, 1);
    assert.deepEqual(received, buildGeminiClientRequest(validProviderRequest()));
    assert.equal(response.ok, true);
    assert.equal(JSON.stringify(raw), before);
  }

  for (const asynchronous of [false, true]) {
    let calls = 0;
    const client = {
      generateContent() {
        calls += 1;
        const error = { kind: "NETWORK", message: "PRIVATE_ERROR" };
        if (asynchronous) return Promise.reject(error);
        throw error;
      },
    };
    const response = await createGeminiProvider({ client }).invoke({
      providerRequest: validProviderRequest(),
      privacyResult: safePrivacyResult(),
    });
    assert.equal(calls, 1);
    assert.equal(response.errorCode, "PROVIDER_NETWORK_ERROR");
    assert.equal(JSON.stringify(response).includes("PRIVATE_ERROR"), false);
  }
});

test("scenarios 54-70: simulated STOP results normalize without raw data or parsing", () => {
  const request = validProviderRequest();
  const response = normalizeGeminiClientResult(clientResult({
    raw: "PRIVATE_RAW", headers: "PRIVATE_HEADERS", candidates: ["PRIVATE"],
  }), request);
  assertCanonical(response);
  assert.equal(response.ok, true);
  assert.equal(response.provider, "GEMINI");
  assert.equal(response.model, "test-model");
  assert.equal(response.content, clientResult().text);
  assert.deepEqual(response.usage, {
    inputUnits: 100, outputUnits: 30, totalUnits: 130,
  });
  assert.equal(response.metadata.providerRequestId, "req_test_1");
  assert.equal(JSON.stringify(response).includes("PRIVATE"), false);

  const noUsage = normalizeGeminiClientResult(clientResult({ usage: undefined }), request);
  assert.deepEqual(noUsage.usage, {
    inputUnits: null, outputUnits: null, totalUnits: null,
  });
  const badUsage = normalizeGeminiClientResult(clientResult({
    usage: { inputUnits: -1, outputUnits: 2.5, totalUnits: Infinity },
  }), request);
  assert.deepEqual(badUsage.usage, {
    inputUnits: null, outputUnits: null, totalUnits: null,
  });
  const longId = normalizeGeminiClientResult(clientResult({
    providerRequestId: "x".repeat(201),
  }), request);
  assert.equal(longId.metadata.providerRequestId, null);

  for (const result of [
    clientResult({ text: "" }), null, "x", 2, [],
  ]) {
    const failure = normalizeGeminiClientResult(result, request);
    assertCanonical(failure);
    assert.equal(failure.ok, false);
  }
});

test("scenarios 71-81: every finish reason maps to a canonical response", () => {
  const expected = {
    STOP: ["SUCCEEDED", "NONE"],
    MAX_OUTPUT: ["FAILED", "PROVIDER_BAD_RESPONSE"],
    SAFETY: ["REJECTED", "PROVIDER_SAFETY_BLOCK"],
    CONTENT_FILTER: ["REJECTED", "PROVIDER_CONTENT_BLOCK"],
    TOOL_CALL: ["FAILED", "PROVIDER_BAD_RESPONSE"],
    ERROR: ["FAILED", "PROVIDER_INTERNAL_ERROR"],
    CANCELLED: ["CANCELLED", "CANCELLED"],
    UNKNOWN: ["FAILED", "PROVIDER_BAD_RESPONSE"],
  };
  for (const [finishReason, [status, errorCode]] of Object.entries(expected)) {
    const response = normalizeGeminiClientResult(
      clientResult({ finishReason }),
      validProviderRequest()
    );
    assertCanonical(response);
    assert.equal(response.status, status);
    assert.equal(response.errorCode, errorCode);
  }
  for (const finishReason of [undefined, "OTHER", 3]) {
    const response = normalizeGeminiClientResult(
      clientResult({ finishReason }),
      validProviderRequest()
    );
    assertCanonical(response);
    assert.equal(response.errorCode, "PROVIDER_BAD_RESPONSE");
  }
});

test("scenarios 82-103: client errors map canonically without exposing raw errors", () => {
  const expected = {
    NETWORK: ["PROVIDER_NETWORK_ERROR", "NETWORK", "FAILED", true],
    TIMEOUT: ["PROVIDER_TIMEOUT", "TIMEOUT", "TIMED_OUT", true],
    RATE_LIMIT: ["PROVIDER_RATE_LIMITED", "RATE_LIMIT", "FAILED", true],
    AUTHENTICATION: ["PROVIDER_AUTH_FAILED", "AUTHENTICATION", "REJECTED", false],
    SAFETY: ["PROVIDER_SAFETY_BLOCK", "SAFETY", "REJECTED", false],
    CONTENT: ["PROVIDER_CONTENT_BLOCK", "CONTENT", "REJECTED", false],
    UNAVAILABLE: ["PROVIDER_UNAVAILABLE", "PROVIDER", "FAILED", true],
    BAD_RESPONSE: ["PROVIDER_BAD_RESPONSE", "PROVIDER", "FAILED", true],
    INTERNAL: ["PROVIDER_INTERNAL_ERROR", "INTERNAL", "FAILED", true],
    CANCELLED: ["CANCELLED", "NONE", "CANCELLED", false],
    UNKNOWN: ["PROVIDER_INTERNAL_ERROR", "INTERNAL", "FAILED", true],
  };
  for (const [kind, [errorCode, failureKind, status, recoverable]] of Object.entries(expected)) {
    const error = Object.freeze({
      kind, message: `PRIVATE_${kind}`, stack: "PRIVATE_STACK",
      cause: "PRIVATE_CAUSE", body: "PRIVATE_BODY", headers: "PRIVATE_HEADERS",
    });
    const response = mapGeminiClientError(error);
    assertCanonical(response);
    assert.equal(response.errorCode, errorCode);
    assert.equal(response.failureKind, failureKind);
    assert.equal(response.status, status);
    assert.equal(response.recoverable, recoverable);
    assert.equal(JSON.stringify(response).includes("PRIVATE_"), false);
  }
  for (const error of [null, undefined, "PRIVATE", 4, new Error("PRIVATE")]) {
    const response = mapGeminiClientError(error);
    assertCanonical(response);
    assert.equal(JSON.stringify(response).includes("PRIVATE"), false);
  }
});

test("scenarios 104-112: privacy is only a gate and never a client data source", async () => {
  let received;
  const privateSentinel = "PRIVATE_RESTORATION_SENTINEL";
  const privacyResult = safePrivacyResult();
  privacyResult.restorationMap = { PERSON_1: privateSentinel };
  const provider = createGeminiProvider({
    client: {
      generateContent(request) {
        received = request;
        return clientResult();
      },
    },
  });
  const response = await provider.invoke({
    providerRequest: validProviderRequest(),
    privacyResult,
  });
  assert.equal(response.ok, false);
  assert.equal(received, undefined);

  const accepted = safePrivacyResult();
  const acceptedResponse = await provider.invoke({
    providerRequest: validProviderRequest(),
    privacyResult: accepted,
  });
  assert.equal(acceptedResponse.ok, true);
  assert.equal(JSON.stringify(received).includes("restorationMap"), false);
  assert.equal(JSON.stringify(received).includes("sanitizedInput"), false);
  assert.equal(JSON.stringify(received).includes(privateSentinel), false);
  assert.equal(JSON.stringify(acceptedResponse).includes(privateSentinel), false);
});

test("scenarios 113-122: frozen inputs and repeated calls remain independent and deterministic", async () => {
  const request = validProviderRequest();
  request.messages = request.messages.map((message) => Object.freeze(message));
  Object.freeze(request.messages);
  Object.freeze(request.generation);
  Object.freeze(request.responseFormat);
  Object.freeze(request.metadata.tags);
  Object.freeze(request.metadata);
  Object.freeze(request);
  const privacyResult = safePrivacyResult();
  Object.freeze(privacyResult);
  const raw = clientResult();
  Object.freeze(raw.usage);
  Object.freeze(raw);
  const provider = createGeminiProvider({
    client: { generateContent: () => raw },
  });
  const first = await provider.invoke({ providerRequest: request, privacyResult });
  const second = await provider.invoke({ providerRequest: request, privacyResult });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.usage, second.usage);
  assert.notStrictEqual(first.metadata, second.metadata);
  const build1 = buildGeminiClientRequest(request);
  const build2 = buildGeminiClientRequest(reverseKeys(request));
  assert.equal(JSON.stringify(build1), JSON.stringify(build2));
  assert.notStrictEqual(build1, build2);
});

test("scenarios 123-150: production imports and source expose no real provider surface", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "kadiBrainGeminiProvider.js"),
    "utf8"
  );
  assert.deepEqual(
    Array.from(source.matchAll(/require\((["'])(.*?)\1\)/g), (match) => match[2]),
    ["./kadiBrainProviderContract", "./kadiBrainPrivacyGateway"]
  );
  assert.doesNotMatch(source, /\bimport\s*\(/);
  const forbidden = [
    /@google\/genai/i, /\bGoogleGenAI\b/, /\bGoogleGenerativeAI\b/,
    /generative-ai/i, /ai\.google\.dev/i, /generativelanguage\.googleapis\.com/i,
    /\bfetch\s*\(/, /\baxios\b/i,
    /\brequire\s*\(\s*["'](?:node:)?(?:http|https|net|tls|fs|crypto|vm|child_process)["']/i,
    /\bnode:(?:http|https|net|tls)\b/i, /https?:\/\//i, /process\.env/,
    /GEMINI_API_KEY/, /GOOGLE_API_KEY/, /\bapiKey\b/, /\bsupabase\b/i,
    /\breadFile\b/, /\bwriteFile\b/, /\bappendFile\b/, /\bcreateWriteStream\b/,
    /Date\.now/, /Math\.random/, /\brandomUUID\b/, /\buuid\b/i,
    /\bsetTimeout\b/, /\bsetInterval\b/, /\bAbortController\b/,
    /\beval\s*\(/, /\bnew\s+Function\b/, /\bFunction\s*\(/,
    /\bexec\s*\(/, /\bspawn\s*\(/, /\bconsole\./, /\blogger\b/i,
    /\btelemetry\b/i, /\banalytics\b/i, /\bwebhook\b/i, /\bdispatch\b/i,
    /\bexecuteIntent\b/, /\bcreateInvoice\b/, /\bcreateQuote\b/,
    /\bcreateReceipt\b/, /\bdebitCredit\b/, /\bsendMessage\b/,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(source, pattern);
});
