"use strict";

const FLOW_NAME = "KADI_FACTURE_V1";
const MAX_RESPONSE_JSON_BYTES = 32 * 1024;
const MAX_TEXT_LENGTH = 500;
const MAX_NOTE_LENGTH = 1000;
const MAX_QUANTITY = 1_000_000;
const MAX_UNIT_PRICE = 1_000_000_000;
const MAX_MONEY_AMOUNT = 9_000_000_000_000_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

const CLIENT_FIELDS = Object.freeze([
  "client_type",
  "client_name",
  "client_phone",
  "client_address",
  "client_ifu",
  "client_registry_number",
  "invoice_subject",
  "transaction_date",
]);

const ITEM_FIELDS = Object.freeze(
  Array.from({ length: 6 }, (_, index) => {
    const number = index + 1;
    return [
      `item_${number}_designation`,
      `item_${number}_quantity`,
      `item_${number}_unit`,
      `item_${number}_unit_price`,
    ];
  }).flat()
);

const OPTION_FIELDS = Object.freeze([
  "tax_status",
  "tax_rate",
  "discount_amount",
  "amount_paid",
  "due_date",
  "payment_method",
  "payment_terms",
  "invoice_note",
  "add_stamp",
]);

const ALLOWED_RESPONSE_FIELDS = Object.freeze([
  "flow_token",
  "draft_id",
  "review_action",
  ...CLIENT_FIELDS,
  ...ITEM_FIELDS,
  "has_more_items",
  ...OPTION_FIELDS,
]);

const ALLOWED_RESPONSE_FIELD_SET = new Set(ALLOWED_RESPONSE_FIELDS);
const UNITS = new Map([
  ["unit", "Unité"],
  ["piece", "Pièce"],
  ["lot", "Lot"],
  ["hour", "Heure"],
  ["day", "Jour"],
  ["kilogram", "Kilogramme"],
  ["meter", "Mètre"],
  ["service", "Service"],
  ["other", "Autre"],
]);
const UNIT_TITLES = new Map([...UNITS].map(([id, title]) => [title, id]));
const PAYMENT_METHODS = new Map([
  ["cash", "Espèces"],
  ["mobile_money", "Mobile Money"],
  ["bank_transfer", "Virement"],
  ["cheque", "Chèque"],
  ["other", "Autre"],
]);
const PAYMENT_TITLES = new Map(
  [...PAYMENT_METHODS].map(([id, title]) => [title, id])
);

function ok(value) {
  return { ok: true, value };
}

function fail(error) {
  return { ok: false, error };
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object") return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function getOwnDataDescriptor(source, key) {
  if (!isPlainRecord(source)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor : null;
  } catch {
    return null;
  }
}

function getOwnDataValue(source, key) {
  return getOwnDataDescriptor(source, key)?.value;
}

function getOwnDataDescriptors(source) {
  if (!isPlainRecord(source)) return null;
  try {
    return Object.getOwnPropertyDescriptors(source);
  } catch {
    return null;
  }
}

function isInvoiceFlowReply(message) {
  const type = getOwnDataValue(message, "type");
  const interactive = getOwnDataValue(message, "interactive");
  return (
    type === "interactive" &&
    isPlainRecord(interactive) &&
    getOwnDataValue(interactive, "type") === "nfm_reply" &&
    isPlainRecord(getOwnDataValue(interactive, "nfm_reply"))
  );
}

