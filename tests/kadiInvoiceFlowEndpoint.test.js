"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createInvoiceFlowEndpoint, estimateData, safeRecord } = require("../kadiInvoiceFlowEndpoint");
const { createInvoiceCartService } = require("../kadiInvoiceCartService");
const { createInMemoryInvoiceDraftRepository } = require("../kadiInvoiceDraftRepository");

function endpoint(overrides = {}) {
  const cartService = createInvoiceCartService({ repository: createInMemoryInvoiceDraftRepository() });
  return createInvoiceFlowEndpoint({
    cartService,
    ownerResolver: async () => "internal-owner",
    estimateDocument: async () => ({ page_count: 2, page_count_mode: "final_renderer", credit_cost: 1, amount_fcfa: 100 }),
    ...overrides,
  });
}

test("endpoint supports official ping and INIT without a network server", async () => {
  const api = endpoint();
  assert.deepEqual((await api.handle({ action: "ping" })).value, { data: { status: "active" } });
  const init = await api.handle({ action: "INIT", flow_token: "synthetic-token", version: "3.0" });
  assert.equal(init.ok, true);
  assert.equal(init.value.screen, "CLIENT");
  assert.equal(typeof init.value.data.draft_id, "string");
});

test("endpoint adds one item, returns an empty ARTICLE form and can finish", async () => {
  const api = endpoint();
  const init = await api.handle({ action: "INIT", flow_token: "synthetic-token", version: "3.0" });
  const draftId = init.value.data.draft_id;
  const client = await api.handle({ action: "data_exchange", flow_token: "synthetic-token", version: "3.0", data: { intent: "save_client", draft_id: draftId, client_type: "individual", client_name: "Awa" } });
  assert.equal(client.value.screen, "ARTICLE");
  const added = await api.handle({ action: "data_exchange", flow_token: "synthetic-token", version: "3.0", data: { intent: "add_item", draft_id: draftId, item_count: 0, description: "Service", quantity: 1, unit: "piece", unit_price: 1000 } });
  assert.equal(added.value.screen, "ARTICLE_DECISION");
  const again = await api.handle({ action: "data_exchange", flow_token: "synthetic-token", version: "3.0", data: { intent: "decide_articles", draft_id: draftId, decision: "add" } });
  assert.deepEqual(again.value.data, { draft_id: draftId, item_count: 1 });
  const finish = await api.handle({ action: "data_exchange", flow_token: "synthetic-token", version: "3.0", data: { intent: "decide_articles", draft_id: draftId, decision: "finish" } });
  assert.equal(finish.value.screen, "OPTIONS");
});

test("endpoint rejects malformed roots, dangerous keys and foreign context", async () => {
  assert.equal(safeRecord(null), null);
  assert.equal(safeRecord([]), null);
  assert.equal(safeRecord(JSON.parse('{"__proto__":true}')), null);
  assert.equal((await endpoint().handle([])).error, "FLOW_REQUEST_INVALID");
});

test("endpoint preserves client metadata and reports a side-effect-free final-renderer estimate", async () => {
  let estimatedInvoice = null;
  const api = endpoint({
    issuerResolver: async () => ({ issuer_registration_status: "registered_rccm" }),
    estimateDocument: async (invoice) => {
      estimatedInvoice = invoice;
      return { page_count: 2, page_count_mode: "final_renderer", credit_cost: 1, amount_fcfa: 100, debit_performed: false, sent: false };
    },
  });
  const init = await api.handle({ action: "INIT", flow_token: "metadata-token", version: "3.0" });
  const draftId = init.value.data.draft_id;
  await api.handle({ action: "data_exchange", flow_token: "metadata-token", version: "3.0", data: {
    intent: "save_client", draft_id: draftId, client_type: "professional", client_name: "Kadi",
    invoice_subject: "Conseil", transaction_date: "2026-07-31",
  } });
  await api.handle({ action: "data_exchange", flow_token: "metadata-token", version: "3.0", data: {
    intent: "add_item", draft_id: draftId, item_count: 0, description: "Service", quantity: 1, unit: "piece", unit_price: 1000,
  } });
  await api.handle({ action: "data_exchange", flow_token: "metadata-token", version: "3.0", data: {
    intent: "decide_articles", draft_id: draftId, decision: "finish",
  } });
  const result = await api.handle({ action: "data_exchange", flow_token: "metadata-token", version: "3.0", data: {
    intent: "save_options", draft_id: draftId, tax_status: "not_applicable", discount_amount: 0,
    amount_paid: 0, add_stamp: "no",
  } });
  assert.equal(result.ok, true);
  assert.equal(result.value.data.page_count_mode_text, "Comptage issu du renderer PDF Kadi final");
  assert.equal(estimatedInvoice.subject, "Conseil");
  assert.equal(estimatedInvoice.transaction_date, "2026-07-31");
  assert.equal(estimateData({ debit_performed: true }, 1), null);
  assert.equal(estimateData({ sent: true }, 1), null);
});
