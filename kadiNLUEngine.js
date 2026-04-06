"use strict";

const { parseNaturalWithOpenAI } = require("./kadiOpenAI");
const { extractItemsFromText } = require("./kadiItemsExtractor");
const { detectClient } = require("./kadiClientDetector");
const { autoFixDraft } = require("./kadiAutoFix");

async function kadiNLUEngine(text) {
  console.log("[KADI NLU ENGINE]", text);

  // 🔥 1. NLU STRICT (ton système actuel)
  let result = await parseNaturalWithOpenAI(text);

  // ✅ Si bon → on utilise
  if (
    result &&
    result.kind === "items" &&
    result.items &&
    result.items.length > 0 &&
    result.confidence > 0.6 &&
    !result.shouldFallbackToManual
  ) {
    console.log("[KADI NLU] STRICT OK");

    return autoFixDraft({
      docType: result.docType || "devis",
      client: result.client || detectClient(text) || "Client",
      items: result.items,
    });
  }

  // 🔥 2. GOD MODE FALLBACK
  console.warn("[KADI NLU] FALLBACK GOD MODE");

  let items = extractItemsFromText(text);

// 🔥 PATCH INTELLIGENT (qty + price)
items = items.map((item) => {
  const t = text.toLowerCase();

  let qty = item.qty || 1;
  let price = item.unitPrice || 0;

  // 🔢 Quantités
  if (/deux|2/.test(t)) qty = 2;
  else if (/trois|3/.test(t)) qty = 3;
  else if (/quatre|4/.test(t)) qty = 4;

  // 💰 Prix
  const priceMatch = t.match(/(\d+[\s\d]*)/);
  if (priceMatch) {
    price = Number(priceMatch[1].replace(/\s/g, ""));
  }

  return {
    label: item.label,
    qty,
    unitPrice: price,
  };
});

// DEBUG
console.log("[KADI PATCH ITEMS]", items);

  const draft = autoFixDraft({
    docType: result?.docType || "devis",
    client: result?.client || detectClient(text) || "Client",
    items,
  });

  return draft;
}

module.exports = { kadiNLUEngine };