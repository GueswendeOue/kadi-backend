"use strict";

const KADI_GEMINI_REAL_CLIENT_VERSION = "kadi.gemini-real-client.v1";

const KADI_GEMINI_REAL_CLIENT_ERROR_KINDS = Object.freeze({
  NETWORK: "NETWORK",
  TIMEOUT: "TIMEOUT",
  RATE_LIMIT: "RATE_LIMIT",
  AUTHENTICATION: "AUTHENTICATION",
  SAFETY: "SAFETY",
  CONTENT: "CONTENT",
  UNAVAILABLE: "UNAVAILABLE",
  BAD_RESPONSE: "BAD_RESPONSE",
  REQUEST_REJECTED: "REQUEST_REJECTED",
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
  INTERNAL: "INTERNAL",
  CANCELLED: "CANCELLED",
  UNKNOWN: "UNKNOWN",
  SDK_EXPORT_MISSING: "SDK_EXPORT_MISSING",
  SDK_CONSTRUCTOR_INVALID: "SDK_CONSTRUCTOR_INVALID",
  SDK_CLIENT_INVALID: "SDK_CLIENT_INVALID",
  SDK_METHOD_MISSING: "SDK_METHOD_MISSING",
  SDK_REQUEST_BUILD_FAILED: "SDK_REQUEST_BUILD_FAILED",
  SDK_RESPONSE_NORMALIZATION_FAILED: "SDK_RESPONSE_NORMALIZATION_FAILED",
  SDK_UNKNOWN_FAILURE: "SDK_UNKNOWN_FAILURE",
});

const KADI_GEMINI_REAL_CLIENT_LIMITS = Object.freeze({
  maxApiKeyCodePoints: 4096,
  maxModelCodePoints: 120,
  maxSystemInstructionCodePoints: 32000,
  maxContentEntries: 32,
  maxContentCodePoints: 32000,
  maxOutputTokens: 8192,
  maxProviderRequestIdCodePoints: 200,
});

const FINISH_REASON_MAP = Object.freeze({
  STOP: "STOP",
  MAX_TOKENS: "MAX_OUTPUT",
  SAFETY: "SAFETY",
  BLOCKLIST: "CONTENT_FILTER",
  PROHIBITED_CONTENT: "CONTENT_FILTER",
  SPII: "CONTENT_FILTER",
  RECITATION: "CONTENT_FILTER",
  MALFORMED_FUNCTION_CALL: "TOOL_CALL",
  UNEXPECTED_TOOL_CALL: "TOOL_CALL",
  OTHER: "ERROR",
});

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  return isPlainObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function codePointLength(value) {
  return [...value].length;
}

function cloneJsonObject(value) {
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    return isPlainObject(cloned) ? cloned : null;
  } catch {
    return null;
  }
}

function safeDescriptorValue(object, key) {
  if (
    !object ||
    (typeof object !== "object" && typeof object !== "function")
  ) return undefined;
  let current = object;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      return !descriptor.get && !descriptor.set
        ? descriptor.value
        : undefined;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

function safeReadProperty(object, key) {
  try {
    if (
      !object ||
      (typeof object !== "object" && typeof object !== "function")
    ) return { ok: false, value: undefined };
    let current = object;
    while (current) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        if (!descriptor.set && typeof descriptor.get === "function") {
          return { ok: true, value: descriptor.get.call(object) };
        }
        return {
          ok: !descriptor.get && !descriptor.set,
          value: !descriptor.get && !descriptor.set
            ? descriptor.value
            : undefined,
        };
      }
      current = Object.getPrototypeOf(current);
    }
    return { ok: false, value: undefined };
  } catch {
    return { ok: false, value: undefined };
  }
}

function readSdkText(response) {
  try {
  let current = response;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "text");
    if (descriptor) {
      if (!descriptor.set && typeof descriptor.get === "function") {
        return descriptor.get.call(response);
      }
      return !descriptor.get && !descriptor.set
        ? descriptor.value
        : undefined;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
  } catch {
    throw canonicalError("BAD_RESPONSE");
  }
}

