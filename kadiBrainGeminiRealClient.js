"use strict";

const { GoogleGenAI } = require("@google/genai");

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
  INTERNAL: "INTERNAL",
  CANCELLED: "CANCELLED",
  UNKNOWN: "UNKNOWN",
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

function readSdkText(response) {
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
}

function normalizeForDetection(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9@+]+/g, " ")
    .trim();
}

function isSafeTechnicalId(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    codePointLength(value.trim()) >
      KADI_GEMINI_REAL_CLIENT_LIMITS.maxProviderRequestIdCodePoints
  ) return false;
  const raw = value.trim();
  const normalized = normalizeForDetection(raw);
  if (
    /@/.test(raw) ||
    /\+?\d(?:[\s.-]*\d){7,}/.test(raw) ||
    /\b(?:otp|pin|waid|ifu|rccm|passeport|passport|signature|adresse|domicile)\b/.test(normalized) ||
    /\b(?:carte|piece)\s+(?:nationale\s+)?(?:d\s+)?identite\b/.test(normalized) ||
    /\bnom\s+[a-z]/.test(normalized)
  ) return false;
  return /^[A-Za-z0-9_-]+$/.test(raw);
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
  ]) &&
    generation.temperature === 0 &&
    Number.isSafeInteger(generation.maxOutputCodePoints) &&
    generation.maxOutputCodePoints > 0 &&
    generation.responseMimeType === "application/json";
}

function buildGoogleGenerateContentRequest(neutralRequest) {
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
    },
  };
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
  if (
    !response ||
    typeof response !== "object" ||
    Array.isArray(response) ||
    !validateNeutralRequest(neutralRequest)
  ) {
    throw canonicalError("BAD_RESPONSE");
  }
  const candidates = safeDescriptorValue(response, "candidates");
  const candidate = Array.isArray(candidates) && candidates.length > 0
    ? candidates[0]
    : null;
  const finishReason = normalizeFinishReason(
    safeDescriptorValue(candidate, "finishReason")
  );
  const text = readSdkText(response);
  if (typeof text !== "string" || !text.trim()) {
    if (finishReason === "SAFETY") throw canonicalError("SAFETY");
    if (finishReason === "CONTENT_FILTER") throw canonicalError("CONTENT");
    throw canonicalError("BAD_RESPONSE");
  }
  const modelVersion = safeDescriptorValue(response, "modelVersion");
  const model = typeof modelVersion === "string" &&
    modelVersion.trim() &&
    codePointLength(modelVersion) <=
      KADI_GEMINI_REAL_CLIENT_LIMITS.maxModelCodePoints
    ? modelVersion
    : neutralRequest.model;
  const usageMetadata = safeDescriptorValue(response, "usageMetadata");
  const usage = isPlainObject(usageMetadata) ? usageMetadata : {};
  const responseId = safeDescriptorValue(response, "responseId");
  return {
    text,
    model,
    finishReason,
    usage: {
      inputUnits: nonNegativeSafeIntegerOrNull(
        safeDescriptorValue(usage, "promptTokenCount")
      ),
      outputUnits: nonNegativeSafeIntegerOrNull(
        safeDescriptorValue(usage, "candidatesTokenCount")
      ),
      totalUnits: nonNegativeSafeIntegerOrNull(
        safeDescriptorValue(usage, "totalTokenCount")
      ),
    },
    providerRequestId: isSafeTechnicalId(responseId)
      ? responseId.trim()
      : null,
  };
}

function mapGoogleGeminiError(error) {
  try {
    if (!error || (typeof error !== "object" && typeof error !== "function")) {
      return canonicalError("UNKNOWN");
    }
    const status = safeDescriptorValue(error, "status");
    if (status === 401 || status === 403) return canonicalError("AUTHENTICATION");
    if (status === 408) return canonicalError("TIMEOUT");
    if (status === 429) return canonicalError("RATE_LIMIT");
    if (status === 502 || status === 503 || status === 504 || status === 409) {
      return canonicalError("UNAVAILABLE");
    }
    if (status === 500) return canonicalError("INTERNAL");
    if (status === 400) return canonicalError("BAD_RESPONSE");
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
  const sdkFactory = options.sdkFactory ||
    (({ apiKey }) => new GoogleGenAI({ apiKey }));
  let sdkClient;
  try {
    sdkClient = sdkFactory({ apiKey: options.apiKey });
  } catch (error) {
    const mapped = mapGoogleGeminiError(error);
    return {
      async generateContent() {
        throw { kind: mapped.kind };
      },
    };
  }
  const models = sdkClient &&
    (typeof sdkClient === "object" || typeof sdkClient === "function")
    ? safeDescriptorValue(sdkClient, "models")
    : null;
  const generate = safeDescriptorValue(models, "generateContent");
  if (typeof generate !== "function") return null;
  return {
    async generateContent(neutralRequest) {
      const googleRequest = buildGoogleGenerateContentRequest(neutralRequest);
      if (!googleRequest) throw canonicalError("BAD_RESPONSE");
      try {
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
