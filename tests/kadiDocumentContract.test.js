"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DOCUMENT_COMPLIANCE_STATUSES,
  DOCUMENT_DRAFT_FIELDS,
  DOCUMENT_TYPES,
  FEC_RESERVED_FIELDS,
  FUTURE_QUOTE_FIELDS,
  FUTURE_RECEIPT_FIELDS,
  ISSUER_PROFILE_FIELDS,
  UNREGISTERED_DOCUMENT_NOTICE,
  createReservedFecContract,
  normalizeIssuerProfile,
  resolveInvoiceComplianceStatus,
  resolveInvoiceDocumentType,
  resolveSafeDocumentLabel,
} = require("../kadiDocumentContract");

test("generic document contract reserves invoice, sales note, quote and receipt", () => {
  assert.deepEqual(DOCUMENT_TYPES, ["quote", "invoice", "receipt", "sales_note"]);
  assert.ok(DOCUMENT_DRAFT_FIELDS.includes("currency"));
  assert.ok(DOCUMENT_DRAFT_FIELDS.includes("grand_total"));
  assert.ok(FUTURE_QUOTE_FIELDS.includes("converted_to_invoice_id"));
  assert.ok(FUTURE_RECEIPT_FIELDS.includes("related_invoice_id"));
  assert.equal(ISSUER_PROFILE_FIELDS.length, 19);
  assert.deepEqual(DOCUMENT_COMPLIANCE_STATUSES, [
    "commercial_document",
    "structured_invoice",
    "fec_certified",
  ]);
});

test("registered RCCM issuer resolves to a structured commercial invoice", () => {
  const issuer = normalizeIssuerProfile({
    issuer_registration_status: "registered_rccm",
    issuer_legal_name: "  Société Kadi  ",
    issuer_ifu: "IFU-FICTIF",
  });

  assert.equal(issuer.issuer_legal_name, "Société Kadi");
  assert.equal(resolveSafeDocumentLabel(issuer), "FACTURE COMMERCIALE");
  assert.equal(resolveInvoiceDocumentType(issuer), "invoice");
  assert.equal(resolveInvoiceComplianceStatus(issuer), "structured_invoice");
});

test("registered professional issuer resolves to a structured commercial invoice", () => {
  const issuer = normalizeIssuerProfile({
    issuer_registration_status: "registered_professional",
    issuer_registry_type: "Registre professionnel fictif",
  });

  assert.equal(resolveSafeDocumentLabel(issuer), "FACTURE COMMERCIALE");
  assert.equal(resolveInvoiceDocumentType(issuer), "invoice");
  assert.equal(resolveInvoiceComplianceStatus(issuer), "structured_invoice");
});

test("unregistered or unknown issuer remains accessible as a sales document", () => {
  for (const issuer of [
    normalizeIssuerProfile({ issuer_registration_status: "unregistered" }),
    normalizeIssuerProfile({}),
    normalizeIssuerProfile(null),
  ]) {
    assert.equal(resolveSafeDocumentLabel(issuer), "DOCUMENT DE VENTE");
    assert.equal(resolveInvoiceDocumentType(issuer), "sales_note");
    assert.equal(resolveInvoiceComplianceStatus(issuer), "commercial_document");
  }
  assert.match(UNREGISTERED_DOCUMENT_NOTICE, /pas une facture fiscale certifiée/i);
});

test("safe labels can never claim normalization, certification, FEC or DGI", () => {
  for (const status of [
    "registered_rccm",
    "registered_professional",
    "unregistered",
    "fec_certified",
    null,
  ]) {
    const label = resolveSafeDocumentLabel({ issuer_registration_status: status });
    assert.doesNotMatch(label, /NORMALIS|CERTIFI|FEC|DGI/i);
  }
});

test("reserved FEC fields are exact, immutable and null", () => {
  const fec = createReservedFecContract();
  assert.deepEqual(Object.keys(fec), FEC_RESERVED_FIELDS);
  assert.ok(Object.values(fec).every((value) => value === null));
  assert.equal(Object.isFrozen(fec), true);
});

test("issuer normalization never invents missing registration data", () => {
  const issuer = normalizeIssuerProfile({
    issuer_registration_status: "unregistered",
    extra_secret: "not copied",
  });
  assert.deepEqual(Object.keys(issuer), ISSUER_PROFILE_FIELDS);
  assert.equal(issuer.issuer_ifu, null);
  assert.equal(issuer.issuer_registry_number, null);
  assert.equal(Object.hasOwn(issuer, "extra_secret"), false);
});