function normalizeForDetection(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9@+]+/g, " ")
    .trim();
}

function containsSensitiveMarker(value) {
  const raw = value.trim();
  const normalized = normalizeForDetection(raw);
  return (
    /@/.test(raw) ||
    /\+?\d(?:[\s.-]*\d){7,}/.test(raw) ||
    /\b(?:secret|password|otp|pin|waid|ifu|rccm|passeport|passport|signature|adresse|domicile)\b/.test(normalized) ||
    /\bmot\s+de\s+passe\b/.test(normalized) ||
    /\b(?:private|api|service\s+role)\s+key\b/.test(normalized) ||
    /\b(?:access|bearer)\s+token\b/.test(normalized) ||
    /\b(?:carte|piece)\s+(?:nationale\s+)?(?:d\s+)?identite\b/.test(normalized) ||
    /\bnom\s+[a-z]/.test(normalized)
  );
}

function isSafeTechnicalId(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    codePointLength(value.trim()) >
      KADI_GEMINI_REAL_CLIENT_LIMITS.maxProviderRequestIdCodePoints
  ) return false;
  const raw = value.trim();
  if (containsSensitiveMarker(raw)) return false;
  return /^[A-Za-z0-9_-]+$/.test(raw);
}

function normalizeSafeModelIdentifier(value, fallbackModel) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    codePointLength(value) > KADI_GEMINI_REAL_CLIENT_LIMITS.maxModelCodePoints ||
    containsSensitiveMarker(value) ||
    !/^[A-Za-z0-9_./-]+$/.test(value)
  ) return fallbackModel;
  return value;
}

function validateNeutralRequest(neutralRequest) {
  if (!exactKeys(neutralRequest, [
    "model", "systemInstruction", "contents", "generationConfig",
  ])) return false;
  if (
    typeof neutralRequest.model !== "string" ||
    !neutralRequest.model.trim() ||
    codePointLength(neutralRequest.model) >
      KADI_GEMINI_REAL_CLIENT_LIMITS.maxModelCodePoints ||
    typeof neutralRequest.systemInstruction !== "string" ||
    codePointLength(neutralRequest.systemInstruction) >
      KADI_GEMINI_REAL_CLIENT_LIMITS.maxSystemInstructionCodePoints ||
    !Array.isArray(neutralRequest.contents) ||
    neutralRequest.contents.length === 0 ||
    neutralRequest.contents.length >
      KADI_GEMINI_REAL_CLIENT_LIMITS.maxContentEntries
  ) return false;
  for (const content of neutralRequest.contents) {
    if (
      !exactKeys(content, ["role", "parts"]) ||
      content.role !== "user" ||
      !Array.isArray(content.parts) ||
      content.parts.length === 0
    ) return false;
    for (const part of content.parts) {
      if (
        !exactKeys(part, ["text"]) ||
        typeof part.text !== "string" ||
        !part.text.trim() ||
        codePointLength(part.text) >
          KADI_GEMINI_REAL_CLIENT_LIMITS.maxContentCodePoints
      ) return false;
    }
  }
  const generation = neutralRequest.generationConfig;
  return exactKeys(generation, [
    "temperature", "maxOutputCodePoints", "responseMimeType",
    "responseJsonSchema",
  ]) &&
    generation.temperature === 0 &&
    Number.isSafeInteger(generation.maxOutputCodePoints) &&
    generation.maxOutputCodePoints > 0 &&
    generation.responseMimeType === "application/json" &&
    cloneJsonObject(generation.responseJsonSchema) !== null;
}

