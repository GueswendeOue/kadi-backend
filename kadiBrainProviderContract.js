"use strict";

const KADI_PROVIDER_CONTRACT_VERSION = "kadi.provider-contract.v1";
const KADI_PROVIDER_REQUEST_VERSION = "kadi.provider-request.v1";
const KADI_PROVIDER_RESPONSE_VERSION = "kadi.provider-response.v1";

const KADI_PROVIDER_NAMES = Object.freeze({
  GENERIC: "GENERIC",
  GEMINI: "GEMINI",
  OPENAI: "OPENAI",
});

const KADI_PROVIDER_STATUSES = Object.freeze({
  PENDING: "PENDING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  TIMED_OUT: "TIMED_OUT",
  CANCELLED: "CANCELLED",
  REJECTED: "REJECTED",
});

const KADI_PROVIDER_FAILURE_KINDS = Object.freeze({
  NONE: "NONE",
  CLIENT: "CLIENT",
  PROVIDER: "PROVIDER",
  NETWORK: "NETWORK",
  TIMEOUT: "TIMEOUT",
  RATE_LIMIT: "RATE_LIMIT",
  AUTHENTICATION: "AUTHENTICATION",
  SAFETY: "SAFETY",
  CONTENT: "CONTENT",
  CONFIGURATION: "CONFIGURATION",
  INTERNAL: "INTERNAL",
});

const KADI_PROVIDER_ERROR_CODES = Object.freeze({
  NONE: "NONE",
  INVALID_REQUEST: "INVALID_REQUEST",
  INVALID_MESSAGES: "INVALID_MESSAGES",
  INVALID_PROVIDER: "INVALID_PROVIDER",
  INVALID_MODEL: "INVALID_MODEL",
  INVALID_TIMEOUT: "INVALID_TIMEOUT",
  INVALID_LIMITS: "INVALID_LIMITS",
  RESPONSE_NOT_OBJECT: "RESPONSE_NOT_OBJECT",
  RESPONSE_INVALID_STATUS: "RESPONSE_INVALID_STATUS",
  RESPONSE_INVALID_CONTENT: "RESPONSE_INVALID_CONTENT",
  PROVIDER_NETWORK_ERROR: "PROVIDER_NETWORK_ERROR",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  PROVIDER_RATE_LIMITED: "PROVIDER_RATE_LIMITED",
  PROVIDER_AUTH_FAILED: "PROVIDER_AUTH_FAILED",
  PROVIDER_SAFETY_BLOCK: "PROVIDER_SAFETY_BLOCK",
  PROVIDER_CONTENT_BLOCK: "PROVIDER_CONTENT_BLOCK",
  PROVIDER_BAD_RESPONSE: "PROVIDER_BAD_RESPONSE",
  PROVIDER_INTERNAL_ERROR: "PROVIDER_INTERNAL_ERROR",
  CANCELLED: "CANCELLED",
  INTERNAL_CONTRACT_FAILURE: "INTERNAL_CONTRACT_FAILURE",
});

