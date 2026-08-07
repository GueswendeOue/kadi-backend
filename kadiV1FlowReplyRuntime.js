"use strict";

const { FLOW_KEYS } = require("./kadiV1FlowRouter");
const { DISCHARGE_CONTENT_TYPES } = require("./kadiV1DischargePolicy");

const OWNER_PATTERN = /^\d{8,20}$/;
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9:_.-]{1,200}$/;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_DEPTH = 5;

const CONTENT_NUMERIC_ACTIONS = new Set(["ADD_CONTENT", "UPDATE_CONTENT"]);
const VALID_INVOICE_KINDS = new Set(["FINAL", "PROFORMA"]);
const VALID_RECEIPT_FORMATS = new Set(["A4", "TICKET_80"]);
const UNIT_CUSTOM_ACTIONS = new Set(["ADD_CONTENT", "UPDATE_CONTENT"]);

const FLOW_ACTIONS = Object.freeze({
  ONBOARDING: Object.freeze(["START"]),
  MENU: Object.freeze(["PREPARE_DOCUMENT", "HISTORY_SEARCH", "BALANCE", "HELP"]),
  DOCUMENT_TYPE: Object.freeze(["SELECT_DOCUMENT_TYPE"]),
  INVOICE_TYPE: Object.freeze(["SAVE_INVOICE_TYPE"]),
  RECEIPT_DETAILS: Object.freeze(["SAVE_RECEIPT_DETAILS"]),
  DOCUMENT_CLIENT: Object.freeze(["SAVE_CLIENT"]),
  DOCUMENT_CONTENT: Object.freeze(["START_ADD_CONTENT", "FINISH_CONTENT"]),
  ARTICLE_FORM: Object.freeze(["ADD_CONTENT"]),
  DOCUMENT_OPTIONS: Object.freeze(["SAVE_OPTIONS"]),
  DOCUMENT_REVIEW: Object.freeze(["VERIFY", "EDIT_CLIENT", "EDIT_CONTENT", "EDIT_OPTIONS", "CANCEL"]),
  EDIT_CLIENT: Object.freeze(["SAVE_CLIENT"]),
  EDIT_CONTENT: Object.freeze(["ADD_CONTENT", "UPDATE_CONTENT", "REMOVE_CONTENT", "FINISH_CONTENT"]),
  EDIT_OPTIONS: Object.freeze(["SAVE_OPTIONS"]),
  DOCUMENT_PREVIEW: Object.freeze(["PREPARE_PDF", "EDIT_CLIENT", "EDIT_CONTENT", "EDIT_OPTIONS", "SAVE_FOR_LATER", "CANCEL"]),
  GENERATION_CONFIRMATION: Object.freeze(["CONFIRM_GENERATION", "CANCEL"]),
  RECHARGE: Object.freeze(["SELECT_PACK", "CHECK_PAYMENT", "CANCEL"]),
  HISTORY_SEARCH: Object.freeze(["SEARCH", "OPEN_DOCUMENT"]),
  DISCHARGE_DETAILS: Object.freeze(["SAVE_DETAILS"]),
});