function buildGoogleGenerateContentRequest(neutralRequest) {
  try {
    if (!validateNeutralRequest(neutralRequest)) return null;
    // Code points are not tokens; this conservative bound is deterministic.
    const maxOutputTokens = Math.min(
      KADI_GEMINI_REAL_CLIENT_LIMITS.maxOutputTokens,
      Math.max(1, Math.ceil(neutralRequest.generationConfig.maxOutputCodePoints / 2))
    );
    return {
      model: neutralRequest.model,
      contents: neutralRequest.contents.map((content) => ({
        role: "user",
        parts: content.parts.map((part) => ({ text: part.text })),
      })),
      config: {
        systemInstruction: neutralRequest.systemInstruction,
        temperature: 0,
        responseMimeType: "application/json",
        maxOutputTokens,
        responseJsonSchema: cloneJsonObject(
          neutralRequest.generationConfig.responseJsonSchema
        ),
      },
    };
  } catch {
    return null;
  }
}

function nonNegativeSafeIntegerOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeFinishReason(value) {
  return typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(FINISH_REASON_MAP, value.trim())
    ? FINISH_REASON_MAP[value.trim()]
    : "UNKNOWN";
}

function canonicalError(kind) {
  return {
    kind: Object.prototype.hasOwnProperty.call(
      KADI_GEMINI_REAL_CLIENT_ERROR_KINDS,
      kind
    ) ? kind : "UNKNOWN",
  };
}

function normalizeGoogleGenerateContentResponse(response, neutralRequest) {
  try {
    if (
      !response ||
      typeof response !== "object" ||
      Array.isArray(response) ||
      !validateNeutralRequest(neutralRequest)
    ) throw canonicalError("BAD_RESPONSE");
    const candidatesRead = safeReadProperty(response, "candidates");
    const candidates = candidatesRead.ok ? candidatesRead.value : null;
    const candidateRead = Array.isArray(candidates) && candidates.length > 0
      ? safeReadProperty(candidates, "0")
      : { ok: false, value: null };
    const finishRead = candidateRead.ok
      ? safeReadProperty(candidateRead.value, "finishReason")
      : { ok: false, value: undefined };
    const finishReason = normalizeFinishReason(
      finishRead.ok ? finishRead.value : undefined
    );
    const text = readSdkText(response);
    if (typeof text !== "string" || !text.trim()) {
      if (finishReason === "SAFETY") throw canonicalError("SAFETY");
      if (finishReason === "CONTENT_FILTER") throw canonicalError("CONTENT");
      throw canonicalError("BAD_RESPONSE");
    }
    const modelRead = safeReadProperty(response, "modelVersion");
    const model = normalizeSafeModelIdentifier(
      modelRead.ok ? modelRead.value : null,
      neutralRequest.model
    );
    const usageRead = safeReadProperty(response, "usageMetadata");
    const usage = usageRead.ok && isPlainObject(usageRead.value)
      ? usageRead.value
      : {};
    const inputRead = safeReadProperty(usage, "promptTokenCount");
    const outputRead = safeReadProperty(usage, "candidatesTokenCount");
    const totalRead = safeReadProperty(usage, "totalTokenCount");
    const responseIdRead = safeReadProperty(response, "responseId");
    const responseId = responseIdRead.ok ? responseIdRead.value : null;
    return {
      text,
      model,
      finishReason,
      usage: {
        inputUnits: nonNegativeSafeIntegerOrNull(inputRead.value),
        outputUnits: nonNegativeSafeIntegerOrNull(outputRead.value),
        totalUnits: nonNegativeSafeIntegerOrNull(totalRead.value),
      },
      providerRequestId: isSafeTechnicalId(responseId)
        ? responseId.trim()
        : null,
    };
  } catch (error) {
    const kind = safeDescriptorValue(error, "kind");
    throw canonicalError(
      typeof kind === "string" &&
      Object.prototype.hasOwnProperty.call(KADI_GEMINI_REAL_CLIENT_ERROR_KINDS, kind)
        ? kind
        : "BAD_RESPONSE"
    );
  }
}

