"use strict";

function normalizeWhitespace(text = "") {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function stripAccents(text = "") {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeQuotes(text = "") {
  return String(text || "")
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'");
}

function normalizeCommonDisplay(text = "") {
  return normalizeWhitespace(normalizeQuotes(String(text || "")));
}

function normalizeCommonParse(text = "") {
  return normalizeWhitespace(
    normalizeQuotes(stripAccents(String(text || "")).toLowerCase())
  );
}

function escapeRegExp(text = "") {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceWholeWord(text, from, to) {
  const escaped = escapeRegExp(String(from || ""));
  return String(text || "").replace(new RegExp(`\\b${escaped}\\b`, "gi"), to);
}

function replaceFromMap(text = "", map = {}) {
  let out = String(text || "");
  const entries = Object.entries(map || {}).sort(
    (a, b) => String(b[0]).length - String(a[0]).length
  );

  for (const [from, to] of entries) {
    out = replaceWholeWord(out, from, String(to));
  }

  return out;
}

module.exports = {
  normalizeWhitespace,
  stripAccents,
  normalizeQuotes,
  normalizeCommonDisplay,
  normalizeCommonParse,
  escapeRegExp,
  replaceWholeWord,
  replaceFromMap,
};