const KADI_PROVIDER_LIMITS = Object.freeze({
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

const PROVIDERS = new Set(Object.values(KADI_PROVIDER_NAMES));
const STATUSES = new Set(Object.values(KADI_PROVIDER_STATUSES));
const FAILURE_KINDS = new Set(Object.values(KADI_PROVIDER_FAILURE_KINDS));
const ERROR_CODES = new Set(Object.values(KADI_PROVIDER_ERROR_CODES));
const MESSAGE_ROLES = new Set(["system", "user"]);
const FINISH_REASONS = new Set([
  "STOP",
  "MAX_OUTPUT",
  "SAFETY",
  "CONTENT_FILTER",
  "TOOL_CALL",
  "ERROR",
  "CANCELLED",
  "UNKNOWN",
]);
const FINAL_FAILURE_STATUSES = new Set([
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "REJECTED",
]);
const DANGEROUS_KEYS = new Set(["proto", "prototype", "constructor"]);
const PROVIDER_REQUEST_ID_MAX_CODE_POINTS = 200;

const FAILURE_RULES = Object.freeze({
  INVALID_REQUEST: Object.freeze({ kind: "CLIENT", recoverable: false }),
  INVALID_MESSAGES: Object.freeze({ kind: "CLIENT", recoverable: false }),
  INVALID_PROVIDER: Object.freeze({ kind: "CONFIGURATION", recoverable: false }),
  INVALID_MODEL: Object.freeze({ kind: "CONFIGURATION", recoverable: false }),
  INVALID_TIMEOUT: Object.freeze({ kind: "CLIENT", recoverable: false }),
  INVALID_LIMITS: Object.freeze({ kind: "CLIENT", recoverable: false }),
  RESPONSE_NOT_OBJECT: Object.freeze({ kind: "PROVIDER", recoverable: true }),
  RESPONSE_INVALID_STATUS: Object.freeze({ kind: "PROVIDER", recoverable: true }),
  RESPONSE_INVALID_CONTENT: Object.freeze({ kind: "CONTENT", recoverable: false }),
  PROVIDER_NETWORK_ERROR: Object.freeze({ kind: "NETWORK", recoverable: true }),
  PROVIDER_UNAVAILABLE: Object.freeze({ kind: "PROVIDER", recoverable: true }),
  PROVIDER_TIMEOUT: Object.freeze({ kind: "TIMEOUT", recoverable: true }),
  PROVIDER_RATE_LIMITED: Object.freeze({ kind: "RATE_LIMIT", recoverable: true }),
  PROVIDER_AUTH_FAILED: Object.freeze({ kind: "AUTHENTICATION", recoverable: false }),
  PROVIDER_SAFETY_BLOCK: Object.freeze({ kind: "SAFETY", recoverable: false }),
  PROVIDER_CONTENT_BLOCK: Object.freeze({ kind: "CONTENT", recoverable: false }),
  PROVIDER_BAD_RESPONSE: Object.freeze({ kind: "PROVIDER", recoverable: true }),
  PROVIDER_INTERNAL_ERROR: Object.freeze({ kind: "INTERNAL", recoverable: true }),
  CANCELLED: Object.freeze({ kind: "NONE", recoverable: false }),
  INTERNAL_CONTRACT_FAILURE: Object.freeze({ kind: "INTERNAL", recoverable: false }),
});

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactOwnKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.length !== expectedKeys.length) return false;
  const expected = new Set(expectedKeys);
  return (
    actualKeys.every((key) => typeof key === "string" && expected.has(key)) &&
    expectedKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key)
    )
  );
}

function codePointLength(value) {
  return Array.from(value).length;
}

function textOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function integerOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeSecurityKey(key) {
  return String(key).trim().toLowerCase().replace(/[_\-\s]/g, "");
}

function containsDangerousKey(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => containsDangerousKey(item, seen));
  }
  return Object.keys(value).some(
    (key) =>
      DANGEROUS_KEYS.has(normalizeSecurityKey(key)) ||
      containsDangerousKey(value[key], seen)
  );
}

function createEmptyProviderRequest() {
  return {
    schemaVersion: KADI_PROVIDER_REQUEST_VERSION,
    provider: KADI_PROVIDER_NAMES.GENERIC,
    model: null,
    messages: [],
    timeoutMs: KADI_PROVIDER_LIMITS.defaultTimeoutMs,
    responseFormat: { type: "json_object" },
    generation: {
      temperature: 0,
      maxOutputCodePoints: KADI_PROVIDER_LIMITS.maxResponseCodePoints,
    },
    metadata: {
      requestPurpose: "intent_resolution",
      tags: [],
    },
  };
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.map(textOrNull).filter(Boolean))
  )
    .sort()
    .slice(0, KADI_PROVIDER_LIMITS.maxProviderRequestTags);
}

