"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeInvoiceFlowSubmission } = require("../kadiInvoiceFlowContract");
const { calculateInvoiceFlowDraft } = require("../kadiInvoiceCalculator");

function normalize(overrides = {}) {
  const result = normalizeInvoiceFlowSubmission({
    client_type: "professional",
    client_name: "Entreprise Awa",
    item_1_designation: "Service",
    item_1_quantity: "2",
    item_1_unit: "service",
    item_1_unit_price: "1000",
    tax_status: "not_applicable",
    discount_amount: "0",
    amount_paid: "0",
    add_stamp: "no",
    ...overrides,
  });
  assert.equal(result.ok, true);
  return result.value;
}

test("one item is calculated locally in deterministic XOF integers", () => {
  const result = calculateInvoiceFlowDraft(normalize(), {
    issuer_registration_status: "registered_rccm",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.currency, "XOF");
  assert.equal(result.value.items[0].line_total, 2000);
  assert.equal(result.value.subtotal_excluding_tax, 2000);
  assert.equal(result.value.grand_total, 2000);
  assert.equal(result.value.balance_due, 2000);
  assert.equal(result.value.document_number, null);
  assert.equal(result.value.issue_date, null);
});

test("six items are calculated and the maximum is enforced", () => {
  const extra = {};
  for (let index = 2; index <= 6; index += 1) {
    extra[`item_${index}_designation`] = `Article ${index}`;
    extra[`item_${index}_quantity`] = "1";
    extra[`item_${index}_unit`] = "piece";
    extra[`item_${index}_unit_price`] = "100";
  }
  const normalized = normalize(extra);
  const result = calculateInvoiceFlowDraft(normalized, {
    issuer_registration_status: "registered_professional",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.items.length, 6);
  assert.equal(result.value.grand_total, 2500);

  assert.equal(
    calculateInvoiceFlowDraft({ ...normalized, items: [...normalized.items, normalized.items[0]] }).error,
    "ITEM_COUNT_INVALID"
  );
});

test("fractional quantities use deterministic half-up FCFA rounding", () => {
  const normalized = normalize({
    item_1_quantity: "1.005",
    item_1_unit_price: "100",
  });
  const result = calculateInvoiceFlowDraft(normalized);
  assert.equal(result.ok, true);
  assert.equal(result.value.items[0].line_total, 101);
  assert.equal(result.value.grand_total, 101);
});

test("tax is local, explicit and rounded after discount", () => {
  const normalized = normalize({
    item_1_quantity: "1",
    item_1_unit_price: "1001",
    tax_status: "taxable",
    tax_rate: "18",
    discount_amount: "1",
  });
  const result = calculateInvoiceFlowDraft(normalized);
  assert.equal(result.ok, true);
  assert.equal(result.value.subtotal_excluding_tax, 1001);
  assert.equal(result.value.discount_total, 1);
  assert.equal(result.value.taxable_amount, 1000);
  assert.equal(result.value.tax_total, 180);
  assert.equal(result.value.grand_total, 1180);
});

test("discount cannot exceed subtotal", () => {
  const result = calculateInvoiceFlowDraft(
    normalize({ discount_amount: "2001" })
  );
  assert.equal(result.error, "DISCOUNT_EXCEEDS_SUBTOTAL");
});

test("amount paid cannot exceed final total", () => {
  const result = calculateInvoiceFlowDraft(normalize({ amount_paid: "2001" }));
  assert.equal(result.error, "AMOUNT_PAID_EXCEEDS_TOTAL");
});

test("calculator rejects malformed normalized counters without throwing", () => {
  const normalized = normalize();
  for (const [field, value, error] of [
    ["discount_amount", "1", "DISCOUNT_INVALID"],
    ["amount_paid", NaN, "AMOUNT_PAID_INVALID"],
    ["tax_rate_basis_points", Infinity, "TAX_RATE_INVALID"],
  ]) {
    assert.doesNotThrow(() => calculateInvoiceFlowDraft({ ...normalized, [field]: value }));
    assert.equal(
      calculateInvoiceFlowDraft({ ...normalized, [field]: value }).error,
      error
    );
  }
});

test("registered profiles produce commercial invoices without certification", () => {
  for (const status of ["registered_rccm", "registered_professional"]) {
    const result = calculateInvoiceFlowDraft(normalize(), {
      issuer_registration_status: status,
    });
    assert.equal(result.value.document_type, "invoice");
    assert.equal(result.value.document_label, "FACTURE COMMERCIALE");
    assert.equal(result.value.document_compliance_status, "structured_invoice");
    assert.doesNotMatch(JSON.stringify(result.value), /FACTURE CERTIFIÉE|CONFORME DGI/i);
  }
});

test("unregistered profile produces a non-blocking sales document", () => {
  const result = calculateInvoiceFlowDraft(normalize(), {
    issuer_registration_status: "unregistered",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.document_type, "sales_note");
  assert.equal(result.value.document_label, "DOCUMENT DE VENTE");
  assert.equal(result.value.document_compliance_status, "commercial_document");
});

test("FEC fields always remain null and certification is inaccessible", () => {
  const result = calculateInvoiceFlowDraft(normalize(), {
    issuer_registration_status: "fec_certified",
    fec_status: "certified",
    secef_code: "invented",
  });
  assert.equal(result.ok, true);
  for (const field of [
    "fec_status",
    "secef_code",
    "machine_nim",
    "certification_qr_payload",
    "certification_reference",
    "certified_at",
  ]) {
    assert.equal(result.value[field], null);
  }
  assert.notEqual(result.value.document_compliance_status, "fec_certified");
});