const ACTION_FIELDS = Object.freeze({
  START: Object.freeze(["owner_name", "business_name"]),
  START_ADD_CONTENT: Object.freeze([]),
  PREPARE_DOCUMENT: Object.freeze(["document_type"]),
  HISTORY_SEARCH: Object.freeze([]),
  BALANCE: Object.freeze([]),
  HELP: Object.freeze([]),
  SELECT_DOCUMENT_TYPE: Object.freeze(["document_type"]),
  SAVE_INVOICE_TYPE: Object.freeze(["invoice_kind"]),
  SAVE_RECEIPT_DETAILS: Object.freeze(["payer", "amount", "reason", "payment_method", "reference", "receipt_format"]),
  // "ifu" is accepted alongside "tax_id" only so a conflicting pair (both
  // present, both non-blank, disagreeing) can be detected and rejected by
  // normalizeClientTaxIdentifier() below — neither real client Flow
  // currently submits "ifu" itself (see CLIENT-001 in
  // docs/KADI_ENGINEERING_MEMORY.md).
  SAVE_CLIENT: Object.freeze(["name", "phone", "email", "address", "tax_id", "ifu"]),
  // kadi_edit_content_v1.json is a single combined form shared by all four
  // EDIT_CONTENT actions — its one Footer always submits item_id/
  // description/quantity/unit/unit_custom/unit_price together, regardless
  // of which action radio button was chosen (Meta submits every declared
  // form field on every submission). ARTICLE_FORM's own ADD_CONTENT never
  // submits item_id (a brand-new item has none yet) — accepted here only
  // so it can be safely stripped by normalizeAddContentItemId() below,
  // never persisted. REMOVE_CONTENT only ever reads item_id downstream
  // (kadiV1FlowCommandRuntime.js); the other fields it now accepts are
  // simply unused, exactly like SAVE_OPTIONS already always receives
  // fields the user didn't touch.
  ADD_CONTENT: Object.freeze(["item_id", "description", "quantity", "unit", "unit_custom", "unit_price"]),
  UPDATE_CONTENT: Object.freeze(["item_id", "description", "quantity", "unit", "unit_custom", "unit_price"]),
  REMOVE_CONTENT: Object.freeze(["item_id", "description", "quantity", "unit", "unit_custom", "unit_price"]),
  SAVE_OPTIONS: Object.freeze(["tax_rate_percent", "tax_rate_basis_points", "discount_amount", "notes", "payment_terms", "validity_days", "payment_method", "reference"]),
  VERIFY: Object.freeze([]),
  EDIT_CLIENT: Object.freeze([]),
  EDIT_CONTENT: Object.freeze([]),
  EDIT_OPTIONS: Object.freeze([]),
  CANCEL: Object.freeze([]),
  EDIT: Object.freeze(["section"]),
  PREPARE_PDF: Object.freeze([]),
  SAVE_FOR_LATER: Object.freeze([]),
  CONFIRM_GENERATION: Object.freeze(["quote_id"]),
  // RECHARGE-CONTRACT-001: kadi_recharge_v1.json is one combined form whose
  // single Footer always submits pack_id/payment_reference together,
  // regardless of which action radio button (SELECT_PACK/CHECK_PAYMENT/
  // CANCEL) was chosen (Meta submits every declared form field on every
  // submission). payment_reference is meaningless for SELECT_PACK;
  // pack_id is meaningless for CHECK_PAYMENT — both accepted here so
  // neither real submission is rejected outright. Both are already
  // correctly ignored downstream: kadiV1FlowCommandRuntime.js's
  // SELECT_PACK mapping reads only data.pack_id, its CHECK_PAYMENT mapping
  // reads only data.payment_reference, and its RECHARGE/CANCEL mapping
  // passes no data at all to the recharge runtime. SELECT_PACK/
  // CHECK_PAYMENT are declared only for RECHARGE in FLOW_ACTIONS, so
  // widening them globally here carries no cross-Flow risk — unlike
  // CANCEL (see FLOW_ACTION_FIELD_OVERRIDES below), which is shared with
  // DOCUMENT_REVIEW/DOCUMENT_PREVIEW/GENERATION_CONFIRMATION and must stay
  // untouched for those.
  SELECT_PACK: Object.freeze(["pack_id", "payment_reference"]),
  CHECK_PAYMENT: Object.freeze(["pack_id", "payment_reference"]),
  // HISTORY-CONTRACT-001: kadi_history_search_v1.json is one combined form
  // whose single Footer always submits query/document_type/date_from/
  // date_to/document_id together, regardless of which action radio button
  // (SEARCH/OPEN_DOCUMENT) was chosen (Meta submits every declared form
  // field on every submission) — the same class of defect already
  // confirmed for CLIENT-001/EDIT-CONTENT-001/OPTIONS-001. document_id is
  // meaningless for SEARCH; query/document_type/date_from/date_to are
  // meaningless for OPEN_DOCUMENT — both accepted here so neither real
  // submission is rejected outright, and dropped/ignored downstream
  // (kadiV1RuntimeAdapters.js's history adapter for SEARCH; only
  // data.document_id is ever read for OPEN_DOCUMENT in
  // kadiV1FlowCommandRuntime.js).
  SEARCH: Object.freeze(["query", "document_type", "date_from", "date_to", "document_id"]),
  OPEN_DOCUMENT: Object.freeze(["document_id", "query", "document_type", "date_from", "date_to"]),
  SAVE_DETAILS: Object.freeze(["giver", "recipient", "transferred_content_type", "amount", "description", "quantity", "reason", "observations"]),
  // FINISH_CONTENT is reachable from two shapes: DOCUMENT_CONTENT submits
  // no data at all, EDIT_CONTENT's combined form always submits all six
  // fields (see the ADD_CONTENT/REMOVE_CONTENT comment above). None of
  // them are read for FINISH_CONTENT downstream
  // (kadiV1FlowCommandRuntime.js's FINISH_CONTENT mapping passes only
  // documentBase, never data) — accepted here so neither origin's real
  // payload is rejected.
  FINISH_CONTENT: Object.freeze(["item_id", "description", "quantity", "unit", "unit_custom", "unit_price"]),
});

