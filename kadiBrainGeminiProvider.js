"use strict";

const {
  createEmptyProviderResponse,
  normalizeProviderRequest,
  validateProviderRequest,
  validateProviderResponse,
} = require("./kadiBrainProviderContract");
const {
  detectSensitiveText,
  isPrivacySafeForProvider,
  sanitizePrivacyInput,
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

function normalizeDetectionText(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsExplicitRestrictedMarker(value) {
  const normalized = normalizeDetectionText(value);
  if (!normalized) return false;
  const documentOrBiometric =
    /\b(?:carte(?: nationale)?(?: d)? identite|cnib|cni|piece(?: d)? identite|numero de piece|passeport|passport|permis de conduire|acte de naissance|signature(?: client| manuscrite)?|signe par|empreinte(?: digitale)?|fingerprint|biometrie|cachet personnel)\b/u;
  if (documentOrBiometric.test(normalized)) return true;
  const explicitSecret =
    /\b(?:otp|pin|password|mot de passe|api key|access token|bearer token|service role key|secret key|mobile money pin|code de validation)\b\s+\S+/u;
  if (explicitSecret.test(normalized)) return true;
  const explicitAddress =
    /\b(?:adresse|domicile|livraison a|quartier|rue|avenue|secteur)\b\s+\S+/u;
  if (explicitAddress.test(normalized)) return true;
  const personalName =
    /\b(?:nom(?: du)? client|nom|client|beneficiaire|destinataire|expediteur|titulaire|proprietaire|monsieur|madame|m|mme)\s+([\p{L}]{2,})\s+([\p{L}]{2,})/u;
  return personalName.test(normalized);
}

function containsRawIdentityText(value) {
  return typeof value === "string" &&
    /\b(?:wa[\s_-]*id|bsuid|whatsapp[\s_-]*id|phone[\s_-]*number[\s_-]*id|code\s+de\s+validation)\b\s*[:=]?\s*\S+/iu.test(value);
}

function isSensitiveText(value) {
  if (typeof value !== "string") return false;
  if (containsRawIdentityText(value) || containsExplicitRestrictedMarker(value)) return true;
  return detectSensitiveText(value).some((item) => item.category !== "FINANCIAL");
}

const SYSTEM_SECRET_REFERENCE =
  /\b(?:mobile money pins?|codes? de validation|mots? de passe|passwords?|passcodes?|pins?|otps?|api keys?|cl[ée]s? api|access tokens?|bearer tokens?|service role keys?|secret keys?)\b/giu;

const SYSTEM_SECRET_REFERENCE_AT_START =
  /^(?:mobile money pins?|codes? de validation|mots? de passe|passwords?|passcodes?|pins?|otps?|api keys?|cles? api|access tokens?|bearer tokens?|service role keys?|secret keys?)\b/u;

const DEFENSIVE_SYSTEM_CONTEXT =
  /\b(?:ne demande(?: jamais| pas| aucun)|ne revele(?: jamais| pas| aucun)|ne reproduis(?: jamais| pas| aucun)|n expose(?: jamais| pas| aucun)|refuse|rejette|bloque|interdit|ne stocke jamais|ne conserve jamais|never ask|do not ask|never reveal|do not reveal|never expose|do not expose|do not request|never request|reject|block|forbid|never store|do not store|must be rejected|doit(?: jamais)? etre demande|ne doit jamais etre demande|ne doivent jamais etre demandes?|sont interdits?|doivent etre rejetees?)\b/u;

const SAFE_SYSTEM_CLASSIFICATION =
  /\b(?:est une categorie de secret|is a category of secret|ne doit pas contenir de secrets?|doit etre rejetee?|doivent etre rejetees?|must be rejected|sont interdits?)\b/u;

function containsNonSecretRestrictedMarker(value) {
  const normalized = normalizeDetectionText(value);
  if (!normalized) return false;
  return (
    /\b(?:carte(?: nationale)?(?: d)? identite|cnib|cni|piece(?: d)? identite|numero de piece|passeport|passport|permis de conduire|acte de naissance|signature(?: client| manuscrite)?|signe par|empreinte(?: digitale)?|fingerprint|biometrie|cachet personnel)\b/u.test(normalized) ||
    /\b(?:adresse|domicile|livraison a|quartier|rue|avenue|secteur)\b\s+\S+/u.test(normalized) ||
    /\b(?:nom(?: du)? client|nom|client|beneficiaire|destinataire|expediteur|titulaire|proprietaire|monsieur|madame|m|mme)\s+([\p{L}]{2,})\s+([\p{L}]{2,})/u.test(normalized)
  );
}

function systemSecretReferenceHasValue(text, match) {
  const termEnd = match.index + match[0].length;
  const rawTail = text.slice(termEnd, termEnd + 64);
  if (/^\s*[:=]\s*\S/u.test(rawTail)) return true;
  if (/^\s*["'`]\s*\S/u.test(rawTail)) return true;
  const tail = normalizeDetectionText(rawTail);
  if (!tail) return false;
  if (/^(?:\d{4,8}|sk \w+|aiza\w*|eyj\w*|bearer\s+\S+)/u.test(tail)) {
    return true;
  }
  if (/^(?:comme|such as)\s+(?:\d{4,8}|[a-z]*\d+[a-z0-9]*)\b/u.test(tail)) {
    return true;
  }
  if (/^(?:est une categorie de secret|is a category of secret)\b/u.test(tail)) {
    return false;
  }
  if (SYSTEM_SECRET_REFERENCE_AT_START.test(tail)) return false;
  if (/^(?:est|is|vaut|value|valeur|code)\s+\S/u.test(tail)) {
    return true;
  }
  const first = tail.split(" ")[0];
  const safeFollowers = new Set([
    "and", "or", "et", "ou", "must", "doit", "doivent", "ne", "should",
    "sont",
  ]);
  return (
    /^(?:\d{4,8}|sk\w*|aiza\w*|eyj\w*)$/u.test(first) ||
    /^(?=.*[a-z])(?=.*\d)[a-z0-9_-]{4,}$/u.test(first) ||
    (/^[a-z]{4,}$/u.test(first) && !safeFollowers.has(first))
  );
}

function containsSystemSecretReference(value) {
  SYSTEM_SECRET_REFERENCE.lastIndex = 0;
  return typeof value === "string" && SYSTEM_SECRET_REFERENCE.test(value);
}

function isSafeDefensiveSystemSecretReference(text) {
  if (typeof text !== "string") return false;
  const normalized = normalizeDetectionText(text);
  if (!normalized) return false;
  SYSTEM_SECRET_REFERENCE.lastIndex = 0;
  const references = [...text.matchAll(SYSTEM_SECRET_REFERENCE)];
  if (references.length === 0) return false;
  if (
    !DEFENSIVE_SYSTEM_CONTEXT.test(normalized) &&
    !SAFE_SYSTEM_CLASSIFICATION.test(normalized)
  ) return false;
  return references.every(
    (reference) => !systemSecretReferenceHasValue(text, reference)
  );
}

function isSystemMessageTextSafe(value) {
  if (typeof value !== "string") return false;
  if (
    containsRawIdentityText(value) ||
    containsNonSecretRestrictedMarker(value)
  ) return false;
  const detections = detectSensitiveText(value).filter(
    (item) => item.category !== "FINANCIAL"
  );
  if (
    detections.some(
      (item) => !["AUTH_SECRET", "ACCESS_SECRET"].includes(item.category)
    )
  ) return false;
  if (detections.length === 0 && !containsSystemSecretReference(value)) {
    return sanitizePrivacyInput({
      userMessage: value,
      context: {},
    }).allowed === true;
  }
  return isSafeDefensiveSystemSecretReference(value);
}

function isProviderMessageTextSafe(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.every((message) => {
    if (!isPlainObject(message) || typeof message.content !== "string") return false;
    if (message.role === "system") return isSystemMessageTextSafe(message.content);
    if (containsSystemSecretReference(message.content)) return false;
    if (isSensitiveText(message.content)) return false;
    const privacyCheck = sanitizePrivacyInput({
      userMessage: message.content,
      context: {},
    });
    return privacyCheck.allowed === true && privacyCheck.decision === "ALLOWED";
  });
}

function verifyPrivacyBinding(providerRequest, privacyResult) {
  try {
    return (
      isPrivacySafeForProvider(privacyResult) === true &&
      isPlainObject(providerRequest) &&
      isProviderMessageTextSafe(providerRequest.messages)
    );
  } catch {
    return false;
  }
}

function safeProviderRequestId(value) {
  const normalized = textOrNull(value, 200);
  return normalized && !isSensitiveText(normalized) ? normalized : null;
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
    if (!isProviderMessageTextSafe(request.messages)) return null;
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
      providerRequestId: safeProviderRequestId(result.providerRequestId),
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
        if (!verifyPrivacyBinding(providerRequest, privacyResult)) {
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
