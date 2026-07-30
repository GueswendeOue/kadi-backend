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

test("hardening: NETWORK has one coherent recoverable representation", () => {
  const network = failureResponse(
    "PROVIDER_NETWORK_ERROR",
    "NETWORK",
    "FAILED",
    true
  );
  assert.deepEqual(validateProviderResponse(network), { valid: true, errors: [] });
  assert.equal(isRecoverableProviderFailure(network), true);

  const incoherent = [
    failureResponse("PROVIDER_INTERNAL_ERROR", "NETWORK", "FAILED", true),
    { ...network, status: "SUCCEEDED", ok: true, content: "unexpected" },
    { ...network, recoverable: false },
    { ...network, failureKind: "PROVIDER" },
  ];
  for (const value of incoherent) {
    assert.equal(validateProviderResponse(value).valid, false);
    assert.equal(isRecoverableProviderFailure(value), false);
  }
  for (const value of [null, "NETWORK"]) {
    assert.equal(isRecoverableProviderFailure(value), false);
  }
});

test("hardening: every canonical failure mapping is explicit and coherent", () => {
  const mappings = [
    ["PROVIDER_NETWORK_ERROR", "NETWORK", "FAILED", true],
    ["PROVIDER_TIMEOUT", "TIMEOUT", "TIMED_OUT", true],
    ["PROVIDER_RATE_LIMITED", "RATE_LIMIT", "FAILED", true],
    ["PROVIDER_UNAVAILABLE", "PROVIDER", "FAILED", true],
    ["PROVIDER_INTERNAL_ERROR", "INTERNAL", "FAILED", true],
    ["PROVIDER_AUTH_FAILED", "AUTHENTICATION", "FAILED", false],
    ["PROVIDER_SAFETY_BLOCK", "SAFETY", "REJECTED", false],
    ["PROVIDER_CONTENT_BLOCK", "CONTENT", "REJECTED", false],
    ["INVALID_REQUEST", "CLIENT", "FAILED", false],
    ["INVALID_MESSAGES", "CLIENT", "FAILED", false],
    ["INVALID_PROVIDER", "CONFIGURATION", "FAILED", false],
    ["INVALID_MODEL", "CONFIGURATION", "FAILED", false],
    ["CANCELLED", "NONE", "CANCELLED", false],
  ];
  for (const [errorCode, failureKind, status, recoverable] of mappings) {
    const response = failureResponse(errorCode, failureKind, status, recoverable);
    assert.equal(validateProviderResponse(response).valid, true);
    assert.equal(isRecoverableProviderFailure(response), recoverable);
  }
});

test("hardening: request normalization covers booleans, richer partials, and every forbidden role", () => {
  assert.deepEqual(normalizeProviderRequest(true), createEmptyProviderRequest());
  const partial = normalizeProviderRequest({
    provider: " OPENAI ",
    model: " model-v2 ",
    timeoutMs: 5000,
    responseFormat: { type: "json_object", ignored: true },
    generation: { temperature: 0, maxOutputCodePoints: 1000, seed: 7 },
    metadata: { requestPurpose: "intent_resolution", tags: [" b ", "a", "b"] },
    ignored: "discarded",
  });
  assert.deepEqual(partial, {
    schemaVersion: "kadi.provider-request.v1",
    provider: "OPENAI",
    model: "model-v2",
    messages: [],
    timeoutMs: 5000,
    responseFormat: { type: "json_object" },
    generation: { temperature: 0, maxOutputCodePoints: 1000 },
    metadata: { requestPurpose: "intent_resolution", tags: ["a", "b"] },
  });
  for (const role of ["assistant", "developer", "tool", "function", "model"]) {
    const request = validRequest();
    request.messages[1].role = role;
    assert.equal(validateProviderRequest(normalizeProviderRequest(request)).valid, false);
  }
});