// RECHARGE-CONTRACT-001: CANCEL is a single action name shared globally by
// DOCUMENT_REVIEW/DOCUMENT_PREVIEW/GENERATION_CONFIRMATION/RECHARGE, and
// ACTION_FIELDS.CANCEL ([]) must stay correct for all of them — those
// other three Flows' real JSON contracts submit no data at all (or, for
// GENERATION_CONFIRMATION, a separate combined-form defect of its own,
// deliberately left untouched here — see docs/KADI_ENGINEERING_MEMORY.md,
// recorded for a later T4). Only the real RECHARGE Flow's single combined
// form also submits pack_id/payment_reference alongside CANCEL (Meta
// submits every declared field on every submission, regardless of which
// action was chosen). Blindly widening the global ACTION_FIELDS.CANCEL
// entry would let every other Flow's CANCEL silently start accepting
// recharge-only fields too — never validated as intentional, and
// reopening exactly the failure mode this whole defect class is about.
// This override is checked first and, when present for the given
// (flowKey, action) pair, replaces the global ACTION_FIELDS lookup
// entirely — every other Flow/action combination is completely
// unaffected. kadiV1FlowCommandRuntime.js's RECHARGE/CANCEL mapping
// already passes no data to the recharge runtime, so both fields are
// safely ignored downstream once accepted here.
const FLOW_ACTION_FIELD_OVERRIDES = Object.freeze({
  RECHARGE: Object.freeze({
    CANCEL: Object.freeze(["pack_id", "payment_reference"]),
  }),
});

const FORBIDDEN_AUTHORITY_FIELDS = new Set([
  "owner_wa_id", "ownerWaId", "document_version", "version", "status", "issued_at",
  "document_number", "subtotal", "total", "tax_amount", "page_count", "cost",
  "credits", "balance", "flow_id", "flow_token", "draft_id", "meta_flow_id",
]);

function ok(value, extra = {}) {
  return { ok: true, value, ...extra };
}

function parseContentInteger(raw, field) {
  let num;
  if (Number.isSafeInteger(raw)) {
    num = raw;
  } else if (typeof raw === "string" && /^\d+$/.test(raw)) {
    num = Number(raw);
    if (!Number.isSafeInteger(num)) {
      return fail(field === "quantity" ? "KADI_V1_FLOW_REPLY_QUANTITY_INVALID" : "KADI_V1_FLOW_REPLY_UNIT_PRICE_INVALID");
    }
  } else {
    return fail(field === "quantity" ? "KADI_V1_FLOW_REPLY_QUANTITY_INVALID" : "KADI_V1_FLOW_REPLY_UNIT_PRICE_INVALID");
  }
  if (field === "quantity" && num <= 0) return fail("KADI_V1_FLOW_REPLY_QUANTITY_INVALID");
  if (field === "unit_price" && num < 0) return fail("KADI_V1_FLOW_REPLY_UNIT_PRICE_INVALID");
  return ok(num);
}

function parsePositiveInteger(raw, errorCode) {
  let num;
  if (Number.isSafeInteger(raw)) {
    num = raw;
  } else if (typeof raw === "string" && /^\d+$/.test(raw)) {
    num = Number(raw);
    if (!Number.isSafeInteger(num)) return fail(errorCode);
  } else {
    return fail(errorCode);
  }
  if (num <= 0) return fail(errorCode);
  return ok(num);
}

function normalizeReceiptNumbers(action, data) {
  if (action !== "SAVE_RECEIPT_DETAILS") return ok(data);
  const normalized = { ...data };
  const result = parsePositiveInteger(data.amount, "KADI_V1_FLOW_REPLY_RECEIPT_AMOUNT_INVALID");
  if (!result.ok) return result;
  normalized.amount = result.value;
  return ok(normalized);
}

