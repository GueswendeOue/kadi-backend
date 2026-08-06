"use strict";

// Canonical, reference-based filename for a delivered final document —
// replaces the old generic "facture.pdf"/"recu.pdf" pattern (unsuitable for
// repeated professional use: every document from the same owner overwrote
// the same filename on the recipient's device). Deterministic and stable
// across delivery retries: same document_type/invoice_kind/document_number
// always produces the same filename, computed fresh wherever it's needed
// (WhatsApp delivery, delivery retry, history/download projection) rather
// than stored once and risking drift between layers.
const PREFIXES = Object.freeze({
  FACTURE: "facture",
  DEVIS: "devis",
  RECU: "recu",
  DECHARGE: "decharge",
});
const DOCUMENT_NUMBER_PATTERN = /^[A-Za-z0-9-]{1,80}$/;

function canonicalFinalFilename({ document_type, invoice_kind, document_number } = {}) {
  const prefix = PREFIXES[document_type];
  if (!prefix) return null;
  if (typeof document_number !== "string" || !DOCUMENT_NUMBER_PATTERN.test(document_number)) return null;
  const base = document_type === "FACTURE" && invoice_kind === "PROFORMA" ? "facture-proforma" : prefix;
  return `${base}_${document_number}.pdf`;
}

module.exports = { canonicalFinalFilename };