function parseInvoiceFlowResponseJson(responseJson) {
  if (typeof responseJson !== "string") return fail("RESPONSE_JSON_TYPE");
  if (Buffer.byteLength(responseJson, "utf8") > MAX_RESPONSE_JSON_BYTES) {
    return fail("RESPONSE_JSON_TOO_LARGE");
  }

  let parsed;
  try {
    parsed = JSON.parse(responseJson);
  } catch {
    return fail("RESPONSE_JSON_INVALID");
  }

  const descriptors = getOwnDataDescriptors(parsed);
  if (!descriptors || Array.isArray(parsed)) return fail("RESPONSE_ROOT_INVALID");

  const safePayload = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (FORBIDDEN_KEYS.has(key)) return fail("FORBIDDEN_FIELD");
    if (!ALLOWED_RESPONSE_FIELD_SET.has(key)) return fail("UNKNOWN_FIELD");
    if (!Object.hasOwn(descriptor, "value")) return fail("FIELD_VALUE_INVALID");
    const value = descriptor.value;
    if (
      value !== null &&
      !["string", "number", "boolean"].includes(typeof value)
    ) {
      return fail("FIELD_VALUE_INVALID");
    }
    safePayload[key] = value;
  }

  return ok(safePayload);
}

function parseInvoiceFlowReply(message) {
  if (!isInvoiceFlowReply(message)) return fail("NOT_INVOICE_FLOW_REPLY");
  const interactive = getOwnDataValue(message, "interactive");
  const reply = getOwnDataValue(interactive, "nfm_reply");
  return parseInvoiceFlowResponseJson(getOwnDataValue(reply, "response_json"));
}

function cleanText(value, maxLength = MAX_TEXT_LENGTH, required = false) {
  if (value === undefined || value === null || value === "") {
    return required ? fail("REQUIRED_TEXT_MISSING") : ok(null);
  }
  if (typeof value !== "string") return fail("TEXT_INVALID");
  const cleaned = value.replace(CONTROL_CHARACTERS, "").trim();
  if (!cleaned) return required ? fail("REQUIRED_TEXT_MISSING") : ok(null);
  if (cleaned.length > maxLength) return fail("TEXT_TOO_LONG");
  return ok(cleaned);
}

function parseScaledDecimal(value, decimals, maximum, allowZero) {
  if (typeof value !== "string" && typeof value !== "number") {
    return fail("NUMBER_INVALID");
  }
  const raw = typeof value === "number" ? String(value) : value.trim();
  const pattern =
    decimals === 0
      ? /^\d+$/
      : new RegExp(`^\\d+(?:[.,]\\d{1,${decimals}})?$`);
  if (!pattern.test(raw)) return fail("NUMBER_INVALID");
  const normalized = raw.replace(",", ".");
  const number = Number(normalized);
  if (!Number.isFinite(number) || number > maximum) return fail("NUMBER_INVALID");
  if (allowZero ? number < 0 : number <= 0) return fail("NUMBER_INVALID");
  const scaled = Math.round(number * 10 ** decimals);
  if (!Number.isSafeInteger(scaled)) return fail("NUMBER_INVALID");
  return ok({ number, scaled });
}

function parseMoney(value, required, strictlyPositive = false) {
  if (value === undefined || value === null || value === "") {
    return required ? fail("MONEY_MISSING") : ok(0);
  }
  const parsed = parseScaledDecimal(value, 0, MAX_MONEY_AMOUNT, !strictlyPositive);
  return parsed.ok ? ok(parsed.value.scaled) : fail("MONEY_INVALID");
}

function normalizeEnum(value, ids, titles, required, error) {
  if (value === undefined || value === null || value === "") {
    return required ? fail(error) : ok(null);
  }
  if (typeof value !== "string") return fail(error);
  const trimmed = value.trim();
  if (ids.has(trimmed)) return ok(trimmed);
  if (titles?.has(trimmed)) return ok(titles.get(trimmed));
  return fail(error);
}

function normalizeDate(value) {
  if (value === undefined || value === null || value === "") return ok(null);
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return fail("DATE_INVALID");
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return fail("DATE_INVALID");
  }
  return ok(value);
}

function normalizeClientType(value) {
  const mapping = new Map([
    ["individual", "individual"],
    ["Particulier", "individual"],
    ["professional", "professional"],
    ["Professionnel", "professional"],
  ]);
  return typeof value === "string" && mapping.has(value.trim())
    ? ok(mapping.get(value.trim()))
    : fail("CLIENT_TYPE_INVALID");
}