function normalizeProviderRequest(input) {
  try {
    if (!isPlainObject(input)) return createEmptyProviderRequest();
    if (containsDangerousKey(input)) {
      const rejected = createEmptyProviderRequest();
      rejected.schemaVersion = null;
      return rejected;
    }
    const result = createEmptyProviderRequest();
    result.schemaVersion =
      typeof input.schemaVersion === "string"
        ? input.schemaVersion
        : KADI_PROVIDER_REQUEST_VERSION;
    if (input.provider === undefined || input.provider === null) {
      result.provider = KADI_PROVIDER_NAMES.GENERIC;
    } else {
      result.provider =
        typeof input.provider === "string" ? input.provider.trim() : input.provider;
    }
    result.model = textOrNull(input.model);
    result.messages = Array.isArray(input.messages)
      ? input.messages.map((message) => {
          const source = isPlainObject(message) ? message : {};
          return {
            role:
              typeof source.role === "string" ? source.role.trim() : source.role,
            content:
              typeof source.content === "string"
                ? source.content.trim()
                : source.content,
          };
        })
      : input.messages === undefined
        ? []
        : input.messages;
    result.timeoutMs =
      input.timeoutMs === undefined
        ? KADI_PROVIDER_LIMITS.defaultTimeoutMs
        : input.timeoutMs;
    const responseFormat = isPlainObject(input.responseFormat)
      ? input.responseFormat
      : {};
    result.responseFormat = {
      type:
        input.responseFormat === undefined
          ? "json_object"
          : responseFormat.type,
    };
    const generation = isPlainObject(input.generation) ? input.generation : {};
    result.generation = {
      temperature:
        input.generation === undefined ? 0 : generation.temperature,
      maxOutputCodePoints:
        input.generation === undefined
          ? KADI_PROVIDER_LIMITS.maxResponseCodePoints
          : generation.maxOutputCodePoints,
    };
    const metadata = isPlainObject(input.metadata) ? input.metadata : {};
    result.metadata = {
      requestPurpose:
        input.metadata === undefined
          ? "intent_resolution"
          : metadata.requestPurpose,
      tags: normalizeTags(metadata.tags),
    };
    return result;
  } catch {
    const rejected = createEmptyProviderRequest();
    rejected.schemaVersion = null;
    return rejected;
  }
}

