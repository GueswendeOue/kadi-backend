"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const contract = require("../kadiBrainProviderContract");

const {
  KADI_PROVIDER_CONTRACT_VERSION,
  KADI_PROVIDER_REQUEST_VERSION,
  KADI_PROVIDER_RESPONSE_VERSION,
  KADI_PROVIDER_NAMES,
  KADI_PROVIDER_STATUSES,
  KADI_PROVIDER_ERROR_CODES,
  KADI_PROVIDER_FAILURE_KINDS,
  KADI_PROVIDER_LIMITS,
  createEmptyProviderRequest,
  createEmptyProviderResponse,
  normalizeProviderRequest,
  validateProviderRequest,
  normalizeProviderResponse,
  validateProviderResponse,
  isRecoverableProviderFailure,
  isSuccessfulProviderResponse,
} = contract;

function validRequest() {
  const value = createEmptyProviderRequest();
  value.provider = "GENERIC";
  value.model = "model-v1";
  value.messages = [
    { role: "system", content: "Resolve intent." },
    { role: "user", content: "Créer une facture." },
  ];
  value.metadata.tags = ["intent", "document"];
  return value;
}

function successResponse() {
  const value = createEmptyProviderResponse();
  value.model = "model-v1";
  value.status = "SUCCEEDED";
  value.ok = true;
  value.content = '{"intent":"CREATE_INVOICE"}';
  value.errorCode = "NONE";
  value.failureKind = "NONE";
  value.metadata.finishReason = "STOP";
  return value;
}

function failureResponse(errorCode, failureKind, status = "FAILED", recoverable = false) {
  const value = createEmptyProviderResponse();
  value.status = status;
  value.errorCode = errorCode;
  value.failureKind = failureKind;
  value.recoverable = recoverable;
  value.metadata.finishReason = status === "CANCELLED" ? "CANCELLED" : "ERROR";
  return value;
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).reverse()) result[key] = reverseKeys(value[key]);
  return result;
}

function assertErrorsSafe(validation) {
  assert.equal(Array.isArray(validation.errors), true);
  for (const error of validation.errors) {
    assert.deepEqual(Object.keys(error), ["path", "code"]);
    assert.equal(typeof error.path, "string");
    assert.equal(typeof error.code, "string");
  }
}

test("scenarios 1-10: exports exact immutable provider constants", () => {
  assert.equal(KADI_PROVIDER_CONTRACT_VERSION, "kadi.provider-contract.v1");
  assert.equal(KADI_PROVIDER_REQUEST_VERSION, "kadi.provider-request.v1");
  assert.equal(KADI_PROVIDER_RESPONSE_VERSION, "kadi.provider-response.v1");
  for (const value of [
    KADI_PROVIDER_NAMES,
    KADI_PROVIDER_STATUSES,
    KADI_PROVIDER_ERROR_CODES,
    KADI_PROVIDER_FAILURE_KINDS,
    KADI_PROVIDER_LIMITS,
  ]) assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(KADI_PROVIDER_NAMES, {
    GENERIC: "GENERIC", GEMINI: "GEMINI", OPENAI: "OPENAI",
  });
  assert.deepEqual(KADI_PROVIDER_LIMITS, {
    maxMessages: 8,
    maxMessageCodePoints: 12000,
    maxTotalMessageCodePoints: 32000,
    maxResponseCodePoints: 32000,
    minTimeoutMs: 1000,
    maxTimeoutMs: 120000,
    defaultTimeoutMs: 30000,
    maxModelNameCodePoints: 120,
    maxProviderRequestTags: 20,
  });
  assert.throws(() => {
    KADI_PROVIDER_LIMITS.maxMessages = 99;
  }, TypeError);
});

test("scenarios 11-17: creates exact independent empty requests", () => {
  const first = createEmptyProviderRequest();
  const second = createEmptyProviderRequest();
  assert.deepEqual(first, {
    schemaVersion: "kadi.provider-request.v1",
    provider: "GENERIC",
    model: null,
    messages: [],
    timeoutMs: 30000,
    responseFormat: { type: "json_object" },
    generation: { temperature: 0, maxOutputCodePoints: 32000 },
    metadata: { requestPurpose: "intent_resolution", tags: [] },
  });
  for (const key of ["messages", "responseFormat", "generation", "metadata"]) {
    assert.notStrictEqual(first[key], second[key]);
  }
  assert.notStrictEqual(first.metadata.tags, second.metadata.tags);
});

