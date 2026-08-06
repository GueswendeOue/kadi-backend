"use strict";

// Resolves a natural-language removal hint (e.g. "livraison") against the
// items ALREADY persisted on the active document — item_id/description come
// straight from kadiV1SharedDocumentPipeline.js's own item shape, nothing is
// invented or renumbered here. Exact-unique-description-match only: both "no
// match" and "multiple matches" fail closed to a clarifying question, never
// guessing which item the user meant.

function normalize(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    // Typographic quote/apostrophe variants are common on mobile keyboards
    // (auto-correct turns a plain ' into a curly '); canonicalize to the
    // plain ASCII forms already used everywhere else in this product
    // (kadiV1SharedDocumentPolicies.js's cleanText never rejects either
    // form) so the same word compares equal regardless of which one was
    // typed.
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    // Collapse any run of whitespace (double spaces, tabs) to one space
    // BEFORE trimming, so "table  en bois" and "table en bois" compare
    // equal regardless of which side (hint or stored description) has the
    // extra whitespace.
    .replace(/\s+/g, " ")
    .trim();
}

// Deterministic, not fuzzy/probabilistic: strips a single trailing "s" off
// a SINGLE whole word only (never a multi-word phrase, and never a word
// shorter than 3 characters). Restricted this narrowly on purpose — many
// legitimate French words already end in "s" in the singular (bois, repas,
// temps, palais...), and folding a whole multi-word phrase would only ever
// affect its last word anyway while producing a form nobody typed. This is
// combined with exact whole-string equality only (see resolveRemovalTarget)
// — never substring containment — specifically because a short folded word
// (e.g. "plats" -> "plat") IS a valid prefix of unrelated longer words
// (e.g. "plateau"), and substring-matching a folded fragment would risk a
// silent wrong-item match; exact equality cannot do that.
function foldSingleWordPlural(text) {
  if (!text || /\s/.test(text) || text.length < 3 || !text.endsWith("s")) return text;
  return text.slice(0, -1);
}

// { status: "MATCHED", item_id } | { status: "NO_MATCH" } | { status: "AMBIGUOUS", candidates: [item_id, ...] }
function resolveRemovalTarget({ hint, items }) {
  const normalizedHint = normalize(hint);
  if (!normalizedHint || !Array.isArray(items) || items.length === 0) {
    return { status: "NO_MATCH" };
  }
  const foldedHint = foldSingleWordPlural(normalizedHint);
  const matches = items.filter((item) => {
    const description = normalize(item?.description);
    if (!description) return false;
    if (description === normalizedHint || description.includes(normalizedHint)) return true;
    return description === foldedHint;
  });
  if (matches.length === 1) return { status: "MATCHED", item_id: matches[0].item_id };
  if (matches.length === 0) return { status: "NO_MATCH" };
  return { status: "AMBIGUOUS", candidates: matches.map((item) => item.item_id) };
}

module.exports = { resolveRemovalTarget };
