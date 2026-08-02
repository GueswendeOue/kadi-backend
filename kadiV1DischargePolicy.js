"use strict";

const DISCHARGE_CONTENT_TYPES = Object.freeze(["MONEY", "GOODS", "DOCUMENT", "OTHER"]);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function ok(value) {
  return { ok: true, value };
}

function fail(error) {
  return { ok: false, error };
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownDataRecord(value) {
  if (!isPlainRecord(value)) return null;
  try {
    const result = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!Object.hasOwn(descriptor, "value") || ["__proto__", "prototype", "constructor"].includes(key)) {
        return null;
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function cleanText(value, { required = false, maximum = 500 } = {}) {
  if (value == null || value === "") return required ? fail("TEXT_REQUIRED") : ok(null);
  if (typeof value !== "string") return fail("TEXT_INVALID");
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  if (!cleaned) return required ? fail("TEXT_REQUIRED") : ok(null);
  return cleaned.length <= maximum ? ok(cleaned) : fail("TEXT_TOO_LONG");
}

function normalizeParty(value) {
  const party = cleanText(value, { required: true, maximum: 200 });
  return party.ok ? party : fail("DISCHARGE_PARTY_INVALID");
}

function normalizeReason(value) {
  const reason = cleanText(value, { required: true, maximum: 500 });
  return reason.ok ? reason : fail("DISCHARGE_REASON_INVALID");
}

function normalizeOptions(value) {
  const options = ownDataRecord(value);
  if (!options) return fail("DISCHARGE_OPTIONS_INVALID");
  if (Object.keys(options).some((key) => key !== "observations")) {
    return fail("DISCHARGE_OPTIONS_INVALID");
  }
  const observations = cleanText(options.observations, { maximum: 1000 });
  return observations.ok ? ok(Object.freeze({ observations: observations.value })) : fail("DISCHARGE_OBSERVATIONS_INVALID");
}

function normalizeTransferredContent(value) {
  const content = ownDataRecord(value);
  if (!content) return fail("DISCHARGE_CONTENT_INVALID");
  const allowed = new Set(["type", "amount", "currency", "description", "quantity"]);
  if (Object.keys(content).some((key) => !allowed.has(key))) return fail("DISCHARGE_CONTENT_FIELD_UNKNOWN");
  if (!DISCHARGE_CONTENT_TYPES.includes(content.type)) return fail("DISCHARGE_CONTENT_TYPE_INVALID");

  const description = cleanText(content.description, {
    required: content.type !== "MONEY",
    maximum: 500,
  });
  if (!description.ok) return fail("DISCHARGE_CONTENT_DESCRIPTION_INVALID");
  if (content.quantity != null && (!Number.isSafeInteger(content.quantity) || content.quantity <= 0)) {
    return fail("DISCHARGE_QUANTITY_INVALID");
  }

  if (content.type === "MONEY") {
    if (!Number.isSafeInteger(content.amount) || content.amount <= 0) return fail("DISCHARGE_AMOUNT_INVALID");
    if (typeof content.currency !== "string" || !CURRENCY_PATTERN.test(content.currency)) {
      return fail("DISCHARGE_CURRENCY_REQUIRED");
    }
    if (content.quantity != null) return fail("DISCHARGE_MONEY_QUANTITY_FORBIDDEN");
  } else if (content.amount != null) {
    return fail("DISCHARGE_NON_MONEY_AMOUNT_FORBIDDEN");
  }

  return ok(Object.freeze({
    type: content.type,
    amount: content.type === "MONEY" ? content.amount : null,
    currency: content.type === "MONEY" ? content.currency : null,
    description: description.value,
    quantity: content.quantity ?? null,
  }));
}

function getMissingFields(document) {
  const missing = [];
  const discharge = document?.discharge || {};
  if (!discharge.giver) missing.push("giver");
  if (!discharge.receiver) missing.push("recipient");
  if (!discharge.subject?.type) {
    missing.push("transferred_content_type");
  } else if (!DISCHARGE_CONTENT_TYPES.includes(discharge.subject.type)) {
    missing.push("transferred_content_type");
  } else if (discharge.subject.type === "MONEY") {
    if (!Number.isSafeInteger(discharge.subject.amount) || discharge.subject.amount <= 0) missing.push("amount");
    if (typeof document.currency !== "string" || !CURRENCY_PATTERN.test(document.currency)) missing.push("currency");
  } else if (!discharge.subject.description) {
    missing.push("description");
  }
  if (!discharge.reason) missing.push("reason");
  return [...new Set(missing)];
}

function validateForReview(document) {
  const missing = getMissingFields(document);
  if (missing.length > 0) return fail("DISCHARGE_INFORMATION_MISSING");
  if (document.discharge.giver.trim().toLocaleLowerCase("fr") === document.discharge.receiver.trim().toLocaleLowerCase("fr")) {
    return fail("DISCHARGE_PARTIES_MUST_DIFFER");
  }
  const normalized = normalizeTransferredContent({
    type: document.discharge.subject.type,
    amount: document.discharge.subject.amount,
    currency: document.currency,
    description: document.discharge.subject.description,
    quantity: document.discharge.quantity,
  });
  return normalized.ok ? ok(document) : normalized;
}

module.exports = {
  DISCHARGE_CONTENT_TYPES,
  getMissingFields,
  normalizeOptions,
  normalizeParty,
  normalizeReason,
  normalizeTransferredContent,
  validateForReview,
};
