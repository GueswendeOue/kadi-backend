"use strict";

// ======================================================
// TEXT NORMALIZATION
// ======================================================
function normalize(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function safeText(v = "") {
  return String(v || "").trim();
}

// ======================================================
// NUMBER WORDS
// ======================================================
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

// ======================================================
// MONEY / BUSINESS AMOUNTS
// ======================================================
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

  // 25.000
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    return Number(s.replace(/\./g, ""));
  }

  // 25,000
  if (/^\d{1,3}(,\d{3})+$/.test(s)) {
    return Number(s.replace(/,/g, ""));
  }

  // 25000
  if (/^\d+$/.test(s)) {
    return Number(s);
  }

  // 25,5 / 25.5
  if (/^\d+[.,]\d+$/.test(s)) {
    return Math.round(Number(s.replace(",", ".")));
  }

  return null;
}

function parsePrice(text) {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return null;

  // 50 mille
  const milleMatch = raw.match(/(\d+(?:[.,]\d+)?)\s*mille\b/);
  if (milleMatch) {
    const base = Number(milleMatch[1].replace(",", "."));
    if (Number.isFinite(base)) return Math.round(base * 1000);
  }

  return parseBusinessAmount(raw);
}

function extractAllPrices(text = "") {
  const s = String(text || "");
  const patterns = [
    /\b\d{1,3}(?:\.\d{3})+\b/g,      // 25.000
    /\b\d{1,3}(?:,\d{3})+\b/g,       // 25,000
    /\b\d+(?:[.,]\d+)?k\b/gi,        // 25k
    /\b\d+(?:[.,]\d+)?m\b/gi,        // 2m
    /\b\d+(?:[.,]\d+)?\s*mille\b/gi, // 25 mille
    /\b\d+\b/g,                      // 25000
  ];

  const seen = new Set();
  const out = [];

  for (const pattern of patterns) {
    const matches = s.match(pattern) || [];
    for (const match of matches) {
      const key = String(match);
      if (seen.has(key)) continue;
      seen.add(key);

      const value = parsePrice(match);
      if (value != null) {
        out.push({
          raw: match,
          value,
        });
      }
    }
  }

  return out;
}

