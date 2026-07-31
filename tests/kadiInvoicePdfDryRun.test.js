"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { renderInvoiceEstimatePdf } = require("../kadiInvoicePdfDryRun");

function invoice(count, description = "Article") {
  const items = Array.from({ length: count }, (_, index) => ({ designation: `${description} ${index + 1}`, quantity: 1, unit_price: 100, line_total: 100 }));
  return { document_label: "FACTURE COMMERCIALE", client: { name: "Client de test" }, items, subtotal_excluding_tax: count * 100, grand_total: count * 100, payment_terms: "Paiement contrôlé", note: "Fixture synthétique" };
}

test("actual in-memory dry run reports 1, 2 and at least 3 rendered pages", async () => {
  const one = await renderInvoiceEstimatePdf(invoice(2));
  const two = await renderInvoiceEstimatePdf(invoice(35));
  const three = await renderInvoiceEstimatePdf(invoice(90, "Article avec une désignation suffisamment descriptive"));
  assert.equal(one.ok, true);
  assert.ok(one.value.page_count >= 1);
  assert.ok(two.value.page_count >= 2);
  assert.ok(three.value.page_count >= 3);
  for (const result of [one.value, two.value, three.value]) {
    assert.equal(result.page_count_mode, "final_renderer");
    assert.equal(result.page_count_source, "kadiPdf.buildPdfBuffer");
    assert.equal(result.page_count_production_safe, true);
    assert.equal(result.production_debit_authorized, false);
    assert.equal(result.debit_performed, false);
    assert.equal(result.sent, false);
    assert.equal(result.temporary_artifact_created, false);
    assert.equal(result.temporary_artifact_cleaned, true);
  }
});
