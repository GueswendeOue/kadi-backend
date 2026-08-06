"use strict";

const {
  DOCUMENT_EVENTS,
  DOCUMENT_STATES,
  resolveTransition,
} = require("./kadiV1DocumentStateMachine");

const DOCUMENT_TYPES = Object.freeze(["FACTURE", "DEVIS", "RECU", "DECHARGE"]);
const COMMON_DOCUMENT_TYPES = Object.freeze(["FACTURE", "DEVIS", "RECU"]);
// FACTURE and DEVIS share an identical stored shape (client/items/options/
// discount/tax/notes — see normalizeCommonContent) and an identical
// normalizeContent policy (kadiV1SharedDocumentPolicies.js's linePolicy/
// quotePolicy both use normalizeLineInput) — that data compatibility is what
// makes converting between exactly these two types safe without inventing a
// migration/data-mapping policy. RECU and DECHARGE have an incompatible
// shape (receipt/discharge instead of client+items) and are deliberately
// excluded.
const TYPE_CONVERTIBLE_DOCUMENT_TYPES = Object.freeze(["FACTURE", "DEVIS"]);
const DISCHARGE_SUBJECT_TYPES = Object.freeze(["MONEY", "GOODS", "DOCUMENT", "OTHER"]);
const RECEIPT_FORMATS = Object.freeze(["A4", "TICKET_80"]);
const DOCUMENT_PURPOSES = Object.freeze({
  FACTURE: "PAYMENT_DUE",
  DEVIS: "COMMERCIAL_PROPOSAL",
  RECU: "PAYMENT_RECEIVED",
  DECHARGE: "HANDOVER_ACKNOWLEDGEMENT",
});
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const DOCUMENT_NUMBER_PREFIXES = Object.freeze({
  FACTURE: "FA", DEVIS: "DV", RECU: "RC", DECHARGE: "DC",
});

// Server-generated, deterministic from (document_type, document_id,
// issued_at) — no external sequence/counter table exists yet, so this
// avoids requiring a new migration while still being effectively unique:
// issued_at carries second-level precision and document_id is already
// globally unique per document.
function generateDocumentNumber(documentType, documentId, issuedAtIso) {
  const prefix = DOCUMENT_NUMBER_PREFIXES[documentType] || "DOC";
  const compact = issuedAtIso.replace(/[^0-9]/g, "").slice(0, 14);
  const idTail = String(documentId).replace(/[^A-Za-z0-9]/g, "").slice(-8).toUpperCase().padStart(8, "0");
  return `${prefix}-${compact}-${idTail}`;
}
const SERVER_MANAGED_FIELDS = new Set([
  "status",
  "version",
  "issued_at",
  "document_number",
  "preview",
  "generation_quote",
  "generation_cost",
  "generated_file",
  "events",
  "recoverable_failure",
  "cancelled_at",
  "stamp",
  "add_stamp",
  "used_stamp",
]);
const COMMON_INPUT_FIELDS = new Set([
  "document_id",
  "document_type",
  "issuer_profile_id",
  "currency",
  "client",
  "items",
  "options",
  "notes",
  "payment_terms",
  "discount_amount",
  "tax_rate_basis_points",
  "receipt",
]);
const DISCHARGE_INPUT_FIELDS = new Set([
  "document_id",
  "document_type",
  "issuer_profile_id",
  "currency",
  "discharge",
  "notes",
]);
const COMMON_PATCH_FIELDS = new Set([
  "issuer_profile_id",
  "currency",
  "client",
  "items",
  "options",
  "notes",
  "payment_terms",
  "discount_amount",
  "tax_rate_basis_points",
  "receipt",
]);
const DISCHARGE_PATCH_FIELDS = new Set([
  "issuer_profile_id",
  "currency",
  "discharge",
  "notes",
]);

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

