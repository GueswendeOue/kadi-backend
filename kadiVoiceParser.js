"use strict";

// ===============================
// NORMALISATION TEXTE
// ===============================
function normalize(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ===============================
// NOMBRES EN LETTRES
// ===============================
const NUMBER_WORDS = {
  zero: 0,
  un: 1,
  une: 1,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  six: 6,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10,
  onze: 11,
  douze: 12,
};

function parseQty(word) {
  const w = String(word || "").trim().toLowerCase();
  if (!w) return 1;

  if (/^\d+$/.test(w)) return Number(w);
  if (NUMBER_WORDS[w] != null) return NUMBER_WORDS[w];

  return 1;
}

// ===============================
// PRIX / MONTANTS BUSINESS
// ===============================
function parseBusinessAmount(input) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return null;

  let s = raw
    .replace(/fcfa|f cfa|cfa/g, "")
    .replace(/\bfrancs?\b/g, "")
    .replace(/\s+/g, "")
    .trim();

  if (!s) return null;

  // 25k / 2.5k / 2,5k
  if (/^\d+([.,]\d+)?k$/.test(s)) {
    return Math.round(Number(s.slice(0, -1).replace(",", ".")) * 1000);
  }

  // 3m / 2.5m
  if (/^\d+([.,]\d+)?m$/.test(s)) {
    return Math.round(Number(s.slice(0, -1).replace(",", ".")) * 1000000);
  }

  // 25.000 => 25000
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    return Number(s.replace(/\./g, ""));
  }

  // 25,000 => 25000
  if (/^\d{1,3}(,\d{3})+$/.test(s)) {
    return Number(s.replace(/,/g, ""));
  }

  // 25000
  if (/^\d+$/.test(s)) {
    return Number(s);
  }

  // 25,5 ou 25.5 (vrai décimal)
  if (/^\d+[.,]\d+$/.test(s)) {
    return Math.round(Number(s.replace(",", ".")));
  }

  return null;
}

function parsePrice(text) {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return null;

  // "50 mille"
  const milleMatch = raw.match(/(\d+(?:[.,]\d+)?)\s*mille\b/);
  if (milleMatch) {
    const base = Number(milleMatch[1].replace(",", "."));
    if (Number.isFinite(base)) return Math.round(base * 1000);
  }

  // fallback général
  return parseBusinessAmount(raw);
}

// ===============================
// EXTRACTION CLIENT
// ===============================
function extractClient(text) {
  const t = String(text || "").trim();

  const patterns = [
    /\bpour\s+([a-zàâäéèêëïîôöùûüç\-]{2,})/i,
    /\bclient\s+([a-zàâäéèêëïîôöùûüç\-]{2,})/i,
    /\bau nom de\s+([a-zàâäéèêëïîôöùûüç\- ]{2,})/i,
  ];

  for (const p of patterns) {
    const m = t.match(p);
    if (m && m[1]) {
      return cleanClientName(m[1]);
    }
  }

  return null;
}

function cleanClientName(name) {
  return String(name || "")
    .replace(/\b(de|du|la|le|les)\b\s*$/i, "")
    .replace(/[^\p{L}\s\-]/gu, "")
    .trim() || null;
}

// ===============================
// LABELS PRODUITS
// ===============================
const PRODUCT_LABEL_PATTERNS = [
  /fen[eê]tre?s?/i,
  /porte?s?/i,
  /table?s?/i,
  /chaise?s?/i,
  /moto/i,
  /moteur/i,
  /ciment/i,
  /fer(?:s)?(?:\s+[àa]\s+b[ée]ton)?/i,
  /brique?s?/i,
  /peinture/i,
  /pagne?s?/i,
  /tresse?s?/i,
  /coiffure/i,
  /livraison/i,
  /r[eé]paration\s+moto/i,
  /r[eé]paration/i,
  /soudure/i,
  /grillage/i,
  /carreau[x]?/i,
  /bois/i,
  /placard/i,
  /plafond/i,
];