function extractTechnicalErrorSignals(error) {
  try {
    if (!error || (typeof error !== "object" && typeof error !== "function")) {
      return { status: null, values: [] };
    }
    const nested = safeDescriptorValue(error, "error");
    const details = safeDescriptorValue(error, "details");
    const values = [
      safeDescriptorValue(error, "status"),
      safeDescriptorValue(error, "statusCode"),
      safeDescriptorValue(error, "code"),
      safeDescriptorValue(error, "name"),
      safeDescriptorValue(error, "kind"),
      safeDescriptorValue(error, "reason"),
      safeDescriptorValue(error, "type"),
      safeDescriptorValue(nested, "status"),
      safeDescriptorValue(nested, "statusCode"),
      safeDescriptorValue(nested, "code"),
      safeDescriptorValue(nested, "name"),
      safeDescriptorValue(nested, "kind"),
      safeDescriptorValue(nested, "reason"),
      safeDescriptorValue(nested, "type"),
      ...(Array.isArray(details)
        ? details.slice(0, 8).map((detail) => safeDescriptorValue(detail, "reason"))
        : []),
    ].filter((value) =>
      typeof value === "string" &&
      value.length <= 120 &&
      /^[A-Za-z0-9_.:/-]+$/.test(value)
    ).map((value) => value.trim().toUpperCase());
    const rawStatus = safeDescriptorValue(error, "status") ??
      safeDescriptorValue(error, "statusCode") ??
      safeDescriptorValue(error, "code") ??
      safeDescriptorValue(nested, "status") ??
      safeDescriptorValue(nested, "statusCode") ??
      safeDescriptorValue(nested, "code");
    const status = Number.isInteger(rawStatus)
      ? rawStatus
      : typeof rawStatus === "string" && /^\d{3}$/.test(rawStatus)
        ? Number(rawStatus)
        : null;
    return { status, values };
  } catch {
    return { status: null, values: [] };
  }
}