test("hardening: request and response identities and secrets never leak", () => {
  const properties = [
    "waId", "wa_id", "WA_ID", "bsuid", "BSUID", "phone", "phoneNumber",
    "fullName", "email", "userId", "sessionId", "apiKey", "API_KEY",
    "accessToken", "ACCESS_TOKEN", "serviceRoleKey", "password", "Password",
    "PASSWORD", "otp", "OTP", "pin", "PIN",
  ];
  properties.forEach((property, index) => {
    const sentinel = `FORBIDDEN_SENTINEL_${index}`;
    const request = validRequest();
    request[property] = sentinel;
    request.metadata[property] = sentinel;
    const normalizedRequest = normalizeProviderRequest(request);
    const requestValidation = validateProviderRequest(normalizedRequest);

    const response = successResponse();
    response[property] = sentinel;
    response.metadata[property] = sentinel;
    const normalizedResponse = normalizeProviderResponse(response);
    const responseValidation = validateProviderResponse(normalizedResponse);

    for (const value of [
      normalizedRequest,
      requestValidation,
      requestValidation.errors,
      normalizedResponse,
      responseValidation,
      responseValidation.errors,
    ]) assert.equal(JSON.stringify(value).includes(sentinel), false);
  });
});

test("hardening: response normalization handles booleans, invalid usage, and frozen inputs purely", () => {
  assert.deepEqual(normalizeProviderResponse(false), createEmptyProviderResponse());
  for (const invalid of [-1, 1.5, Infinity]) {
    const response = successResponse();
    response.usage = {
      inputUnits: invalid,
      outputUnits: invalid,
      totalUnits: invalid,
    };
    assert.deepEqual(normalizeProviderResponse(response).usage, {
      inputUnits: null,
      outputUnits: null,
      totalUnits: null,
    });
  }

  const frozen = successResponse();
  frozen.usage = Object.freeze({ inputUnits: 1, outputUnits: 2, totalUnits: 3 });
  frozen.metadata = Object.freeze({
    providerRequestId: " request-1 ",
    finishReason: "STOP",
  });
  Object.freeze(frozen);
  const before = JSON.stringify(frozen);
  assert.doesNotThrow(() => normalizeProviderResponse(frozen));
  assert.equal(JSON.stringify(frozen), before);
});

test("hardening: normalization and validation are byte deterministic and reference independent", () => {
  const request = validRequest();
  request.metadata.tags = ["z", "a", "z"];
  const reversedRequest = reverseKeys(request);
  reversedRequest.metadata.tags = ["a", "z"];
  const firstRequest = normalizeProviderRequest(request);
  const secondRequest = normalizeProviderRequest(reversedRequest);
  assert.equal(JSON.stringify(firstRequest), JSON.stringify(secondRequest));
  for (const key of ["messages", "responseFormat", "generation", "metadata"]) {
    assert.notStrictEqual(firstRequest[key], secondRequest[key]);
  }
  firstRequest.messages.forEach((message, index) => {
    assert.notStrictEqual(message, secondRequest.messages[index]);
  });
  assert.notStrictEqual(firstRequest.metadata.tags, secondRequest.metadata.tags);

  const unicodeRequest = validRequest();
  unicodeRequest.messages[1].content = "Facture 😀 é";
  assert.equal(
    JSON.stringify(normalizeProviderRequest(unicodeRequest)),
    JSON.stringify(normalizeProviderRequest(reverseKeys(unicodeRequest)))
  );

  const firstResponse = normalizeProviderResponse(successResponse());
  const secondResponse = normalizeProviderResponse(reverseKeys(successResponse()));
  assert.equal(JSON.stringify(firstResponse), JSON.stringify(secondResponse));
  assert.notStrictEqual(firstResponse.usage, secondResponse.usage);
  assert.notStrictEqual(firstResponse.metadata, secondResponse.metadata);

  const invalidRequest = validRequest();
  invalidRequest.provider = "INVALID";
  const firstValidation = validateProviderRequest(invalidRequest);
  const secondValidation = validateProviderRequest(invalidRequest);
  assert.equal(JSON.stringify(firstValidation), JSON.stringify(secondValidation));
  assert.notStrictEqual(firstValidation.errors, secondValidation.errors);
  firstValidation.errors.forEach((error, index) => {
    assert.notStrictEqual(error, secondValidation.errors[index]);
  });

  firstRequest.messages[0].content = "changed";
  firstRequest.responseFormat.type = "changed";
  firstRequest.generation.temperature = 1;
  firstRequest.metadata.requestPurpose = "changed";
  firstRequest.metadata.tags.push("changed");
  firstResponse.usage.inputUnits = 99;
  firstResponse.metadata.finishReason = "ERROR";
  firstValidation.errors[0].code = "changed";
  assert.notEqual(JSON.stringify(firstRequest), JSON.stringify(secondRequest));
  assert.notEqual(JSON.stringify(firstResponse), JSON.stringify(secondResponse));
  assert.notEqual(JSON.stringify(firstValidation), JSON.stringify(secondValidation));
});

