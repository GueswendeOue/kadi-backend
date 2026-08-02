"use strict";

const PAYMENT_STATUSES = Object.freeze(["PENDING", "CONFIRMED", "FAILED", "CANCELLED", "EXPIRED"]);
const METHODS = Object.freeze(["createPaymentRequest", "verifyPaymentEvent", "getPaymentStatus"]);
const ID_PATTERN = /^[A-Za-z0-9:_.-]{1,200}$/;
const SENSITIVE_METADATA_KEY = /(?:authorization|token|secret|signature|phone|account|payload)/i;

function ownData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!Object.hasOwn(descriptor, "value") || ["__proto__", "prototype", "constructor"].includes(key)) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function assertPaymentProvider(provider) {
  if (!provider || typeof provider !== "object") throw new TypeError("PAYMENT_PROVIDER_REQUIRED");
  for (const method of METHODS) {
    if (typeof provider[method] !== "function") throw new TypeError(`PAYMENT_PROVIDER_METHOD_REQUIRED:${method}`);
  }
  if (typeof provider.name !== "string" || !/^[A-Z][A-Z0-9_]{1,79}$/.test(provider.name)) {
    throw new TypeError("PAYMENT_PROVIDER_NAME_INVALID");
  }
  return provider;
}

function normalizePaymentResult(value, { eventRequired = false } = {}) {
  const input = ownData(value);
  if (!input) return { ok: false, error: "PAYMENT_RESULT_INVALID" };
  const requiredIds = ["provider", "provider_payment_id", "merchant_reference"];
  if (eventRequired) requiredIds.push("provider_event_id");
  if (requiredIds.some((field) => typeof input[field] !== "string" || !ID_PATTERN.test(input[field]))) {
    return { ok: false, error: "PAYMENT_RESULT_REFERENCE_INVALID" };
  }
  if (input.provider_event_id != null && (typeof input.provider_event_id !== "string" || !ID_PATTERN.test(input.provider_event_id))) {
    return { ok: false, error: "PAYMENT_RESULT_EVENT_ID_INVALID" };
  }
  if (!Number.isSafeInteger(input.amount) || input.amount < 1 || typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency)) {
    return { ok: false, error: "PAYMENT_RESULT_AMOUNT_INVALID" };
  }
  if (!PAYMENT_STATUSES.includes(input.status) || typeof input.verified !== "boolean") {
    return { ok: false, error: "PAYMENT_RESULT_STATUS_INVALID" };
  }
  if (!Number.isFinite(Date.parse(input.occurred_at))) return { ok: false, error: "PAYMENT_RESULT_TIME_INVALID" };
  const metadata = input.metadata == null ? {} : ownData(input.metadata);
  if (!metadata) return { ok: false, error: "PAYMENT_RESULT_METADATA_INVALID" };
  const safeMetadata = {};
  for (const [key, entry] of Object.entries(metadata)) {
    if (!/^[a-z][a-z0-9_]{0,49}$/.test(key) || SENSITIVE_METADATA_KEY.test(key) ||
        !["string", "number", "boolean"].includes(typeof entry) ||
        (typeof entry === "string" && (entry.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(entry)))) {
      return { ok: false, error: "PAYMENT_RESULT_METADATA_INVALID" };
    }
    safeMetadata[key] = entry;
  }
  return { ok: true, value: Object.freeze({
    provider: input.provider,
    provider_payment_id: input.provider_payment_id,
    provider_event_id: input.provider_event_id ?? null,
    merchant_reference: input.merchant_reference,
    amount: input.amount,
    currency: input.currency,
    status: input.status,
    verified: input.verified,
    occurred_at: new Date(input.occurred_at).toISOString(),
    metadata: safeMetadata,
  }) };
}

module.exports = { PAYMENT_STATUSES, assertPaymentProvider, normalizePaymentResult };
