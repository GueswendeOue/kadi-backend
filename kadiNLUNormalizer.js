"use strict";

function normalizeNLU(raw) {
  let data;

  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }

  if (!data) return null;

  const items = (data.items || []).map((i) => {
    let qty = Number(i.qty) || 1;
    let price = Number(i.unitPrice) || 0;

    // 🔥 intelligence terrain
    if (qty > 1 && price > 100000) {
      price = Math.round(price / qty);
    }

    return {
      label: cleanLabel(i.label),
      qty,
      unitPrice: price,
    };
  });

  return {
    intent: data.intent || "unknown",
    docType: normalizeDocType(data.docType),
    client: cleanClient(data.client),
    items,
  };
}

function cleanLabel(l) {
  return String(l || "").toLowerCase().trim() || "article";
}

function cleanClient(c) {
  return c ? c.trim() : "Client";
}

function normalizeDocType(t) {
  const s = String(t || "").toLowerCase();

  if (s.includes("fact")) return "facture";
  if (s.includes("rec")) return "recu";
  return "devis";
}

module.exports = { normalizeNLU };