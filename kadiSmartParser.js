"use strict";

function parseKadiJSON(raw) {
  let data;

  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return fallbackParse(raw);
  }

  return normalizeData(data);
}

// 🔥 Normalisation intelligente
function normalizeData(data = {}) {
  const items = Array.isArray(data.items) ? data.items : [];

  const cleanItems = items.map((i) => {
    let qty = Number(i.qty) || 1;
    let price = Number(i.unitPrice) || 0;

    // 🔥 Cas intelligent :
    // "2 portes à 25000" → ok
    // "2 portes 25000" → on assume prix unitaire
    if (qty > 1 && price > 100000) {
      price = Math.round(price / qty);
    }

    return {
      label: (i.label || "").trim() || "Article",
      qty,
      unitPrice: price,
    };
  });

  const total =
    Number(data.total) ||
    cleanItems.reduce((sum, i) => sum + i.qty * i.unitPrice, 0);

  return {
    docType: normalizeDocType(data.docType),
    client: data.client || "Client",
    items: cleanItems,
    total,
  };
}

function normalizeDocType(type) {
  const t = String(type || "").toLowerCase();

  if (t.includes("fact")) return "facture";
  if (t.includes("rec")) return "recu";
  return "devis";
}

// 🔥 fallback si JSON cassé
function fallbackParse(text) {
  const t = String(text).toLowerCase();

  const match = t.match(/(\d+)\s*(.+?)\s*(\d+)/);

  if (!match) {
    return {
      docType: "devis",
      client: "Client",
      items: [],
      total: 0,
    };
  }

  return {
    docType: "devis",
    client: "Client",
    items: [
      {
        label: match[2],
        qty: Number(match[1]),
        unitPrice: Number(match[3]),
      },
    ],
    total: Number(match[1]) * Number(match[3]),
  };
}

module.exports = { parseKadiJSON };