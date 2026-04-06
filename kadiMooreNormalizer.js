"use strict";

const {
  MOORE_NUMBER_MAP,
  MOORE_DOC_WORDS,
  MOORE_CLIENT_WORDS,
  MOORE_ACTION_WORDS,
  MOORE_PRICE_WORDS,
  MOORE_PRODUCT_WORDS,
  FRENCH_VARIANTS,
} = require("./kadiMooreLexicon");

function stripAccents(text = "") {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function baseNormalize(text = "") {
  return stripAccents(text)
    .toLowerCase()
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function replaceWholeWord(text, from, to) {
  const escaped = String(from).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\b${escaped}\\b`, "gi"), to);
}

function replaceFromMap(text = "", map = {}) {
  let out = text;
  const entries = Object.entries(map).sort((a, b) => b[0].length - a[0].length);

  for (const [from, to] of entries) {
    out = replaceWholeWord(out, from, String(to));
  }

  return out;
}

function normalizeLocalMoney(text = "") {
  let out = text;

  // 5k -> 5000
  out = out.replace(/\b(\d+)\s*k\b/gi, (_, n) => String(Number(n) * 1000));

  // 25 mille -> 25000
  out = out.replace(/\b(\d+)\s*mille\b/gi, (_, n) => String(Number(n) * 1000));

  // 5 barres -> 5000
  out = out.replace(/\b(\d+)\s+barres?\b/gi, (_, n) => String(Number(n) * 1000));

  return out;
}

function normalizeMooreNumbers(text = "") {
  let out = text;

  // On remplace d'abord les mots-nombres mooré isolés
  for (const [word, value] of Object.entries(MOORE_NUMBER_MAP)) {
    out = replaceWholeWord(out, word, String(value));
  }

  // Cas comme "5 toukouli" => 5000
  out = out.replace(/\b(\d+)\s+1000\b/g, (_, n) => String(Number(n) * 1000));

  return out;
}

function normalizeDocHints(text = "") {
  let out = text;
  out = replaceFromMap(out, MOORE_DOC_WORDS);
  out = replaceFromMap(out, MOORE_CLIENT_WORDS);
  out = replaceFromMap(out, MOORE_ACTION_WORDS);
  out = replaceFromMap(out, MOORE_PRICE_WORDS);
  out = replaceFromMap(out, MOORE_PRODUCT_WORDS);
  out = replaceFromMap(out, FRENCH_VARIANTS);
  return out;
}

function cleanupBusinessText(text = "") {
  return String(text || "")
    .replace(/\bfaire moi\b/g, "fais moi")
    .replace(/\bfait moi\b/g, "fais moi")
    .replace(/\bcree moi\b/g, "cree")
    .replace(/\bcreer moi\b/g, "cree")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMooreBusinessText(text = "") {
  let out = baseNormalize(text);
  out = normalizeMooreNumbers(out);
  out = normalizeDocHints(out);
  out = normalizeLocalMoney(out);
  out = cleanupBusinessText(out);
  return out;
}

module.exports = {
  normalizeMooreBusinessText,
  baseNormalize,
  normalizeMooreNumbers,
  normalizeDocHints,
};