function validateProviderRequest(request) {
  const errors = [];
  const add = (path, code) => errors.push({ path, code });
  try {
    if (
      !hasExactOwnKeys(request, [
      "schemaVersion",
      "provider",
      "model",
      "messages",
      "timeoutMs",
      "responseFormat",
      "generation",
      "metadata",
      ])
    ) {
      return { valid: false, errors: [{ path: "$", code: "INVALID_REQUEST" }] };
    }
  if (request.schemaVersion !== KADI_PROVIDER_REQUEST_VERSION) add("schemaVersion", "INVALID_REQUEST");
  if (!PROVIDERS.has(request.provider)) add("provider", "INVALID_PROVIDER");
  if (
    request.model !== null &&
    (typeof request.model !== "string" ||
      !request.model.trim() ||
      codePointLength(request.model) > KADI_PROVIDER_LIMITS.maxModelNameCodePoints)
  ) add("model", "INVALID_MODEL");
  if (!Array.isArray(request.messages)) {
    add("messages", "INVALID_MESSAGES");
  } else {
    if (
      request.messages.length < 2 ||
      request.messages.length > KADI_PROVIDER_LIMITS.maxMessages
    ) add("messages", "INVALID_MESSAGES");
    let total = 0;
    request.messages.forEach((message, index) => {
      if (
        !hasExactOwnKeys(message, ["role", "content"])
      ) {
        add(`messages[${index}]`, "INVALID_MESSAGES");
        return;
      }
      if (!MESSAGE_ROLES.has(message.role)) add(`messages[${index}].role`, "INVALID_MESSAGES");
      if (typeof message.content !== "string" || !message.content.trim()) {
        add(`messages[${index}].content`, "INVALID_MESSAGES");
      } else {
        const length = codePointLength(message.content);
        total += length;
        if (length > KADI_PROVIDER_LIMITS.maxMessageCodePoints) {
          add(`messages[${index}].content`, "INVALID_MESSAGES");
        }
      }
    });
    if (request.messages[0]?.role !== "system") add("messages[0].role", "INVALID_MESSAGES");
    if (request.messages.at(-1)?.role !== "user") add(`messages[${Math.max(0, request.messages.length - 1)}].role`, "INVALID_MESSAGES");
    if (total > KADI_PROVIDER_LIMITS.maxTotalMessageCodePoints) add("messages", "INVALID_MESSAGES");
  }
  if (
    !Number.isInteger(request.timeoutMs) ||
    request.timeoutMs < KADI_PROVIDER_LIMITS.minTimeoutMs ||
    request.timeoutMs > KADI_PROVIDER_LIMITS.maxTimeoutMs
  ) add("timeoutMs", "INVALID_TIMEOUT");
  if (
    !hasExactOwnKeys(request.responseFormat, ["type"]) ||
    request.responseFormat.type !== "json_object"
  ) add("responseFormat", "INVALID_REQUEST");
  if (
    !hasExactOwnKeys(request.generation, ["temperature", "maxOutputCodePoints"]) ||
    request.generation.temperature !== 0 ||
    !Number.isInteger(request.generation.maxOutputCodePoints) ||
    request.generation.maxOutputCodePoints <= 0 ||
    request.generation.maxOutputCodePoints > KADI_PROVIDER_LIMITS.maxResponseCodePoints
  ) add("generation", "INVALID_LIMITS");
  if (
    !hasExactOwnKeys(request.metadata, ["requestPurpose", "tags"]) ||
    request.metadata.requestPurpose !== "intent_resolution" ||
    !Array.isArray(request.metadata.tags) ||
    request.metadata.tags.length > KADI_PROVIDER_LIMITS.maxProviderRequestTags ||
    request.metadata.tags.some((tag) => typeof tag !== "string" || !tag.trim())
  ) add("metadata", "INVALID_REQUEST");
  return { valid: errors.length === 0, errors };
  } catch {
    return { valid: false, errors: [{ path: "$", code: "INVALID_REQUEST" }] };
  }
}

function createEmptyProviderResponse() {
  return {
    schemaVersion: KADI_PROVIDER_RESPONSE_VERSION,
    provider: KADI_PROVIDER_NAMES.GENERIC,
    model: null,
    status: KADI_PROVIDER_STATUSES.FAILED,
    ok: false,
    content: null,
    errorCode: KADI_PROVIDER_ERROR_CODES.NONE,
    failureKind: KADI_PROVIDER_FAILURE_KINDS.NONE,
    recoverable: false,
    usage: {
      inputUnits: null,
      outputUnits: null,
      totalUnits: null,
    },
    metadata: {
      providerRequestId: null,
      finishReason: null,
    },
  };
}

