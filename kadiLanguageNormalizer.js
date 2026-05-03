"use strict";

const {
  normalizeCommonDisplay,
  normalizeCommonParse,
} = require("./normalizers/kadiNormalizeCommon");

const {
  normalizeMooreBusiness,
} = require("./normalizers/kadiNormalizeMoore");

function normalizeFrenchBusiness(text = "") {
  let out = String(text || "");

  const replacements = [
    ["trente-cinq mille", "35000"],
    ["vingt-cinq mille", "25000"],
    ["cinquante mille", "50000"],
    ["vingt mille", "20000"],
    ["quinze mille", "15000"],
    ["dix mille", "10000"],
    ["cinq mille", "5000"],
  ];

  for (const [from, to] of replacements) {
    out = out.replace(new RegExp(`\\b${from}\\b`, "gi"), to);
  }

  out = out.replace(
    /\bdeux\s+(portes?|fenetres?|fenêtres?|tables?|chaises?|pagnes?|sacs?|accessoires?)\b/gi,
    "2 $1"
  );

  return out;
}

function uniqueList(items = []) {
  return Array.from(new Set((items || []).filter(Boolean)));
}

function normalizeBusinessInput(text = "", options = {}) {
  const rawText = String(text || "");
  const localeHint = String(options.localeHint || "").trim() || null;

  const requestedLanguages = Array.isArray(options.languages)
    ? options.languages
    : ["fr"];

  const languages = uniqueList(requestedLanguages.map((x) => String(x).toLowerCase()));

  const displayText = normalizeCommonDisplay(rawText);

  let parseText = normalizeCommonParse(rawText);

  // couche français / standard
  if (languages.includes("fr")) {
    parseText = normalizeFrenchBusiness(parseText);
  }

  // couche mooré
  if (languages.includes("moore")) {
    parseText = normalizeMooreBusiness(parseText);
  }

  return {
    rawText,
    displayText,
    parseText,
    localeHint,
    detectedLanguages: languages,
  };
}

module.exports = {
  normalizeBusinessInput,
  normalizeFrenchBusiness,
};