test("hardening: Unicode boundaries are exact and never silently truncated", () => {
  const limits = KADI_PROVIDER_LIMITS;
  for (const size of [
    limits.maxModelNameCodePoints - 1,
    limits.maxModelNameCodePoints,
    limits.maxModelNameCodePoints + 1,
  ]) {
    const request = validRequest();
    request.model = `😀${"m".repeat(size - 1)}`;
    const normalized = normalizeProviderRequest(request);
    assert.equal(normalized.model, request.model);
    assert.equal(validateProviderRequest(normalized).valid, size <= limits.maxModelNameCodePoints);
  }

  for (const size of [
    limits.maxMessageCodePoints - 1,
    limits.maxMessageCodePoints,
    limits.maxMessageCodePoints + 1,
  ]) {
    const request = validRequest();
    request.messages[1].content = `😀${"m".repeat(size - 1)}`;
    const normalized = normalizeProviderRequest(request);
    assert.equal(normalized.messages[1].content, request.messages[1].content);
    assert.equal(validateProviderRequest(normalized).valid, size <= limits.maxMessageCodePoints);
  }

  for (const size of [
    limits.maxTotalMessageCodePoints - 1,
    limits.maxTotalMessageCodePoints,
    limits.maxTotalMessageCodePoints + 1,
  ]) {
    const request = validRequest();
    request.messages = [
      { role: "system", content: "s".repeat(12000) },
      { role: "user", content: "u".repeat(12000) },
      { role: "user", content: `😀${"t".repeat(size - 24001)}` },
    ];
    const normalized = normalizeProviderRequest(request);
    assert.equal(
      normalized.messages.reduce((total, message) => total + Array.from(message.content).length, 0),
      size
    );
    assert.equal(validateProviderRequest(normalized).valid, size <= limits.maxTotalMessageCodePoints);
  }

  for (const size of [
    limits.maxResponseCodePoints - 1,
    limits.maxResponseCodePoints,
    limits.maxResponseCodePoints + 1,
  ]) {
    const response = successResponse();
    response.content = `😀${"r".repeat(size - 1)}`;
    const normalized = normalizeProviderResponse(response);
    assert.equal(normalized.content, response.content);
    assert.equal(validateProviderResponse(normalized).valid, size <= limits.maxResponseCodePoints);
  }

  for (const size of [199, 200, 201]) {
    const response = successResponse();
    response.metadata.providerRequestId = `😀${"i".repeat(size - 1)}`;
    const normalized = normalizeProviderResponse(response);
    assert.equal(normalized.metadata.providerRequestId, response.metadata.providerRequestId);
    assert.equal(validateProviderResponse(normalized).valid, size <= 200);
  }

  for (const count of [
    limits.maxProviderRequestTags - 1,
    limits.maxProviderRequestTags,
    limits.maxProviderRequestTags + 1,
  ]) {
    const request = validRequest();
    request.metadata.tags = Array.from({ length: count }, (_, index) => `😀-${index}`);
    const normalized = normalizeProviderRequest(request);
    assert.equal(
      normalized.metadata.tags.length,
      Math.min(count, limits.maxProviderRequestTags)
    );
    assert.equal(normalized.metadata.tags.every((tag) => tag.startsWith("😀-")), true);
  }
});

