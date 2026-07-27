"use strict";

const {
  createEmptyProviderResponse,
  normalizeProviderRequest,
  validateProviderRequest,
  validateProviderResponse,
} = require("./kadiBrainProviderContract");
const {
  isPrivacySafeForProvider,
} = require("./kadiBrainPrivacyGateway");

const KADI_GEMINI_PROVIDER_VERSION = "kadi.gemini-provider.v1";

const KADI_GEMINI_CLIENT_ERROR_KINDS = Object.freeze({
  NETWORK: "NETWORK",
  TIMEOUT: "TIMEOUT",
  RATE_LIMIT: "RATE_LIMIT",
  AUTHENTICATION: "AUTHENTICATION",
  SAFETY: "SAFETY",
  CONTENT: "CONTENT",
  UNAVAILABLE: "UNAVAILABLE",
  BAD_RESPONSE: "BAD_RESPONSE",
  INTERNAL: "INTERNAL",
  CANCELLED: "CANCELLED",
  UNKNOWN: "UNKNOWN",
});

const KADI_GEMINI_FINISH_REASONS = Object.freeze({
  STOP: "STOP",
  MAX_OUTPUT: "MAX_OUTPUT",
  SAFETY: "SAFETY",
  CONTENT_FILTER: "CONTENT_FILTER",
  TOOL_CALL: "TOOL_CALL",
  ERROR: "ERROR",
  CANCELLED: "CANCELLED",
  UNKNOWN: "UNKNOWN",
});

const ERROR_MAPPINGS = Object.freeze({
  NETWORK: Object.freeze({
    errorCode: "PROVIDER_NETWORK_ERROR",
    failureKind: "NETWORK",
    status: "FAILED",
    recoverable: true,
  }),
  TIMEOUT: Object.freeze({
    errorCode: "PROVIDER_TIMEOUT",
    failureKind: "TIMEOUT",
    status: "TIMED_OUT",
    recoverable: true,
  }),
  RATE_LIMIT: Object.freeze({
    errorCode: "PROVIDER_RATE_LIMITED",
    failureKind: "RATE_LIMIT",
    status: "FAILED",
    recoverable: true,
  }),
  AUTHENTICATION: Object.freeze({
    errorCode: "PROVIDER_AUTH_FAILED",
    failureKind: "AUTHENTICATION",
    status: "REJECTED",
    recoverable: false,
  }),
  SAFETY: Object.freeze({
    errorCode: "PROVIDER_SAFETY_BLOCK",
    failureKind: "SAFETY",
    status: "REJECTED",
    recoverable: false,
  }),
  CONTENT: Object.freeze({
    errorCode: "PROVIDER_CONTENT_BLOCK",
    failureKind: "CONTENT",
    status: "REJECTED",
    recoverable: false,
  }),
  UNAVAILABLE: Object.freeze({
    errorCode: "PROVIDER_UNAVAILABLE",
    failureKind: "PROVIDER",
    status: "FAILED",
    recoverable: true,
  }),
  BAD_RESPONSE: Object.freeze({
    errorCode: "PROVIDER_BAD_RESPONSE",
    failureKind: "PROVIDER",
    status: "FAILED",
    recoverable: true,
  }),
  INTERNAL: Object.freeze({
    errorCode: "PROVIDER_INTERNAL_ERROR",
    failureKind: "INTERNAL",
    status: "FAILED",
    recoverable: true,
  }),
  CANCELLED: Object.freeze({
    errorCode: "CANCELLED",
    failureKind: "NONE",
    status: "CANCELLED",
    recoverable: false,
  }),
  UNKNOWN: Object.freeze({
    errorCode: "PROVIDER_INTERNAL_ERROR",
    failureKind: "INTERNAL",
    status: "FAILED",
    recoverable: true,
  }),
});

const FINISH_MAPPINGS = Object.freeze({
  MAX_OUTPUT: ERROR_MAPPINGS.BAD_RESPONSE,
  SAFETY: ERROR_MAPPINGS.SAFETY,
  CONTENT_FILTER: ERROR_MAPPINGS.CONTENT,
  TOOL_CALL: ERROR_MAPPINGS.BAD_RESPONSE,
  ERROR: ERROR_MAPPINGS.INTERNAL,
  CANCELLED: ERROR_MAPPINGS.CANCELLED,
  UNKNOWN: ERROR_MAPPINGS.BAD_RESPONSE,
});

