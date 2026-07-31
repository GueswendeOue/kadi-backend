"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { quoteInvoicePages } = require("../kadiInvoicePageQuote");

test("explicit page policies quote without debiting", () => {
  for (const [policy, pages, credits] of [["ONE_CREDIT_PER_PAGE", 3, 3], ["ONE_CREDIT_PER_TWO_PAGES", 1, 1], ["ONE_CREDIT_PER_TWO_PAGES", 2, 1], ["ONE_CREDIT_PER_TWO_PAGES", 3, 2], ["ONE_CREDIT_PER_TWO_PAGES", 6, 3]]) {
    const result = quoteInvoicePages({ page_count: pages, policy_id: policy, credit_value_fcfa: 100 });
    assert.equal(result.ok, true);
    assert.equal(result.value.credit_cost, credits);
    assert.equal(result.value.amount_fcfa, credits * 100);
    assert.equal(result.value.production_debit_authorized, false);
    assert.equal(result.value.debit_performed, false);
  }
});

test("pricing has no implicit production policy and rejects invalid numbers", () => {
  for (const args of [{ page_count: 0, policy_id: "ONE_CREDIT_PER_PAGE", credit_value_fcfa: 100 }, { page_count: 1, credit_value_fcfa: 100 }, { page_count: Infinity, policy_id: "ONE_CREDIT_PER_PAGE", credit_value_fcfa: 100 }, { page_count: 1, policy_id: "ONE_CREDIT_PER_PAGE", credit_value_fcfa: NaN }]) assert.equal(quoteInvoicePages(args).ok, false);
});