function mapGoogleGeminiError(error) {
  try {
    if (!error || (typeof error !== "object" && typeof error !== "function")) {
      return canonicalError("UNKNOWN");
    }
    const signals = extractTechnicalErrorSignals(error);
    const technical = new Set(signals.values);
    const status = signals.status;
    if (status === 401 || status === 403) return canonicalError("AUTHENTICATION");
    if (
      status === 404 ||
      ["MODEL_NOT_FOUND", "RESOURCE_NOT_FOUND", "NOT_FOUND"].some(
        (value) => technical.has(value)
      )
    ) return canonicalError("MODEL_NOT_FOUND");
    if (status === 408) return canonicalError("TIMEOUT");
    if (status === 429) return canonicalError("RATE_LIMIT");
    if (status === 502 || status === 503 || status === 504) {
      return canonicalError("UNAVAILABLE");
    }
    if (status === 500) return canonicalError("INTERNAL");
    if (status !== null && status >= 400 && status < 500) {
      return canonicalError("REQUEST_REJECTED");
    }
    if (status !== null && status >= 500 && status < 600) {
      return canonicalError("UNAVAILABLE");
    }
    if (
      technical.has("UNAUTHENTICATED") ||
      technical.has("PERMISSION_DENIED")
    ) return canonicalError("AUTHENTICATION");
    if (
      technical.has("INVALID_ARGUMENT") ||
      technical.has("BAD_REQUEST") ||
      technical.has("FAILED_PRECONDITION") ||
      technical.has("ALREADY_EXISTS") ||
      technical.has("ABORTED") ||
      technical.has("CONFLICT")
    ) return canonicalError("REQUEST_REJECTED");
    if (
      technical.has("RESOURCE_EXHAUSTED") ||
      technical.has("RATE_LIMITED")
    ) return canonicalError("RATE_LIMIT");
    if (
      technical.has("DEADLINE_EXCEEDED") ||
      technical.has("TIMEOUT")
    ) return canonicalError("TIMEOUT");
    if (technical.has("UNAVAILABLE")) return canonicalError("UNAVAILABLE");
    if (technical.has("INTERNAL")) return canonicalError("INTERNAL");
    const code = safeDescriptorValue(error, "code");
    if (code === "ETIMEDOUT") return canonicalError("TIMEOUT");
    if (["ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(code)) {
      return canonicalError("NETWORK");
    }
    const name = safeDescriptorValue(error, "name");
    if (name === "AbortError") return canonicalError("CANCELLED");
    const kind = safeDescriptorValue(error, "kind");
    if (kind === "SAFETY") return canonicalError("SAFETY");
    if (kind === "CONTENT") return canonicalError("CONTENT");
    if (
      typeof kind === "string" &&
      Object.prototype.hasOwnProperty.call(KADI_GEMINI_REAL_CLIENT_ERROR_KINDS, kind)
    ) return canonicalError(kind);
    return canonicalError("UNKNOWN");
  } catch {
    return canonicalError("UNKNOWN");
  }
}

function createGeminiRealClient(options) {
  const optionKeys = isPlainObject(options) ? Object.keys(options).sort() : [];
  const validOptionKeys =
    JSON.stringify(optionKeys) === JSON.stringify(["apiKey"]) ||
    JSON.stringify(optionKeys) === JSON.stringify(["apiKey", "sdkFactory"]);
  if (
    !validOptionKeys ||
    typeof options.apiKey !== "string" ||
    !options.apiKey.trim() ||
    codePointLength(options.apiKey) >
      KADI_GEMINI_REAL_CLIENT_LIMITS.maxApiKeyCodePoints ||
    (
      Object.prototype.hasOwnProperty.call(options, "sdkFactory") &&
      typeof options.sdkFactory !== "function"
    )
  ) return null;
  const hasInjectedFactory = typeof options.sdkFactory === "function";
  const sdkFactory = options.sdkFactory || (async ({ apiKey }) => {
    let sdk;
    try {
      sdk = await import("@google/genai");
    } catch {
      throw canonicalError("SDK_EXPORT_MISSING");
    }
    if (typeof sdk.GoogleGenAI !== "function") {
      throw canonicalError("SDK_CONSTRUCTOR_INVALID");
    }
    try {
      return new sdk.GoogleGenAI({ apiKey });
    } catch {
      throw canonicalError("SDK_CONSTRUCTOR_INVALID");
    }
  });
  let sdkClient;
  let initializationError = null;
  if (hasInjectedFactory) {
    try {
      sdkClient = sdkFactory({ apiKey: options.apiKey });
    } catch (error) {
      initializationError = mapGoogleGeminiError(error);
    }
    const models = sdkClient &&
      (typeof sdkClient === "object" || typeof sdkClient === "function")
      ? safeDescriptorValue(sdkClient, "models")
      : null;
    if (!initializationError && typeof safeDescriptorValue(
      models, "generateContent"
    ) !== "function") return null;
  }
  let defaultInitialization;
  return {
    async generateContent(neutralRequest) {
      const googleRequest = buildGoogleGenerateContentRequest(neutralRequest);
      if (!googleRequest) throw canonicalError("SDK_REQUEST_BUILD_FAILED");
      if (initializationError) throw canonicalError(initializationError.kind);
      try {
        if (!hasInjectedFactory) {
          if (!defaultInitialization) {
            defaultInitialization = Promise.resolve(
              sdkFactory({ apiKey: options.apiKey })
            );
          }
          sdkClient = await defaultInitialization;
        }
        const models = safeDescriptorValue(sdkClient, "models");
        if (!models) throw canonicalError("SDK_CLIENT_INVALID");
        const generate = safeDescriptorValue(models, "generateContent");
        if (typeof generate !== "function") {
          throw canonicalError("SDK_METHOD_MISSING");
        }
        const response = await generate.call(models, googleRequest);
        return normalizeGoogleGenerateContentResponse(response, neutralRequest);
      } catch (error) {
        throw mapGoogleGeminiError(error);
      }
    },
  };
}

module.exports = {
  KADI_GEMINI_REAL_CLIENT_VERSION,
  KADI_GEMINI_REAL_CLIENT_ERROR_KINDS,
  KADI_GEMINI_REAL_CLIENT_LIMITS,
  createGeminiRealClient,
  buildGoogleGenerateContentRequest,
  normalizeGoogleGenerateContentResponse,
  mapGoogleGeminiError,
};
