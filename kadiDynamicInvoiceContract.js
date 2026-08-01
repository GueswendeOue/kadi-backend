"use strict";

const {
  MAX_INVOICE_ITEMS,
  MAX_ITEM_DESCRIPTION_LENGTH,
  MAX_ITEM_QUANTITY,
  MAX_ITEM_UNIT_PRICE,
} = require("./kadiInvoiceLimits");

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const UNIT_IDS = new Set([
  "piece", "unit", "lot", "pack", "carton", "kilogram", "gram", "liter",
  "meter", "square_meter", "cubic_meter", "hour", "day", "flat_rate", "other",
]);
const CLIENT_TYPES = new Set(["individual", "professional"]);
const TAX_STATUSES = new Set(["not_applicable", "exempt", "taxable"]);
const PAYMENT_METHODS = new Set(["cash", "mobile_money", "bank_transfer", "cheque", "other"]);
const CLIENT_FIELDS = new Set([
  "type", "name", "phone", "address", "ifu", "registry_number",
  "invoice_subject", "transaction_date",
]);
const OPTION_FIELDS = new Set([
  "tax_status", "tax_rate", "discount_amount", "amount_paid", "due_date",
  "payment_method", "payment_terms", "note", "add_stamp",
]);

function ok(value) { return { ok: true, value }; }
function fail(error) { return { ok: false, error }; }

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownDataDescriptors(value) {
  if (!isPlainRecord(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (DANGEROUS_KEYS.has(key) || !Object.hasOwn(descriptor, "value")) return null;
    }
    return descriptors;
  } catch {
    return null;
  }
}

function read(descriptors, key) { return descriptors?.[key]?.value; }

function hasOnlyFields(descriptors, allowed) {
  return Object.keys(descriptors).every((key) => allowed.has(key));
}

function normalizeDate(value, error) {
  if (value == null || value === "") return ok(null);
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail(error);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? ok(value)
    : fail(error);
}

function cleanText(value, maximum, required = false) {
  if (value === undefined || value === null || value === "") {
    return required ? fail("TEXT_REQUIRED") : ok(null);
  }
  if (typeof value !== "string") return fail("TEXT_INVALID");
  const cleaned = value.replace(CONTROL_CHARACTERS, "").trim();
  if (!cleaned) return required ? fail("TEXT_REQUIRED") : ok(null);
  if (cleaned.length > maximum) return fail("TEXT_TOO_LONG");
  return ok(cleaned);
}

function parseScaledNumber(value, decimals, maximum, allowZero) {
  if (typeof value !== "string" && typeof value !== "number") return fail("NUMBER_INVALID");
  const raw = typeof value === "number" ? String(value) : value.trim();
  const pattern = decimals === 0 ? /^\d+$/ : new RegExp(`^\\d+(?:[.,]\\d{1,${decimals}})?$`);
  if (!pattern.test(raw)) return fail("NUMBER_INVALID");
  const number = Number(raw.replace(",", "."));
  if (!Number.isFinite(number) || number > maximum || (allowZero ? number < 0 : number <= 0)) {
    return fail("NUMBER_INVALID");
  }
  const scaled = Math.round(number * 10 ** decimals);
  if (!Number.isSafeInteger(scaled)) return fail("NUMBER_INVALID");
  return ok({ number, scaled });
}

function normalizeInvoiceItem(input) {
  const descriptors = ownDataDescriptors(input);
  if (!descriptors) return fail("ITEM_INVALID");
  const allowed = new Set(["description", "designation", "quantity", "unit", "unit_price"]);
  if (Object.keys(descriptors).some((key) => !allowed.has(key))) return fail("ITEM_FIELD_UNKNOWN");

  const description = cleanText(
    read(descriptors, "description") ?? read(descriptors, "designation"),
    MAX_ITEM_DESCRIPTION_LENGTH,
    true
  );
  if (!description.ok) return fail("ITEM_DESCRIPTION_INVALID");
  const quantity = parseScaledNumber(read(descriptors, "quantity"), 3, MAX_ITEM_QUANTITY, false);
  if (!quantity.ok) return fail("ITEM_QUANTITY_INVALID");
  const unit = read(descriptors, "unit");
  if (typeof unit !== "string" || !UNIT_IDS.has(unit.trim())) return fail("ITEM_UNIT_INVALID");
  const unitPrice = parseScaledNumber(read(descriptors, "unit_price"), 0, MAX_ITEM_UNIT_PRICE, true);
  if (!unitPrice.ok) return fail("ITEM_UNIT_PRICE_INVALID");

  return ok(Object.freeze({
    description: description.value,
    designation: description.value,
    quantity: quantity.value.number,
    quantity_millis: quantity.value.scaled,
    unit: unit.trim(),
    unit_price: unitPrice.value.scaled,
  }));
}

