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

function escapeRegExp(str = "") {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function findMoneyMatches(text = "") {
  const raw = String(text || "");
  const regex =
    /\d{1,3}(?:[., ]\d{3})+(?:\s*(?:f|fcfa))?|\d+(?:[.,]\d+)?\s*(?:mil|mille|k|million|millions)|\d+\s*(?:f|fcfa)?/gi;

  const matches = raw.match(regex) || [];
  return matches
    .map((m) => ({
      raw: m,
      value: parseMoneyToken(m),
    }))
    .filter((x) => Number.isFinite(x.value) && x.value > 0);
}

function findLastMoneyAmount(text = "") {
  const matches = findMoneyMatches(text);
  if (!matches.length) return null;
  return matches[matches.length - 1].value;
}

function countNumberTokens(text = "") {
  const raw = String(text || "");
  const matches = raw.match(/\d+(?:[.,]\d+)?/g) || [];
  return matches.length;
}

function hasExplicitPriceMarker(text = "") {
  const t = cleanText(text);
  return /\bpu\b|\bprix\b|\bmontant\b|\btotal\b|\bmt\b|\bfcfa\b|\bfc\b|\bf\b/.test(t);
}

function hasExplicitQtyMarker(text = "") {
  const t = cleanText(text);
  return /\bqte\b|\bqté\b|\bquantite\b|\bquantité\b|\bx\b|\bfois\b/.test(t);
}

function hasStrongStructuredLineSignal(text = "") {
  const t = cleanText(text);

  return (
    hasExplicitPriceMarker(t) ||
    hasExplicitQtyMarker(t) ||
    /\b\d+(?:[.,]\d+)?\s*[x×]\s*\d+(?:[.,]\d+)?\b/.test(t) ||
    /\b\d+(?:[.,]\d+)?\s+(sac|sacs|bidon|bidons|rouleau|rouleaux|carton|cartons|piece|pieces|pièce|pièces|barre|barres|kg|tonne|tonnes)\b/i.test(
      t
    )
  );
}

function isLikelyHumanOrCompanySegment(segment = "") {
  const s = String(segment || "").trim();
  if (!s) return false;

  const t = cleanText(s);

  // Marqueurs très forts de client
  if (
    /\b(monsieur|mr|mme|madame|mademoiselle|client|societe|société|entreprise|ets|eurl|sarl|sa)\b/.test(
      t
    )
  ) {
    return true;
  }

  // 1 à 5 mots "propres", sans verbe d'action métier
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 1 && words.length <= 5) {
    if (
      !/\b(installation|reparation|réparation|maintenance|travaux|construction|location|loyer|paiement|versement|devis|facture|recu|reçu|decharge|décharge|proposition|prix|tube|pvc|robinet|ciment|fer|main|oeuvre|main d oeuvre)\b/.test(
        t
      )
    ) {
      return true;
    }
  }

  return false;
}

function extractClientCandidateSegments(text = "") {
  const raw = String(text || "").trim();
  const lowered = cleanText(raw);
  const results = [];

  // 1) segments après "pour"
  const pourRegex = /\bpour\s+([^,;]+)/gi;
  let m;
  while ((m = pourRegex.exec(raw)) !== null) {
    const seg = String(m[1] || "").trim();
    if (seg) {
      results.push({
        source: "pour",
        value: seg,
        index: m.index,
      });
    }
  }

  // 2) segments après "chez"
  const chezRegex = /\bchez\s+([^,;]+)/gi;
  while ((m = chezRegex.exec(raw)) !== null) {
    const seg = String(m[1] || "").trim();
    if (seg) {
      results.push({
        source: "chez",
        value: seg,
        index: m.index,
      });
    }
  }

  // 3) segments après "client"
  const clientRegex = /\bclient\s*:?\s*([^,;]+)/gi;
  while ((m = clientRegex.exec(raw)) !== null) {
    const seg = String(m[1] || "").trim();
    if (seg) {
      results.push({
        source: "client",
        value: seg,
        index: m.index,
      });
    }
  }

  // on privilégie le dernier segment "pour..." si lui ressemble à un client
  return results;
}