function normalizeDischargeNumbers(action, data) {
  if (action !== "SAVE_DETAILS") return ok(data);
  const normalized = { ...data };
  const isMoney = data.transferred_content_type === "MONEY";
  if (isMoney) {
    const result = parsePositiveInteger(data.amount, "KADI_V1_FLOW_REPLY_DISCHARGE_AMOUNT_INVALID");
    if (!result.ok) return result;
    normalized.amount = result.value;
    delete normalized.quantity;
  } else {
    delete normalized.amount;
    if (Object.hasOwn(data, "quantity") && data.quantity !== "" && data.quantity != null) {
      const result = parsePositiveInteger(data.quantity, "KADI_V1_FLOW_REPLY_DISCHARGE_QUANTITY_INVALID");
      if (!result.ok) return result;
      normalized.quantity = result.value;
    } else {
      delete normalized.quantity;
    }
  }
  return ok(normalized);
}

// kadi_edit_content_v1.json's single combined form always submits item_id
// alongside every action, including ADD_CONTENT — but a brand-new item has
// no id yet, and kadiV1SharedDocumentPolicies.js's normalizeLineInput has
// its own closed field allowlist that does not recognize item_id at all
// (it would fail DOCUMENT_CONTENT_FIELD_UNKNOWN downstream even though
// this function's own allowlist above now accepts the field). Stripped
// here, the same Flow/backend boundary used for every other field-name
// mismatch already handled in this file — never forwarded to the domain.
function normalizeAddContentItemId(action, data) {
  if (action !== "ADD_CONTENT" || !Object.hasOwn(data, "item_id")) return ok(data);
  const normalized = { ...data };
  delete normalized.item_id;
  return ok(normalized);
}

function resolveUnitCustom(action, data) {
  if (!UNIT_CUSTOM_ACTIONS.has(action)) return ok(data);
  const normalized = { ...data };
  delete normalized.unit_custom;
  if (data.unit !== "autre") return ok(normalized);
  const raw = data.unit_custom;
  if (typeof raw !== "string") return fail("KADI_V1_FLOW_REPLY_UNIT_CUSTOM_REQUIRED");
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (cleaned.length < 1 || cleaned.length > 50) return fail("KADI_V1_FLOW_REPLY_UNIT_CUSTOM_INVALID");
  normalized.unit = cleaned;
  return ok(normalized);
}

// CLIENT-001: both real client Flows (kadi_document_client_v1.json,
// kadi_edit_client_v1.json) submit a field named "tax_id", labelled
// "Identifiant fiscal" — the French term for exactly what IFU
// (Identifiant Financier Unique) means. The document domain's own
// CLIENT_FIELDS (kadiV1SharedDocumentPolicies.js) and the Brain contract
// (kadiV1BrainContracts.js) both only ever recognize "ifu" — "tax_id" is
// not a distinct, separately-persisted concept anywhere else in the
// codebase. tax_id is therefore a Flow-layer alias for ifu, normalized
// once here, at the same boundary as every other Flow/backend field-name
// mismatch already handled in this function — never persisted as a
// second, contradictory representation of the same identifier.
function normalizeClientTaxIdentifier(action, data) {
  if (action !== "SAVE_CLIENT") return ok(data);
  if (!Object.hasOwn(data, "tax_id")) return ok(data);
  const normalized = { ...data };
  const submittedTaxId = typeof normalized.tax_id === "string" ? normalized.tax_id.trim() : "";
  delete normalized.tax_id;
  if (!submittedTaxId) return ok(normalized);
  const existingIfu = typeof normalized.ifu === "string" ? normalized.ifu.trim() : "";
  if (existingIfu && existingIfu !== submittedTaxId) {
    return fail("KADI_V1_FLOW_REPLY_CLIENT_TAX_IDENTIFIER_CONFLICT");
  }
  normalized.ifu = submittedTaxId;
  return ok(normalized);
}

function normalizeContentNumbers(action, data) {
  if (!CONTENT_NUMERIC_ACTIONS.has(action)) return ok(data);
  const normalized = { ...data };
  for (const field of ["quantity", "unit_price"]) {
    if (!Object.hasOwn(data, field)) continue;
    const result = parseContentInteger(data[field], field);
    if (!result.ok) return result;
    normalized[field] = result.value;
  }
  return ok(normalized);
}

