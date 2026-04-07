"use strict";

const { parseVoiceText } = require("./kadiVoiceParser");

// ===============================
// DÉTECTION DES MANQUES
// ===============================
function detectMissing(intent) {
  const missing = [];

  if (!intent.client) missing.push("client");

  const items = intent.items || [];
  if (!items.length) missing.push("items");

  const itemsMissingPrice = items.filter((i) => !i.unitPrice);
  if (itemsMissingPrice.length > 0) missing.push("price");

  return missing;
}

// ===============================
// NORMALISATION LABELS
// ===============================
function cleanLabel(label = "") {
  return label
    .replace(/fenetre/i, "Fenêtre")
    .replace(/porte/i, "Porte")
    .replace(/produit/i, "Produit")
    .trim();
}

// ===============================
// BUILD INTENT
// ===============================
function buildIntent(rawText) {
  const parsed = parseVoiceText(rawText);

  const intent = {
    type: "create_document",
    docType: "devis", // V1 simple
    client: parsed.client,
    items: (parsed.items || []).map((i) => ({
      label: cleanLabel(i.label),
      qty: i.qty || 1,
      unitPrice: i.unitPrice || null,
    })),
    confidence: parsed.confidence,
  };

  intent.missing = detectMissing(intent);

  return intent;
}

module.exports = {
  buildIntent,
};