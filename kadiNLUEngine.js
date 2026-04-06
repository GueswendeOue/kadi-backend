"use strict";

const { parseNaturalWithOpenAI } = require("./kadiNLU");
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

  const items = extractItemsFromText(text);

  const draft = autoFixDraft({
    docType: result?.docType || "devis",
    client: result?.client || detectClient(text) || "Client",
    items,
  });

  return draft;
}

module.exports = { kadiNLUEngine };