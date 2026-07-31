"use strict";

const { createHash } = require("node:crypto");

const KADI_BRAIN_SHADOW_VERSION = "kadi.brain-real-shadow.v1";

const KADI_BRAIN_SHADOW_STATUSES = Object.freeze({
  SKIPPED: "SKIPPED",
  SKIPPED_DUPLICATE: "SKIPPED_DUPLICATE",
  INPUT_INVALID: "INPUT_INVALID",
  PRIVACY_BLOCKED: "PRIVACY_BLOCKED",
  CONFIG_UNAVAILABLE: "CONFIG_UNAVAILABLE",
  PROVIDER_FAILED: "PROVIDER_FAILED",
  PARSE_FAILED: "PARSE_FAILED",
  SUCCEEDED: "SUCCEEDED",
  INTERNAL_FAILED: "INTERNAL_FAILED",
  TIMEOUT: "TIMEOUT",
});

const KADI_BRAIN_CONFIDENCE_BUCKETS = Object.freeze({
  NONE: "NONE",
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
});

const KADI_BRAIN_LATENCY_BUCKETS = Object.freeze({
  NONE: "NONE",
  LT_250MS: "LT_250MS",
  LT_1S: "LT_1S",
  LT_3S: "LT_3S",
  GTE_3S: "GTE_3S",
});

const STATUS_VALUES = new Set(Object.values(KADI_BRAIN_SHADOW_STATUSES));
const SOURCE_TYPES = new Set(["text", "voice"]);
const PROVIDER_STATUSES = new Set([
  "PENDING", "SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "REJECTED",
]);
const FAILURE_KINDS = new Set([
  "NONE", "CLIENT", "PROVIDER", "NETWORK", "TIMEOUT", "RATE_LIMIT",
  "AUTHENTICATION", "SAFETY", "CONTENT", "CONFIGURATION", "INTERNAL",
]);
const PARSER_CODES = new Set([
  "EMPTY_RESPONSE", "RESPONSE_NOT_STRING", "RESPONSE_TOO_LONG",
  "MARKDOWN_NOT_ALLOWED", "SURROUNDING_TEXT_NOT_ALLOWED", "INVALID_JSON",
  "ROOT_NOT_OBJECT", "MULTIPLE_JSON_VALUES", "INVALID_SCHEMA",
  "INVALID_RESOLUTION", "UNSAFE_VALUE", "INTERNAL_PARSE_FAILURE",
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function confidenceBucket(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return KADI_BRAIN_CONFIDENCE_BUCKETS.NONE;
  }
  if (value < 0.5) return KADI_BRAIN_CONFIDENCE_BUCKETS.LOW;
  if (value < 0.75) return KADI_BRAIN_CONFIDENCE_BUCKETS.MEDIUM;
  return KADI_BRAIN_CONFIDENCE_BUCKETS.HIGH;
}

function latencyBucket(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return KADI_BRAIN_LATENCY_BUCKETS.NONE;
  }
  if (value < 250) return KADI_BRAIN_LATENCY_BUCKETS.LT_250MS;
  if (value < 1000) return KADI_BRAIN_LATENCY_BUCKETS.LT_1S;
  if (value < 3000) return KADI_BRAIN_LATENCY_BUCKETS.LT_3S;
  return KADI_BRAIN_LATENCY_BUCKETS.GTE_3S;
}

function hashMessageId(value, hashFunction) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const computed = typeof hashFunction === "function"
      ? hashFunction(value)
      : createHash("sha256").update(value, "utf8").digest("hex");
    if (typeof computed !== "string" || !/^[a-f0-9]{12,64}$/iu.test(computed)) {
      return null;
    }
    return computed.toLowerCase().slice(0, 16);
  } catch {
    return null;
  }
}

function nonNegativeCount(value) {
  return Number.isInteger(value) && value >= 0 ? Math.min(value, 100) : 0;
}

function createKadiBrainShadowResult(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const safety = isPlainObject(source.safetyFlags) ? source.safetyFlags : {};
  return {
    shadowVersion: KADI_BRAIN_SHADOW_VERSION,
    status: STATUS_VALUES.has(source.status)
      ? source.status
      : KADI_BRAIN_SHADOW_STATUSES.INTERNAL_FAILED,
    sourceType: SOURCE_TYPES.has(source.sourceType) ? source.sourceType : null,
    messageIdHash: hashMessageId(source.messageId, source.hashFunction),
    providerStatus: PROVIDER_STATUSES.has(source.providerStatus)
      ? source.providerStatus
      : null,
    providerFailureKind: FAILURE_KINDS.has(source.providerFailureKind)
      ? source.providerFailureKind
      : "NONE",
    parserValid: source.parserValid === true,
    parserFailureCode: PARSER_CODES.has(source.parserFailureCode)
      ? source.parserFailureCode
      : null,
    intent: typeof source.intent === "string" &&
      /^[A-Z][A-Z0-9_]{0,63}$/u.test(source.intent)
      ? source.intent
      : null,
    confidenceBucket: confidenceBucket(source.confidence),
    actionable: source.actionable === true,
    missingFieldCount: nonNegativeCount(source.missingFieldCount),
    blockingAmbiguityCount: nonNegativeCount(source.blockingAmbiguityCount),
    safetyFlags: {
      containsSensitiveData: safety.containsSensitiveData === true,
      requiresHumanReview: safety.requiresHumanReview === true,
    },
    latencyBucket: latencyBucket(source.latencyMs),
    execution: "NONE",
    timestamp: typeof source.timestamp === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(source.timestamp)
      ? source.timestamp
      : null,
  };
}

module.exports = {
  KADI_BRAIN_SHADOW_VERSION,
  KADI_BRAIN_SHADOW_STATUSES,
  KADI_BRAIN_CONFIDENCE_BUCKETS,
  KADI_BRAIN_LATENCY_BUCKETS,
  confidenceBucket,
  latencyBucket,
  hashMessageId,
  createKadiBrainShadowResult,
};