function removeOneOccurrenceInsensitive(text = "", chunk = "") {
  if (!chunk) return String(text || "");
  const re = new RegExp(escapeRegExp(chunk), "i");
  return String(text || "").replace(re, " ");
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
  const candidates = extractClientCandidateSegments(text);

  if (!candidates.length) return null;

  // 1) priorité au dernier segment qui ressemble fortement à un client
  for (let i = candidates.length - 1; i >= 0; i--) {
    const seg = candidates[i].value;
    if (isLikelyHumanOrCompanySegment(seg)) {
      return seg.trim();
    }
  }

  // 2) fallback : dernier segment brut mais raisonnable
  const last = candidates[candidates.length - 1]?.value || "";
  if (last && last.split(/\s+/).length <= 6) {
    return last.trim();
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
  const client = extractClientFromText(raw);

  let motif = raw;

  // retire montants
  motif = motif.replace(
    /\d{1,3}(?:[., ]\d{3})+(?:\s*(?:f|fcfa))?|\d+(?:[.,]\d+)?\s*(?:mil|mille|k|million|millions)|\d+\s*(?:f|fcfa)?/gi,
    " "
  );

  // retire mots de commande
  motif = motif
    .replace(/\bfais(?:\s+moi)?\b/gi, " ")
    .replace(/\bcree\b|\bcrée\b|\bfaire\b|\bcreer\b|\bcréer\b/gi, " ")
    .replace(/\brecu\b|\breçu\b|\bfacture\b|\bdevis\b|\bdecharge\b|\bdécharge\b/gi, " ");

  // retire le segment client détecté, seulement celui-là
  if (client) {
    motif = removeOneOccurrenceInsensitive(motif, client)
      .replace(/\bpour\b/gi, " ")
      .replace(/\bchez\b/gi, " ")
      .replace(/\bclient\b/gi, " ");
  }

  motif = motif.replace(/\s+/g, " ").trim();

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

function parseStructuredItemSegment(segment = "") {
  const raw = String(segment || "").trim();
  if (!raw) return null;

  const amount = findLastMoneyAmount(raw);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const t = cleanText(raw);
  const numberCount = countNumberTokens(raw);

  // Si la ligne n'a qu'un seul nombre et aucun marqueur fort,
  // on ne la traite PAS comme ligne structurée.
  if (numberCount <= 1 && !hasStrongStructuredLineSignal(t)) {
    return null;
  }

  let qty = 1;

  const qtyMatch =
    t.match(/\bqte\s*[:=]?\s*(\d+(?:[.,]\d+)?)\b/i) ||
    t.match(/\bqt[eé]\s*[:=]?\s*(\d+(?:[.,]\d+)?)\b/i) ||
    t.match(/\bquantit[eé]\s*[:=]?\s*(\d+(?:[.,]\d+)?)\b/i) ||
    t.match(/\b(\d+(?:[.,]\d+)?)\s*[x×]\s*\d+(?:[.,]\d+)?\b/i) ||
    t.match(
      /\b(\d+(?:[.,]\d+)?)\s*(sac|sacs|bidon|bidons|rouleau|rouleaux|carton|cartons|piece|pieces|pi[eè]ce|pi[eè]ces|barre|barres|kg|tonne|tonnes)\b/i
    );

  if (qtyMatch) {
    const q = Number(String(qtyMatch[1]).replace(",", "."));
    if (Number.isFinite(q) && q > 0 && q <= 1000) qty = q;
  }

  let label = raw;

  // retire seulement les marqueurs et montants si ligne clairement structurée
  label = label
    .replace(
      /\d{1,3}(?:[., ]\d{3})+(?:\s*(?:f|fcfa))?|\d+(?:[.,]\d+)?\s*(?:mil|mille|k|million|millions)|\d+\s*(?:f|fcfa)?/gi,
      " "
    )
    .replace(/\bdevis\b|\bfacture\b|\brecu\b|\breçu\b|\bdécharge\b|\bdecharge\b/gi, " ")
    .replace(/\bqte\b|\bqt[eé]\b|\bquantit[eé]\b|\bpu\b|\bprix\b|\bmontant\b|\bmt\b/gi, " ")
    .replace(/\bpour\b|\bchez\b|\bclient\b/gi, " ")
    .replace(/[=:]/g, " ")
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
    const item = parseStructuredItemSegment(seg);
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
// INTENT ONLY MESSAGE
// ===============================
function extractIntentMotif(text = "", client = null) {
  let motif = String(text || "").trim();

  motif = motif
    .replace(/\bfais(?:\s+moi)?\b/gi, " ")
    .replace(/\bje veux\b/gi, " ")
    .replace(/\bcree\b|\bcrée\b|\bcreer\b|\bcréer\b/gi, " ")
    .replace(/\bun\b|\bune\b/gi, " ")
    .replace(/\bdevis\b|\bfacture\b|\brecu\b|\breçu\b|\bdecharge\b|\bdécharge\b/gi, " ");

  if (client) {
    motif = removeOneOccurrenceInsensitive(motif, client)
      .replace(/\bpour\b/gi, " ")
      .replace(/\bchez\b/gi, " ")
      .replace(/\bclient\b/gi, " ");
  }

  motif = motif.replace(/\s+/g, " ").trim();
  return motif || null;
}

function parseNaturalIntentOnlyMessage(text = "") {
  const docType = detectDocTypeFromText(text);
  if (!docType) return null;

  const client = extractClientFromText(text);
  const motif = extractIntentMotif(text, client);

  return {
    kind: "intent_only",
    docType,
    client: client || null,
    motif: motif || null,
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

  const intentOnly = parseNaturalIntentOnlyMessage(text);
  if (intentOnly) return intentOnly;

  return null;
}

// ===============================
module.exports = {
  detectDocTypeFromText,
  extractClientFromText,
  parseNaturalWhatsAppMessage,
};