function normalizeInvoiceItems(items, maximum = MAX_INVOICE_ITEMS) {
  if (!Array.isArray(items) || items.length < 1) return fail("ITEMS_REQUIRED");
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > MAX_INVOICE_ITEMS) {
    return fail("ITEM_LIMIT_INVALID");
  }
  if (items.length > maximum) return fail("ITEM_LIMIT_REACHED");
  const normalized = [];
  for (const item of items) {
    const result = normalizeInvoiceItem(item);
    if (!result.ok) return result;
    normalized.push(result.value);
  }
  return ok(Object.freeze(normalized));
}

function normalizeClient(input) {
  const descriptors = ownDataDescriptors(input);
  if (!descriptors) return fail("CLIENT_INVALID");
  if (!hasOnlyFields(descriptors, CLIENT_FIELDS)) return fail("CLIENT_FIELD_UNKNOWN");
  const type = read(descriptors, "type");
  if (!CLIENT_TYPES.has(type)) return fail("CLIENT_TYPE_INVALID");
  const name = cleanText(read(descriptors, "name"), 200, true);
  if (!name.ok) return fail("CLIENT_NAME_INVALID");
  const result = { type, name: name.value };
  for (const [key, maximum] of [["phone", 50], ["address", 300], ["ifu", 100], ["registry_number", 150]]) {
    const value = cleanText(read(descriptors, key), maximum);
    if (!value.ok) return fail(`CLIENT_${key.toUpperCase()}_INVALID`);
    result[key] = value.value;
  }
  const subject = cleanText(read(descriptors, "invoice_subject"), 300);
  if (!subject.ok) return fail("CLIENT_INVOICE_SUBJECT_INVALID");
  const transactionDate = normalizeDate(read(descriptors, "transaction_date"), "CLIENT_TRANSACTION_DATE_INVALID");
  if (!transactionDate.ok) return transactionDate;
  result.invoice_subject = subject.value;
  result.transaction_date = transactionDate.value;
  return ok(Object.freeze(result));
}

function normalizeOptions(input = {}) {
  const descriptors = ownDataDescriptors(input);
  if (!descriptors) return fail("OPTIONS_INVALID");
  if (!hasOnlyFields(descriptors, OPTION_FIELDS)) return fail("OPTIONS_FIELD_UNKNOWN");
  const taxStatus = read(descriptors, "tax_status");
  if (!TAX_STATUSES.has(taxStatus)) return fail("TAX_STATUS_INVALID");
  let taxRateBasisPoints = 0;
  if (taxStatus === "taxable") {
    const rate = parseScaledNumber(read(descriptors, "tax_rate"), 2, 100, false);
    if (!rate.ok) return fail("TAX_RATE_REQUIRED");
    taxRateBasisPoints = rate.value.scaled;
  }
  const discount = parseScaledNumber(read(descriptors, "discount_amount") ?? 0, 0, 9e15, true);
  const paid = parseScaledNumber(read(descriptors, "amount_paid") ?? 0, 0, 9e15, true);
  if (!discount.ok) return fail("DISCOUNT_INVALID");
  if (!paid.ok) return fail("AMOUNT_PAID_INVALID");
  const paymentMethod = read(descriptors, "payment_method");
  if (paymentMethod != null && paymentMethod !== "" && !PAYMENT_METHODS.has(paymentMethod)) {
    return fail("PAYMENT_METHOD_INVALID");
  }
  const terms = cleanText(read(descriptors, "payment_terms"), 500);
  const note = cleanText(read(descriptors, "note"), 1000);
  const dueDate = normalizeDate(read(descriptors, "due_date"), "DUE_DATE_INVALID");
  if (!terms.ok || !note.ok) return fail("OPTION_TEXT_INVALID");
  if (!dueDate.ok) return dueDate;
  const addStamp = read(descriptors, "add_stamp");
  if (addStamp !== "yes" && addStamp !== "no") return fail("STAMP_CHOICE_INVALID");
  return ok(Object.freeze({
    tax_status: taxStatus,
    tax_rate_basis_points: taxRateBasisPoints,
    discount_amount: discount.value.scaled,
    amount_paid: paid.value.scaled,
    due_date: dueDate.value,
    payment_method: paymentMethod || null,
    payment_terms: terms.value,
    note: note.value,
    add_stamp: addStamp === "yes",
  }));
}

module.exports = {
  CLIENT_FIELDS,
  OPTION_FIELDS,
  UNIT_IDS,
  isPlainRecord,
  normalizeClient,
  normalizeInvoiceItem,
  normalizeInvoiceItems,
  normalizeOptions,
  ownDataDescriptors,
};
