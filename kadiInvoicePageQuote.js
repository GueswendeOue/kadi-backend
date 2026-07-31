"use strict";

const POLICIES = Object.freeze({
  ONE_CREDIT_PER_PAGE: (pages) => pages,
  ONE_CREDIT_PER_TWO_PAGES: (pages) => Math.ceil(pages / 2),
});

function quoteInvoicePages({ page_count, policy_id, credit_value_fcfa }) {
  if (!Number.isInteger(page_count) || page_count < 1) return { ok: false, error: "PAGE_COUNT_INVALID" };
  if (!Object.hasOwn(POLICIES, policy_id)) return { ok: false, error: "PRICING_POLICY_REQUIRED" };
  if (!Number.isSafeInteger(credit_value_fcfa) || credit_value_fcfa < 0) return { ok: false, error: "CREDIT_VALUE_INVALID" };
  const creditCost = POLICIES[policy_id](page_count);
  const amount = creditCost * credit_value_fcfa;
  if (!Number.isSafeInteger(amount)) return { ok: false, error: "QUOTE_OVERFLOW" };
  return { ok: true, value: Object.freeze({
    page_count,
    credit_cost: creditCost,
    amount_fcfa: amount,
    policy_id,
    explanation: `${page_count} page(s), ${creditCost} crédit(s). Aucun débit effectué.`,
    production_debit_authorized: false,
    debit_performed: false,
  }) };
}

module.exports = { POLICIES, quoteInvoicePages };