const FORBIDDEN_KEYS = new Set([
  "restorationmap", "rawinput", "rawmessage", "originalmessage", "waid",
  "bsuid", "phone", "phonenumber", "email", "address", "password", "otp",
  "pin", "accesscredential", "servicerolecredential", "secretcredential",
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeKey(value) {
  return String(value).trim().toLowerCase().replace(/[_\-\s]/g, "");
}

function codePointLength(value) {
  return Array.from(value).length;
}

function textOrNull(value, maximum = Infinity) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && codePointLength(text) <= maximum ? text : null;
}

function nonNegativeIntegerOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function containsForbiddenKey(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsForbiddenKey(item, seen));
  return Object.keys(value).some(
    (key) =>
      FORBIDDEN_KEYS.has(normalizeKey(key)) ||
      containsForbiddenKey(value[key], seen)
  );
}

function hasExactKeys(value, keys) {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function canonicalProviderRequest(value) {
  const rootKeys = [
    "schemaVersion", "provider", "model", "messages", "timeoutMs",
    "responseFormat", "generation", "metadata",
  ];
  if (
    !hasExactKeys(value, rootKeys) ||
    !Array.isArray(value.messages) ||
    value.messages.some((message) => !hasExactKeys(message, ["role", "content"])) ||
    !hasExactKeys(value.responseFormat, ["type"]) ||
    !hasExactKeys(value.generation, ["temperature", "maxOutputCodePoints"]) ||
    !hasExactKeys(value.metadata, ["requestPurpose", "tags"])
  ) return null;
  const normalized = normalizeProviderRequest(value);
  return validateProviderRequest(normalized).valid ? normalized : null;
}

function failureResponse(mapping, model = null, finishReason = "ERROR") {
  const response = createEmptyProviderResponse();
  response.provider = "GEMINI";
  response.model = model;
  response.status = mapping.status;
  response.errorCode = mapping.errorCode;
  response.failureKind = mapping.failureKind;
  response.recoverable = mapping.recoverable;
  response.metadata.finishReason = finishReason;
  return response;
}

function localFailure(errorCode, failureKind, status, recoverable) {
  return failureResponse(
    { errorCode, failureKind, status, recoverable },
    null,
    "ERROR"
  );
}

function validatedResponse(response) {
  if (validateProviderResponse(response).valid) return response;
  return failureResponse(ERROR_MAPPINGS.INTERNAL);
}

function buildGeminiClientRequest(providerRequest) {
  try {
    const request = canonicalProviderRequest(providerRequest);
    if (!request || request.provider !== "GEMINI") return null;
    if (typeof request.model !== "string" || !request.model.trim()) {
      return null;
    }
    const systemMessages = request.messages.filter(
      (message) => message.role === "system"
    );
    if (systemMessages.length !== 1 || request.messages[0].role !== "system") {
      return null;
    }
    const users = request.messages.filter((message) => message.role === "user");
    if (users.length === 0) return null;
    const result = {
      model: request.model,
      systemInstruction: systemMessages[0].content,
      contents: users.map((message) => ({
        role: "user",
        parts: [{ text: message.content }],
      })),
      generationConfig: {
        temperature: 0,
        maxOutputCodePoints: request.generation.maxOutputCodePoints,
        responseMimeType: "application/json",
      },
    };
    return containsForbiddenKey(result) ? null : result;
  } catch {
    return null;
  }
}

function mapGeminiClientError(error) {
  try {
    let kind = "UNKNOWN";
    if (isPlainObject(error)) {
      const descriptor = Object.getOwnPropertyDescriptor(error, "kind");
      if (descriptor && !descriptor.get && !descriptor.set) {
        const value = descriptor.value;
        if (
          typeof value === "string" &&
          Object.prototype.hasOwnProperty.call(
            KADI_GEMINI_CLIENT_ERROR_KINDS,
            value.trim()
          )
        ) kind = value.trim();
      }
    }
    return validatedResponse(failureResponse(ERROR_MAPPINGS[kind]));
  } catch {
    return validatedResponse(failureResponse(ERROR_MAPPINGS.UNKNOWN));
  }
}

function normalizeGeminiClientResult(result, providerRequest) {
  try {
    if (
      !isPlainObject(result) ||
      !isPlainObject(providerRequest) ||
      providerRequest.provider !== "GEMINI"
    ) return validatedResponse(failureResponse(ERROR_MAPPINGS.BAD_RESPONSE));

    const finishReason =
      typeof result.finishReason === "string" &&
      Object.prototype.hasOwnProperty.call(
        KADI_GEMINI_FINISH_REASONS,
        result.finishReason.trim()
      )
        ? result.finishReason.trim()
        : "UNKNOWN";
    const model = textOrNull(result.model, 120);
    if (finishReason !== "STOP") {
      return validatedResponse(
        failureResponse(FINISH_MAPPINGS[finishReason], model, finishReason)
      );
    }
    const content = textOrNull(result.text, 32000);
    if (!content) {
      return validatedResponse(
        failureResponse(ERROR_MAPPINGS.BAD_RESPONSE, model, "ERROR")
      );
    }
    const usage = isPlainObject(result.usage) ? result.usage : {};
    const response = createEmptyProviderResponse();
    response.provider = "GEMINI";
    response.model = model;
    response.status = "SUCCEEDED";
    response.ok = true;
    response.content = content;
    response.errorCode = "NONE";
    response.failureKind = "NONE";
    response.recoverable = false;
    response.usage = {
      inputUnits: nonNegativeIntegerOrNull(usage.inputUnits),
      outputUnits: nonNegativeIntegerOrNull(usage.outputUnits),
      totalUnits: nonNegativeIntegerOrNull(usage.totalUnits),
    };
    if (
      response.usage.inputUnits !== null &&
      response.usage.outputUnits !== null &&
      response.usage.totalUnits !==
        response.usage.inputUnits + response.usage.outputUnits
    ) response.usage.totalUnits = null;
    response.metadata = {
      providerRequestId: textOrNull(result.providerRequestId, 200),
      finishReason: "STOP",
    };
    return validatedResponse(response);
  } catch {
    return validatedResponse(failureResponse(ERROR_MAPPINGS.INTERNAL));
  }
}

function getInjectedGenerate(options) {
  if (
    !isPlainObject(options) ||
    JSON.stringify(Object.keys(options)) !== JSON.stringify(["client"]) ||
    !isPlainObject(options.client)
  ) return null;
  const descriptor = Object.getOwnPropertyDescriptor(options.client, "generateContent");
  return descriptor && !descriptor.get && !descriptor.set &&
    typeof descriptor.value === "function"
    ? { client: options.client, generate: descriptor.value }
    : null;
}

function createGeminiProvider(options) {
  const injected = getInjectedGenerate(options);
  return {
    async invoke(input) {
      try {
        if (!isPlainObject(input)) {
          return validatedResponse(
            localFailure("INVALID_REQUEST", "CLIENT", "REJECTED", false)
          );
        }
        const providerRequest = input.providerRequest;
        const privacyResult = input.privacyResult;
        if (!validateProviderRequest(providerRequest).valid) {
          return validatedResponse(
            localFailure("INVALID_REQUEST", "CLIENT", "REJECTED", false)
          );
        }
        if (providerRequest.provider !== "GEMINI") {
          return validatedResponse(
            localFailure("INVALID_PROVIDER", "CONFIGURATION", "REJECTED", false)
          );
        }
        if (typeof providerRequest.model !== "string" || !providerRequest.model.trim()) {
          return validatedResponse(
            localFailure("INVALID_MODEL", "CONFIGURATION", "REJECTED", false)
          );
        }
        if (!isPrivacySafeForProvider(privacyResult)) {
          return validatedResponse(
            localFailure("INVALID_REQUEST", "CLIENT", "REJECTED", false)
          );
        }
        if (!injected) {
          return validatedResponse(failureResponse(ERROR_MAPPINGS.UNAVAILABLE));
        }
        const clientRequest = buildGeminiClientRequest(providerRequest);
        if (!clientRequest || containsForbiddenKey(clientRequest)) {
          return validatedResponse(
            localFailure("INVALID_REQUEST", "CLIENT", "REJECTED", false)
          );
        }
        let result;
        try {
          result = await injected.generate.call(injected.client, clientRequest);
        } catch (error) {
          return mapGeminiClientError(error);
        }
        return normalizeGeminiClientResult(result, providerRequest);
      } catch {
        return validatedResponse(failureResponse(ERROR_MAPPINGS.INTERNAL));
      }
    },
  };
}

module.exports = {
  KADI_GEMINI_PROVIDER_VERSION,
  KADI_GEMINI_CLIENT_ERROR_KINDS,
  KADI_GEMINI_FINISH_REASONS,
  createGeminiProvider,
  buildGeminiClientRequest,
  normalizeGeminiClientResult,
  mapGeminiClientError,
};