function ownValues(value) {
  if (!isPlainRecord(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
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

function deepCopy(value, depth = 0) {
  if (depth > 12) throw new Error("DOCUMENT_VALUE_TOO_DEEP");
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map((entry) => deepCopy(entry, depth + 1));
  const record = ownValues(value);
  if (!record) throw new Error("DOCUMENT_VALUE_INVALID");
  const result = {};
  for (const [key, entry] of Object.entries(record)) result[key] = deepCopy(entry, depth + 1);
  return result;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

function cleanText(value, required = false, maximum = 500) {
  if (value == null || value === "") return required ? fail("TEXT_REQUIRED") : ok(null);
  if (typeof value !== "string") return fail("TEXT_INVALID");
  const cleaned = value.replace(CONTROL_CHARACTERS, "").trim();
  if (!cleaned) return required ? fail("TEXT_REQUIRED") : ok(null);
  if (cleaned.length > maximum) return fail("TEXT_TOO_LONG");
  return ok(cleaned);
}

function validIdentifier(value) {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function normalizeCurrency(value) {
  const currency = value == null ? "XOF" : value;
  return typeof currency === "string" && CURRENCY_PATTERN.test(currency)
    ? ok(currency)
    : fail("DOCUMENT_CURRENCY_INVALID");
}

function rejectUnexpectedFields(record, allowed) {
  for (const key of Object.keys(record)) {
    if (SERVER_MANAGED_FIELDS.has(key)) return fail("DOCUMENT_SERVER_FIELD_FORBIDDEN");
    if (!allowed.has(key)) return fail("DOCUMENT_FIELD_UNKNOWN");
  }
  return ok(record);
}

function roundPositiveRatio(numerator, denominator) {
  return (numerator + denominator / 2n) / denominator;
}

function safeInteger(bigint) {
  const value = Number(bigint);
  return Number.isSafeInteger(value) ? value : null;
}

function normalizeItems(value) {
  if (value == null) return ok([]);
  if (!Array.isArray(value)) return fail("DOCUMENT_ITEMS_INVALID");
  const items = [];
  for (const input of value) {
    const item = ownValues(input);
    if (!item) return fail("DOCUMENT_ITEM_INVALID");
    const allowed = new Set(["item_id", "description", "quantity_millis", "unit", "unit_price", "line_total"]);
    if (Object.keys(item).some((key) => !allowed.has(key))) return fail("DOCUMENT_ITEM_FIELD_UNKNOWN");
    if (!validIdentifier(item.item_id)) return fail("DOCUMENT_ITEM_ID_INVALID");
    const description = cleanText(item.description, true, 300);
    if (!description.ok) return fail("DOCUMENT_ITEM_DESCRIPTION_INVALID");
    if (!Number.isSafeInteger(item.quantity_millis) || item.quantity_millis <= 0) {
      return fail("DOCUMENT_ITEM_QUANTITY_INVALID");
    }
    if (!Number.isSafeInteger(item.unit_price) || item.unit_price < 0) {
      return fail("DOCUMENT_ITEM_PRICE_INVALID");
    }
    const unit = cleanText(item.unit, false, 50);
    if (!unit.ok) return fail("DOCUMENT_ITEM_UNIT_INVALID");
    items.push({
      item_id: item.item_id,
      description: description.value,
      quantity_millis: item.quantity_millis,
      unit: unit.value,
      unit_price: item.unit_price,
    });
  }
  return ok(items);
}

function calculateCommonTotals({ items, discount_amount: discount = 0, tax_rate_basis_points: taxRate = 0 }) {
  if (!Number.isSafeInteger(discount) || discount < 0) return fail("DOCUMENT_DISCOUNT_INVALID");
  if (!Number.isSafeInteger(taxRate) || taxRate < 0 || taxRate > 10000) {
    return fail("DOCUMENT_TAX_RATE_INVALID");
  }
  let subtotal = 0n;
  const calculatedItems = [];
  for (const item of items) {
    const lineTotal = roundPositiveRatio(
      BigInt(item.quantity_millis) * BigInt(item.unit_price),
      1000n
    );
    subtotal += lineTotal;
    const numericLineTotal = safeInteger(lineTotal);
    if (numericLineTotal == null) return fail("DOCUMENT_TOTAL_OVERFLOW");
    calculatedItems.push({ ...item, line_total: numericLineTotal });
  }
  const discountValue = BigInt(discount);
  if (discountValue > subtotal) return fail("DOCUMENT_DISCOUNT_EXCEEDS_SUBTOTAL");
  const taxableAmount = subtotal - discountValue;
  const taxes = roundPositiveRatio(taxableAmount * BigInt(taxRate), 10000n);
  const total = taxableAmount + taxes;
  const numericValues = [subtotal, taxes, total].map(safeInteger);
  if (numericValues.some((value) => value == null)) return fail("DOCUMENT_TOTAL_OVERFLOW");
  return ok({
    items: calculatedItems,
    subtotal: numericValues[0],
    taxes: numericValues[1],
    discount,
    total: numericValues[2],
  });
}

function normalizeReceipt(value) {
  if (value == null) return ok(null);
  const receipt = ownValues(value);
  if (!receipt) return fail("DOCUMENT_RECEIPT_INVALID");
  const allowed = new Set(["payer", "beneficiary", "amount", "reason", "payment_method", "reference"]);
  if (Object.keys(receipt).some((key) => !allowed.has(key))) return fail("DOCUMENT_RECEIPT_FIELD_UNKNOWN");
  for (const field of ["payer", "beneficiary", "reason", "payment_method", "reference"]) {
    const normalized = cleanText(receipt[field], false, field === "reason" ? 500 : 200);
    if (!normalized.ok) return fail("DOCUMENT_RECEIPT_TEXT_INVALID");
    receipt[field] = normalized.value;
  }
  if (receipt.amount != null && (!Number.isSafeInteger(receipt.amount) || receipt.amount <= 0)) {
    return fail("DOCUMENT_RECEIPT_AMOUNT_INVALID");
  }
  return ok({ ...receipt, amount: receipt.amount ?? null });
}

function normalizeDischarge(value) {
  if (value == null) return ok({ giver: null, receiver: null, subject: null, quantity: null, reason: null, observations: null });
  const discharge = ownValues(value);
  if (!discharge) return fail("DISCHARGE_INVALID");
  const allowed = new Set(["giver", "receiver", "subject", "quantity", "reason", "observations"]);
  if (Object.keys(discharge).some((key) => !allowed.has(key))) return fail("DISCHARGE_FIELD_UNKNOWN");
  const result = {};
  for (const [field, maximum] of [["giver", 200], ["receiver", 200], ["reason", 500], ["observations", 1000]]) {
    const normalized = cleanText(discharge[field], false, maximum);
    if (!normalized.ok) return fail(`DISCHARGE_${field.toUpperCase()}_INVALID`);
    result[field] = normalized.value;
  }
  if (discharge.quantity != null && (!Number.isSafeInteger(discharge.quantity) || discharge.quantity <= 0)) {
    return fail("DISCHARGE_QUANTITY_INVALID");
  }
  result.quantity = discharge.quantity ?? null;
  if (discharge.subject == null) {
    result.subject = null;
  } else {
    const subject = ownValues(discharge.subject);
    if (!subject || Object.keys(subject).some((key) => !["type", "description", "amount"].includes(key))) {
      return fail("DISCHARGE_SUBJECT_INVALID");
    }
    if (!DISCHARGE_SUBJECT_TYPES.includes(subject.type)) return fail("DISCHARGE_SUBJECT_TYPE_INVALID");
    const description = cleanText(subject.description, false, 500);
    if (!description.ok) return fail("DISCHARGE_SUBJECT_DESCRIPTION_INVALID");
    if (subject.amount != null && (!Number.isSafeInteger(subject.amount) || subject.amount <= 0)) {
      return fail("DISCHARGE_SUBJECT_AMOUNT_INVALID");
    }
    result.subject = {
      type: subject.type,
      description: description.value,
      amount: subject.amount ?? null,
    };
  }
  return ok(result);
}

function baseAggregate(input, now) {
  const currency = normalizeCurrency(input.currency);
  if (!currency.ok) return currency;
  if (!validIdentifier(input.document_id)) return fail("DOCUMENT_ID_INVALID");
  if (input.issuer_profile_id != null && !validIdentifier(input.issuer_profile_id)) {
    return fail("DOCUMENT_ISSUER_INVALID");
  }
  const timestamp = now();
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
    return fail("DOCUMENT_CLOCK_INVALID");
  }
  return ok({
    document_id: input.document_id,
    document_type: input.document_type,
    document_purpose: DOCUMENT_PURPOSES[input.document_type],
    status: "COLLECTING",
    version: 1,
    issuer_profile_id: input.issuer_profile_id ?? null,
    currency: currency.value,
    preview: null,
    generation_quote: null,
    generation_cost: null,
    generated_file: null,
    issued_at: null,
    document_number: null,
    recoverable_failure: null,
    cancelled_at: null,
    events: [{
      type: "DOCUMENT_CREATED",
      from_state: null,
      to_state: "COLLECTING",
      version: 1,
      occurred_at: new Date(timestamp).toISOString(),
    }],
  });
}

function normalizeCommonContent(input) {
  const items = normalizeItems(input.items);
  if (!items.ok) return items;
  const receipt = normalizeReceipt(input.receipt);
  if (!receipt.ok) return receipt;
  if (input.document_type === "RECU" && items.value.length > 0) {
    return fail("DOCUMENT_RECEIPT_ITEMS_FORBIDDEN");
  }
  if (
    input.document_type === "RECU" &&
    ((input.discount_amount ?? 0) !== 0 || (input.tax_rate_basis_points ?? 0) !== 0)
  ) {
    return fail("DOCUMENT_RECEIPT_CALCULATION_FIELDS_FORBIDDEN");
  }
  if (input.document_type !== "RECU" && input.receipt != null) {
    return fail("DOCUMENT_RECEIPT_DATA_FORBIDDEN");
  }
  const totals = input.document_type === "RECU"
    ? ok({ items: [], subtotal: receipt.value?.amount ?? 0, taxes: 0, discount: 0, total: receipt.value?.amount ?? 0 })
    : calculateCommonTotals({
      items: items.value,
      discount_amount: input.discount_amount ?? 0,
      tax_rate_basis_points: input.tax_rate_basis_points ?? 0,
    });
  if (!totals.ok) return totals;
  for (const field of ["notes", "payment_terms"]) {
    const value = cleanText(input[field], false, field === "notes" ? 1000 : 500);
    if (!value.ok) return fail(`DOCUMENT_${field.toUpperCase()}_INVALID`);
    input[field] = value.value;
  }
  let client = null;
  try {
    client = input.client == null ? null : deepCopy(input.client);
  } catch {
    return fail("DOCUMENT_CLIENT_INVALID");
  }
  let options = {};
  try {
    options = input.options == null ? {} : deepCopy(input.options);
  } catch {
    return fail("DOCUMENT_OPTIONS_INVALID");
  }
  return ok({
    aggregate_kind: "COMMON_DOCUMENT",
    client,
    items: totals.value.items,
    options,
    subtotal: totals.value.subtotal,
    taxes: totals.value.taxes,
    discount: totals.value.discount,
    discount_amount: totals.value.discount,
    tax_rate_basis_points: input.document_type === "RECU" ? 0 : (input.tax_rate_basis_points ?? 0),
    total: totals.value.total,
    notes: input.notes,
    payment_terms: input.payment_terms,
    receipt: receipt.value,
  });
}

function validateForReview(document) {
  if (document.document_type !== "DECHARGE" && !validIdentifier(document.issuer_profile_id)) {
    return fail("DOCUMENT_ISSUER_REQUIRED");
  }
  if (["FACTURE", "DEVIS"].includes(document.document_type)) {
    if (!isPlainRecord(document.client) || !cleanText(document.client.name, true, 200).ok) {
      return fail("DOCUMENT_CLIENT_REQUIRED");
    }
    if (!Array.isArray(document.items) || document.items.length < 1) return fail("DOCUMENT_ITEMS_REQUIRED");
  }
  if (document.document_type === "RECU") {
    const receipt = document.receipt;
    if (!receipt?.payer || !receipt?.beneficiary || !receipt?.reason || !Number.isSafeInteger(receipt?.amount) || receipt.amount <= 0) {
      return fail("DOCUMENT_RECEIPT_INCOMPLETE");
    }
    if (!RECEIPT_FORMATS.includes(document.options?.receipt_format)) {
      return fail("DOCUMENT_RECEIPT_FORMAT_REQUIRED");
    }
  }
  if (document.document_type === "DECHARGE") {
    const discharge = document.discharge;
    if (!discharge?.giver || !discharge?.receiver || !discharge?.subject || !discharge?.reason) {
      return fail("DISCHARGE_INCOMPLETE");
    }
    if (discharge.subject.type === "MONEY" && !Number.isSafeInteger(discharge.subject.amount)) {
      return fail("DISCHARGE_SUBJECT_AMOUNT_REQUIRED");
    }
    if (discharge.subject.type !== "MONEY" && !discharge.subject.description) {
      return fail("DISCHARGE_SUBJECT_DESCRIPTION_REQUIRED");
    }
  }
  return ok(document);
}

function restoreDocumentSnapshot(rawSnapshot) {
  const snapshot = ownValues(rawSnapshot);
  if (!snapshot) return fail("DOCUMENT_SNAPSHOT_INVALID");
  if (!DOCUMENT_TYPES.includes(snapshot.document_type)) return fail("DOCUMENT_TYPE_INVALID");
  if (!DOCUMENT_STATES.includes(snapshot.status)) return fail("DOCUMENT_STATE_INVALID");
  if (!validIdentifier(snapshot.document_id) || !Number.isSafeInteger(snapshot.version) || snapshot.version < 1) {
    return fail("DOCUMENT_SNAPSHOT_INVALID");
  }
  if (!Array.isArray(snapshot.events)) return fail("DOCUMENT_EVENTS_INVALID");
  try {
    return ok(deepFreeze(deepCopy(snapshot)));
  } catch {
    return fail("DOCUMENT_SNAPSHOT_INVALID");
  }
}

function createDocumentDomain({ clock = () => new Date().toISOString() } = {}) {
  if (typeof clock !== "function") throw new TypeError("DOCUMENT_CLOCK_REQUIRED");

  function now() {
    return clock();
  }

  function createDocument(rawInput) {
    const input = ownValues(rawInput);
    if (!input) return fail("DOCUMENT_INPUT_INVALID");
    if (!DOCUMENT_TYPES.includes(input.document_type)) return fail("DOCUMENT_TYPE_INVALID");
    const allowed = input.document_type === "DECHARGE" ? DISCHARGE_INPUT_FIELDS : COMMON_INPUT_FIELDS;
    const fields = rejectUnexpectedFields(input, allowed);
    if (!fields.ok) return fields;
    const base = baseAggregate(input, now);
    if (!base.ok) return base;
    if (input.document_type === "DECHARGE") {
      const discharge = normalizeDischarge(input.discharge);
      if (!discharge.ok) return discharge;
      const notes = cleanText(input.notes, false, 1000);
      if (!notes.ok) return fail("DOCUMENT_NOTES_INVALID");
      return ok(deepFreeze({
        ...base.value,
        aggregate_kind: "DISCHARGE_DOCUMENT",
        discharge: discharge.value,
        notes: notes.value,
        subtotal: null,
        taxes: null,
        discount: null,
        total: discharge.value.subject?.type === "MONEY" ? discharge.value.subject.amount : null,
      }));
    }
    const content = normalizeCommonContent(input);
    if (!content.ok) return content;
    return ok(deepFreeze({ ...base.value, ...content.value }));
  }

  function modifyDocument(document, rawPatch) {
    if (!isPlainRecord(document) || !DOCUMENT_TYPES.includes(document.document_type)) {
      return fail("DOCUMENT_INVALID");
    }
    const transition = resolveTransition(document.status, DOCUMENT_EVENTS.MODIFY, document.recoverable_failure);
    if (!transition.ok) return transition;
    const patch = ownValues(rawPatch);
    if (!patch || Object.keys(patch).length === 0) return fail("DOCUMENT_PATCH_INVALID");
    const allowed = document.document_type === "DECHARGE" ? DISCHARGE_PATCH_FIELDS : COMMON_PATCH_FIELDS;
    const fields = rejectUnexpectedFields(patch, allowed);
    if (!fields.ok) return fields;
    const merged = { ...deepCopy(document), ...deepCopy(patch), document_type: document.document_type, document_id: document.document_id };
    const baseChanges = {};
    if (patch.issuer_profile_id !== undefined) {
      if (!validIdentifier(patch.issuer_profile_id)) return fail("DOCUMENT_ISSUER_INVALID");
      baseChanges.issuer_profile_id = patch.issuer_profile_id;
    }
    if (patch.currency !== undefined) {
      const currency = normalizeCurrency(patch.currency);
      if (!currency.ok) return currency;
      baseChanges.currency = currency.value;
    }
    let content;
    if (document.document_type === "DECHARGE") {
      const discharge = normalizeDischarge(merged.discharge);
      if (!discharge.ok) return discharge;
      const notes = cleanText(merged.notes, false, 1000);
      if (!notes.ok) return fail("DOCUMENT_NOTES_INVALID");
      content = {
        discharge: discharge.value,
        notes: notes.value,
        total: discharge.value.subject?.type === "MONEY" ? discharge.value.subject.amount : null,
      };
    } else {
      const normalized = normalizeCommonContent(merged);
      if (!normalized.ok) return normalized;
      content = normalized.value;
    }
    const timestamp = now();
    if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) return fail("DOCUMENT_CLOCK_INVALID");
    const nextVersion = document.version + 1;
    return ok(deepFreeze({
      ...deepCopy(document),
      ...baseChanges,
      ...content,
      status: transition.value,
      version: nextVersion,
      preview: null,
      generation_quote: null,
      generation_cost: null,
      recoverable_failure: null,
      events: [...deepCopy(document.events), {
        type: DOCUMENT_EVENTS.MODIFY,
        from_state: document.status,
        to_state: transition.value,
        version: nextVersion,
        occurred_at: new Date(timestamp).toISOString(),
      }],
    }));
  }

  // Deliberately NOT implemented by extending modifyDocument's general
  // patch surface: modifyDocument hardcodes `document_type:
  // document.document_type` (line ~482) and COMMON_PATCH_FIELDS/
  // DISCHARGE_PATCH_FIELDS never include "document_type" — opening that up
  // to every existing modifyDocument caller (setClientOrPayer, addContent,
  // applyBrainExtraction, ...) would widen the risk surface for a change
  // only one, explicit, narrowly-scoped operation needs. This function
  // reuses the SAME editable-state gate as modifyDocument
  // (DOCUMENT_EVENTS.MODIFY -> EDITABLE_STATES, resetting to COLLECTING —
  // a type change invalidates any already-computed preview/cost exactly
  // like any other content correction does) without touching that shared
  // surface.
  function changeDocumentType(document, targetType) {
    if (!isPlainRecord(document) || !DOCUMENT_TYPES.includes(document.document_type)) {
      return fail("DOCUMENT_INVALID");
    }
    if (!TYPE_CONVERTIBLE_DOCUMENT_TYPES.includes(document.document_type)) {
      return fail("DOCUMENT_TYPE_CONVERSION_UNSUPPORTED");
    }
    if (!TYPE_CONVERTIBLE_DOCUMENT_TYPES.includes(targetType)) {
      return fail("DOCUMENT_TYPE_CONVERSION_TARGET_INVALID");
    }
    if (document.document_type === targetType) return fail("DOCUMENT_TYPE_CONVERSION_NOOP");
    const transition = resolveTransition(document.status, DOCUMENT_EVENTS.MODIFY, document.recoverable_failure);
    if (!transition.ok) return transition;
    const merged = { ...deepCopy(document), document_type: targetType };
    const normalized = normalizeCommonContent(merged);
    if (!normalized.ok) return normalized;
    const timestamp = now();
    if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) return fail("DOCUMENT_CLOCK_INVALID");
    const nextVersion = document.version + 1;
    return ok(deepFreeze({
      ...deepCopy(document),
      ...normalized.value,
      document_type: targetType,
      document_purpose: DOCUMENT_PURPOSES[targetType],
      status: transition.value,
      version: nextVersion,
      preview: null,
      generation_quote: null,
      generation_cost: null,
      recoverable_failure: null,
      events: [...deepCopy(document.events), {
        type: DOCUMENT_EVENTS.MODIFY,
        from_state: document.status,
        to_state: transition.value,
        version: nextVersion,
        occurred_at: new Date(timestamp).toISOString(),
      }],
    }));
  }

  function transitionDocument(document, event, payload = {}) {
    if (!isPlainRecord(document) || !DOCUMENT_TYPES.includes(document.document_type)) return fail("DOCUMENT_INVALID");
    if (event === DOCUMENT_EVENTS.MODIFY) return fail("DOCUMENT_USE_MODIFY_COMMAND");
    const payloadValues = ownValues(payload);
    if (!payloadValues) return fail("DOCUMENT_EVENT_PAYLOAD_INVALID");
    const transition = resolveTransition(document.status, event, document.recoverable_failure);
    if (!transition.ok) return transition;
    if (event === DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW) {
      const validation = validateForReview(document);
      if (!validation.ok) return validation;
    }
    const changes = {};
    if (event === DOCUMENT_EVENTS.PREPARE_PREVIEW) {
      if (!isPlainRecord(payloadValues.preview)) return fail("DOCUMENT_PREVIEW_REQUIRED");
      changes.preview = deepFreeze({ ...deepCopy(payloadValues.preview), document_version: document.version });
    }
    if (event === DOCUMENT_EVENTS.CALCULATE_COST) {
      const quote = ownValues(payloadValues.generation_quote);
      if (!quote || !validIdentifier(quote.quote_id) || quote.document_version !== document.version) {
        return fail("DOCUMENT_GENERATION_QUOTE_INVALID");
      }
      if (!Number.isSafeInteger(quote.page_count) || quote.page_count < 1 || !Number.isSafeInteger(quote.credit_cost) || quote.credit_cost < 0) {
        return fail("DOCUMENT_GENERATION_COST_INVALID");
      }
      changes.generation_quote = deepFreeze(deepCopy(quote));
      changes.generation_cost = quote.credit_cost;
    }
    if (event === DOCUMENT_EVENTS.RECORD_RECOVERABLE_FAILURE) {
      const code = cleanText(payloadValues.code, true, 100);
      if (!code.ok || !/^[A-Z0-9_:-]+$/.test(code.value)) return fail("DOCUMENT_FAILURE_CODE_INVALID");
      changes.recoverable_failure = {
        code: code.value,
        from_state: document.status,
        resume_state: document.status,
      };
    }
    if (event === DOCUMENT_EVENTS.RESUME) changes.recoverable_failure = null;
    const timestamp = now();
    if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) return fail("DOCUMENT_CLOCK_INVALID");
    if (event === DOCUMENT_EVENTS.START_GENERATION) {
      // issued_at/document_number are assigned here, not at MARK_GENERATED,
      // so that the renderer producing the delivered PDF (which runs between
      // these two events) can be fed the real finalized identity instead of
      // a stale pre-finalization placeholder. issued_at always comes from
      // this injected server clock, never from caller/payload input.
      //
      // This branch is itself idempotent: a document can reach
      // START_GENERATION more than once (a renderer failure sends it to
      // RECOVERABLE_FAILURE, RESUME brings it back here for a retry) and
      // must reuse the exact same identity every time, never mint a new
      // one — the "assign once" guarantee is enforced here, in the domain,
      // not only by the repository/SQL layers that also happen to enforce
      // it downstream.
      const hasIssuedAt = typeof document.issued_at === "string" && document.issued_at !== "";
      const hasDocumentNumber = typeof document.document_number === "string" && document.document_number !== "";
      if (hasIssuedAt !== hasDocumentNumber) {
        return fail("DOCUMENT_FINALIZATION_IDENTITY_CORRUPT");
      }
      if (!hasIssuedAt) {
        changes.issued_at = new Date(timestamp).toISOString();
        changes.document_number = generateDocumentNumber(document.document_type, document.document_id, changes.issued_at);
      }
    }
    if (event === DOCUMENT_EVENTS.MARK_GENERATED) {
      // Fail closed: a document reaching GENERATED without a real
      // server-assigned issued_at/document_number must never be marked as
      // generated, delivered or billed as final (mission §4 gate).
      if (typeof document.issued_at !== "string" || !document.issued_at ||
          typeof document.document_number !== "string" || !document.document_number) {
        return fail("DOCUMENT_FINALIZATION_IDENTITY_MISSING");
      }
      const file = ownValues(payloadValues.generated_file);
      if (!file || !validIdentifier(file.final_file_id) || file.document_id !== document.document_id ||
          file.document_version !== document.version || file.immutable !== true ||
          !Number.isSafeInteger(file.page_count) || file.page_count < 1 ||
          typeof file.checksum !== "string" || !/^[a-f0-9]{64}$/.test(file.checksum)) {
        return fail("DOCUMENT_GENERATED_FILE_INVALID");
      }
      changes.generated_file = deepFreeze(deepCopy(file));
    }
    if (event === DOCUMENT_EVENTS.CANCEL) changes.cancelled_at = new Date(timestamp).toISOString();
    return ok(deepFreeze({
      ...deepCopy(document),
      ...changes,
      status: transition.value,
      events: [...deepCopy(document.events), {
        type: event,
        from_state: document.status,
        to_state: transition.value,
        version: document.version,
        occurred_at: new Date(timestamp).toISOString(),
      }],
    }));
  }

  return Object.freeze({
    changeDocumentType,
    createDocument,
    modifyDocument,
    restoreDocument: restoreDocumentSnapshot,
    transitionDocument,
    validateForReview,
  });
}

module.exports = {
  COMMON_DOCUMENT_TYPES,
  TYPE_CONVERTIBLE_DOCUMENT_TYPES,
  DISCHARGE_SUBJECT_TYPES,
  RECEIPT_FORMATS,
  DOCUMENT_EVENTS,
  DOCUMENT_PURPOSES,
  DOCUMENT_STATES,
  DOCUMENT_TYPES,
  calculateCommonTotals,
  generateDocumentNumber,
  createDocumentDomain,
  restoreDocumentSnapshot,
  validateForReview,
};
