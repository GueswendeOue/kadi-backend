// kadiNaturalParser.js
"use strict";

// ===============================
// HELPERS
// ===============================
function cleanText(input = "") {
  return String(input)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMoneyToken(token = "") {
  let t = cleanText(token)
    .replace(/fcfa|fc|f\b/g, "")
    .replace(/\s+/g, "");

  if (!t) return null;

  // 100.000 / 100,000 / 100 000
  if (/^\d{1,3}([.,]\d{3})+$/.test(t)) {
    const n = Number(t.replace(/[.,]/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  // 12mil / 12mille / 12k
  if (/^\d+(?:[.,]\d+)?(mil|mille|k)$/.test(t)) {
    const n = Number(t.replace(/(mil|mille|k)$/g, "").replace(",", "."));
    return Number.isFinite(n) ? Math.round(n * 1000) : null;
  }

  // 1million / 1.5million
  if (/^\d+(?:[.,]\d+)?million(s)?$/.test(t)) {
    const n = Number(t.replace(/millions?$/g, "").replace(",", "."));
    return Number.isFinite(n) ? Math.round(n * 1000000) : null;
  }

  // 100000
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

function findLastMoneyAmount(text = "") {
  const raw = String(text || "");
  const matches =
    raw.match(/\d{1,3}(?:[., ]\d{3})+(?:\s*(?:f|fcfa))?|\d+(?:[.,]\d+)?\s*(?:mil|mille|k|million|millions)|\d+\s*(?:f|fcfa)?/gi) ||
    [];

  let last = null;
  for (const m of matches) {
    const value = parseMoneyToken(m);
    if (Number.isFinite(value) && value > 0) last = value;
  }
  return last;
}

// ===============================
// DOC TYPE
// ===============================
function detectDocTypeFromText(text = "") {
  const t = cleanText(text);

  if (/\brecu\b|\breçu\b/.test(t)) return "recu";
  if (/\bfacture\b/.test(t)) return "facture";
  if (/\bdevis\b/.test(t)) return "devis";
  if (/\bdecharge\b|\bdécharge\b/.test(t)) return "decharge";

  return null;
}

// ===============================
// CLIENT
// ===============================
function extractClientFromText(text = "") {
  const raw = String(text || "").trim();

  const patterns = [
    /\bpour\s+(mr\.?\s+[A-Za-zÀ-ÿ'-]+(?:\s+[A-Za-zÀ-ÿ'-]+){0,2})/i,
    /\bpour\s+(mme\.?\s+[A-Za-zÀ-ÿ'-]+(?:\s+[A-Za-zÀ-ÿ'-]+){0,2})/i,
    /\bpour\s+(m\.?\s+[A-Za-zÀ-ÿ'-]+(?:\s+[A-Za-zÀ-ÿ'-]+){0,2})/i,
    /\bpour\s+([A-Za-zÀ-ÿ'-]+(?:\s+[A-Za-zÀ-ÿ'-]+){0,2})/i,
    /\bchez\s+([A-Za-zÀ-ÿ'-]+(?:\s+[A-Za-zÀ-ÿ'-]+){0,2})/i,
    /\bclient\s+([A-Za-zÀ-ÿ'-]+(?:\s+[A-Za-zÀ-ÿ'-]+){0,2})/i,
  ];

  for (const p of patterns) {
    const m = raw.match(p);
    if (m && m[1]) return m[1].trim();
  }

  return null;
}

// ===============================
// SIMPLE PAYMENT / RECEIPT
// ===============================
function looksLikeSimplePaymentMessage(text = "") {
  const t = cleanText(text);

  const hasPaymentDoc = /\brecu\b|\breçu\b|\bdecharge\b|\bdécharge\b/.test(t);
  const hasMoney = Number.isFinite(findLastMoneyAmount(text));
  const hasPaymentWord =
    /\bloyer\b|\bacompte\b|\bavance\b|\bpaiement\b|\bversement\b|\breglement\b|\brèglement\b/.test(t);

  return (hasPaymentDoc || hasPaymentWord) && hasMoney;
}

