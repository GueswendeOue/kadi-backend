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

test("terminal estimate bindings stay safe when business values are absent", () => {
  for (const estimate of [null, undefined, {}, { page_count: null, credit_cost: undefined, amount_fcfa: null }]) {
    const data = estimateData(estimate, 0);
    assert.equal(typeof data.item_count_text, "string");
    assert.equal(typeof data.page_count_text, "string");
    assert.equal(typeof data.source_text, "string");
    assert.equal(typeof data.credit_cost_text, "string");
    assert.equal(typeof data.amount_fcfa_text, "string");
    assert.ok(data.item_count_text.length > 0);
    assert.ok(data.page_count_text.length > 0);
    assert.ok(data.source_text.length > 0);
    assert.ok(data.credit_cost_text.length > 0);
    assert.ok(data.amount_fcfa_text.length > 0);
  }
});

test("add returns Article 2 with Form reset values while preserving the first item summary", async () => {
  const api = endpoint();
  const init = await api.handle({ action: "INIT", flow_token: "synthetic-token", version: "3.0" });
  const draftId = init.value.data.draft_id;
  const client = await api.handle({ action: "data_exchange", flow_token: "synthetic-token", version: "3.0", data: { intent: "save_client", draft_id: draftId, client_type: "individual", client_name: "Awa" } });
  assert.equal(client.value.screen, "ARTICLE_CART");
  const request = { action: "data_exchange", flow_token: "synthetic-token", version: "3.0", data: { intent: "submit_article", draft_id: draftId, item_count: 0, description: "Ordinateur", quantity: 1, unit: "unit", unit_price: 150000, decision: "add" } };
  const added = await api.handle(request);
  assert.equal(added.value.screen, "ARTICLE_CART");
  assert.equal(added.value.data.item_count, "1");
  assert.equal(typeof added.value.data.item_count, "string");
  assert.match(added.value.data.items_summary, /Ordinateur — 1 ×/);
  assert.match(added.value.data.saved_items_summary, /Ordinateur — 1 ×/);
  assert.equal(added.value.data.provisional_subtotal, "150 000 FCFA");
  assert.equal(added.value.data.saved_subtotal_text, "150 000 FCFA");
  assert.deepEqual(added.value.data.article_form_init_values, {
    item_description: "",
    item_quantity: "1",
    item_unit_price: "",
  });
  assert.equal(Object.values(added.value.data.article_form_init_values).every((value) => typeof value === "string"), true);
  assert.equal(added.value.data.item_unit, "");
  assert.equal(added.value.data.article_decision, "");
  assert.equal(added.value.data.item_number_text, "Article 2");
  assert.equal(added.value.data.saved_item_count_text, "1 article enregistré");
  const retried = await api.handle(request);
  assert.equal(retried.value.data.item_count, "1");
  assert.deepEqual(retried.value.data.article_form_init_values, added.value.data.article_form_init_values);
});

test("finish adds the last item once, advances to OPTIONS and rejects an empty submission", async () => {
  const api = endpoint();
  const init = await api.handle({ action: "INIT", flow_token: "finish-token", version: "3.0" });
  const draftId = init.value.data.draft_id;
  await api.handle({ action: "data_exchange", flow_token: "finish-token", version: "3.0", data: { intent: "save_client", draft_id: draftId, client_type: "individual", client_name: "Awa" } });
  const finishRequest = { action: "data_exchange", flow_token: "finish-token", version: "3.0", data: { intent: "submit_article", draft_id: draftId, item_count: 0, description: "Service", quantity: 1, unit: "piece", unit_price: 1000, decision: "finish" } };
  const finish = await api.handle(finishRequest);
  assert.equal(finish.value.screen, "OPTIONS");
  assert.equal(finish.value.data.item_count, "1");
  const retried = await api.handle(finishRequest);
  assert.equal(retried.value.screen, "OPTIONS");
  assert.equal(retried.value.data.item_count, "1");

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
  assert.equal(result.value.screen, "REVIEW_INVOICE_DRAFT");
  assert.equal(result.value.data.page_count_mode_text, "Comptage issu du renderer PDF Kadi final");
  assert.equal(estimatedInvoice.subject, "Conseil");
  assert.equal(estimatedInvoice.transaction_date, null);
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
  assert.deepEqual(Object.keys(client.value.data).sort(), [
    "article_decision", "article_form_init_values", "current_item_id", "draft_id", "item_count", "item_number_text",
    "item_unit", "items_summary",
    "provisional_subtotal", "return_to_review", "saved_item_count_text", "saved_items_summary", "saved_subtotal_text",
  ].sort());
  assert.equal(client.value.data.item_count, "0");
  assert.equal(typeof client.value.data.item_count, "string");
  assert.equal(client.value.data.item_number_text, "Article 1");
  const cart = await api.handle({ action: "data_exchange", flow_token: "journey-token", data: {
    intent: "submit_article", draft_id: draftId, item_count: 0, description: "Ordinateur", quantity: 1, unit: "unit", unit_price: 50000, decision: "finish",
  } });
  assert.equal(cart.value.screen, "OPTIONS");
  const estimate = await api.handle({ action: "data_exchange", flow_token: "journey-token", data: {
    intent: "save_options", draft_id: draftId,
  } });
  assert.equal(estimate.value.screen, "REVIEW_INVOICE_DRAFT");
  assert.equal(estimatedInvoice.tax_status, "not_applicable");
  assert.equal(estimatedInvoice.add_stamp, undefined);
  assert.equal(estimate.value.data.total_text, "50 000 FCFA");
  const final = await api.handle({ action: "data_exchange", flow_token: "journey-token", data: { intent: "review_action", draft_id: draftId, review_action: "confirm_generate" } });
  assert.equal(final.value.screen, "DOCUMENT_ESTIMATE");
  assert.equal(final.value.data.item_count_text, "1 article");
  assert.equal(final.value.data.source_text, "Brouillon Flow");
  assert.match(final.value.data.message, /brouillon de facture a été enregistré/);
});