function normalizeTaxStatus(value) {
  const mapping = new Map([
    ["not_applicable", "not_applicable"],
    ["Non applicable", "not_applicable"],
    ["exempt", "exempt"],
    ["Exonéré", "exempt"],
    ["taxable", "taxable"],
    ["Taxable", "taxable"],
  ]);
  return typeof value === "string" && mapping.has(value.trim())
    ? ok(mapping.get(value.trim()))
    : fail("TAX_STATUS_INVALID");
}

function normalizeYesNo(value) {
  const mapping = new Map([
    ["no", false],
    ["Non", false],
    ["yes", true],
    ["Oui", true],
  ]);
  return typeof value === "string" && mapping.has(value.trim())
    ? ok(mapping.get(value.trim()))
    : fail("STAMP_CHOICE_INVALID");
}

function normalizeMoreItemsChoice(value) {
  if (value === undefined || value === null || value === "") return ok(null);
  const mapping = new Map([
    ["no", false],
    ["Non", false],
    ["yes", true],
    ["Oui", true],
  ]);
  return typeof value === "string" && mapping.has(value.trim())
    ? ok(mapping.get(value.trim()))
    : fail("MORE_ITEMS_CHOICE_INVALID");
}

function normalizeInvoiceFlowSubmission(payload) {
  const descriptors = getOwnDataDescriptors(payload);
  if (!descriptors || Array.isArray(payload)) return fail("SUBMISSION_INVALID");
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (FORBIDDEN_KEYS.has(key)) return fail("FORBIDDEN_FIELD");
    if (!ALLOWED_RESPONSE_FIELD_SET.has(key)) return fail("UNKNOWN_FIELD");
    if (!Object.hasOwn(descriptor, "value")) return fail("FIELD_VALUE_INVALID");
    const value = descriptor.value;
    if (
      value !== null &&
      !["string", "number", "boolean"].includes(typeof value)
    ) {
      return fail("FIELD_VALUE_INVALID");
    }
  }

  const read = (key) => descriptors[key]?.value;
  const clientType = normalizeClientType(read("client_type"));
  if (!clientType.ok) return clientType;
  const clientName = cleanText(read("client_name"), 200, true);
  if (!clientName.ok) return fail("CLIENT_NAME_INVALID");

  const optionalClientFields = {};
  for (const [field, maxLength] of [
    ["client_phone", 50],
    ["client_address", 300],
    ["client_ifu", 100],
    ["client_registry_number", 150],
    ["invoice_subject", 300],
  ]) {
    const normalized = cleanText(read(field), maxLength);
    if (!normalized.ok) return fail(`${field.toUpperCase()}_INVALID`);
    optionalClientFields[field] = normalized.value;
  }

  const transactionDate = normalizeDate(read("transaction_date"));
  if (!transactionDate.ok) return transactionDate;

  const moreItemsChoice = normalizeMoreItemsChoice(read("has_more_items"));
  if (!moreItemsChoice.ok) return moreItemsChoice;
  const maximumItemIndex = moreItemsChoice.value === false ? 3 : 6;

  const items = [];
  for (let index = 1; index <= maximumItemIndex; index += 1) {
    const rawValues = {
      designation: read(`item_${index}_designation`),
      quantity: read(`item_${index}_quantity`),
      unit: read(`item_${index}_unit`),
      unitPrice: read(`item_${index}_unit_price`),
    };
    const present = Object.values(rawValues).map(
      (value) => value !== undefined && value !== null && value !== ""
    );
    if (!present.some(Boolean)) {
      if (index === 1) return fail("ITEM_1_REQUIRED");
      if (index === 4 && moreItemsChoice.value === true) {
        return fail("ITEM_4_REQUIRED");
      }
      continue;
    }
    if (!present.every(Boolean)) return fail(`ITEM_${index}_PARTIAL`);

    const designation = cleanText(rawValues.designation, 300, true);
    if (!designation.ok) return fail(`ITEM_${index}_DESIGNATION_INVALID`);
    const quantity = parseScaledDecimal(
      rawValues.quantity,
      3,
      MAX_QUANTITY,
      false
    );
    if (!quantity.ok) return fail(`ITEM_${index}_QUANTITY_INVALID`);
    const unit = normalizeEnum(
      rawValues.unit,
      UNITS,
      UNIT_TITLES,
      true,
      `ITEM_${index}_UNIT_INVALID`
    );
    if (!unit.ok) return unit;
    const unitPrice = parseMoney(rawValues.unitPrice, true, true);
    if (!unitPrice.ok) return fail(`ITEM_${index}_UNIT_PRICE_INVALID`);
    if (unitPrice.value > MAX_UNIT_PRICE) {
      return fail(`ITEM_${index}_UNIT_PRICE_INVALID`);
    }

    items.push({
      designation: designation.value,
      quantity: quantity.value.number,
      quantity_millis: quantity.value.scaled,
      unit: unit.value,
      unit_price: unitPrice.value,
    });
  }

  const taxStatus = normalizeTaxStatus(read("tax_status"));
  if (!taxStatus.ok) return taxStatus;
  let taxRateBasisPoints = 0;
  if (taxStatus.value === "taxable") {
    const taxRate = parseScaledDecimal(read("tax_rate"), 2, 100, false);
    if (!taxRate.ok) return fail("TAX_RATE_REQUIRED");
    taxRateBasisPoints = taxRate.value.scaled;
  }

  const discount = parseMoney(read("discount_amount"), false);
  if (!discount.ok) return fail("DISCOUNT_INVALID");
  const amountPaid = parseMoney(read("amount_paid"), false);
  if (!amountPaid.ok) return fail("AMOUNT_PAID_INVALID");
  const dueDate = normalizeDate(read("due_date"));
  if (!dueDate.ok) return dueDate;
  const paymentMethod = normalizeEnum(
    read("payment_method"),
    PAYMENT_METHODS,
    PAYMENT_TITLES,
    false,
    "PAYMENT_METHOD_INVALID"
  );
  if (!paymentMethod.ok) return paymentMethod;
  const paymentTerms = cleanText(read("payment_terms"), MAX_TEXT_LENGTH);
  if (!paymentTerms.ok) return fail("PAYMENT_TERMS_INVALID");
  const note = cleanText(read("invoice_note"), MAX_NOTE_LENGTH);
  if (!note.ok) return fail("NOTE_INVALID");
  const addStamp = normalizeYesNo(read("add_stamp"));
  if (!addStamp.ok) return addStamp;
  const flowToken = cleanText(read("flow_token"), 256);
  if (!flowToken.ok) return fail("FLOW_TOKEN_INVALID");

  return ok({
    flow_name: FLOW_NAME,
    flow_token: flowToken.value,
    client: {
      type: clientType.value,
      name: clientName.value,
      phone: optionalClientFields.client_phone,
      address: optionalClientFields.client_address,
      ifu: optionalClientFields.client_ifu,
      registry_number: optionalClientFields.client_registry_number,
    },
    invoice_subject: optionalClientFields.invoice_subject,
    transaction_date: transactionDate.value,
    items,
    tax_status: taxStatus.value,
    tax_rate_basis_points: taxRateBasisPoints,
    discount_amount: discount.value,
    amount_paid: amountPaid.value,
    due_date: dueDate.value,
    payment_method: paymentMethod.value,
    payment_terms: paymentTerms.value,
    note: note.value,
    add_stamp: addStamp.value,
  });
}

module.exports = {
  ALLOWED_RESPONSE_FIELDS,
  CLIENT_FIELDS,
  FLOW_NAME,
  ITEM_FIELDS,
  MAX_RESPONSE_JSON_BYTES,
  OPTION_FIELDS,
  isInvoiceFlowReply,
  normalizeInvoiceFlowSubmission,
  parseInvoiceFlowReply,
  parseInvoiceFlowResponseJson,
};
