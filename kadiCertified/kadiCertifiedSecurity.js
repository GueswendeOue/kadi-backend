"use strict";

const crypto = require("crypto");

function toNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function safeText(v, def = "") {
  const s = String(v ?? "").trim();
  return s || def;
}

function normalizePhone(v = "") {
  const digits = String(v || "").replace(/\D/g, "");
  return digits || null;
}

function normalizeStatus(status) {
  const s = safeText(status, "draft").toLowerCase();

  if (
    s === "draft" ||
    s === "pending" ||
    s === "certified" ||
    s === "rejected" ||
    s === "cancelled"
  ) {
    return s;
  }

  return "draft";
}

function isFinalCertifiedStatus(status) {
  const s = normalizeStatus(status);
  return s === "certified" || s === "cancelled";
}

function assertCanMutateCertifiedInvoice(invoice = null) {
  if (!invoice) return true;

  const status = normalizeStatus(invoice.status || invoice.compliance_status);

  if (isFinalCertifiedStatus(status) || invoice.locked === true) {
    throw new Error("CERTIFIED_INVOICE_LOCKED");
  }

  return true;
}

function assertValidVatRate(vatRate) {
  const n = toNum(vatRate, NaN);

  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error("CERTIFIED_INVALID_VAT_RATE");
  }

  return Number(n.toFixed(4));
}

function normalizeCertifiedItems(items = []) {
  const rows = (Array.isArray(items) ? items : [])
    .map((it, index) => {
      const designation = safeText(
        it?.designation ?? it?.label,
        ""
      ).slice(0, 200);

      const quantity = toNum(it?.quantity ?? it?.qty, 0);
      const unitPrice = toNum(it?.unit_price ?? it?.unitPrice, 0);

      const lineTotalHtRaw =
        it?.line_total_ht != null
          ? toNum(it.line_total_ht, NaN)
          : quantity * unitPrice;

      const lineTotalHt = Number(toNum(lineTotalHtRaw, 0).toFixed(2));

      return {
        line_number: index + 1,
        designation,
        quantity: Number(quantity.toFixed(3)),
        unit_price: Number(unitPrice.toFixed(2)),
        line_total_ht: lineTotalHt,
      };
    })
    .filter((it) => it.designation && it.quantity > 0);

  if (!rows.length) {
    throw new Error("CERTIFIED_ITEMS_REQUIRED");
  }

  return rows;
}

function computeCertifiedTotals({ items, vatRate = 0 }) {
  const normalizedItems = normalizeCertifiedItems(items);
  const safeVatRate = assertValidVatRate(vatRate);

  const totalHt = Number(
    normalizedItems
      .reduce((sum, it) => sum + toNum(it.line_total_ht, 0), 0)
      .toFixed(2)
  );

  const vatAmount = Number((totalHt * safeVatRate).toFixed(2));
  const totalTtc = Number((totalHt + vatAmount).toFixed(2));

  return {
    items: normalizedItems,
    vat_rate: safeVatRate,
    total_ht: totalHt,
    vat_amount: vatAmount,
    total_ttc: totalTtc,
  };
}

function buildCertifiedInvoiceNumber({ fiscalYear, sequenceNumber, prefix = "KADI-FEC-BF" }) {
  const year = Number(fiscalYear);
  const seq = String(Number(sequenceNumber) || 0).padStart(6, "0");

  if (!Number.isFinite(year) || year < 2024) {
    throw new Error("CERTIFIED_INVALID_FISCAL_YEAR");
  }

  if (!Number.isFinite(Number(sequenceNumber)) || Number(sequenceNumber) <= 0) {
    throw new Error("CERTIFIED_INVALID_SEQUENCE");
  }

  return `${prefix}-${year}-${seq}`;
}

function buildComplianceReference({
  fiscalYear,
  sequenceNumber,
  prefix = "KADI-CERT",
}) {
  const year = Number(fiscalYear);
  const seq = String(Number(sequenceNumber) || 0).padStart(6, "0");

  if (!Number.isFinite(year) || year < 2024) {
    throw new Error("CERTIFIED_INVALID_FISCAL_YEAR");
  }

  if (!Number.isFinite(Number(sequenceNumber)) || Number(sequenceNumber) <= 0) {
    throw new Error("CERTIFIED_INVALID_SEQUENCE");
  }

  return `${prefix}-${year}-${seq}`;
}

function buildCanonicalCertifiedPayload({
  invoiceNumber,
  fiscalYear,
  sequenceNumber,
  issuedAt,
  seller,
  buyer,
  items,
  vatRate,
  currency = "XOF",
  complianceVersion = 1,
}) {
  const sellerName = safeText(seller?.name);
  const sellerIfu = safeText(seller?.ifu);

  if (!sellerName) throw new Error("CERTIFIED_SELLER_NAME_REQUIRED");
  if (!sellerIfu) throw new Error("CERTIFIED_SELLER_IFU_REQUIRED");

  const buyerName = safeText(buyer?.name);
  if (!buyerName) throw new Error("CERTIFIED_BUYER_NAME_REQUIRED");

  const totals = computeCertifiedTotals({ items, vatRate });

  return {
    document_type: "facture_electronique_certifiee",
    invoice_number: safeText(invoiceNumber),
    fiscal_year: Number(fiscalYear),
    sequence_number: Number(sequenceNumber),
    issued_at: safeText(issuedAt),

    seller: {
      name: sellerName,
      ifu: sellerIfu,
      phone: normalizePhone(seller?.phone),
      address: safeText(seller?.address, null),
    },

    buyer: {
      name: buyerName,
      ifu: safeText(buyer?.ifu, null),
      phone: normalizePhone(buyer?.phone),
      address: safeText(buyer?.address, null),
    },

    currency: safeText(currency, "XOF"),
    vat_rate: totals.vat_rate,
    total_ht: totals.total_ht,
    vat_amount: totals.vat_amount,
    total_ttc: totals.total_ttc,
    compliance_version: Number(complianceVersion) || 1,

    items: totals.items.map((it) => ({
      line_number: it.line_number,
      designation: it.designation,
      quantity: it.quantity,
      unit_price: it.unit_price,
      line_total_ht: it.line_total_ht,
    })),
  };
}

function buildComplianceHash(payload) {
  const canonical = JSON.stringify(payload);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function buildVerificationPath(invoiceId) {
  const id = safeText(invoiceId);
  if (!id) throw new Error("CERTIFIED_INVOICE_ID_REQUIRED");
  return `/verify/certified/${id}`;
}

function buildVerificationUrl(invoiceId, baseUrl = "https://kadi.app") {
  const cleanBase = safeText(baseUrl, "https://kadi.app").replace(/\/+$/, "");
  return `${cleanBase}${buildVerificationPath(invoiceId)}`;
}

function buildQrPayload({ invoiceId, verificationUrl = null, baseUrl = "https://kadi.app" }) {
  return safeText(verificationUrl) || buildVerificationUrl(invoiceId, baseUrl);
}

module.exports = {
  toNum,
  safeText,
  normalizePhone,
  normalizeStatus,
  isFinalCertifiedStatus,
  assertCanMutateCertifiedInvoice,
  assertValidVatRate,
  normalizeCertifiedItems,
  computeCertifiedTotals,
  buildCertifiedInvoiceNumber,
  buildComplianceReference,
  buildCanonicalCertifiedPayload,
  buildComplianceHash,
  buildVerificationPath,
  buildVerificationUrl,
  buildQrPayload,
};