test("hardening: production source blocks expanded execution, network, and key-reading surfaces", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "kadiBrainProviderContract.js"),
    "utf8"
  );
  const forbidden = [
    /\bimport\s*\(/,
    /\brequire\s*\(\s*(?!["'])/,
    /\brequire\s*\(\s*["'](?:node:)?(?:http|https|net|tls)["']\s*\)/i,
    /\bnode:(?:http|https|net|tls)\b/i,
    /https?:\/\//i,
    /\b(?:api[_\-\s]?key|access[_\-\s]?token|service[_\-\s]?role[_\-\s]?key)\b/i,
    /\b(?:handler|handlers)\s*=\s*[{[]/i,
    /\b(?:dispatch|executeIntent|runProvider|callProvider)\s*\(/i,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(source, pattern);
});

test("key order: deeply reordered requests and responses validate identically", () => {
  const request = validRequest();
  const reorderedRequest = reverseKeys(request);
  const requestValidation = validateProviderRequest(request);
  const reorderedRequestValidation = validateProviderRequest(reorderedRequest);
  assert.equal(requestValidation.valid, true);
  assert.equal(reorderedRequestValidation.valid, true);
  assert.equal(
    JSON.stringify(requestValidation),
    JSON.stringify(reorderedRequestValidation)
  );

  const response = successResponse();
  response.usage = { inputUnits: 2, outputUnits: 3, totalUnits: 5 };
  response.metadata.providerRequestId = "request-1";
  const reorderedResponse = reverseKeys(response);
  const responseValidation = validateProviderResponse(response);
  const reorderedResponseValidation = validateProviderResponse(reorderedResponse);
  assert.equal(responseValidation.valid, true);
  assert.equal(reorderedResponseValidation.valid, true);
  assert.equal(
    JSON.stringify(responseValidation),
    JSON.stringify(reorderedResponseValidation)
  );
});

test("exact keys: unknown own keys and missing required keys remain rejected", () => {
  const requestUnknowns = [
    (value) => { value.unknown = true; },
    (value) => { value.messages[0].unknown = true; },
    (value) => { value.generation.unknown = true; },
    (value) => { value.metadata.unknown = true; },
  ];
  for (const mutate of requestUnknowns) {
    const value = validRequest();
    mutate(value);
    assert.equal(validateProviderRequest(value).valid, false);
  }

  for (const key of ["provider", "model", "messages", "generation", "metadata"]) {
    const value = validRequest();
    delete value[key];
    assert.equal(validateProviderRequest(value).valid, false);
  }
  for (const key of ["role", "content"]) {
    const value = validRequest();
    delete value.messages[0][key];
    assert.equal(validateProviderRequest(value).valid, false);
  }

  const responseUnknowns = [
    (value) => { value.unknown = true; },
    (value) => { value.usage.unknown = true; },
    (value) => { value.metadata.unknown = true; },
    (value) => { value.error = { unknown: true }; },
  ];
  for (const mutate of responseUnknowns) {
    const value = successResponse();
    mutate(value);
    assert.equal(validateProviderResponse(value).valid, false);
  }
  for (const key of ["status", "errorCode"]) {
    const value = successResponse();
    delete value[key];
    assert.equal(validateProviderResponse(value).valid, false);
  }
});

test("exact keys: inherited, symbol, numeric and prototype keys fail closed", () => {
  const inherited = Object.create({ provider: "GENERIC" });
  Object.assign(inherited, validRequest());
  delete inherited.provider;
  assert.equal(validateProviderRequest(inherited).valid, false);

  for (const mutate of [
    (value) => { value[Symbol("secret")] = "OTP_123456"; },
    (value) => { value[0] = "unknown"; },
    (value) => {
      Object.defineProperty(value, "hidden", {
        enumerable: false,
        value: "unknown",
      });
    },
    (value) => {
      Object.defineProperty(value, "__proto__", {
        enumerable: true,
        value: { polluted: true },
      });
    },
    (value) => { value.constructor = "unknown"; },
    (value) => { value.prototype = "unknown"; },
  ]) {
    const request = validRequest();
    mutate(request);
    assert.equal(validateProviderRequest(request).valid, false);
    const response = successResponse();
    mutate(response);
    assert.equal(validateProviderResponse(response).valid, false);
  }
  assert.equal({}.polluted, undefined);

  const customPrototype = Object.assign(
    Object.create({ inheritedUnknown: true }),
    validRequest()
  );
  assert.equal(validateProviderRequest(customPrototype).valid, false);

  const nullPrototype = Object.assign(Object.create(null), validRequest());
  assert.equal(validateProviderRequest(nullPrototype).valid, true);
});

test("hostile getters and reflection traps return canonical failures", () => {
  const validations = [];
  for (const key of [
    "provider", "messages", "generation", "metadata",
  ]) {
    const request = validRequest();
    Object.defineProperty(request, key, {
      enumerable: true,
      get() { throw new Error(`HOSTILE_${key}`); },
    });
    validations.push(validateProviderRequest(request));
  }

  const unknownGetter = validRequest();
  Object.defineProperty(unknownGetter, "unknown", {
    enumerable: true,
    get() { throw new Error("HOSTILE_UNKNOWN"); },
  });
  validations.push(validateProviderRequest(unknownGetter));

  for (const [container, key] of [
    ["messages", "role"],
    ["generation", "temperature"],
    ["metadata", "requestPurpose"],
  ]) {
    const request = validRequest();
    const target = container === "messages"
      ? request.messages[0]
      : request[container];
    Object.defineProperty(target, key, {
      enumerable: true,
      get() { throw new Error(`HOSTILE_${container}_${key}`); },
    });
    validations.push(validateProviderRequest(request));
  }

  const ownKeysTrap = new Proxy(validRequest(), {
    ownKeys() { throw new Error("HOSTILE_OWN_KEYS"); },
  });
  validations.push(validateProviderRequest(ownKeysTrap));

  const responseGetter = successResponse();
  Object.defineProperty(responseGetter, "status", {
    enumerable: true,
    get() { throw new Error("HOSTILE_STATUS"); },
  });
  validations.push(validateProviderResponse(responseGetter));

  for (const [container, key] of [
    ["usage", "inputUnits"],
    ["metadata", "providerRequestId"],
  ]) {
    const response = successResponse();
    Object.defineProperty(response[container], key, {
      enumerable: true,
      get() { throw new Error(`HOSTILE_${container}_${key}`); },
    });
    validations.push(validateProviderResponse(response));
  }

  for (const validation of validations) {
    assert.equal(validation.valid, false);
    assertErrorsSafe(validation);
    assert.equal(JSON.stringify(validation).includes("HOSTILE"), false);
  }
});

test("frozen, sealed and non-extensible reordered structures are pure", () => {
  function deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      for (const nested of Object.values(value)) deepFreeze(nested);
      Object.freeze(value);
    }
    return value;
  }
  const variants = [
    reverseKeys(validRequest()),
    reverseKeys(validRequest()),
    reverseKeys(validRequest()),
  ];
  deepFreeze(variants[0]);
  Object.seal(variants[1]);
  Object.preventExtensions(variants[2]);
  for (const value of variants) {
    const before = JSON.stringify(value);
    assert.equal(validateProviderRequest(value).valid, true);
    assert.equal(JSON.stringify(value), before);
  }

  const response = reverseKeys(successResponse());
  deepFreeze(response);
  const before = JSON.stringify(response);
  assert.equal(validateProviderResponse(response).valid, true);
  assert.equal(JSON.stringify(response), before);
});

test("array order is preserved and validation stays byte deterministic", () => {
  const request = validRequest();
  const reversedMessages = validRequest();
  reversedMessages.messages.reverse();
  assert.equal(validateProviderRequest(request).valid, true);
  assert.equal(validateProviderRequest(reversedMessages).valid, false);
  assert.deepEqual(reversedMessages.messages.map((message) => message.role), [
    "user", "system",
  ]);

  for (const value of [
    reverseKeys(validRequest()),
    reverseKeys(successResponse()),
  ]) {
    const validate = Object.hasOwn(value, "messages")
      ? validateProviderRequest
      : validateProviderResponse;
    assert.equal(
      JSON.stringify(validate(value)),
      JSON.stringify(validate(value))
    );
  }
});
