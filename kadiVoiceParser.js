"use strict";

// ===============================
// NORMALISATION TEXTE
// ===============================
function normalize(text = "") {
  return text
    .toLowerCase()
    .replace(/[,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ===============================
// NOMBRES (fr + local)
// ===============================
const NUMBER_WORDS = {
  un: 1,
  une: 1,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  six: 6,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10,
};

function parseQty(word) {
  if (!word) return 1;

  if (!isNaN(word)) return Number(word);

  if (NUMBER_WORDS[word]) return NUMBER_WORDS[word];

  return 1;
}

// ===============================
// PRIX (mille, k)
// ===============================
function parsePrice(text) {
  if (!text) return null;

  const clean = text.replace(/\s/g, "");

  // 50k
  if (/(\d+)k/.test(clean)) {
    return Number(clean.replace("k", "")) * 1000;
  }

  // 50 mille
  if (/(\d+)\s*mille/.test(text)) {
    const n = Number(text.match(/(\d+)/)[1]);
    return n * 1000;
  }

  // normal
  const num = Number(clean);
  return isNaN(num) ? null : num;
}

// ===============================
// EXTRACTION CLIENT
// ===============================
function extractClient(text) {
  const match =
    text.match(/pour\s+([a-zA-Z]+)/) ||
    text.match(/client\s+([a-zA-Z]+)/);

  return match ? match[1] : null;
}

// ===============================
// EXTRACTION ITEMS
// ===============================
function extractItems(text) {
  const parts = text.split(/et|,/);

  const items = [];

  for (let p of parts) {
    p = p.trim();

    // qty
    const qtyMatch = p.match(/(\d+|un|une|deux|trois|quatre)/);
    const qty = qtyMatch ? parseQty(qtyMatch[1]) : 1;

    // label
    const labelMatch = p.match(/porte|fenetre|fenêtre|table|chaise/i);
    const label = labelMatch ? labelMatch[0] : "Produit";

    // price
    const priceMatch = p.match(/(\d+\s*mille|\d+k|\d+)/i);
    const price = priceMatch ? parsePrice(priceMatch[0]) : null;

    items.push({
      label,
      qty,
      unitPrice: price,
    });
  }

  return items.filter((i) => i.label);
}

// ===============================
// SCORE CONFIANCE
// ===============================
function computeConfidence(data) {
  let score = 0;

  if (data.client) score += 0.3;
  if (data.items.length > 0) score += 0.3;

  const fullItems = data.items.filter((i) => i.unitPrice);
  if (fullItems.length === data.items.length) score += 0.4;

  return score;
}

// ===============================
// MAIN
// ===============================
function parseVoiceText(text) {
  const t = normalize(text);

  const result = {
    client: extractClient(t),
    items: extractItems(t),
  };

  result.confidence = computeConfidence(result);

  return result;
}

module.exports = {
  parseVoiceText,
};