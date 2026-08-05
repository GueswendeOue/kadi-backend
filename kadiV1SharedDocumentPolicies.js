"use strict";

const SHARED_DOCUMENT_TYPES = Object.freeze(["FACTURE", "DEVIS", "RECU"]);
const PAYMENT_OPTION_FIELDS = new Set(["payment_method", "reference"]);
const COMMON_OPTION_FIELDS = new Set([
  "options",
  "discount_amount",
  "tax_rate_basis_points",
  "notes",
  "payment_terms",
]);
const CLIENT_FIELDS = new Set(["name", "phone", "address", "email", "ifu", "rccm"]);
const VALID_RECEIPT_FORMATS = new Set(["A4", "TICKET_80"]);

function ok(value) {
  return { ok: true, value };
}

function fail(error) {
  return { ok: false, error };
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanText(value, { required = false, maximum = 500 } = {}) {
  if (value == null || value === "") return required ? fail("TEXT_REQUIRED") : ok(null);
  if (typeof value !== "string") return fail("TEXT_INVALID");
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  if (!cleaned) return required ? fail("TEXT_REQUIRED") : ok(null);
  return cleaned.length <= maximum ? ok(cleaned) : fail("TEXT_TOO_LONG");
}

function clonePlain(value) {
  if (!isPlainRecord(value)) return fail("STRUCTURED_VALUE_INVALID");
  try {
    return ok(structuredClone(value));
  } catch {
    return fail("STRUCTURED_VALUE_INVALID");
  }
}

function normalizeLineInput(value, { partial = false } = {}) {
  if (!isPlainRecord(value)) return fail("DOCUMENT_CONTENT_INVALID");
  const allowed = new Set(["description", "quantity", "unit", "unit_price"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return fail("DOCUMENT_CONTENT_FIELD_UNKNOWN");
  const normalized = {};
  if (!partial || Object.hasOwn(value, "description")) {
    const description = cleanText(value.description, { required: true, maximum: 300 });
    if (!description.ok) return fail("DOCUMENT_ITEM_DESCRIPTION_INVALID");
    normalized.description = description.value;
  }
  if (!partial || Object.hasOwn(value, "quantity")) {
    if (!Number.isSafeInteger(value.quantity) || value.quantity <= 0) return fail("DOCUMENT_ITEM_QUANTITY_INVALID");
    normalized.quantity_millis = value.quantity * 1000;
  }
  if (!partial || Object.hasOwn(value, "unit_price")) {
    if (!Number.isSafeInteger(value.unit_price) || value.unit_price < 0) return fail("DOCUMENT_ITEM_PRICE_INVALID");
    normalized.unit_price = value.unit_price;
  }
  if (!partial || Object.hasOwn(value, "unit")) {
    const unit = cleanText(value.unit, { maximum: 50 });
    if (!unit.ok) return fail("DOCUMENT_ITEM_UNIT_INVALID");
    normalized.unit = unit.value;
  }
  return Object.keys(normalized).length > 0 ? ok(normalized) : fail("DOCUMENT_CONTENT_EMPTY");
}

function normalizeReceiptContent(value, { partial = false } = {}) {
  if (!isPlainRecord(value)) return fail("DOCUMENT_CONTENT_INVALID");
  const allowed = new Set(["payer", "beneficiary", "amount", "reason", "payment_method", "reference"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return fail("DOCUMENT_CONTENT_FIELD_UNKNOWN");
  const normalized = {};
  for (const field of ["payer", "beneficiary", "reason", "payment_method", "reference"]) {
    if (!partial || Object.hasOwn(value, field)) {
      const required = !partial && ["payer", "beneficiary", "reason"].includes(field);
      const text = cleanText(value[field], { required, maximum: field === "reason" ? 500 : 200 });
      if (!text.ok) return fail(`DOCUMENT_RECEIPT_${field.toUpperCase()}_INVALID`);
      normalized[field] = text.value;
    }
  }
  if (!partial || Object.hasOwn(value, "amount")) {
    if (!Number.isSafeInteger(value.amount) || value.amount <= 0) return fail("DOCUMENT_RECEIPT_AMOUNT_INVALID");
    normalized.amount = value.amount;
  }
  return Object.keys(normalized).length > 0 ? ok(normalized) : fail("DOCUMENT_CONTENT_EMPTY");
}

function commonMissing(document) {
  const missing = [];
  if (typeof document.issuer_profile_id !== "string" || !document.issuer_profile_id) missing.push("issuer");
  if (!isPlainRecord(document.client) || !cleanText(document.client.name, { required: true, maximum: 200 }).ok) {
    missing.push("client");
  }
  if (
    !Array.isArray(document.items) ||
    document.items.length === 0 ||
    document.items.some((item) => (
      !Number.isSafeInteger(item.quantity_millis) ||
      item.quantity_millis <= 0 ||
      item.quantity_millis % 1000 !== 0 ||
      !Number.isSafeInteger(item.unit_price) ||
      item.unit_price < 0
    ))
  ) missing.push("items");
  return missing;
}

function receiptMissing(document) {
  const missing = [];
  if (typeof document.issuer_profile_id !== "string" || !document.issuer_profile_id) missing.push("issuer");
  if (!document.receipt?.payer) missing.push("payer");
  if (!document.receipt?.beneficiary) missing.push("beneficiary");
  if (!Number.isSafeInteger(document.receipt?.amount) || document.receipt.amount <= 0) missing.push("amount");
  if (!document.receipt?.reason) missing.push("reason");
  if (!VALID_RECEIPT_FORMATS.has(document.options?.receipt_format)) missing.push("receipt_format");
  return missing;
}

function createSharedDocumentPolicies({ quoteValidityRequired = false } = {}) {
  if (typeof quoteValidityRequired !== "boolean") throw new TypeError("QUOTE_VALIDITY_POLICY_INVALID");
  const linePolicy = Object.freeze({
    normalizeContent: normalizeLineInput,
    getMissingFields: commonMissing,
    allowsPaymentRecognition: false,
  });
  const quotePolicy = Object.freeze({
    normalizeContent: normalizeLineInput,
    getMissingFields(document) {
      const missing = commonMissing(document);
      const hasValidity = Number.isSafeInteger(document.options?.validity_days) || typeof document.options?.expires_at === "string";
      if (quoteValidityRequired && !hasValidity) missing.push("validity");
      return missing;
    },
    allowsPaymentRecognition: false,
    quoteValidityRequired,
  });
  const receiptPolicy = Object.freeze({
    normalizeContent: normalizeReceiptContent,
    getMissingFields: receiptMissing,
    allowsPaymentRecognition: false,
  });
  return Object.freeze({ FACTURE: linePolicy, DEVIS: quotePolicy, RECU: receiptPolicy });
}

function normalizeClient(value) {
  const cloned = clonePlain(value);
  if (!cloned.ok) return fail("DOCUMENT_CLIENT_INVALID");
  if (Object.keys(cloned.value).some((key) => !CLIENT_FIELDS.has(key))) return fail("DOCUMENT_CLIENT_FIELD_UNKNOWN");
  const name = cleanText(cloned.value.name, { required: true, maximum: 200 });
  if (!name.ok) return fail("DOCUMENT_CLIENT_INVALID");
  return ok({ ...cloned.value, name: name.value });
}

function normalizeOptions(documentType, value) {
  if (!isPlainRecord(value)) return fail("DOCUMENT_OPTIONS_INVALID");
  const allowed = documentType === "RECU" ? PAYMENT_OPTION_FIELDS : COMMON_OPTION_FIELDS;
  if (Object.keys(value).some((key) => !allowed.has(key))) return fail("DOCUMENT_OPTIONS_FIELD_UNKNOWN");
  if (documentType === "RECU") return ok({ receipt: { ...value } });
  const result = {};
  if (Object.hasOwn(value, "options")) {
    const options = clonePlain(value.options);
    if (!options.ok) return fail("DOCUMENT_OPTIONS_INVALID");
    if (Object.hasOwn(options.value, "validity_days") && (
      !Number.isSafeInteger(options.value.validity_days) || options.value.validity_days <= 0
    )) return fail("DOCUMENT_VALIDITY_INVALID");
    if (Object.hasOwn(options.value, "expires_at") && !Number.isFinite(Date.parse(options.value.expires_at))) {
      return fail("DOCUMENT_EXPIRATION_INVALID");
    }
    result.options = options.value;
  }
  for (const field of ["discount_amount", "tax_rate_basis_points"]) {
    if (Object.hasOwn(value, field)) {
      if (!Number.isSafeInteger(value[field]) || value[field] < 0) return fail("DOCUMENT_OPTIONS_AMOUNT_INVALID");
      result[field] = value[field];
    }
  }
  for (const field of ["notes", "payment_terms"]) {
    if (Object.hasOwn(value, field)) result[field] = value[field];
  }
  return Object.keys(result).length > 0 ? ok(result) : fail("DOCUMENT_OPTIONS_EMPTY");
}

module.exports = {
  SHARED_DOCUMENT_TYPES,
  createSharedDocumentPolicies,
  normalizeClient,
  normalizeLineInput,
  normalizeOptions,
  normalizeReceiptContent,
};