test("Flow item_count remains a string for two internal numeric items", async () => {
  let estimated = null;
  const api = endpoint({ estimateDocument: async (invoice) => { estimated = invoice; return { page_count: 1, page_count_mode: "final_renderer", credit_cost: 0, amount_fcfa: 300000 }; } });
  const init = await api.handle({ action: "INIT", flow_token: "two-items-token" });
  const draftId = init.value.data.draft_id;
  await api.handle({ action: "data_exchange", flow_token: "two-items-token", data: {
    intent: "save_client", draft_id: draftId, client_type: "individual", client_name: "Ben",
  } });
  const first = await api.handle({ action: "data_exchange", flow_token: "two-items-token", data: {
    intent: "submit_article", draft_id: draftId, item_count: 0, description: "Ordinateur", quantity: 1, unit: "unit", unit_price: 150000, decision: "add_another",
  } });
  assert.equal(first.value.data.item_count, "1");
  const secondRequest = { action: "data_exchange", flow_token: "two-items-token", data: {
    intent: "submit_article", draft_id: draftId, item_count: 1, description: "Souris", quantity: 1, unit: "unit", unit_price: 150000, decision: "finish_items",
  } };
  const second = await api.handle(secondRequest);
  assert.equal(second.value.screen, "OPTIONS");
  assert.equal(second.value.data.item_count, "2");
  assert.equal(typeof second.value.data.item_count, "string");
  const retriedSecond = await api.handle(secondRequest);
  assert.equal(retriedSecond.value.data.item_count, "2");
  const estimate = await api.handle({ action: "data_exchange", flow_token: "two-items-token", data: {
    intent: "save_options", draft_id: draftId,
  } });
  assert.equal(estimate.value.screen, "REVIEW_INVOICE_DRAFT");
  assert.equal(estimated.subtotal_excluding_tax, 300000);
  const final = await api.handle({ action: "data_exchange", flow_token: "two-items-token", data: { intent: "review_action", draft_id: draftId, review_action: "confirm_generate" } });
  assert.equal(final.value.screen, "DOCUMENT_ESTIMATE");
  assert.equal(final.value.data.item_count_text, "2 articles");
  assert.equal(final.value.data.source_text, "Brouillon Flow");
});

test("review actions preserve the draft and server-finalize only in draft mode", async () => {
  const api = endpoint();
  const init = await api.handle({ action: "INIT", flow_token: "review-token" });
  const draftId = init.value.data.draft_id;
  await api.handle({ action: "data_exchange", flow_token: "review-token", data: {
    intent: "save_client", draft_id: draftId, client_type: "individual", client_name: "Ben",
  } });
  await api.handle({ action: "data_exchange", flow_token: "review-token", data: {
    intent: "submit_article", draft_id: draftId, description: "Ordinateur", quantity: 1, unit: "unit", unit_price: 150000, decision: "finish_items",
  } });
  const review = await api.handle({ action: "data_exchange", flow_token: "review-token", data: { intent: "save_options", draft_id: draftId, tax_status: "not_applicable" } });
  assert.equal(review.value.screen, "REVIEW_INVOICE_DRAFT");
  const modifyClient = await api.handle({ action: "data_exchange", flow_token: "review-token", data: { intent: "review_action", draft_id: draftId, review_action: "modify_client" } });
  assert.equal(modifyClient.value.screen, "CLIENT");
  assert.equal(modifyClient.value.data.client_name, "Ben");
  const modifyItems = await api.handle({ action: "data_exchange", flow_token: "review-token", data: { intent: "review_action", draft_id: draftId, review_action: "modify_items" } });
  assert.equal(modifyItems.value.screen, "ARTICLE_CART");
  assert.equal(modifyItems.value.data.item_count, "1");
  const modifyOptions = await api.handle({ action: "data_exchange", flow_token: "review-token", data: { intent: "review_action", draft_id: draftId, review_action: "modify_options" } });
  assert.equal(modifyOptions.value.screen, "OPTIONS");
  const final = await api.handle({ action: "data_exchange", flow_token: "review-token", data: { intent: "review_action", draft_id: draftId, review_action: "confirm_generate" } });
  assert.equal(final.value.screen, "DOCUMENT_ESTIMATE");
  assert.match(final.value.data.issued_at_local, /\d{2}:\d{2}:\d{2}/);
  assert.match(final.value.data.message, /brouillon de facture/);
  const retry = await api.handle({ action: "data_exchange", flow_token: "review-token", data: { intent: "review_action", draft_id: draftId, review_action: "confirm_generate" } });
  assert.equal(retry.value.screen, "DOCUMENT_ESTIMATE");
});
