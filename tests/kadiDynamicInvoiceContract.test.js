"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeClient, normalizeInvoiceItem, normalizeInvoiceItems, normalizeOptions } = require("../kadiDynamicInvoiceContract");

test("canonical items accept finite JSON numbers and expanded units", () => {
  for (const unit of ["piece", "unit", "lot", "pack", "carton", "kilogram", "gram", "liter", "meter", "square_meter", "cubic_meter", "hour", "day", "flat_rate", "other"]) {
    const result = normalizeInvoiceItem({ description: "Article", quantity: 1.25, unit, unit_price: 0 });
    assert.equal(result.ok, true, unit);
    assert.equal(result.value.quantity_millis, 1250);
  }
});

test("canonical items reject partial, hostile and non-finite values", () => {
  for (const item of [null, [], {}, { description: "A", quantity: NaN, unit: "piece", unit_price: 1 }, { description: "A", quantity: Infinity, unit: "piece", unit_price: 1 }, { description: "A", quantity: -1, unit: "piece", unit_price: 1 }, { description: "A", quantity: 1, unit: "bad", unit_price: 1 }, { description: "A", quantity: 1, unit: "piece", unit_price: -1 }]) {
    assert.equal(normalizeInvoiceItem(item).ok, false);
  }
});

test("canonical array has no six-item truncation and enforces technical limit", () => {
  const make = (index) => ({ description: `Article ${index}`, quantity: 1, unit: "piece", unit_price: 100 });
  for (const count of [1, 6, 7, 25, 100]) assert.equal(normalizeInvoiceItems(Array.from({ length: count }, (_, index) => make(index))).value.length, count);
  assert.equal(normalizeInvoiceItems(Array.from({ length: 101 }, (_, index) => make(index))).error, "ITEM_LIMIT_REACHED");
});

test("options require an explicit tax rate only when taxable", () => {
  assert.equal(normalizeOptions({ tax_status: "taxable", add_stamp: "no" }).error, "TAX_RATE_REQUIRED");
  assert.equal(normalizeOptions({ tax_status: "not_applicable", tax_rate: 99, add_stamp: "no" }).value.tax_rate_basis_points, 0);
});

test("client metadata and option dates are strict and unknown fields fail closed", () => {
  const client = normalizeClient({
    type: "professional",
    name: "Entreprise Kadi",
    invoice_subject: "Prestations",
    transaction_date: "2026-07-31",
  });
  assert.equal(client.ok, true);
  assert.equal(client.value.invoice_subject, "Prestations");
  assert.equal(client.value.transaction_date, "2026-07-31");
  assert.equal(normalizeClient({ type: "individual", name: "Awa", unexpected: true }).error, "CLIENT_FIELD_UNKNOWN");
  assert.equal(normalizeClient({ type: "individual", name: "Awa", transaction_date: "2026-02-31" }).error, "CLIENT_TRANSACTION_DATE_INVALID");
  assert.equal(normalizeOptions({ tax_status: "exempt", add_stamp: "no", due_date: "2026-02-31" }).error, "DUE_DATE_INVALID");
  assert.equal(normalizeOptions({ tax_status: "exempt", add_stamp: "no", unexpected: true }).error, "OPTIONS_FIELD_UNKNOWN");
});