test("scenarios 18-29: request normalization is total, pure, and provider-safe", () => {
  for (const input of [null, undefined, "x", 2, []]) {
    assert.deepEqual(normalizeProviderRequest(input), createEmptyProviderRequest());
  }
  const partial = normalizeProviderRequest({ model: "  Model-X  " });
  assert.equal(partial.provider, "GENERIC");
  assert.equal(partial.model, "Model-X");
  assert.equal(normalizeProviderRequest({ model: "   " }).model, null);
  assert.equal(normalizeProviderRequest({ provider: "GEMINI" }).provider, "GEMINI");
  assert.equal(normalizeProviderRequest({ provider: "UNKNOWN" }).provider, "UNKNOWN");

  const frozen = Object.freeze({ model: " m ", messages: Object.freeze([]) });
  assert.doesNotThrow(() => normalizeProviderRequest(frozen));
  assert.equal(frozen.model, " m ");
});

test("scenarios 30-39 and 49-50: messages preserve overlimits and use Unicode points", () => {
  const tooLongModel = "m".repeat(121);
  const modelResult = normalizeProviderRequest({ model: tooLongModel });
  assert.equal(modelResult.model, tooLongModel);

  for (const messages of ["bad", [null], [{ role: "assistant", content: "x" }], [{ role: "system", content: 3 }], [{ role: "system", content: " " }]]) {
    const result = normalizeProviderRequest({ messages });
    assert.equal(validateProviderRequest(result).valid, false);
  }

  const long = `😀${"a".repeat(12000)}`;
  const longRequest = validRequest();
  longRequest.messages[0].content = long;
  const normalized = normalizeProviderRequest(longRequest);
  assert.equal(normalized.messages[0].content, long);
  assert.equal(validateProviderRequest(normalized).valid, false);

  const total = validRequest();
  total.messages = [
    { role: "system", content: "a".repeat(12000) },
    { role: "user", content: "b".repeat(12000) },
    { role: "system", content: "c".repeat(8001) },
    { role: "user", content: "end" },
  ];
  assert.equal(validateProviderRequest(normalizeProviderRequest(total)).valid, false);

  const many = validRequest();
  many.messages = Array.from({ length: 9 }, (_, index) => ({
    role: index === 0 ? "system" : "user",
    content: `m${index}`,
  }));
  assert.equal(normalizeProviderRequest(many).messages.length, 9);
  assert.equal(validateProviderRequest(normalizeProviderRequest(many)).valid, false);
  assert.equal(validateProviderRequest(normalizeProviderRequest(validRequest())).valid, true);
});

test("scenarios 40-46: tags canonicalize and unknown sensitive fields disappear", () => {
  const input = validRequest();
  input.metadata = {
    requestPurpose: "intent_resolution",
    tags: [" z ", "a", "z", "", null, ...Array.from({ length: 30 }, (_, i) => `t${i}`)],
    waId: "SENTINEL_ID",
    apiKey: "SENTINEL_SECRET",
  };
  input.unknown = "SENTINEL_UNKNOWN";
  input.messages[0].tool = "SENTINEL_TOOL";
  const result = normalizeProviderRequest(input);
  assert.equal(result.metadata.tags.length, 20);
  assert.deepEqual(result.metadata.tags, [...result.metadata.tags].sort());
  assert.equal(new Set(result.metadata.tags).size, result.metadata.tags.length);
  assert.deepEqual(Object.keys(result.messages[0]), ["role", "content"]);
  const serialized = JSON.stringify(result);
  for (const sentinel of ["SENTINEL_ID", "SENTINEL_SECRET", "SENTINEL_UNKNOWN", "SENTINEL_TOOL"]) {
    assert.equal(serialized.includes(sentinel), false);
  }
});

test("scenarios 47-48 and 114-120: dangerous keys fail closed recursively without pollution", () => {
  const keys = ["__proto__", "__PROTO__", "constructor", "Constructor", "prototype", "PROTO_TYPE"];
  for (const key of keys) {
    const input = validRequest();
    const nested = JSON.parse(`{${JSON.stringify(key)}:{"polluted":true}}`);
    input.metadata.extra = [{ nested }];
    const result = normalizeProviderRequest(input);
    assert.equal(validateProviderRequest(result).valid, false);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);

    const response = successResponse();
    response.metadata.extra = nested;
    assert.equal(validateProviderResponse(normalizeProviderResponse(response)).valid, false);
    assert.equal(Object.prototype.polluted, undefined);
  }
  const cyclic = validRequest();
  cyclic.self = cyclic;
  assert.doesNotThrow(() => normalizeProviderRequest(cyclic));
});

