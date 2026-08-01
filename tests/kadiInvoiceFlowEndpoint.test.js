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

test("add returns a refreshed empty ARTICLE_CART summary and retry does not duplicate", async () => {
  const api = endpoint();
  const init = await api.handle({ action: "INIT", flow_token: "synthetic-token", version: "3.0" });
  const draftId = init.value.data.draft_id;
  const client = await api.handle({ action: "data_exchange", flow_token: "synthetic-token", version: "3.0", data: { intent: "save_client", draft_id: draftId, client_type: "individual", client_name: "Awa" } });
  assert.equal(client.value.screen, "ARTICLE_CART");
  const request = { action: "data_exchange", flow_token: "synthetic-token", version: "3.0", data: { intent: "submit_article", draft_id: draftId, item_count: 0, description: "Service", quantity: 1, unit: "piece", unit_price: 1000, decision: "add" } };
  const added = await api.handle(request);
  assert.equal(added.value.screen, "ARTICLE_CART");
  assert.equal(added.value.data.item_count, 1);
  assert.match(added.value.data.items_summary, /1 × Service/);
  assert.equal(added.value.data.provisional_subtotal, "1 000 FCFA");
  assert.equal(added.value.data.item_description, undefined);
  assert.equal(added.value.data.item_quantity, undefined);
  assert.equal(added.value.data.item_unit, undefined);
  assert.equal(added.value.data.item_unit_price, undefined);
  assert.equal(added.value.data.article_decision, undefined);
  const retried = await api.handle(request);
  assert.equal(retried.value.data.item_count, 1);
});

test("finish adds the last item once, advances to OPTIONS and rejects an empty submission", async () => {
  const api = endpoint();
  const init = await api.handle({ action: "INIT", flow_token: "finish-token", version: "3.0" });
  const draftId = init.value.data.draft_id;
  await api.handle({ action: "data_exchange", flow_token: "finish-token", version: "3.0", data: { intent: "save_client", draft_id: draftId, client_type: "individual", client_name: "Awa" } });
  const finishRequest = { action: "data_exchange", flow_token: "finish-token", version: "3.0", data: { intent: "submit_article", draft_id: draftId, item_count: 0, description: "Service", quantity: 1, unit: "piece", unit_price: 1000, decision: "finish" } };
  const finish = await api.handle(finishRequest);
  assert.equal(finish.value.screen, "OPTIONS");
  assert.equal(finish.value.data.item_count, 1);
  const retried = await api.handle(finishRequest);
  assert.equal(retried.value.screen, "OPTIONS");
  assert.equal(retried.value.data.item_count, 1);

  const emptyInit = await api.handle({ action: "INIT", flow_token: "empty-finish-token", version: "3.0" });
  await api.handle({ action: "data_exchange", flow_token: "empty-finish-token", version: "3.0", data: { intent: "save_client", draft_id: emptyInit.value.data.draft_id, client_type: "individual", client_name: "Awa" } });
  const emptyFinish = await api.handle({ action: "data_exchange", flow_token: "empty-finish-token", version: "3.0", data: { intent: "submit_article", draft_id: emptyInit.value.data.draft_id, item_count: 0, decision: "finish" } });
  assert.equal(emptyFinish.ok, false);
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
    intent: "submit_article", draft_id: draftId, item_count: 0, description: "Service", quantity: 1, unit: "piece", unit_price: 1000, decision: "finish",
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

test("synthetic Ben invoice path returns complete bound data with empty optional options", async () => {
  let estimatedInvoice = null;
  const api = endpoint({ estimateDocument: async (invoice) => { estimatedInvoice = invoice; return { page_count: 1, page_count_mode: "final_renderer", credit_cost: 0, amount_fcfa: 50000 }; } });
  const init = await api.handle({ action: "INIT", flow_token: "journey-token" });
  const draftId = init.value.data.draft_id;
  const client = await api.handle({ action: "data_exchange", flow_token: "journey-token", data: {
    intent: "save_client", draft_id: draftId, client_type: "individual", client_name: "Ben",
  } });
  assert.deepEqual(Object.keys(client.value.data).sort(), ["draft_id", "item_count", "items_summary", "provisional_subtotal"].sort());
  const cart = await api.handle({ action: "data_exchange", flow_token: "journey-token", data: {
    intent: "submit_article", draft_id: draftId, item_count: 0, description: "Ordinateur", quantity: 1, unit: "unit", unit_price: 50000, decision: "finish",
  } });
  assert.equal(cart.value.screen, "OPTIONS");
  const estimate = await api.handle({ action: "data_exchange", flow_token: "journey-token", data: {
    intent: "save_options", draft_id: draftId,
  } });
  assert.equal(estimate.value.screen, "DOCUMENT_ESTIMATE");
  assert.equal(estimatedInvoice.tax_status, "not_applicable");
  assert.equal(estimatedInvoice.add_stamp, false);
  assert.deepEqual(estimate.value.data, {
    item_count: 1,
    page_count_text: "1",
    page_count_mode_text: "Comptage issu du renderer PDF Kadi final",
    credit_cost_text: "0",
    amount_fcfa_text: "50000 FCFA",
    estimate_notice: "Estimation locale uniquement : aucun débit et aucun envoi PDF.",
  });
});
