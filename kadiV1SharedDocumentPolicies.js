"use strict";

const SHARED_DOCUMENT_TYPES = Object.freeze(["FACTURE", "DEVIS", "RECU"]);
const PAYMENT_OPTION_FIELDS = new Set(["payment_method", "reference"]);
// OPTIONS-001: the real kadi_document_options_v1.json / kadi_edit_options_v1.json
// Flows always submit validity_days/payment_method/reference alongside
// discount_amount/tax_rate_basis_points/notes/payment_terms (Meta submits
// every declared form field on every submission) — every real FACTURE/DEVIS
// SAVE_OPTIONS used to be rejected outright with DOCUMENT_OPTIONS_FIELD_UNKNOWN.
// payment_method/reference are accepted here only for that reason: the only
// legitimate meaning either field has anywhere in the domain model is
// receipt-specific (document.receipt.payment_method/.reference — see
// kadiV1PreviewService.js, normalizeReceiptContent below) — normalizeOptions
// still never persists them for FACTURE/DEVIS.
const COMMON_OPTION_FIELDS = new Set([
  "options",
  "discount_amount",
  "tax_rate_basis_points",
  "notes",
  "payment_terms",
  "validity_days",
  "payment_method",
  "reference",
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

// Meta's "number" input-type TextInput fields (discount_amount,
// validity_days) submit a JSON value that is blank ("") when the optional
// field is left empty — the same convention already established and
// handled for tax_rate_percent/tax_rate_basis_points
// (kadiV1FlowReplyRuntime.js's normalizePercentText/parseLegacyBasisPoints).
// Before OPTIONS-001's field-allowlist was widened, no real submission ever
// reached this far, so a blank discount_amount had never actually been
// exercised — it would have failed DOCUMENT_OPTIONS_AMOUNT_INVALID exactly
// like validity_days would have. Blank means "not provided", never zero.
function parseOptionalInteger(raw, { min = null, invalidError }) {
  if (raw === "" || raw == null) return ok(null);
  let num;
  if (Number.isSafeInteger(raw)) {
    num = raw;
  } else if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    num = Number(raw.trim());
  } else {
    return fail(invalidError);
  }
  if (!Number.isSafeInteger(num) || (min != null && num < min)) return fail(invalidError);
  return ok(num);
}

function normalizeOptions(documentType, value) {
  if (!isPlainRecord(value)) return fail("DOCUMENT_OPTIONS_INVALID");
  const allowed = documentType === "RECU" ? PAYMENT_OPTION_FIELDS : COMMON_OPTION_FIELDS;
  if (Object.keys(value).some((key) => !allowed.has(key))) return fail("DOCUMENT_OPTIONS_FIELD_UNKNOWN");
  if (documentType === "RECU") return ok({ receipt: { ...value } });
  const result = {};
  let nestedOptions = null;
  if (Object.hasOwn(value, "options")) {
    const options = clonePlain(value.options);
    if (!options.ok) return fail("DOCUMENT_OPTIONS_INVALID");
    nestedOptions = options.value;
    if (Object.hasOwn(nestedOptions, "validity_days") && (
      !Number.isSafeInteger(nestedOptions.validity_days) || nestedOptions.validity_days <= 0
    )) return fail("DOCUMENT_VALIDITY_INVALID");
    if (Object.hasOwn(nestedOptions, "expires_at") && !Number.isFinite(Date.parse(nestedOptions.expires_at))) {
      return fail("DOCUMENT_EXPIRATION_INVALID");
    }
    result.options = nestedOptions;
  }
  // validity_days: the real Flow always submits this as a flat top-level
  // field, never nested — the canonical persisted location, matching the
  // already-established invoice_kind/receipt_format convention, is
  // document.options.validity_days, so it is mapped there. If a caller
  // somehow supplies both the flat field and the nested form with
  // disagreeing values, fail explicitly rather than silently pick one
  // (same principle already applied to CLIENT-001's tax_id/ifu alias).
  if (Object.hasOwn(value, "validity_days")) {
    const parsed = parseOptionalInteger(value.validity_days, { min: 1, invalidError: "DOCUMENT_VALIDITY_INVALID" });
    if (!parsed.ok) return parsed;
    if (parsed.value != null) {
      const existing = nestedOptions?.validity_days;
      if (existing != null && existing !== parsed.value) return fail("DOCUMENT_VALIDITY_CONFLICT");
      result.options = { ...(result.options || {}), validity_days: parsed.value };
    }
  }
  if (Object.hasOwn(value, "discount_amount")) {
    const parsed = parseOptionalInteger(value.discount_amount, { min: 0, invalidError: "DOCUMENT_OPTIONS_AMOUNT_INVALID" });
    if (!parsed.ok) return parsed;
    if (parsed.value != null) result.discount_amount = parsed.value;
  }
  if (Object.hasOwn(value, "tax_rate_basis_points")) {
    // Already normalized to a genuine, bounded integer (or omitted
    // entirely) upstream by kadiV1FlowReplyRuntime.js's
    // normalizeTaxRateFields — validated the same way as before.
    if (!Number.isSafeInteger(value.tax_rate_basis_points) || value.tax_rate_basis_points < 0) {
      return fail("DOCUMENT_OPTIONS_AMOUNT_INVALID");
    }
    if (value.tax_rate_basis_points > 10000) return fail("DOCUMENT_OPTIONS_AMOUNT_INVALID");
    result.tax_rate_basis_points = value.tax_rate_basis_points;
  }
  // payment_method/reference: accepted by the allowlist above only because
  // the real combined options Flow always submits them — deliberately never
  // persisted here. FACTURE/DEVIS have no invoice-level concept for either
  // field today (the only existing meaning anywhere in the domain is
  // receipt-specific). Silently dropped by design, not a bug — see
  // docs/KADI_ENGINEERING_MEMORY.md.
  for (const field of ["notes", "payment_terms"]) {
    if (Object.hasOwn(value, field)) result[field] = value[field];
  }
  // A real Flow submission with every optional field left blank (the most
  // common real case — a user who has nothing to change) now legitimately
  // normalizes down to an empty patch: payment_method/reference are always
  // dropped, and every numeric/text field above is skipped when blank. This
  // must succeed as a harmless no-op, never an error — the adapter layer
  // (kadiV1RuntimeAdapters.js's setOptions) already short-circuits before
  // ever reaching this function when the raw submitted object itself has
  // zero keys; DOCUMENT_OPTIONS_EMPTY served no caller and is removed.
  return ok(result);
}

module.exports = {
  SHARED_DOCUMENT_TYPES,
  createSharedDocumentPolicies,
  normalizeClient,
  normalizeLineInput,
  normalizeOptions,
  normalizeReceiptContent,
};