test("scenarios 51-65: request validation covers every canonical invariant safely", () => {
  assert.equal(validateProviderRequest(createEmptyProviderRequest()).valid, false);
  assert.equal(validateProviderRequest(validRequest()).valid, true);
  const variants = [
    ["schemaVersion", "bad"],
    ["provider", "BAD"],
    ["model", 1],
    ["timeoutMs", 999],
    ["timeoutMs", 120001],
    ["timeoutMs", 1000.5],
    ["responseFormat", { type: "text" }],
    ["generation", { temperature: 1, maxOutputCodePoints: 32000 }],
    ["generation", { temperature: 0, maxOutputCodePoints: 0 }],
    ["metadata", { requestPurpose: "other", tags: [] }],
    ["metadata", { requestPurpose: "intent_resolution", tags: [1] }],
  ];
  for (const [key, value] of variants) {
    const request = validRequest();
    request[key] = value;
    const validation = validateProviderRequest(request);
    assert.equal(validation.valid, false);
    assertErrorsSafe(validation);
    assert.equal(JSON.stringify(validation).includes("Créer une facture"), false);
  }
});

test("scenarios 66-69: creates exact independent empty responses", () => {
  const first = createEmptyProviderResponse();
  const second = createEmptyProviderResponse();
  assert.deepEqual(first, {
    schemaVersion: "kadi.provider-response.v1",
    provider: "GENERIC",
    model: null,
    status: "FAILED",
    ok: false,
    content: null,
    errorCode: "NONE",
    failureKind: "NONE",
    recoverable: false,
    usage: { inputUnits: null, outputUnits: null, totalUnits: null },
    metadata: { providerRequestId: null, finishReason: null },
  });
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.usage, second.usage);
  assert.notStrictEqual(first.metadata, second.metadata);
});

test("scenarios 70-75: response normalization is total and canonical", () => {
  for (const input of [null, undefined, "x", 4, []]) {
    assert.deepEqual(normalizeProviderResponse(input), createEmptyProviderResponse());
  }
  assert.deepEqual(normalizeProviderResponse({}), createEmptyProviderResponse());
  const success = normalizeProviderResponse(successResponse());
  assert.equal(validateProviderResponse(success).valid, true);
  const failed = normalizeProviderResponse(failureResponse("PROVIDER_TIMEOUT", "TIMEOUT", "TIMED_OUT", true));
  assert.equal(validateProviderResponse(failed).valid, true);
});

test("scenarios 76-80 and 85: raw fields, identities, and secrets never survive", () => {
  const properties = [
    "raw", "rawResponse", "body", "headers", "request", "response", "config",
    "stack", "cause", "debug", "reasoning", "chainOfThought", "prompt", "messages",
    "tools", "toolCalls", "apiKey", "accessToken", "password", "otp", "pin",
    "waId", "wa_id", "bsuid", "phone", "email", "userId", "sessionId",
  ];
  properties.forEach((property, index) => {
    const input = successResponse();
    input[property] = `SENTINEL_${index}`;
    const result = normalizeProviderResponse(input);
    assert.equal(JSON.stringify(result).includes(`SENTINEL_${index}`), false);
  });
  const input = successResponse();
  input.metadata = { providerRequestId: " id ", finishReason: "STOP", extra: "secret" };
  assert.deepEqual(normalizeProviderResponse(input).metadata, {
    providerRequestId: "id", finishReason: "STOP",
  });
});