// Transition window: the currently-published Meta Flow still sends the
// legacy raw basis-points field (tax_rate_basis_points); a newly-published
// Flow sends the safer human percentage field (tax_rate_percent, e.g. "18"
// for 18%, or "18,5"/"18.5" for a decimal rate). Both are accepted so
// neither publish order (backend-first or Flow-first) breaks SAVE_OPTIONS —
// see docs/KADI_ENGINEERING_MEMORY.md fiche P. Never an FCFA tax amount
// (that stays server-computed downstream from the authoritative
// subtotal/total). Both normalize to the single canonical persisted
// representation, tax_rate_basis_points — nothing downstream of this
// validation needs to change, and only one representation is ever
// persisted.
function normalizePercentText(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return ok(String(raw));
  if (typeof raw !== "string") return fail("KADI_V1_FLOW_REPLY_TAX_RATE_INVALID");
  const trimmed = raw.trim();
  if (!trimmed) return ok("");
  if (/\s/.test(trimmed)) return fail("KADI_V1_FLOW_REPLY_TAX_RATE_INVALID");
  const commaCount = (trimmed.match(/,/g) || []).length;
  const dotCount = (trimmed.match(/\./g) || []).length;
  if (commaCount === 0) return ok(trimmed);
  // exactly one comma and no dot: French decimal entry, normalize to a dot
  if (commaCount === 1 && dotCount === 0) return ok(trimmed.replace(",", "."));
  return fail("KADI_V1_FLOW_REPLY_TAX_RATE_INVALID"); // mixed or multiple separators
}

function parseTaxPercentToBasisPoints(raw) {
  const normalizedText = normalizePercentText(raw);
  if (!normalizedText.ok) return normalizedText;
  const text = normalizedText.value;
  if (!text) return ok(null);
  // at most 2 decimal places — matches basis-point granularity (1 bp = 0.01%)
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return fail("KADI_V1_FLOW_REPLY_TAX_RATE_INVALID");
  const percent = Number(text);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return fail("KADI_V1_FLOW_REPLY_TAX_RATE_INVALID");
  return ok(Math.round(percent * 100));
}

function parseLegacyBasisPoints(raw) {
  if (raw === "" || raw == null) return ok(null);
  let num;
  if (Number.isSafeInteger(raw)) {
    num = raw;
  } else if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    num = Number(raw.trim());
    if (!Number.isSafeInteger(num)) return fail("KADI_V1_FLOW_REPLY_TAX_RATE_INVALID");
  } else {
    return fail("KADI_V1_FLOW_REPLY_TAX_RATE_INVALID");
  }
  if (num <= 0 || num > 10000) return fail("KADI_V1_FLOW_REPLY_TAX_RATE_INVALID");
  return ok(num);
}

function normalizeTaxRateFields(action, data) {
  if (action !== "SAVE_OPTIONS") return ok(data);
  const hasPercent = Object.hasOwn(data, "tax_rate_percent");
  const hasBps = Object.hasOwn(data, "tax_rate_basis_points");
  if (!hasPercent && !hasBps) return ok(data);
  const normalized = { ...data };
  delete normalized.tax_rate_percent;
  delete normalized.tax_rate_basis_points;

  const percentResult = hasPercent ? parseTaxPercentToBasisPoints(data.tax_rate_percent) : ok(null);
  if (!percentResult.ok) return percentResult;
  const legacyResult = hasBps ? parseLegacyBasisPoints(data.tax_rate_basis_points) : ok(null);
  if (!legacyResult.ok) return legacyResult;

  const percentBps = percentResult.value;
  const legacyBps = legacyResult.value;

  if (percentBps == null && legacyBps == null) return ok(normalized); // both absent/blank: no tax
  if (percentBps != null && legacyBps != null) {
    if (percentBps !== legacyBps) return fail("KADI_V1_FLOW_REPLY_TAX_RATE_CONFLICT");
    normalized.tax_rate_basis_points = percentBps;
    return ok(normalized);
  }
  normalized.tax_rate_basis_points = percentBps != null ? percentBps : legacyBps;
  return ok(normalized);
}

