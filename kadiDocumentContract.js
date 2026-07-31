"use strict";

const ISSUER_REGISTRATION_STATUSES = Object.freeze([
  "registered_rccm",
  "registered_professional",
  "unregistered",
]);

const DOCUMENT_COMPLIANCE_STATUSES = Object.freeze([
  "commercial_document",
  "structured_invoice",
  "fec_certified",
]);

const DOCUMENT_TYPES = Object.freeze([
  "quote",
  "invoice",
  "receipt",
  "sales_note",
]);

const ISSUER_PROFILE_FIELDS = Object.freeze([
  "issuer_registration_status",
  "issuer_legal_name",
  "issuer_trade_name",
  "issuer_first_name",
  "issuer_last_name",
  "issuer_legal_form",
  "issuer_ifu",
  "issuer_registry_type",
  "issuer_registry_number",
  "issuer_tax_regime",
  "issuer_tax_office",
  "issuer_geographical_address",
  "issuer_cadastral_address",
  "issuer_postal_address",
  "issuer_phone",
  "issuer_email",
  "issuer_bank_references",
  "issuer_logo_reference",
  "issuer_stamp_reference",
]);

const FEC_RESERVED_FIELDS = Object.freeze([
  "fec_status",
  "secef_code",
  "machine_nim",
  "certification_qr_payload",
  "certification_reference",
  "certified_at",
]);

const FUTURE_QUOTE_FIELDS = Object.freeze([
  "quote_number",
  "quote_issue_date",
  "validity_days",
  "valid_until",
  "execution_delay",
  "delivery_delay",
  "payment_terms",
  "special_conditions",
  "converted_to_invoice_id",
]);

const FUTURE_RECEIPT_FIELDS = Object.freeze([
  "receipt_number",
  "payment_date",
  "payer_name",
  "amount_received",
  "payment_method",
  "payment_reference",
  "payment_reason",
  "related_invoice_id",
  "balance_remaining",
]);

const DOCUMENT_DRAFT_FIELDS = Object.freeze([
  "document_type",
  "document_label",
  "document_compliance_status",
  "document_number",
  "issue_date",
  "transaction_date",
  "currency",
  "issuer",
  "client",
  "items",
  "tax_status",
  "tax_rate",
  "subtotal_excluding_tax",
  "discount_total",
  "taxable_amount",
  "tax_total",
  "grand_total",
  "amount_paid",
  "balance_due",
  "payment_method",
  "payment_terms",
  "due_date",
  "note",
  "add_stamp",
]);

const MAX_ISSUER_TEXT_LENGTH = 500;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const UNREGISTERED_DOCUMENT_NOTICE =
  "Ce document de vente n’est pas une facture fiscale certifiée.";

function isPlainRecord(value) {
  if (value === null || typeof value !== "object") return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function readOwnDataValue(source, key) {
  if (!isPlainRecord(source)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function cleanOptionalIssuerText(value) {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(CONTROL_CHARACTERS, "")
    .trim()
    .slice(0, MAX_ISSUER_TEXT_LENGTH);
  return cleaned || null;
}

function normalizeIssuerProfile(source) {
  const status = readOwnDataValue(source, "issuer_registration_status");
  const normalized = {
    issuer_registration_status: ISSUER_REGISTRATION_STATUSES.includes(status)
      ? status
      : null,
  };

  for (const field of ISSUER_PROFILE_FIELDS.slice(1)) {
    normalized[field] = cleanOptionalIssuerText(readOwnDataValue(source, field));
  }

  return Object.freeze(normalized);
}

function resolveSafeDocumentLabel(issuerProfile) {
  const status = readOwnDataValue(issuerProfile, "issuer_registration_status");
  return status === "registered_rccm" || status === "registered_professional"
    ? "FACTURE COMMERCIALE"
    : "DOCUMENT DE VENTE";
}

function resolveInvoiceDocumentType(issuerProfile) {
  return resolveSafeDocumentLabel(issuerProfile) === "FACTURE COMMERCIALE"
    ? "invoice"
    : "sales_note";
}

function resolveInvoiceComplianceStatus(issuerProfile) {
  return resolveSafeDocumentLabel(issuerProfile) === "FACTURE COMMERCIALE"
    ? "structured_invoice"
    : "commercial_document";
}

function createReservedFecContract() {
  return Object.freeze({
    fec_status: null,
    secef_code: null,
    machine_nim: null,
    certification_qr_payload: null,
    certification_reference: null,
    certified_at: null,
  });
}

module.exports = {
  DOCUMENT_COMPLIANCE_STATUSES,
  DOCUMENT_DRAFT_FIELDS,
  DOCUMENT_TYPES,
  FEC_RESERVED_FIELDS,
  FUTURE_QUOTE_FIELDS,
  FUTURE_RECEIPT_FIELDS,
  ISSUER_PROFILE_FIELDS,
  ISSUER_REGISTRATION_STATUSES,
  UNREGISTERED_DOCUMENT_NOTICE,
  createReservedFecContract,
  normalizeIssuerProfile,
  resolveInvoiceComplianceStatus,
  resolveInvoiceDocumentType,
  resolveSafeDocumentLabel,
};
