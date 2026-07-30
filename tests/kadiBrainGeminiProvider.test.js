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

async function invokeWithMessage(role, content) {
  let calls = 0;
  let captured = null;
  const request = validProviderRequest();
  request.messages = [
    { role: "system", content: "Return strict JSON." },
    { role: "user", content: "Bonjour" },
  ];
  request.messages[role === "system" ? 0 : 1].content = content;
  const response = await createGeminiProvider({
    client: {
      generateContent(value) {
        calls += 1;
        captured = value;
        return clientResult();
      },
    },
  }).invoke({
    providerRequest: request,
    privacyResult: safePrivacyResult(),
  });
  return { calls, captured, response };
}

test("scenarios 1-4: exact frozen adapter constants", () => {
  assert.equal(KADI_GEMINI_PROVIDER_VERSION, "kadi.gemini-provider.v1");
  assert.deepEqual(KADI_GEMINI_CLIENT_ERROR_KINDS, {
    NETWORK: "NETWORK", TIMEOUT: "TIMEOUT", RATE_LIMIT: "RATE_LIMIT",
    AUTHENTICATION: "AUTHENTICATION", SAFETY: "SAFETY", CONTENT: "CONTENT",
    UNAVAILABLE: "UNAVAILABLE", BAD_RESPONSE: "BAD_RESPONSE",
    REQUEST_REJECTED: "REQUEST_REJECTED", MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
    INTERNAL: "INTERNAL",
    SDK_EXPORT_MISSING: "SDK_EXPORT_MISSING",
    SDK_CONSTRUCTOR_INVALID: "SDK_CONSTRUCTOR_INVALID",
    SDK_CLIENT_INVALID: "SDK_CLIENT_INVALID",
    SDK_METHOD_MISSING: "SDK_METHOD_MISSING",
    SDK_REQUEST_BUILD_FAILED: "SDK_REQUEST_BUILD_FAILED",
    SDK_RESPONSE_NORMALIZATION_FAILED: "SDK_RESPONSE_NORMALIZATION_FAILED",
    SDK_UNKNOWN_FAILURE: "SDK_UNKNOWN_FAILURE",
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

test("hardening: factory and invoke reject remaining primitive and malformed inputs", async () => {
  for (const options of [true, false, []]) {
    const response = await createGeminiProvider(options).invoke({
      providerRequest: validProviderRequest(),
      privacyResult: safePrivacyResult(),
    });
    assertCanonical(response);
    assert.equal(response.errorCode, "PROVIDER_UNAVAILABLE");
  }

  let calls = 0;
  const provider = createGeminiProvider({
    client: { generateContent() { calls += 1; return clientResult(); } },
  });
  const invalidInputs = [undefined, "x", 4, true];
  for (const input of invalidInputs) {
    const response = await provider.invoke(input);
    assertCanonical(response);
    assert.equal(response.errorCode, "INVALID_REQUEST");
  }
  const badVersion = validProviderRequest(); badVersion.schemaVersion = "bad";
  const generic = validProviderRequest(); generic.provider = "GENERIC";
  const noMessages = validProviderRequest(); delete noMessages.messages;
  for (const request of [badVersion, generic, noMessages]) {
    const response = await provider.invoke({
      providerRequest: request,
      privacyResult: safePrivacyResult(),
    });
    assertCanonical(response);
    assert.equal(response.ok, false);
  }
  assert.equal(calls, 0);
});

test("hardening: forged privacy payloads never reach the client", async () => {
  let calls = 0;
  const provider = createGeminiProvider({
    client: { generateContent() { calls += 1; return clientResult(); } },
  });
  const forgedValues = [
    { userMessage: "Téléphone 70 12 34 56", context: {} },
    { userMessage: "Email awa@example.com", context: {} },
    { userMessage: "Adresse Ouagadougou secteur 15", context: {} },
    { userMessage: "OTP 123456", context: {} },
  ];
  for (const sanitizedInput of forgedValues) {
    const privacyResult = {
      ...safePrivacyResult(),
      sanitizedInput,
    };
    const response = await provider.invoke({
      providerRequest: validProviderRequest(),
      privacyResult,
    });
    assertCanonical(response);
    assert.equal(response.errorCode, "INVALID_REQUEST");
  }
  assert.equal(calls, 0);
});

test("hardening: secrets and personal data in transmitted messages block locally", async () => {
  const unsafeMessages = [
    "OTP 123456",
    "PIN 4321",
    "Mot de passe abc123",
    "API key sk_test_123",
    "Bearer token abc",
    "serviceRoleKey secret-value",
    "secretKey secret-value",
    "mobile money PIN 1234",
    "code de validation 998877",
    "Téléphone 70 12 34 56",
    "Email awa@example.com",
    "Adresse Ouagadougou secteur 15",
    "waId 22670123456",
    "IFU 00012345",
    "RCCM BF-OUA-2024",
    "Passeport AB12345",
    "Ligne publique\nOTP 123456\nFin",
  ];
  for (const content of unsafeMessages) {
    let calls = 0;
    const provider = createGeminiProvider({
      client: { generateContent() { calls += 1; return clientResult(); } },
    });
    const request = validProviderRequest();
    request.messages[1].content = content;
    const response = await provider.invoke({
      providerRequest: request,
      privacyResult: safePrivacyResult(),
    });
    assertCanonical(response);
    assert.equal(response.status, "REJECTED");
    assert.equal(response.ok, false);
    assert.equal(response.content, null);
    assert.equal(response.errorCode, "INVALID_REQUEST");
    assert.equal(response.failureKind, "CLIENT");
    assert.equal(response.recoverable, false);
    assert.equal(calls, 0);
    assert.equal(JSON.stringify(response).includes(content), false);
    assert.equal(buildGeminiClientRequest(request), null);
  }

  const amount = validProviderRequest();
  amount.messages[1].content = "Montant 125000 FCFA";
  assert.notEqual(buildGeminiClientRequest(amount), null);
});

test("hardening: multiline Unicode remains deterministic while tool and developer roles fail", () => {
  const request = validProviderRequest();
  request.messages[1].content = "Première ligne 😀\nDeuxième ligne é";
  const first = buildGeminiClientRequest(request);
  const second = buildGeminiClientRequest(reverseKeys(request));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.contents[0].parts[0].text, request.messages[1].content);

  for (const role of ["tool", "developer"]) {
    const invalid = validProviderRequest();
    invalid.messages[1].role = role;
    assert.equal(buildGeminiClientRequest(invalid), null);
  }
  const noSystem = validProviderRequest();
  noSystem.messages = [{ role: "user", content: "Créer une facture" }];
  assert.equal(buildGeminiClientRequest(noSystem), null);
});

test("hardening: client result variants are minimized and sensitive request ids become null", () => {
  const request = validProviderRequest();
  const missingModel = normalizeGeminiClientResult(
    clientResult({ model: undefined }),
    request
  );
  assertCanonical(missingModel);
  assert.equal(missingModel.model, null);

  const trimmed = normalizeGeminiClientResult(
    clientResult({ providerRequestId: " req_test_1 " }),
    request
  );
  assert.equal(trimmed.metadata.providerRequestId, "req_test_1");

  const sensitiveIds = [
    "awa@example.com",
    "70 12 34 56",
    "Adresse Ouagadougou secteur 15",
    "waId 22670123456",
    "IFU 00012345",
    "RCCM BF-OUA-2024",
    "OTP-123456",
    "PIN 4321",
    "access token secret",
    "API key secret",
    "Passeport AB12345",
  ];
  for (const providerRequestId of sensitiveIds) {
    const response = normalizeGeminiClientResult(
      clientResult({ providerRequestId }),
      request
    );
    assertCanonical(response);
    assert.equal(response.metadata.providerRequestId, null);
    assert.equal(JSON.stringify(response).includes(providerRequestId), false);
  }

  const rawSentinels = {
    promptFeedback: "PRIVATE_PROMPT_FEEDBACK",
    safetyRatings: "PRIVATE_SAFETY_RATINGS",
    reasoning: "PRIVATE_REASONING",
    chainOfThought: "PRIVATE_CHAIN",
  };
  const minimized = normalizeGeminiClientResult(
    clientResult(rawSentinels),
    request
  );
  for (const sentinel of Object.values(rawSentinels)) {
    assert.equal(JSON.stringify(minimized).includes(sentinel), false);
  }

  for (const result of [
    clientResult({ text: "   " }),
    undefined,
    true,
    clientResult({ finishReason: null }),
  ]) {
    const response = normalizeGeminiClientResult(result, request);
    assertCanonical(response);
    assert.equal(response.ok, false);
  }
});

test("hardening: error variants stay deterministic and never expose internals", () => {
  for (const error of [
    true,
    { kind: "NETWORK", config: "PRIVATE_CONFIG" },
    { kind: "NETWORK", apiKeySentinel: "PRIVATE_KEY" },
  ]) {
    const first = mapGeminiClientError(error);
    const second = mapGeminiClientError(reverseKeys(error));
    assertCanonical(first);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(JSON.stringify(first).includes("PRIVATE_"), false);
  }
});

test("hardening: local failures are byte deterministic", async () => {
  const provider = createGeminiProvider({
    client: { generateContent: () => clientResult() },
  });
  const first = await provider.invoke(undefined);
  const second = await provider.invoke(undefined);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("hardening: client-side request mutation cannot alter caller-owned structures", async () => {
  const providerRequest = validProviderRequest();
  const privacyResult = safePrivacyResult();
  const providerBefore = JSON.stringify(providerRequest);
  const privacyBefore = JSON.stringify(privacyResult);
  const independentBuild = buildGeminiClientRequest(providerRequest);
  const buildBefore = JSON.stringify(independentBuild);
  const frozenResult = Object.freeze(clientResult());
  const provider = createGeminiProvider({
    client: {
      generateContent(request) {
        request.model = "mutated";
        request.contents[0].parts[0].text = "mutated";
        request.generationConfig.temperature = 1;
        return frozenResult;
      },
    },
  });
  const response = await provider.invoke({ providerRequest, privacyResult });
  assertCanonical(response);
  assert.equal(JSON.stringify(providerRequest), providerBefore);
  assert.equal(JSON.stringify(privacyResult), privacyBefore);
  assert.equal(JSON.stringify(independentBuild), buildBefore);
});

test("hardening: reordered client results produce byte-identical responses", () => {
  const result = clientResult({
    text: '{"message":"Unicode 😀 é"}',
    usage: { inputUnits: 3, outputUnits: 2, totalUnits: 5 },
  });
  const first = normalizeGeminiClientResult(result, validProviderRequest());
  const second = normalizeGeminiClientResult(reverseKeys(result), validProviderRequest());
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("closing escapes: French identity and biometric markers block in every message position", async () => {
  const forbidden = [
    "Carte d’identité 12345",
    "CARTE D IDENTITE 12345",
    "carte-identite-12345",
    "carte_identite_12345",
    "Carte nationale d’identité 12345",
    "carte nationale identite 12345",
    "CNIB B123456",
    "CNI 123456",
    "Pièce d’identité 98765",
    "piece d'identite 98765",
    "Numéro de pièce 12345",
    "numero de piece 12345",
    "Passeport A123456",
    "passport A123456",
    "Permis de conduire 12345",
    "Acte de naissance 12345",
    "Signature Awa",
    "signature: Awa Kaboré",
    "signature client Awa",
    "signature manuscrite Awa",
    "signé par Awa Kaboré",
    "signe par Awa Kabore",
    "Empreinte client",
    "Empreinte digitale client",
    "fingerprint PERSON_RAW",
    "Biométrie utilisateur",
    "biometrie utilisateur",
    "cachet personnel Awa",
  ];
  const positions = ["first", "system", "second", "multiline", "middle", "end"];
  for (const value of forbidden) {
    for (const position of positions) {
      let calls = 0;
      const provider = createGeminiProvider({
        client: { generateContent() { calls += 1; return clientResult(); } },
      });
      const request = validProviderRequest();
      if (position === "system") request.messages[0].content = value;
      else if (position === "second") {
        request.messages.push({ role: "user", content: value });
      } else if (position === "multiline") {
        request.messages[1].content = `Ligne publique\n${value}\nFin`;
      } else if (position === "middle") {
        request.messages[1].content = `Début public ${value} fin publique`;
      } else if (position === "end") {
        request.messages[1].content = `Début public ${value}`;
      } else request.messages[1].content = value;
      const response = await provider.invoke({
        providerRequest: request,
        privacyResult: safePrivacyResult(),
      });
      assertCanonical(response);
      assert.equal(response.status, "REJECTED");
      assert.equal(response.errorCode, "INVALID_REQUEST");
      assert.equal(calls, 0);
      assert.equal(JSON.stringify(response).includes(value), false);
    }
  }
});

test("closing escapes: explicitly marked raw names block while aliases and public names remain allowed", async () => {
  const forbidden = [
    "Nom Awa Kaboré",
    "Nom: Awa Kaboré",
    "Nom client Awa Kaboré",
    "Nom du client Awa Kaboré",
    "Client Awa Kaboré",
    "Bénéficiaire Awa Kaboré",
    "Beneficiaire Awa Kabore",
    "Destinataire Awa Kaboré",
    "Expéditeur Issa Ouedraogo",
    "expediteur Issa Ouedraogo",
    "Titulaire Awa Kaboré",
    "Propriétaire Awa Kaboré",
    "proprietaire Awa Kabore",
    "Madame Awa Kaboré",
    "Monsieur Issa Ouedraogo",
    "M. Issa Ouedraogo",
    "Mme Awa Kaboré",
    "nom-awa-kabore",
    "nom_awa_kabore",
  ];
  for (const value of forbidden) {
    let calls = 0;
    const request = validProviderRequest();
    request.messages[1].content = value;
    const response = await createGeminiProvider({
      client: { generateContent() { calls += 1; return clientResult(); } },
    }).invoke({ providerRequest: request, privacyResult: safePrivacyResult() });
    assertCanonical(response);
    assert.equal(response.errorCode, "INVALID_REQUEST");
    assert.equal(calls, 0);
  }

  const allowed = [
    "PERSON_1", "PERSON_2", "Client PERSON_1", "Bénéficiaire PERSON_2",
    "Facture Standard", "Produit Premium", "Service Express", "Ouagadougou",
    "Burkina Faso", "Kadi AI", "SYSCOHADA", "25000 FCFA",
    "Créer une facture de 25000 FCFA pour PERSON_1",
    "Facture 2026-001, quantité 3, Produit Premium",
    "Service disponible à Ouagadougou",
  ];
  for (const value of allowed) {
    let calls = 0;
    const request = validProviderRequest();
    request.messages[1].content = value;
    const response = await createGeminiProvider({
      client: { generateContent() { calls += 1; return clientResult(); } },
    }).invoke({ providerRequest: request, privacyResult: safePrivacyResult() });
    assertCanonical(response);
    assert.equal(response.ok, true);
    assert.equal(calls, 1);
  }
});

test("closing escapes: provider request ids reject normalized sensitive markers", () => {
  const allowed = [
    "req_test_1", "request-001", "gemini_call_42",
    "abc123", "trace_001", "call-prod-02",
  ];
  const forbidden = [
    "Adresse-Ouagadougou-secteur-15",
    "adresse_ouaga_secteur_15",
    "CARTE-IDENTITE-12345",
    "signature-Awa",
    "nom-Awa-Kabore",
    "awa@example.com",
    "70-12-34-56",
    "OTP-123456",
    "PIN_4321",
    "waId-22670123456",
    "IFU-00012345",
    "RCCM-BF-OUA",
    "Passeport-A123456",
  ];
  for (const providerRequestId of allowed) {
    const response = normalizeGeminiClientResult(
      clientResult({ providerRequestId: ` ${providerRequestId} ` }),
      validProviderRequest()
    );
    assertCanonical(response);
    assert.equal(response.metadata.providerRequestId, providerRequestId);
  }
  for (const providerRequestId of forbidden) {
    const response = normalizeGeminiClientResult(
      clientResult({ providerRequestId }),
      validProviderRequest()
    );
    assertCanonical(response);
    assert.equal(response.metadata.providerRequestId, null);
    assert.equal(JSON.stringify(response).includes(providerRequestId), false);
  }
  assert.equal(
    normalizeGeminiClientResult(
      clientResult({ providerRequestId: "   " }),
      validProviderRequest()
    ).metadata.providerRequestId,
    null
  );
});

test("closing escapes: every forbidden factory option invalidates the injected client", async () => {
  const extras = ["endpoint", "credentials", "apiKey", "projectId", "region"];
  for (const extra of extras) {
    let calls = 0;
    const provider = createGeminiProvider({
      client: { generateContent() { calls += 1; return clientResult(); } },
      [extra]: "sentinel",
    });
    const response = await provider.invoke({
      providerRequest: validProviderRequest(),
      privacyResult: safePrivacyResult(),
    });
    assertCanonical(response);
    assert.equal(response.errorCode, "PROVIDER_UNAVAILABLE");
    assert.equal(calls, 0);
    assert.equal(JSON.stringify(response).includes("sentinel"), false);
  }
});

test("closing escapes: providers have isolated clients and no shared counters", async () => {
  let callsA = 0;
  let callsB = 0;
  const providerA = createGeminiProvider({
    client: { generateContent() { callsA += 1; return clientResult({ providerRequestId: "a" }); } },
  });
  const providerB = createGeminiProvider({
    client: { generateContent() { callsB += 1; return clientResult({ providerRequestId: "b" }); } },
  });
  assert.notStrictEqual(providerA, providerB);
  assert.notStrictEqual(providerA.invoke, providerB.invoke);
  const input = {
    providerRequest: validProviderRequest(),
    privacyResult: safePrivacyResult(),
  };
  const responseA = await providerA.invoke(input);
  assert.equal(callsA, 1);
  assert.equal(callsB, 0);
  const responseB = await providerB.invoke(input);
  assert.equal(callsA, 1);
  assert.equal(callsB, 1);
  assert.equal(responseA.metadata.providerRequestId, "a");
  assert.equal(responseB.metadata.providerRequestId, "b");
});

test("closing escapes: invoke always returns a Promise", async () => {
  const validInput = {
    providerRequest: validProviderRequest(),
    privacyResult: safePrivacyResult(),
  };
  const cases = [
    [createGeminiProvider(), validInput],
    [createGeminiProvider({ client: { generateContent: () => clientResult() } }), undefined],
    [createGeminiProvider({ client: { generateContent: () => clientResult() } }), {
      ...validInput,
      privacyResult: sanitizePrivacyInput({
        ...createEmptyPrivacyInput(),
        userMessage: "OTP 123456",
      }),
    }],
    [createGeminiProvider({ client: { generateContent: () => clientResult() } }), validInput],
    [createGeminiProvider({ client: { generateContent() { throw { kind: "NETWORK" }; } } }), validInput],
  ];
  for (const [provider, input] of cases) {
    const promise = provider.invoke(input);
    assert.equal(promise instanceof Promise, true);
    assertCanonical(await promise);
  }
});

test("closing escapes: deeply frozen requests and privacy results are accepted unchanged", async () => {
  const request = validProviderRequest();
  request.messages.forEach(Object.freeze);
  Object.freeze(request.messages);
  Object.freeze(request.generation);
  Object.freeze(request.responseFormat);
  Object.freeze(request.metadata.tags);
  Object.freeze(request.metadata);
  Object.freeze(request);
  const privacyResult = safePrivacyResult();
  Object.freeze(privacyResult.errors);
  Object.freeze(privacyResult.sanitizedInput.context);
  Object.freeze(privacyResult.sanitizedInput);
  Object.freeze(privacyResult.redactions);
  Object.freeze(privacyResult.restorationMap);
  Object.freeze(privacyResult.summary);
  Object.freeze(privacyResult);
  const requestBefore = JSON.stringify(request);
  const privacyBefore = JSON.stringify(privacyResult);
  const response = await createGeminiProvider({
    client: { generateContent: () => clientResult() },
  }).invoke({ providerRequest: request, privacyResult });
  assertCanonical(response);
  assert.equal(response.ok, true);
  assert.equal(JSON.stringify(request), requestBefore);
  assert.equal(JSON.stringify(privacyResult), privacyBefore);
});

test("closing escapes: partial usage preserves every independently valid field", () => {
  const cases = [
    [
      { inputUnits: 1, outputUnits: -1, totalUnits: 4 },
      { inputUnits: 1, outputUnits: null, totalUnits: 4 },
    ],
    [
      { inputUnits: -1, outputUnits: 3, totalUnits: 4 },
      { inputUnits: null, outputUnits: 3, totalUnits: 4 },
    ],
    [
      { inputUnits: 1, outputUnits: 3, totalUnits: -1 },
      { inputUnits: 1, outputUnits: 3, totalUnits: null },
    ],
    [
      { inputUnits: 0, outputUnits: 0 },
      { inputUnits: 0, outputUnits: 0, totalUnits: null },
    ],
    [
      { inputUnits: 2, totalUnits: 2 },
      { inputUnits: 2, outputUnits: null, totalUnits: 2 },
    ],
  ];
  for (const [usage, expected] of cases) {
    const response = normalizeGeminiClientResult(
      clientResult({ usage }),
      validProviderRequest()
    );
    assertCanonical(response);
    assert.equal(response.ok, true);
    assert.deepEqual(response.usage, expected);
  }
});

test("closing escapes: complete active client mutation cannot affect later calls", async () => {
  const providerRequest = validProviderRequest();
  const privacyResult = safePrivacyResult();
  const independentBuild = buildGeminiClientRequest(providerRequest);
  const providerBefore = JSON.stringify(providerRequest);
  const buildBefore = JSON.stringify(independentBuild);
  let calls = 0;
  const provider = createGeminiProvider({
    client: {
      generateContent(request) {
        calls += 1;
        request.model = "mutated";
        request.systemInstruction = "mutated";
        request.contents.push({ role: "user", parts: [{ text: "mutated" }] });
        request.contents[0] = { role: "user", parts: [{ text: "replaced" }] };
        request.contents[0].parts = [{ text: "parts replaced" }];
        request.contents[0].parts[0].text = "text mutated";
        request.generationConfig = { temperature: 1 };
        request.generationConfig.temperature = 2;
        return clientResult();
      },
    },
  });
  const first = await provider.invoke({ providerRequest, privacyResult });
  const second = await provider.invoke({ providerRequest, privacyResult });
  assertCanonical(first);
  assertCanonical(second);
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(providerRequest), providerBefore);
  assert.equal(JSON.stringify(independentBuild), buildBefore);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("defensive system secret vocabulary is allowed without values", async () => {
  const messages = [
    "Ne demande jamais un PIN.",
    "Ne révèle jamais un OTP.",
    "N’expose aucun password.",
    "Refuse les mots de passe, PIN et OTP.",
    "Do not request API keys.",
    "Never reveal passwords or access tokens.",
    "Secrets such as PIN, OTP and passwords must be rejected.",
    "Le code PIN est une catégorie de secret.",
    "Un OTP ne doit jamais être demandé.",
    "Les mots de passe sont interdits.",
    "Le format JSON ne doit pas contenir de secrets.",
    "Les clés API doivent être rejetées.",
  ];
  for (const content of messages) {
    const result = await invokeWithMessage("system", content);
    assert.equal(result.calls, 1);
    assert.equal(result.response.ok, true);
    assertCanonical(result.response);
  }
});

test("system secret values and defensive wording with examples remain blocked", async () => {
  const messages = [
    "PIN 4321",
    "OTP 123456",
    "Password abc123",
    "Mot de passe : abc123",
    "API key = abc123",
    "Bearer token eyJ123",
    "Ne demande jamais un PIN comme 4321.",
    "Ne révèle pas l’OTP 123456.",
    "Exemple de PIN : 4321.",
    "Exemple d’OTP = 123456.",
    "Un mot de passe tel que abc123 doit être refusé.",
    "Never expose API key abc123.",
    "Le mot de passe est secret123.",
    "Le code PIN est 4321.",
    "L’OTP vaut 123456.",
    "Le mot de passe est abc123.",
    "La clé API est abc123.",
    "Password abcdef",
    "PIN value abcdef",
    "API key \"abcdef\"",
  ];
  for (const content of messages) {
    const result = await invokeWithMessage("system", content);
    assert.equal(result.calls, 0);
    assert.equal(result.response.status, "REJECTED");
    assert.equal(result.response.errorCode, "INVALID_REQUEST");
    assert.equal(result.response.failureKind, "CLIENT");
    assert.equal(result.response.recoverable, false);
    assert.equal(JSON.stringify(result.response).includes(content), false);
    assertCanonical(result.response);
  }
});

test("user secret vocabulary always remains blocked", async () => {
  const messages = [
    "OTP 123456",
    "PIN 4321",
    "Password abc123",
    "Mot de passe abc123",
    "API key abc123",
    "Access token abc123",
    "Bearer token abc123",
    "Code de validation 123456",
    "Mobile money PIN 4321",
    "Ne demande jamais un PIN.",
    "Ne révèle jamais un OTP.",
    "Les mots de passe sont interdits.",
    "Service OTP Consulting.",
    "OTP_123456",
  ];
  for (const content of messages) {
    const result = await invokeWithMessage("user", content);
    assert.equal(result.calls, 0);
    assert.equal(result.response.status, "REJECTED");
    assert.equal(result.response.errorCode, "INVALID_REQUEST");
    assert.equal(result.response.failureKind, "CLIENT");
    assert.equal(result.response.recoverable, false);
    assert.equal(JSON.stringify(result.response).includes(content), false);
  }
});

test("non-secret privacy categories remain strict in system", async () => {
  const messages = [
    "Contact: client@example.com",
    "Téléphone 70 00 00 00",
    "Adresse: secteur 12",
    "IFU: BF123456",
    "Passeport: A123456",
    "Nom client Jean Dupont",
    "wa_id: 123456",
  ];
  for (const content of messages) {
    const result = await invokeWithMessage("system", content);
    assert.equal(result.calls, 0);
    assert.equal(result.response.errorCode, "INVALID_REQUEST");
  }
});

test("system and user roles are evaluated independently and deterministically", async () => {
  const defensive = "Never reveal passwords or access tokens.";
  const first = await invokeWithMessage("system", defensive);
  const second = await invokeWithMessage("system", defensive);
  const user = await invokeWithMessage("user", defensive);
  assert.equal(first.calls, 1);
  assert.equal(second.calls, 1);
  assert.equal(user.calls, 0);
  assert.equal(JSON.stringify(first.response), JSON.stringify(second.response));
  assert.equal(JSON.stringify(first.captured), JSON.stringify(second.captured));
});

test("separator bypasses and defensive examples with values remain blocked", async () => {
  const messages = [
    "Refuse un OTP tel que 123456.",
    "OTP_123456",
    "OTP-123456",
    "OTP:123456",
    "OTP=123456",
    "OTP/123456",
    "OTP\\123456",
    "PIN_4321",
    "PIN-4321",
    "pin=4321",
    "api_key_abc123",
    "api-key-abc123",
    "api key abc123",
    "access_token_abc123",
    "access-token-abc123",
    "bearer_token_eyJ123",
    "bearer-token-eyJ123",
    "secret_key_abc123",
    "service_role_key_abc123",
    "password_abc123",
    "password-abc123",
    "mot_de_passe_abc123",
    "api/key/abc123",
    "Never expose an API key such as abc123.",
    "Do not reveal bearer token eyJ123.",
    "Reject passwords like abc123.",
    "PIN example 4321.",
    "OTP sample 123456.",
    "API key example abc123.",
  ];
  for (const content of messages) {
    const result = await invokeWithMessage("system", content);
    assert.equal(result.calls, 0);
    assert.equal(result.response.status, "REJECTED");
    assert.equal(result.response.errorCode, "INVALID_REQUEST");
    assert.equal(result.response.failureKind, "CLIENT");
    assert.equal(result.response.recoverable, false);
    assert.equal(JSON.stringify(result.response).includes(content), false);
    assertCanonical(result.response);
  }
});

test("ordinary words and business names avoid secret substring false positives", async () => {
  const messages = [
    "Service OTP Consulting.",
    "Société OTP Consulting.",
    "Mot de passeport.",
    "Numéro de passeport interdit.",
    "Produit PINCE.",
    "Service Passwordless.",
    "Token budgétaire.",
    "Clé de répartition.",
    "API Management.",
    "Code produit 123456.",
    "Facture 2026-001.",
    "PERSON_1.",
    "25000 FCFA.",
  ];
  for (const content of messages) {
    const result = await invokeWithMessage("system", content);
    assert.equal(result.calls, 1);
    assert.equal(result.response.ok, true);
    assertCanonical(result.response);
  }
});

test("multiline defensive text cannot mask a separated secret value", async () => {
  for (const content of [
    "Ne demande jamais un OTP.\nOTP_123456",
    "Les clés API sont interdites.\napi_key_abc123",
    "Never reveal bearer tokens.\nbearer_token_eyJ123",
    "Service OTP Consulting.\nOTP 123456",
  ]) {
    const result = await invokeWithMessage("system", content);
    assert.equal(result.calls, 0);
    assert.equal(result.response.errorCode, "INVALID_REQUEST");
  }
});

test("deeply reordered provider requests produce the same decision", async () => {
  function deepReverse(value) {
    if (Array.isArray(value)) return value.map(deepReverse);
    if (!value || typeof value !== "object") return value;
    const result = {};
    for (const key of Object.keys(value).reverse()) {
      result[key] = deepReverse(value[key]);
    }
    return result;
  }
  const request = validProviderRequest();
  const privacyResult = safePrivacyResult();
  const captures = [];
  let calls = 0;
  const provider = createGeminiProvider({
    client: {
      generateContent(value) {
        calls += 1;
        captures.push(value);
        return clientResult();
      },
    },
  });
  const first = await provider.invoke({ providerRequest: request, privacyResult });
  const second = await provider.invoke({
    providerRequest: deepReverse(request),
    privacyResult,
  });
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(captures[0]), JSON.stringify(captures[1]));
});

test("hostile provider request structures fail closed or are safely minimized", async () => {
  async function invoke(providerRequest) {
    let calls = 0;
    let captured = null;
    const response = await createGeminiProvider({
      client: {
        generateContent(value) {
          calls += 1;
          captured = value;
          return clientResult();
        },
      },
    }).invoke({ providerRequest, privacyResult: safePrivacyResult() });
    assertCanonical(response);
    return { calls, captured, response };
  }

  const rejected = [];
  rejected.push(Object.create(validProviderRequest()));
  rejected.push(Object.assign(
    Object.create({ inherited: true }),
    validProviderRequest()
  ));
  for (const mutate of [
    (value) => { value.unknown = "OTP_123456"; },
    (value) => { value[0] = "OTP_123456"; },
    (value) => {
      Object.defineProperty(value, "model", {
        enumerable: true,
        get() { throw new Error("HOSTILE_MODEL"); },
      });
    },
  ]) {
    const value = validProviderRequest();
    mutate(value);
    rejected.push(value);
  }
  for (const value of rejected) {
    const result = await invoke(value);
    assert.equal(result.calls, 0);
    assert.equal(result.response.ok, false);
    assert.equal(JSON.stringify(result.response).includes("HOSTILE"), false);
  }

  for (const protect of [
    Object.freeze,
    Object.seal,
    Object.preventExtensions,
  ]) {
    const value = reverseKeys(validProviderRequest());
    protect(value);
    const before = JSON.stringify(value);
    const result = await invoke(value);
    assert.equal(result.calls, 1);
    assert.equal(result.response.ok, true);
    assert.equal(JSON.stringify(value), before);
  }

  const symbolRequest = validProviderRequest();
  symbolRequest[Symbol("secret")] = "OTP_123456";
  const symbolResult = await invoke(symbolRequest);
  assert.equal(symbolResult.calls, 1);
  assert.equal(
    JSON.stringify(symbolResult.captured).includes("OTP_123456"),
    false
  );

  const nullPrototype = Object.assign(
    Object.create(null),
    validProviderRequest()
  );
  assert.equal((await invoke(nullPrototype)).calls, 1);
});

test("real client error kinds map to canonical non-leaking provider responses", () => {
  const expected = {
    REQUEST_REJECTED: ["INVALID_REQUEST", "CLIENT", "REJECTED", false],
    MODEL_NOT_FOUND: ["PROVIDER_MODEL_NOT_FOUND", "PROVIDER", "FAILED", false],
    SDK_EXPORT_MISSING: ["PROVIDER_INTERNAL_ERROR", "INTERNAL", "FAILED", true],
    SDK_CONSTRUCTOR_INVALID: ["PROVIDER_INTERNAL_ERROR", "INTERNAL", "FAILED", true],
    SDK_CLIENT_INVALID: ["PROVIDER_INTERNAL_ERROR", "INTERNAL", "FAILED", true],
    SDK_METHOD_MISSING: ["PROVIDER_INTERNAL_ERROR", "INTERNAL", "FAILED", true],
    SDK_REQUEST_BUILD_FAILED: ["PROVIDER_INTERNAL_ERROR", "INTERNAL", "FAILED", true],
    SDK_RESPONSE_NORMALIZATION_FAILED: ["PROVIDER_INTERNAL_ERROR", "INTERNAL", "FAILED", true],
    SDK_UNKNOWN_FAILURE: ["PROVIDER_INTERNAL_ERROR", "INTERNAL", "FAILED", true],
  };
  for (const [kind, fields] of Object.entries(expected)) {
    const first = mapGeminiClientError({ kind, message: "PRIVATE_SENTINEL" });
    const second = mapGeminiClientError({ message: "CHANGED", kind });
    assert.deepEqual(
      [first.errorCode, first.failureKind, first.status, first.recoverable],
      fields
    );
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(JSON.stringify(first).includes("PRIVATE_SENTINEL"), false);
    assertCanonical(first);
  }
});