function normalizeProviderResponse(input) {
  try {
    if (!isPlainObject(input)) return createEmptyProviderResponse();
    if (containsDangerousKey(input)) {
      const rejected = createEmptyProviderResponse();
      rejected.schemaVersion = null;
      return rejected;
    }
    const result = createEmptyProviderResponse();
    result.schemaVersion =
      typeof input.schemaVersion === "string"
        ? input.schemaVersion
        : KADI_PROVIDER_RESPONSE_VERSION;
    result.provider =
      input.provider === undefined
        ? KADI_PROVIDER_NAMES.GENERIC
        : typeof input.provider === "string"
          ? input.provider.trim()
          : input.provider;
    result.model = textOrNull(input.model);
    result.status =
      input.status === undefined
        ? KADI_PROVIDER_STATUSES.FAILED
        : typeof input.status === "string"
          ? input.status.trim()
          : input.status;
    result.ok = input.ok === true;
    result.content =
      result.ok && result.status === KADI_PROVIDER_STATUSES.SUCCEEDED
        ? textOrNull(input.content)
        : null;
    result.errorCode =
      input.errorCode === undefined
        ? KADI_PROVIDER_ERROR_CODES.NONE
        : typeof input.errorCode === "string"
          ? input.errorCode.trim()
          : input.errorCode;
    result.failureKind =
      input.failureKind === undefined
        ? KADI_PROVIDER_FAILURE_KINDS.NONE
        : typeof input.failureKind === "string"
          ? input.failureKind.trim()
          : input.failureKind;
    result.recoverable = input.recoverable === true;
    const usage = isPlainObject(input.usage) ? input.usage : {};
    result.usage = {
      inputUnits: integerOrNull(usage.inputUnits),
      outputUnits: integerOrNull(usage.outputUnits),
      totalUnits: integerOrNull(usage.totalUnits),
    };
    const metadata = isPlainObject(input.metadata) ? input.metadata : {};
    result.metadata = {
      providerRequestId: textOrNull(metadata.providerRequestId),
      finishReason:
        typeof metadata.finishReason === "string"
          ? metadata.finishReason.trim()
          : metadata.finishReason ?? null,
    };
    return result;
  } catch {
    const rejected = createEmptyProviderResponse();
    rejected.schemaVersion = null;
    return rejected;
  }
}

