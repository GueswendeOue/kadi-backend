"use strict";

const { parseVoiceText } = require("./kadiVoiceParser");

// ===============================
// HELPERS
// ===============================
function safeText(v = "") {
  return String(v || "").trim();
}

function normalizeLoose(text = "") {
  return safeText(text)
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function ucfirst(text = "") {
  const t = safeText(text);
  if (!t) return "";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ===============================
// DOC TYPE DETECTION
// ===============================
function detectDocType(rawText = "") {
  const t = normalizeLoose(rawText);

  if (/\b(decharge|décharge)\b/.test(t)) return "decharge";
  if (/\b(recu|reçu)\b/.test(t)) return "recu";
  if (/\b(facture|proforma|pro forma)\b/.test(t)) return "facture";
  if (/\b(devis|proposition|offre)\b/.test(t)) return "devis";

  return "devis";
}

function detectFactureKind(rawText = "", docType = "devis") {
  if (docType !== "facture") return null;

  const t = normalizeLoose(rawText);

  if (/\b(proforma|pro forma)\b/.test(t)) return "proforma";
  return "definitive";
}

// ===============================
// LABEL NORMALIZATION
// ===============================
function cleanLabel(label = "") {
  let out = safeText(label);

  if (!out) return "Produit";

  out = out
    .replace(/\bf[eé]n[eê]tre?s?\b/gi, "Fenêtre")
    .replace(/\bporte?s?\b/gi, "Porte")
    .replace(/\bchaises?\b/gi, "Chaise")
    .replace(/\btables?\b/gi, "Table")
    .replace(/\bproduits?\b/gi, "Produit")
    .replace(/\bsacs?\s+de?\s*ciment\b/gi, "Sac de ciment")
    .replace(/\bciment\b/gi, "Ciment")
    .replace(/\bfer(?:s)?\b/gi, "Fer")
    .replace(/\bpagne?s?\b/gi, "Pagne")
    .replace(/\btresses?\b/gi, "Tresses")
    .replace(/\breparation\b/gi, "Réparation")
    .replace(/\bmoto\b/gi, "Moto")
    .replace(/\s+/g, " ")
    .trim();

  return ucfirst(out);
}

function isMeaningfulLabel(label = "") {
  const t = normalizeLoose(label);

  if (!t) return false;
  if (t === "produit") return false;
  if (t.length < 2) return false;

  return true;
}

// ===============================
// ITEM SANITIZATION
// ===============================
function sanitizeQty(qty) {
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n;
}

function sanitizeUnitPrice(unitPrice) {
  if (unitPrice == null || unitPrice === "") return null;

  const n = Number(unitPrice);
  if (!Number.isFinite(n) || n < 0) return null;

  return Math.round(n);
}

function sanitizeItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const label = cleanLabel(item?.label);
      const qty = sanitizeQty(item?.qty);
      const unitPrice = sanitizeUnitPrice(item?.unitPrice);

      return {
        label,
        qty,
        unitPrice,
      };
    })
    .filter((item) => isMeaningfulLabel(item.label));
}

// ===============================
// CLIENT SANITIZATION
// ===============================
function sanitizeClient(client = "") {
  const out = safeText(client)
    .replace(/[.,;:!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return out || null;
}

// ===============================
// MISSING FIELDS
// ===============================
function detectMissing(intent) {
  const missing = [];
  const items = Array.isArray(intent?.items) ? intent.items : [];

  if (!intent?.client) {
    missing.push("client");
  }

  if (!items.length) {
    missing.push("items");
  }

  const itemsMissingPrice = items.filter((i) => i?.unitPrice == null);
  if (items.length > 0 && itemsMissingPrice.length > 0) {
    missing.push("price");
  }

  return missing;
}

// ===============================
// CONFIDENCE TUNING
// ===============================
function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function computeAdjustedConfidence(parsed, intent) {
  let score = clamp01(parsed?.confidence || 0);

  if (intent?.client) {
    score += 0.1;
  }

  if (Array.isArray(intent?.items) && intent.items.length > 0) {
    score += 0.1;
  }

  const pricedItems = (intent?.items || []).filter((i) => i?.unitPrice != null);
  if (
    Array.isArray(intent?.items) &&
    intent.items.length > 0 &&
    pricedItems.length === intent.items.length
  ) {
    score += 0.1;
  }

  if (
    ["facture", "devis", "recu", "decharge"].includes(intent?.docType || "")
  ) {
    score += 0.05;
  }

  return clamp01(Number(score.toFixed(2)));
}

// ===============================
// BUILD INTENT
// ===============================
function buildIntent(rawText = "", options = {}) {
  const inputText = safeText(rawText);
  const parsed = parseVoiceText(inputText);

  const docType = detectDocType(inputText);
  const factureKind = detectFactureKind(inputText, docType);

  const intent = {
    type: "create_document",
    docType,
    factureKind,
    client: sanitizeClient(parsed?.client),
    items: sanitizeItems(parsed?.items || []),
    confidence: 0,
    rawText: inputText,
    source: options.source || "voice",
  };

  intent.missing = detectMissing(intent);
  intent.confidence = computeAdjustedConfidence(parsed, intent);

  return intent;
}

module.exports = {
  buildIntent,
  detectDocType,
  detectFactureKind,
  cleanLabel,
  sanitizeItems,
  sanitizeClient,
  detectMissing,
};