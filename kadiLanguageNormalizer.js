"use strict";

const {
  normalizeCommonDisplay,
  normalizeCommonParse,
} = require("./normalizers/kadiNormalizeCommon");

const {
  normalizeMooreBusiness,
} = require("./normalizers/kadiNormalizeMoore");

// Placeholder futur
function normalizeFrenchBusiness(text = "") {
  return String(text || "");
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
};