function fail(error) {
  return { ok: false, error };
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function assertPort(target, methods, name) {
  if (!target || typeof target !== "object") throw new TypeError(`${name}_REQUIRED`);
  for (const method of methods) if (typeof target[method] !== "function") throw new TypeError(`${name}_METHOD_REQUIRED:${method}`);
  return target;
}

function inspectPayload(value, depth = 0) {
  if (depth > MAX_DEPTH) return fail("KADI_V1_FLOW_REPLY_PAYLOAD_TOO_DEEP");
  if (value == null || ["string", "number", "boolean"].includes(typeof value)) return ok(true);
  if (Array.isArray(value)) {
    if (value.length > 50) return fail("KADI_V1_FLOW_REPLY_PAYLOAD_TOO_LARGE");
    for (const item of value) {
      const inspected = inspectPayload(item, depth + 1);
      if (!inspected.ok) return inspected;
    }
    return ok(true);
  }
  if (!isPlainObject(value)) return fail("KADI_V1_FLOW_REPLY_PAYLOAD_INVALID");
  const keys = Object.keys(value);
  if (keys.length > 30) return fail("KADI_V1_FLOW_REPLY_PAYLOAD_TOO_LARGE");
  for (const key of keys) {
    if (FORBIDDEN_AUTHORITY_FIELDS.has(key)) return fail("KADI_V1_FLOW_REPLY_AUTHORITY_FIELD_FORBIDDEN");
    const inspected = inspectPayload(value[key], depth + 1);
    if (!inspected.ok) return inspected;
  }
  return ok(true);
}

function validateActionPayload(flowKey, action, data) {
  if (!FLOW_KEYS.includes(flowKey)) return fail("KADI_V1_FLOW_REPLY_KEY_INVALID");
  if (typeof action !== "string" || !FLOW_ACTIONS[flowKey]?.includes(action)) {
    return fail("KADI_V1_FLOW_REPLY_ACTION_FORBIDDEN");
  }
  if (!isPlainObject(data)) return fail("KADI_V1_FLOW_REPLY_PAYLOAD_INVALID");
  let encoded;
  try { encoded = Buffer.byteLength(JSON.stringify(data), "utf8"); } catch { return fail("KADI_V1_FLOW_REPLY_PAYLOAD_INVALID"); }
  if (encoded > MAX_PAYLOAD_BYTES) return fail("KADI_V1_FLOW_REPLY_PAYLOAD_TOO_LARGE");
  const inspected = inspectPayload(data);
  if (!inspected.ok) return inspected;
  const allowed = new Set(FLOW_ACTION_FIELD_OVERRIDES[flowKey]?.[action] || ACTION_FIELDS[action] || []);
  if (Object.keys(data).some((key) => !allowed.has(key))) return fail("KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN");
  if (action === "START") {
    if (typeof data.owner_name !== "string") return fail("KADI_V1_FLOW_REPLY_OWNER_NAME_REQUIRED");
    if (data.owner_name.trim().replace(/\s+/g, " ").length < 2) return fail("KADI_V1_FLOW_REPLY_OWNER_NAME_REQUIRED");
  }
  if (action === "SAVE_INVOICE_TYPE") {
    if (typeof data.invoice_kind !== "string" || !VALID_INVOICE_KINDS.has(data.invoice_kind)) {
      return fail("KADI_V1_FLOW_REPLY_INVOICE_KIND_INVALID");
    }
  }
  if (action === "ADD_CONTENT") {
    if (typeof data.description !== "string" || !data.description.trim()) return fail("KADI_V1_FLOW_REPLY_DESCRIPTION_REQUIRED");
    if (!Object.hasOwn(data, "quantity")) return fail("KADI_V1_FLOW_REPLY_QUANTITY_INVALID");
    if (!Object.hasOwn(data, "unit_price")) return fail("KADI_V1_FLOW_REPLY_UNIT_PRICE_INVALID");
  }
  if (action === "SAVE_RECEIPT_DETAILS") {
    if (typeof data.payer !== "string" || !data.payer.trim()) return fail("KADI_V1_FLOW_REPLY_RECEIPT_PAYER_REQUIRED");
    if (typeof data.reason !== "string" || !data.reason.trim()) return fail("KADI_V1_FLOW_REPLY_RECEIPT_REASON_REQUIRED");
    if (!Object.hasOwn(data, "amount")) return fail("KADI_V1_FLOW_REPLY_RECEIPT_AMOUNT_INVALID");
    if (typeof data.receipt_format !== "string" || !VALID_RECEIPT_FORMATS.has(data.receipt_format)) {
      return fail("KADI_V1_FLOW_REPLY_RECEIPT_FORMAT_INVALID");
    }
  }
  if (action === "SAVE_DETAILS") {
    if (typeof data.giver !== "string" || !data.giver.trim()) return fail("KADI_V1_FLOW_REPLY_DISCHARGE_GIVER_REQUIRED");
    if (typeof data.recipient !== "string" || !data.recipient.trim()) return fail("KADI_V1_FLOW_REPLY_DISCHARGE_RECIPIENT_REQUIRED");
    if (typeof data.reason !== "string" || !data.reason.trim()) return fail("KADI_V1_FLOW_REPLY_DISCHARGE_REASON_REQUIRED");
    if (typeof data.transferred_content_type !== "string" || !DISCHARGE_CONTENT_TYPES.includes(data.transferred_content_type)) {
      return fail("KADI_V1_FLOW_REPLY_DISCHARGE_TYPE_INVALID");
    }
    if (data.transferred_content_type === "MONEY") {
      if (!Object.hasOwn(data, "amount")) return fail("KADI_V1_FLOW_REPLY_DISCHARGE_AMOUNT_INVALID");
    } else {
      if (typeof data.description !== "string" || !data.description.trim()) return fail("KADI_V1_FLOW_REPLY_DISCHARGE_DESCRIPTION_REQUIRED");
      if (Object.hasOwn(data, "amount") && data.amount !== "" && data.amount != null) {
        return fail("KADI_V1_FLOW_REPLY_DISCHARGE_AMOUNT_UNEXPECTED");
      }
    }
  }
  const contentNormalized = normalizeContentNumbers(action, data);
  if (!contentNormalized.ok) return contentNormalized;
  const receiptNormalized = normalizeReceiptNumbers(action, contentNormalized.value);
  if (!receiptNormalized.ok) return receiptNormalized;
  const dischargeNormalized = normalizeDischargeNumbers(action, receiptNormalized.value);
  if (!dischargeNormalized.ok) return dischargeNormalized;
  const taxRateNormalized = normalizeTaxRateFields(action, dischargeNormalized.value);
  if (!taxRateNormalized.ok) return taxRateNormalized;
  const unitResolved = resolveUnitCustom(action, taxRateNormalized.value);
  if (!unitResolved.ok) return unitResolved;
  const addContentItemIdResolved = normalizeAddContentItemId(action, unitResolved.value);
  if (!addContentItemIdResolved.ok) return addContentItemIdResolved;
  const clientTaxIdentifierNormalized = normalizeClientTaxIdentifier(action, addContentItemIdResolved.value);
  if (!clientTaxIdentifierNormalized.ok) return clientTaxIdentifierNormalized;
  return ok(Object.freeze(structuredClone(clientTaxIdentifierNormalized.value)));
}

function validateReplyEnvelope(input) {
  if (!isPlainObject(input)) return fail("KADI_V1_FLOW_REPLY_INVALID");
  if (!OWNER_PATTERN.test(input.ownerWaId || "")) return fail("KADI_V1_FLOW_REPLY_OWNER_INVALID");
  if (!ID_PATTERN.test(input.sessionId || "")) return fail("KADI_V1_FLOW_REPLY_SESSION_INVALID");
  if (!FLOW_KEYS.includes(input.flowKey)) return fail("KADI_V1_FLOW_REPLY_KEY_INVALID");
  if (!IDEMPOTENCY_PATTERN.test(input.idempotencyKey || "")) return fail("KADI_V1_FLOW_REPLY_IDEMPOTENCY_INVALID");
  return validateActionPayload(input.flowKey, input.action, input.data || {});
}

function createKadiV1FlowReplyRuntime({ sessionService, commandRuntime } = {}) {
  const sessions = assertPort(sessionService, ["consumeReply"], "KADI_V1_SESSION_SERVICE");
  const commands = assertPort(commandRuntime, ["execute"], "KADI_V1_FLOW_COMMAND_RUNTIME");

  async function handle(input) {
    const checked = validateReplyEnvelope(input);
    if (!checked.ok) return checked;

    const consumed = await sessions.consumeReply({
      ownerWaId: input.ownerWaId,
      sessionId: input.sessionId,
      flowKey: input.flowKey,
      idempotencyKey: input.idempotencyKey,
    });
    if (!consumed?.ok) return consumed || fail("KADI_V1_FLOW_REPLY_SESSION_FAILED");

    const session = consumed.value;

    // RECHARGE-CONTRACT-001 (R2 independent review, HIGH/P0): an exact
    // duplicate reply must execute zero second business mutation.
    // sessionOpenedAt (R1) prevents a stale/replayed CANCEL from ever
    // affecting a recharge session created after this Flow was opened,
    // but does not by itself make cancel() idempotent when MULTIPLE
    // eligible active sessions already existed before the Flow was
    // opened: cancel() always re-resolves "the newest remaining eligible
    // session", so a replay after the first cancel already removed one
    // session from that set would find and cancel a second, different one.
    // consumed.duplicate === true here is the same authoritative,
    // persisted signal (kadiV1ConversationSession.js's CONSUMED status +
    // matching consumed_reply_key, safe across process restarts — never
    // an in-memory flag) the presenter already relies on to suppress the
    // user-visible reply; RECHARGE/CANCEL is the one action with no
    // command-level idempotency key of its own, so it is the one place
    // that signal must also prevent re-execution here. Scoped narrowly to
    // (RECHARGE, CANCEL) only — every other Flow/action's existing
    // duplicate-execution behavior (already covered by each command's own
    // idempotency key, e.g. SELECT_PACK/CHECK_PAYMENT/document mutations)
    // is completely unchanged; generalizing this further would need its
    // own exhaustive proof across every existing Flow, which this
    // targeted fix does not attempt.
    if (consumed.duplicate === true && input.flowKey === "RECHARGE" && input.action === "CANCEL") {
      return ok(Object.freeze({
        handled: true,
        action: input.action,
        flow_key: input.flowKey,
        duplicate: true,
        result: null,
      }));
    }

    const executed = await commands.execute({
      ownerWaId: input.ownerWaId,
      flowKey: input.flowKey,
      action: input.action,
      data: checked.value,
      idempotencyKey: `flow_command:${input.idempotencyKey}`,
      documentContext: session.document_id ? Object.freeze({
        document_id: session.document_id,
        document_version: session.document_version,
        document_type: session.document_type,
        document_state: session.document_state,
        return_state: session.return_state,
      }) : null,
      // RECHARGE-CONTRACT-001 (R1 independent review, HIGH/P0): the
      // trusted server-side moment this session was opened — never a
      // client-supplied value. Used only by RECHARGE/CANCEL
      // (kadiV1FlowCommandRuntime.js) to bound which recharge session a
      // stale or replayed Flow submission is allowed to affect, since
      // Meta's RECHARGE form carries no session/recharge identifier of
      // its own. See kadiV1ProductionInfrastructure.js's cancel().
      sessionOpenedAt: session.opened_at,
    });
    if (!executed || typeof executed.ok !== "boolean") return fail("KADI_V1_FLOW_COMMAND_RESULT_INVALID");
    if (!executed.ok) return executed;

    return ok(Object.freeze({
      handled: true,
      action: input.action,
      // The screen the reply was actually submitted from, exactly as
      // verified against the session's own expected_flow_key by
      // sessions.consumeReply() above (kadiV1ConversationSession.js's
      // validateReply rejects any mismatch with KADI_V1_SESSION_UNEXPECTED_FLOW
      // before this point is ever reached) — never a client-supplied
      // "edit mode" flag. Lets the presenter distinguish the same action
      // name reached from an initial-creation screen versus a correction
      // screen (e.g. SAVE_CLIENT from DOCUMENT_CLIENT vs EDIT_CLIENT)
      // without trusting anything the payload itself claims.
      flow_key: input.flowKey,
      duplicate: consumed.duplicate === true || executed.duplicate === true,
      result: executed.value == null ? null : structuredClone(executed.value),
    }));
  }

  return Object.freeze({ handle });
}

module.exports = {
  ACTION_FIELDS,
  FLOW_ACTIONS,
  FORBIDDEN_AUTHORITY_FIELDS,
  createKadiV1FlowReplyRuntime,
  validateActionPayload,
  validateReplyEnvelope,
};
