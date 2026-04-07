"use strict";

const {
  MOORE_NUMBER_MAP,
  MOORE_DOC_WORDS,
  MOORE_CLIENT_WORDS,
  MOORE_ACTION_WORDS,
  MOORE_PRICE_WORDS,
  MOORE_PRODUCT_WORDS,
  FRENCH_VARIANTS,
} = require("../kadiMooreLexicon");

const {
  normalizeWhitespace,
  replaceWholeWord,
  replaceFromMap,
} = require("./kadiNormalizeCommon");

// ======================================================
// MONEY / NUMBER NORMALIZATION
// ======================================================
function normalizeLocalMoney(text = "") {
  let out = String(text || "");

  // 5k -> 5000
  out = out.replace(/\b(\d+)\s*k\b/gi, (_, n) => String(Number(n) * 1000));

  // 25 mille -> 25000
  out = out.replace(/\b(\d+)\s*mille\b/gi, (_, n) => String(Number(n) * 1000));

  // 5 barres -> 5000
  out = out.replace(/\b(\d+)\s+barres?\b/gi, (_, n) => String(Number(n) * 1000));

  return out;
}

function normalizeMooreNumbers(text = "") {
  let out = String(text || "");

  for (const [word, value] of Object.entries(MOORE_NUMBER_MAP || {})) {
    out = replaceWholeWord(out, word, String(value));
  }

  // Exemple: "5 1000" -> "5000"
  out = out.replace(/\b(\d+)\s+1000\b/g, (_, n) => String(Number(n) * 1000));

  return out;
}

// ======================================================
// BUSINESS HINTS
// ======================================================
function normalizeDocHints(text = "") {
  let out = String(text || "");

  out = replaceFromMap(out, MOORE_DOC_WORDS);
  out = replaceFromMap(out, MOORE_CLIENT_WORDS);
  out = replaceFromMap(out, MOORE_ACTION_WORDS);
  out = replaceFromMap(out, MOORE_PRICE_WORDS);
  out = replaceFromMap(out, MOORE_PRODUCT_WORDS);
  out = replaceFromMap(out, FRENCH_VARIANTS);

  return out;
}

function cleanupBusinessText(text = "") {
  return normalizeWhitespace(
    String(text || "")
      .replace(/\bfaire moi\b/g, "fais moi")
      .replace(/\bfait moi\b/g, "fais moi")
      .replace(/\bcree moi\b/g, "cree")
      .replace(/\bcreer moi\b/g, "cree")
  );
}

// ======================================================
// PUBLIC
// ======================================================
function normalizeMooreBusiness(text = "") {
  let out = String(text || "");
  out = normalizeMooreNumbers(out);
  out = normalizeDocHints(out);
  out = normalizeLocalMoney(out);
  out = cleanupBusinessText(out);
  return out;
}

module.exports = {
  normalizeMooreBusiness,
  normalizeMooreNumbers,
  normalizeDocHints,
  normalizeLocalMoney,
};