function singularizeLabel(label = "") {
  const t = String(label || "").trim();
  if (!t) return "Produit";

  return t
    .replace(/^fenetres?$/i, "Fenêtre")
    .replace(/^fenêtres?$/i, "Fenêtre")
    .replace(/^portes?$/i, "Porte")
    .replace(/^tables?$/i, "Table")
    .replace(/^chaises?$/i, "Chaise")
    .replace(/^pagnes?$/i, "Pagne")
    .replace(/\bfer(?:s)? à béton\b/i, "Fer à béton")
    .replace(/^fers?$/i, "Fer")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function extractLabel(segment) {
  const s = String(segment || "").trim();
  if (!s) return "Produit";

  for (const pattern of PRODUCT_LABEL_PATTERNS) {
    const m = s.match(pattern);
    if (m && m[0]) {
      return singularizeLabel(m[0]);
    }
  }

  return "Produit";
}

// ===============================
// DÉCOUPAGE DES ITEMS
// ===============================
function splitItemSegments(text) {
  const t = String(text || "").trim();
  if (!t) return [];

  return t
    .split(/\s+\bet\b\s+|,/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

function looksLikeDocumentIntro(segment) {
  return /\b(fais-moi|fais moi|cr[eé]e|cree|devis|facture|re[çc]u)\b/i.test(
    String(segment || "")
  );
}

function extractQty(segment) {
  const s = String(segment || "").trim();

  const m =
    s.match(/\b(\d+|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b/i);

  return m ? parseQty(m[1]) : 1;
}

function extractPrice(segment) {
  const s = String(segment || "").trim();
  if (!s) return null;

  const patterns = [
    /\b\d{1,3}(?:\.\d{3})+\b/,          // 25.000
    /\b\d{1,3}(?:,\d{3})+\b/,           // 25,000
    /\b\d+(?:[.,]\d+)?k\b/i,            // 25k / 2.5k
    /\b\d+(?:[.,]\d+)?m\b/i,            // 2m
    /\b\d+(?:[.,]\d+)?\s*mille\b/i,     // 25 mille
    /\b\d+\b/,                          // 25000
  ];

  for (const pattern of patterns) {
    const m = s.match(pattern);
    if (m && m[0]) {
      const price = parsePrice(m[0]);
      if (price != null) return price;
    }
  }

  return null;
}

// ===============================
// EXTRACTION ITEMS
// ===============================
function extractItems(text) {
  const segments = splitItemSegments(text);
  const items = [];

  for (let segment of segments) {
    if (!segment) continue;

    const label = extractLabel(segment);
    const qty = extractQty(segment);
    const unitPrice = extractPrice(segment);

    // Évite de créer un faux item si le segment ne contient rien d’exploitable
    const hasRealLabel = label !== "Produit";
    const hasPrice = unitPrice != null;

    // Cas vocal minimal:
    // "devis pour Moussa de 25.000"
    // => pas de vrai produit nommé, mais on garde 1 item générique avec prix
    if (!hasRealLabel && !hasPrice) {
      continue;
    }

    // Évite que l’intro crée un faux produit si aucun prix
    if (looksLikeDocumentIntro(segment) && !hasPrice && !hasRealLabel) {
      continue;
    }

    items.push({
      label,
      qty: qty || 1,
      unitPrice,
    });
  }

  return items;
}

// ===============================
// CONFIANCE
// ===============================
function computeConfidence(data) {
  let score = 0;

  if (data.client) score += 0.3;
  if (Array.isArray(data.items) && data.items.length > 0) score += 0.3;

  const fullItems = (data.items || []).filter((i) => i.unitPrice != null);
  if (fullItems.length > 0) score += 0.4;

  return Math.min(1, score);
}

// ===============================
// MAIN
// ===============================
function parseVoiceText(text) {
  const t = normalize(text);

  const result = {
    client: extractClient(t),
    items: extractItems(t),
  };

  result.confidence = computeConfidence(result);
  return result;
}

module.exports = {
  parseVoiceText,
  parseBusinessAmount,
  parsePrice,
};