test("scenarios 81-90: response limits, usage, metadata, purity, and determinism", () => {
  const long = successResponse();
  long.content = `😀${"a".repeat(32000)}`;
  const normalizedLong = normalizeProviderResponse(long);
  assert.equal(normalizedLong.content, long.content);
  assert.equal(validateProviderResponse(normalizedLong).valid, false);

  const usage = successResponse();
  usage.usage = { inputUnits: 2, outputUnits: 3, totalUnits: 5 };
  assert.equal(validateProviderResponse(normalizeProviderResponse(usage)).valid, true);
  for (const bad of [-1, 1.5, Infinity]) {
    const value = successResponse();
    value.usage = { inputUnits: bad, outputUnits: null, totalUnits: null };
    assert.equal(validateProviderResponse(value).valid, false);
  }
  const longId = successResponse();
  longId.metadata.providerRequestId = "x".repeat(201);
  assert.equal(validateProviderResponse(normalizeProviderResponse(longId)).valid, false);
  const reason = successResponse();
  reason.metadata.finishReason = "OTHER";
  assert.equal(validateProviderResponse(normalizeProviderResponse(reason)).valid, false);

  const frozen = Object.freeze(successResponse());
  assert.doesNotThrow(() => normalizeProviderResponse(frozen));
  const first = normalizeProviderResponse(successResponse());
  const second = normalizeProviderResponse(reverseKeys(successResponse()));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("scenarios 91-100: response validation enforces global coherence", () => {
  assert.equal(validateProviderResponse(successResponse()).valid, true);
  const variants = [];
  const noContent = successResponse(); noContent.content = null; variants.push(noContent);
  const successError = successResponse(); successError.errorCode = "PROVIDER_TIMEOUT"; variants.push(successError);
  const failureContent = failureResponse("PROVIDER_UNAVAILABLE", "PROVIDER", "FAILED", true); failureContent.content = "partial"; variants.push(failureContent);
  const noneFailure = createEmptyProviderResponse(); variants.push(noneFailure);
  const invalidStatus = successResponse(); invalidStatus.status = "OTHER"; variants.push(invalidStatus);
  const invalidProvider = successResponse(); invalidProvider.provider = "OTHER"; variants.push(invalidProvider);
  const invalidSchema = successResponse(); invalidSchema.schemaVersion = "other"; variants.push(invalidSchema);
  for (const value of variants) {
    const validation = validateProviderResponse(value);
    assert.equal(validation.valid, false);
    assertErrorsSafe(validation);
  }
  assert.equal(validateProviderResponse(failureResponse("PROVIDER_TIMEOUT", "TIMEOUT", "TIMED_OUT", true)).valid, true);
  assert.equal(validateProviderResponse(failureResponse("CANCELLED", "NONE", "CANCELLED", false)).valid, true);
});

test("scenarios 101-113: success and recoverability helpers validate structure", () => {
  assert.equal(isSuccessfulProviderResponse(successResponse()), true);
  assert.equal(isSuccessfulProviderResponse(failureResponse("PROVIDER_UNAVAILABLE", "PROVIDER", "FAILED", true)), false);
  for (const value of [null, undefined, {}, "x"]) {
    assert.equal(isSuccessfulProviderResponse(value), false);
    assert.equal(isRecoverableProviderFailure(value), false);
  }
  for (const value of [
    failureResponse("PROVIDER_TIMEOUT", "TIMEOUT", "TIMED_OUT", true),
    failureResponse("PROVIDER_RATE_LIMITED", "RATE_LIMIT", "FAILED", true),
    failureResponse("PROVIDER_UNAVAILABLE", "PROVIDER", "FAILED", true),
  ]) assert.equal(isRecoverableProviderFailure(value), true);
  for (const value of [
    failureResponse("PROVIDER_AUTH_FAILED", "AUTHENTICATION"),
    failureResponse("PROVIDER_SAFETY_BLOCK", "SAFETY", "REJECTED"),
    failureResponse("PROVIDER_CONTENT_BLOCK", "CONTENT", "REJECTED"),
    failureResponse("INVALID_PROVIDER", "CONFIGURATION"),
    failureResponse("CANCELLED", "NONE", "CANCELLED"),
  ]) assert.equal(isRecoverableProviderFailure(value), false);
  const incoherent = failureResponse("PROVIDER_TIMEOUT", "PROVIDER", "TIMED_OUT", true);
  assert.equal(isRecoverableProviderFailure(incoherent), false);
});

test("scenarios 121-140: production source has no provider execution surface", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "kadiBrainProviderContract.js"),
    "utf8"
  );
  assert.deepEqual(
    Array.from(source.matchAll(/require\((["'])(.*?)\1\)/g), (match) => match[2]),
    []
  );
  assert.doesNotMatch(source, /\bimport\s*\(/);
  const forbidden = [
    /@openai/i, /\bgoogle\b/i, /generative-ai/i, /\bfetch\s*\(/,
    /\baxios\b/i, /require\(["'](?:http|https|net|tls|fs|vm|child_process)["']\)/,
    /\bsupabase\b/i, /process\.env/, /\breadFile\b/, /\bwriteFile\b/,
    /\bappendFile\b/, /\bcreateWriteStream\b/, /\beval\s*\(/,
    /\bnew\s+Function\b/, /\bFunction\s*\(/, /\bexec\s*\(/, /\bspawn\s*\(/,
    /Date\.now/, /Math\.random/, /\brandomUUID\b/, /crypto\.randomUUID/,
    /\bsetTimeout\b/, /\bsetInterval\b/, /\bAbortController\b/,
    /\bwebhook\b/i, /\bdispatch\b/i,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(source, pattern);
  const openAiOccurrences = source.match(/\bOPENAI\b/g) || [];
  const geminiOccurrences = source.match(/\bGEMINI\b/g) || [];
  assert.equal(openAiOccurrences.length, 2);
  assert.equal(geminiOccurrences.length, 2);
});
