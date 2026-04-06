"use strict";

const { parseNaturalWithOpenAI } = require("./kadiOpenAI");
const { extractItemsFromText } = require("./kadiItemsExtractor");
const { detectClient } = require("./kadiClientDetector");
const { autoFixDraft } = require("./kadiAutoFix");

function splitMultiItems(text) {
  return text
    .replace(/\s+avec\s+/gi, "|")
    .replace(/\s+et\s+/gi, "|")
    .split("|")
    .map((t) => t.trim())
    .filter(Boolean);
}

async function kadiNLUEngine(text) {
  console.log("[KADI NLU ENGINE]", text);

  let result = await parseNaturalWithOpenAI(text);

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

  console.warn("[KADI NLU] FALLBACK GOD MODE");

  const parts = splitMultiItems(text);

  let items = [];

  for (const part of parts) {
    let extracted = extractItemsFromText(part) || [];

    extracted = extracted.map((item) => {
      const t = part.toLowerCase();

      let qty = item.qty || 1;
      let price = item.unitPrice || 0;

      if (/\bdeux\b|\b2\b/.test(t)) qty = 2;
      else if (/\btrois\b|\b3\b/.test(t)) qty = 3;
      else if (/\bquatre\b|\b4\b/.test(t)) qty = 4;

      const priceMatch =
        t.match(/(?:a|à)\s*(\d+(?:\s\d+)*)/) ||
        t.match(/(\d+(?:\s\d+)*)\s*(?:f|fcfa)?/);

      if (priceMatch) {
        price = Number(priceMatch[1].replace(/\s/g, ""));
      }

      return {
        label: item.label,
        qty,
        unitPrice: price,
      };
    });

    items.push(...extracted);
  }

  console.log("[KADI PATCH ITEMS]", items);

  const draft = autoFixDraft({
    docType: result?.docType || "devis",
    client: result?.client || detectClient(text) || "Client",
    items,
  });

  return draft;
}

module.exports = { kadiNLUEngine };