function extractSimplePaymentMotif(text = "") {
  const raw = String(text || "").trim();

  // on enlève le montant final s’il existe
  let motif = raw.replace(
    /\d{1,3}(?:[., ]\d{3})+(?:\s*(?:f|fcfa))?|\d+(?:[.,]\d+)?\s*(?:mil|mille|k|million|millions)|\d+\s*(?:f|fcfa)?/gi,
    " "
  );

  // enlever les verbes/documents fréquents
  motif = motif
    .replace(/\bfais(?:\s+moi)?\b/gi, " ")
    .replace(/\bcree\b|\bcrée\b|\bfaire\b|\bcréer\b/gi, " ")
    .replace(/\brecu\b|\breçu\b|\bfacture\b|\bdevis\b|\bdecharge\b|\bdécharge\b/gi, " ")
    .replace(/\bpour\s+(mr\.?\s+[A-Za-zÀ-ÿ'-]+(?:\s+[A-Za-zÀ-ÿ'-]+){0,2})/i, " ")
    .replace(/\bpour\s+(mme\.?\s+[A-Za-zÀ-ÿ'-]+(?:\s+[A-Za-zÀ-ÿ'-]+){0,2})/i, " ")
    .replace(/\bpour\s+(m\.?\s+[A-Za-zÀ-ÿ'-]+(?:\s+[A-Za-zÀ-ÿ'-]+){0,2})/i, " ")
    .replace(/\bpour\s+([A-Za-zÀ-ÿ'-]+(?:\s+[A-Za-zÀ-ÿ'-]+){0,2})/i, " ")
    .replace(/\bchez\s+([A-Za-zÀ-ÿ'-]+(?:\s+[A-Za-zÀ-ÿ'-]+){0,2})/i, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!motif) return "Paiement";
  return motif;
}

function parseNaturalSimplePaymentMessage(text = "") {
  const docType = detectDocTypeFromText(text) || "recu";
  const client = extractClientFromText(text);
  const total = findLastMoneyAmount(text);
  const motif = extractSimplePaymentMotif(text);

  if (!Number.isFinite(total) || total <= 0) return null;

  return {
    kind: "simple_payment",
    docType,
    client,
    motif,
    total,
  };
}

// ===============================
// ITEMS MESSAGE
// ===============================
function splitNaturalSegments(text = "") {
  const raw = String(text || "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return raw
    .split(/\s+\bet\b\s+|,/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseNaturalItemSegment(segment = "") {
  const raw = String(segment || "").trim();
  if (!raw) return null;

  const amount = findLastMoneyAmount(raw);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const clean = cleanText(raw)
    .replace(/\bdevis\b|\bfacture\b|\brecu\b|\bdecharge\b/g, " ")
    .replace(/\bpour\b|\bchez\b|\bclient\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const qtyMatch =
    clean.match(/\b(\d+(?:[.,]\d+)?)\s*(sac|sacs|bidon|bidons|rouleau|rouleaux|carton|cartons|piece|pieces|barre|barres|kg|tonne|tonnes)\b/i) ||
    clean.match(/\b(\d+(?:[.,]\d+)?)\b/i);

  let qty = 1;
  if (qtyMatch) {
    const q = Number(String(qtyMatch[1]).replace(",", "."));
    if (Number.isFinite(q) && q > 0 && q <= 1000) qty = q;
  }

  const label = raw
    .replace(/\d{1,3}(?:[., ]\d{3})+(?:\s*(?:f|fcfa))?|\d+(?:[.,]\d+)?\s*(?:mil|mille|k|million|millions)|\d+\s*(?:f|fcfa)?/gi, " ")
    .replace(/\bdevis\b|\bfacture\b|\brecu\b|\bdécharge\b|\bdecharge\b/gi, " ")
    .replace(/\bpour\b|\bchez\b|\bclient\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!label || label.length < 2) return null;

  const unitPrice = qty > 0 ? Math.round(amount / qty) : amount;

  return {
    label,
    qty,
    unitPrice,
  };
}

function parseNaturalItemsMessage(text = "") {
  const docType = detectDocTypeFromText(text);
  const client = extractClientFromText(text);
  const segments = splitNaturalSegments(text);

  const items = [];
  for (const seg of segments) {
    const item = parseNaturalItemSegment(seg);
    if (item) items.push(item);
  }

  if (!items.length) return null;

  return {
    kind: "items",
    docType,
    client,
    items,
  };
}

// ===============================
// ROUTER
// ===============================
function parseNaturalWhatsAppMessage(text = "") {
  if (!text || String(text).trim().length < 3) return null;

  if (looksLikeSimplePaymentMessage(text)) {
    const simple = parseNaturalSimplePaymentMessage(text);
    if (simple) return simple;
  }

  const items = parseNaturalItemsMessage(text);
  if (items) return items;

  return null;
}

// ===============================
module.exports = {
  detectDocTypeFromText,
  extractClientFromText,
  parseNaturalWhatsAppMessage,
};