// ======================================================
// CLIENT EXTRACTION
// ======================================================
function cleanClientName(name) {
  return (
    String(name || "")
      .replace(/\b(de|du|la|le|les)\b\s*$/i, "")
      .replace(/[^\p{L}\s\-]/gu, "")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

function extractClient(text) {
  const t = String(text || "").trim();

  const patterns = [
    /\bpour\s+([a-zàâäéèêëïîôöùûüç\- ]{2,})/i,
    /\bclient\s+([a-zàâäéèêëïîôöùûüç\- ]{2,})/i,
    /\bau nom de\s+([a-zàâäéèêëïîôöùûüç\- ]{2,})/i,
  ];

  for (const p of patterns) {
    const m = t.match(p);
    if (!m || !m[1]) continue;

    let candidate = m[1]
      .split(/\b(?:avec|à|a|de|du|pour|montant|prix)\b/i)[0]
      .trim();

    candidate = cleanClientName(candidate);
    if (candidate) return candidate;
  }

  return null;
}

// ======================================================
// PRODUCT / SERVICE LABELS
// ======================================================
const PRODUCT_LABEL_PATTERNS = [
  /r[eé]paration\s+moto/i,
  /main d[’']oeuvre/i,
  /main d oeuvre/i,
  /livraison/i,
  /installation/i,
  /soudure/i,
  /coiffure/i,
  /tresse?s?/i,
  /fer(?:s)?(?:\s+[àa]\s+b[ée]ton)?/i,
  /sacs?\s+de?\s*ciment/i,
  /ciment/i,
  /brique?s?/i,
  /peinture/i,
  /grillage/i,
  /carreau[x]?/i,
  /bois/i,
  /placard/i,
  /plafond/i,
  /moto/i,
  /moteur/i,
  /fen[eê]tre?s?/i,
  /porte?s?/i,
  /table?s?/i,
  /chaise?s?/i,
  /pagne?s?/i,
];

function singularizeLabel(label = "") {
  const t = safeText(label);
  if (!t) return "Produit";

  return t
    .replace(/^fenetres?$/i, "Fenêtre")
    .replace(/^fenêtres?$/i, "Fenêtre")
    .replace(/^portes?$/i, "Porte")
    .replace(/^tables?$/i, "Table")
    .replace(/^chaises?$/i, "Chaise")
    .replace(/^pagnes?$/i, "Pagne")
    .replace(/^tresses?$/i, "Tresses")
    .replace(/^sacs?\s+de?\s*ciment$/i, "Sac de ciment")
    .replace(/\bfer(?:s)? à béton\b/i, "Fer à béton")
    .replace(/^fers?$/i, "Fer")
    .replace(/^main d[’']oeuvre$/i, "Main d’œuvre")
    .replace(/^main d oeuvre$/i, "Main d’œuvre")
    .replace(/^reparation moto$/i, "Réparation moto")
    .replace(/^reparation$/i, "Réparation")
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

// ======================================================
// SEGMENTATION
// ======================================================
function looksLikeDocumentIntro(segment) {
  return /\b(fais-moi|fais moi|cr[eé]e|cree|devis|facture|re[çc]u|décharge|decharge)\b/i.test(
    String(segment || "")
  );
}

function splitItemSegments(text) {
  const t = String(text || "").trim();
  if (!t) return [];

  return t
    .split(/\s+\bet\b\s+|,/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

// ======================================================
// FIELD EXTRACTION
// ======================================================
function extractQty(segment) {
  const s = String(segment || "").trim();

  const m = s.match(
    /\b(\d+|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b/i
  );

  return m ? parseQty(m[1]) : 1;
}

function extractUnitPrice(segment) {
  const s = String(segment || "").trim();
  if (!s) return null;

  const patterns = [
    /\b[aà]\s*(\d{1,3}(?:\.\d{3})+)\b/i,
    /\b[aà]\s*(\d{1,3}(?:,\d{3})+)\b/i,
    /\b[aà]\s*(\d+(?:[.,]\d+)?k)\b/i,
    /\b[aà]\s*(\d+(?:[.,]\d+)?m)\b/i,
    /\b[aà]\s*(\d+(?:[.,]\d+)?\s*mille)\b/i,
    /\b[aà]\s*(\d+)\b/i,
    /\bprix\s*(?:de)?\s*(\d{1,3}(?:\.\d{3})+)\b/i,
    /\bprix\s*(?:de)?\s*(\d{1,3}(?:,\d{3})+)\b/i,
    /\bprix\s*(?:de)?\s*(\d+(?:[.,]\d+)?k)\b/i,
    /\bprix\s*(?:de)?\s*(\d+(?:[.,]\d+)?m)\b/i,
    /\bprix\s*(?:de)?\s*(\d+(?:[.,]\d+)?\s*mille)\b/i,
    /\bprix\s*(?:de)?\s*(\d+)\b/i,
  ];

  for (const pattern of patterns) {
    const m = s.match(pattern);
    if (m && m[1]) {
      const price = parsePrice(m[1]);
      if (price != null) return price;
    }
  }

  return null;
}

function extractFallbackPrice(segment) {
  const prices = extractAllPrices(segment);
  if (prices.length === 1) return prices[0].value;
  return null;
}

// ======================================================
// ITEMS EXTRACTION
// ======================================================
function extractItems(text) {
  const segments = splitItemSegments(text);
  const items = [];

  for (let segment of segments) {
    if (!segment) continue;

    const label = extractLabel(segment);
    const qty = extractQty(segment);
    let unitPrice = extractUnitPrice(segment);

    if (unitPrice == null) {
      unitPrice = extractFallbackPrice(segment);
    }

    const hasRealLabel = label !== "Produit";
    const hasPrice = unitPrice != null;

    if (!hasRealLabel && !hasPrice) {
      continue;
    }

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

// ======================================================
// CONFIDENCE
// ======================================================
function computeConfidence(data) {
  let score = 0;

  if (data.client) score += 0.3;
  if (Array.isArray(data.items) && data.items.length > 0) score += 0.3;

  const fullItems = (data.items || []).filter((i) => i.unitPrice != null);
  if (fullItems.length > 0) score += 0.4;

  return Math.min(1, score);
}

// ======================================================
// MAIN
// ======================================================
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
  extractClient,
  extractItems,
};