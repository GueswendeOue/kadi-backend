"use strict";

const {
  createReservedFecContract,
  normalizeIssuerProfile,
  resolveInvoiceComplianceStatus,
  resolveInvoiceDocumentType,
  resolveSafeDocumentLabel,
} = require("./kadiDocumentContract");
const { MAX_INVOICE_ITEMS } = require("./kadiInvoiceLimits");

function ok(value) {
  return { ok: true, value };
}

function fail(error) {
  return { ok: false, error };
}

function roundPositiveRatio(numerator, denominator) {
  return (numerator + denominator / 2n) / denominator;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function calculateInvoiceFlowDraft(normalizedSubmission, issuerProfile = null) {
  if (!normalizedSubmission || typeof normalizedSubmission !== "object") {
    return fail("SUBMISSION_INVALID");
  }
  if (
    !Array.isArray(normalizedSubmission.items) ||
    normalizedSubmission.items.length < 1 ||
    normalizedSubmission.items.length > MAX_INVOICE_ITEMS
  ) {
    return fail("ITEM_COUNT_INVALID");
  }

  const calculatedItems = [];
  let subtotal = 0n;
  for (const item of normalizedSubmission.items) {
    if (
      !item ||
      typeof item.designation !== "string" ||
      !Number.isSafeInteger(item.quantity_millis) ||
      item.quantity_millis <= 0 ||
      !Number.isSafeInteger(item.unit_price) ||
      item.unit_price < 0
    ) {
      return fail("ITEM_INVALID");
    }
    const lineTotal = roundPositiveRatio(
      BigInt(item.quantity_millis) * BigInt(item.unit_price),
      1000n
    );
    subtotal += lineTotal;
    calculatedItems.push({
      designation: item.designation,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unit_price,
      line_total: safeNumber(lineTotal),
    });
  }

  if (!isSafeNonNegativeInteger(normalizedSubmission.discount_amount)) {
    return fail("DISCOUNT_INVALID");
  }
  const discount = BigInt(normalizedSubmission.discount_amount);
  if (discount < 0n || discount > subtotal) {
    return fail("DISCOUNT_EXCEEDS_SUBTOTAL");
  }
  const taxableAmount = subtotal - discount;
  if (!isSafeNonNegativeInteger(normalizedSubmission.tax_rate_basis_points)) {
    return fail("TAX_RATE_INVALID");
  }
  const rateBasisPoints = BigInt(normalizedSubmission.tax_rate_basis_points);
  if (
    normalizedSubmission.tax_status === "taxable" &&
    (rateBasisPoints <= 0n || rateBasisPoints > 10000n)
  ) {
    return fail("TAX_RATE_INVALID");
  }
  if (
    normalizedSubmission.tax_status !== "taxable" &&
    rateBasisPoints !== 0n
  ) {
    return fail("TAX_RATE_INVALID");
  }
  const taxTotal =
    normalizedSubmission.tax_status === "taxable"
      ? roundPositiveRatio(taxableAmount * rateBasisPoints, 10000n)
      : 0n;
  const grandTotal = taxableAmount + taxTotal;
  if (!isSafeNonNegativeInteger(normalizedSubmission.amount_paid)) {
    return fail("AMOUNT_PAID_INVALID");
  }
  const amountPaid = BigInt(normalizedSubmission.amount_paid);
  if (amountPaid < 0n || amountPaid > grandTotal) {
    return fail("AMOUNT_PAID_EXCEEDS_TOTAL");
  }
  const balanceDue = grandTotal - amountPaid;

  const numericValues = [
    subtotal,
    discount,
    taxableAmount,
    taxTotal,
    grandTotal,
    amountPaid,
    balanceDue,
  ].map(safeNumber);
  if (numericValues.some((value) => value === null)) return fail("TOTAL_OVERFLOW");

  const issuer = normalizeIssuerProfile(issuerProfile);
  const fec = createReservedFecContract();
  const draft = {
    document_type: resolveInvoiceDocumentType(issuer),
    document_label: resolveSafeDocumentLabel(issuer),
    document_compliance_status: resolveInvoiceComplianceStatus(issuer),
    document_number: null,
    issue_date: null,
    transaction_date: normalizedSubmission.transaction_date || null,
    subject: normalizedSubmission.invoice_subject || normalizedSubmission.client?.invoice_subject || null,
    currency: "XOF",
    issuer,
    client: {
      type: normalizedSubmission.client?.type || null,
      name: normalizedSubmission.client?.name || null,
      phone: normalizedSubmission.client?.phone || null,
      address: normalizedSubmission.client?.address || null,
      ifu: normalizedSubmission.client?.ifu || null,
      registry_number: normalizedSubmission.client?.registry_number || null,
    },
    items: calculatedItems,
    tax_status: normalizedSubmission.tax_status,
    tax_rate:
      normalizedSubmission.tax_status === "taxable"
        ? normalizedSubmission.tax_rate_basis_points / 100
        : 0,
    subtotal_excluding_tax: numericValues[0],
    discount_total: numericValues[1],
    taxable_amount: numericValues[2],
    tax_total: numericValues[3],
    grand_total: numericValues[4],
    amount_paid: numericValues[5],
    balance_due: numericValues[6],
    payment_method: normalizedSubmission.payment_method || null,
    payment_terms: normalizedSubmission.payment_terms || null,
    due_date: normalizedSubmission.due_date || null,
    note: normalizedSubmission.note || null,
    add_stamp: normalizedSubmission.add_stamp === true,
    ...fec,
  };

  return ok(draft);
}

module.exports = { calculateInvoiceFlowDraft };