function validateProviderResponse(response) {
  const errors = [];
  const add = (path, code) => errors.push({ path, code });
  try {
    if (!isPlainObject(response)) {
      return { valid: false, errors: [{ path: "$", code: "RESPONSE_NOT_OBJECT" }] };
    }
    if (
      !hasExactOwnKeys(response, [
      "schemaVersion", "provider", "model", "status", "ok", "content",
      "errorCode", "failureKind", "recoverable", "usage", "metadata",
      ])
    ) {
      return {
        valid: false,
        errors: [{ path: "$", code: "PROVIDER_BAD_RESPONSE" }],
      };
    }
  if (response.schemaVersion !== KADI_PROVIDER_RESPONSE_VERSION) add("schemaVersion", "PROVIDER_BAD_RESPONSE");
  if (!PROVIDERS.has(response.provider)) add("provider", "INVALID_PROVIDER");
  if (
    response.model !== null &&
    (typeof response.model !== "string" ||
      !response.model.trim() ||
      codePointLength(response.model) > KADI_PROVIDER_LIMITS.maxModelNameCodePoints)
  ) add("model", "INVALID_MODEL");
  if (!STATUSES.has(response.status)) add("status", "RESPONSE_INVALID_STATUS");
  if (typeof response.ok !== "boolean") add("ok", "PROVIDER_BAD_RESPONSE");
  if (!ERROR_CODES.has(response.errorCode)) add("errorCode", "PROVIDER_BAD_RESPONSE");
  if (!FAILURE_KINDS.has(response.failureKind)) add("failureKind", "PROVIDER_BAD_RESPONSE");
  if (typeof response.recoverable !== "boolean") add("recoverable", "PROVIDER_BAD_RESPONSE");
  if (response.status === "SUCCEEDED" && response.ok === true) {
    if (
      typeof response.content !== "string" ||
      !response.content.trim() ||
      codePointLength(response.content) > KADI_PROVIDER_LIMITS.maxResponseCodePoints
    ) add("content", "RESPONSE_INVALID_CONTENT");
    if (response.errorCode !== "NONE") add("errorCode", "PROVIDER_BAD_RESPONSE");
    if (response.failureKind !== "NONE") add("failureKind", "PROVIDER_BAD_RESPONSE");
    if (response.recoverable !== false) add("recoverable", "PROVIDER_BAD_RESPONSE");
  } else {
    if (!FINAL_FAILURE_STATUSES.has(response.status)) add("status", "RESPONSE_INVALID_STATUS");
    if (response.ok !== false) add("ok", "PROVIDER_BAD_RESPONSE");
    if (response.content !== null) add("content", "RESPONSE_INVALID_CONTENT");
    if (response.errorCode === "NONE") add("errorCode", "PROVIDER_BAD_RESPONSE");
    const rule = FAILURE_RULES[response.errorCode];
    if (!rule) {
      add("errorCode", "PROVIDER_BAD_RESPONSE");
    } else {
      if (response.failureKind !== rule.kind) add("failureKind", "PROVIDER_BAD_RESPONSE");
      if (response.recoverable !== rule.recoverable) add("recoverable", "PROVIDER_BAD_RESPONSE");
    }
    if (response.status === "TIMED_OUT" && response.errorCode !== "PROVIDER_TIMEOUT") {
      add("status", "PROVIDER_BAD_RESPONSE");
    }
    if (response.status === "CANCELLED" && response.errorCode !== "CANCELLED") {
      add("status", "PROVIDER_BAD_RESPONSE");
    }
  }
  if (!isPlainObject(response.usage)) {
    add("usage", "PROVIDER_BAD_RESPONSE");
  } else {
    const keys = ["inputUnits", "outputUnits", "totalUnits"];
    if (!hasExactOwnKeys(response.usage, keys)) {
      add("usage", "PROVIDER_BAD_RESPONSE");
    } else {
      for (const key of keys) {
        const value = response.usage[key];
        if (value !== null && (!Number.isInteger(value) || value < 0)) add(`usage.${key}`, "PROVIDER_BAD_RESPONSE");
      }
      if (
        keys.every((key) => response.usage[key] !== null) &&
        response.usage.totalUnits !==
          response.usage.inputUnits + response.usage.outputUnits
      ) add("usage.totalUnits", "PROVIDER_BAD_RESPONSE");
    }
  }
  if (!isPlainObject(response.metadata)) {
    add("metadata", "PROVIDER_BAD_RESPONSE");
  } else {
    if (!hasExactOwnKeys(response.metadata, ["providerRequestId", "finishReason"])) {
      add("metadata", "PROVIDER_BAD_RESPONSE");
    } else {
      if (
        response.metadata.providerRequestId !== null &&
        (typeof response.metadata.providerRequestId !== "string" ||
          !response.metadata.providerRequestId.trim() ||
          codePointLength(response.metadata.providerRequestId) >
            PROVIDER_REQUEST_ID_MAX_CODE_POINTS)
      ) add("metadata.providerRequestId", "PROVIDER_BAD_RESPONSE");
      if (
        response.metadata.finishReason !== null &&
        !FINISH_REASONS.has(response.metadata.finishReason)
      ) add("metadata.finishReason", "PROVIDER_BAD_RESPONSE");
      if (
        response.status === "SUCCEEDED" &&
        response.metadata.finishReason === "TOOL_CALL"
      ) add("metadata.finishReason", "PROVIDER_BAD_RESPONSE");
    }
  }
  return { valid: errors.length === 0, errors };
  } catch {
    return {
      valid: false,
      errors: [{ path: "$", code: "PROVIDER_BAD_RESPONSE" }],
    };
  }
}

function isSuccessfulProviderResponse(response) {
  try {
    return (
      validateProviderResponse(response).valid &&
      response.status === KADI_PROVIDER_STATUSES.SUCCEEDED &&
      response.ok === true &&
      typeof response.content === "string" &&
      !!response.content.trim()
    );
  } catch {
    return false;
  }
}

function isRecoverableProviderFailure(response) {
  try {
    if (!validateProviderResponse(response).valid || response.ok !== false) return false;
    const rule = FAILURE_RULES[response.errorCode];
    return !!rule && rule.recoverable === true && response.recoverable === true;
  } catch {
    return false;
  }
}

module.exports = {
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
};
