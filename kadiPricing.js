"use strict";

const PRICING = {
  PDF_SIMPLE: 1,
  DECHARGE: 2,
  OCR: 2,
  VOICE: 2,
  STAMP_PER_DOC: 1,
  LOGO_GENERATE: 2,
};

// ===============================
// CALCUL PDF
// ===============================
function computePdfCost(draft, options = {}) {
  let cost = 0;

  if (draft?.type === "decharge") {
    cost += PRICING.DECHARGE;
  } else {
    cost += PRICING.PDF_SIMPLE;
  }

  if (options.withStamp) {
    cost += PRICING.STAMP_PER_DOC;
  }

  return cost;
}

// ===============================
// TEXT DISPLAY
// ===============================
function formatPdfCostMessage(cost, withStamp) {
  if (withStamp) {
    return `📄 Document : 1 crédit\n🟦 Tampon : +1 crédit\n\n👉 Total : ${cost} crédits`;
  }

  return `📄 Document : ${cost} crédit`;
}

// ===============================
// CHECK BALANCE
// ===============================
function hasEnoughCredits(balance, cost) {
  return Number(balance || 0) >= Number(cost || 0);
}

module.exports = {
  PRICING,
  computePdfCost,
  formatPdfCostMessage,
  hasEnoughCredits,
};