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

  if (/^\d{1,3}([.,]\d{3})+$/.test(t)) {
    const n = Number(t.replace(/[.,]/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  if (/^\d+(?:[.,]\d+)?(mil|mille|k)$/.test(t)) {
    const n = Number(t.replace(/(mil|mille|k)$/g, "").replace(",", "."));
    return Number.isFinite(n) ? Math.round(n * 1000) : null;
  }

  if (/^\d+(?:[.,]\d+)?million(s)?$/.test(t)) {
    const n = Number(t.replace(/millions?$/g, "").replace(",", "."));
    return Number.isFinite(n) ? Math.round(n * 1000000) : null;
  }

  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

function isLikelyYear(value) {
  return Number.isFinite(value) && value >= 1900 && value <= 2100;
}

function countNumberTokens(text = "") {
  const raw = String(text || "");
  const matches = raw.match(/\d+(?:[.,]\d+)?/g) || [];
  return matches.length;
}

function hasExplicitPriceMarker(text = "") {
  const t = cleanText(text);
  return /\bpu\b|\bprix\b|\bmontant\b|\btotal\b|\bmt\b|\bfcfa\b|\bfc\b|\bf\b/.test(
    t
  );
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
    /\b\d+(?:[.,]\d+)?\s+(sac|sacs|bidon|bidons|rouleau|rouleaux|carton|cartons|piece|pieces|pi[eè]ce|pi[eè]ces|barre|barres|kg|tonne|tonnes)\b/i.test(
      t
    )
  );
}

function findMoneyMatches(text = "") {
  const raw = String(text || "");
  const regex =
    /\d{1,3}(?:[., ]\d{3})+(?:\s*(?:f|fcfa))?|\d+(?:[.,]\d+)?\s*(?:mil|mille|k|million|millions)|\d+\s*(?:f|fcfa)?/gi;

  const matches = raw.match(regex) || [];

  return matches
    .map((m) => {
      const value = parseMoneyToken(m);
      if (!Number.isFinite(value) || value <= 0) return null;
      if (isLikelyYear(value)) return null;

      return {
        raw: m,
        value,
      };
    })
    .filter(Boolean);
}

function findLastMoneyAmount(text = "") {
  const matches = findMoneyMatches(text);
  if (!matches.length) return null;
  return matches[matches.length - 1].value;
}

function normalizeLabel(label = "") {
  const t = String(label || "").trim();
  if (!t) return "Produit";

  return t
    .replace(/^portes?$/i, "Porte")
    .replace(/^fenetres?$/i, "Fenêtre")
    .replace(/^fenêtres?$/i, "Fenêtre")
    .replace(/^tables?$/i, "Table")
    .replace(/^chaises?$/i, "Chaise")
    .replace(/^pagnes?$/i, "Pagne")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isLikelyHumanOrCompanySegment(segment = "") {
  const s = String(segment || "").trim();
  if (!s) return false;

  const t = cleanText(s);

  if (
    /\b(monsieur|mr|mme|madame|mademoiselle|client|societe|société|entreprise|ets|eurl|sarl|sa)\b/.test(
      t
    )
  ) {
    return true;
  }

  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 1 && words.length <= 6) {
    if (
      !/\b(installation|reparation|réparation|maintenance|travaux|construction|location|loyer|paiement|versement|devis|facture|recu|reçu|decharge|décharge|proposition|prix|tube|pvc|robinet|ciment|fer|main|oeuvre|mois|annee|année)\b/.test(
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
  const results = [];

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

  return results;
}

function removeOneOccurrenceInsensitive(text = "", chunk = "") {
  if (!chunk) return String(text || "");
  const re = new RegExp(escapeRegExp(chunk), "i");
  return String(text || "").replace(re, " ");
}

function stripClientClauseFromText(text = "", client = null) {
  let out = String(text || "");

  if (client) {
    out = out.replace(
      new RegExp(`\\bpour\\s+${escapeRegExp(client)}\\b`, "i"),
      " "
    );
    out = out.replace(
      new RegExp(`\\bchez\\s+${escapeRegExp(client)}\\b`, "i"),
      " "
    );
    out = out.replace(
      new RegExp(`\\bclient\\s*:?\\s*${escapeRegExp(client)}\\b`, "i"),
      " "
    );
  }

  return out.replace(/\s+/g, " ").trim();
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

  for (let i = candidates.length - 1; i >= 0; i--) {
    const seg = candidates[i].value;
    if (isLikelyHumanOrCompanySegment(seg)) {
      return seg.trim();
    }
  }

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
    /\bloyer\b|\bacompte\b|\bavance\b|\bpaiement\b|\bversement\b|\breglement\b|\brèglement\b/.test(
      t
    );

  return (hasPaymentDoc || hasPaymentWord) && hasMoney;
}

function extractSimplePaymentMotif(text = "") {
  const raw = String(text || "").trim();
  const client = extractClientFromText(raw);

  let motif = raw;

  motif = motif.replace(
    /\d{1,3}(?:[., ]\d{3})+(?:\s*(?:f|fcfa))?|\d+(?:[.,]\d+)?\s*(?:mil|mille|k|million|millions)|\d+\s*(?:f|fcfa)?/gi,
    " "
  );

  motif = motif
    .replace(/\bfais(?:\s+moi)?\b/gi, " ")
    .replace(/\bcree\b|\bcrée\b|\bfaire\b|\bcreer\b|\bcréer\b/gi, " ")
    .replace(
      /\brecu\b|\breçu\b|\bfacture\b|\bdevis\b|\bdecharge\b|\bdécharge\b/gi,
      " "
    );

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
  const numberCount = countNumberTokens(raw);
  const strongSignal = hasStrongStructuredLineSignal(raw);

  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (numberCount <= 1 && !strongSignal) return null;

  const t = cleanText(raw);

  let qty = 1;

  const directQtyLabelPrice =
    t.match(
      /\b(\d+(?:[.,]\d+)?)\s+([a-z][a-z\s-]{1,60}?)\s+[aà]\s+(\d{1,3}(?:[., ]\d{3})+|\d+(?:[.,]\d+)?(?:\s*(?:mil|mille|k|million|millions))?)\b/i
    ) ||
    t.match(
      /\b(\d+(?:[.,]\d+)?)\s+([a-z][a-z\s-]{1,60}?)\s+(?:pu|prix|montant|mt)\s*[:=]?\s*(\d{1,3}(?:[., ]\d{3})+|\d+(?:[.,]\d+)?(?:\s*(?:mil|mille|k|million|millions))?)\b/i
    );

  if (directQtyLabelPrice) {
    const q = Number(String(directQtyLabelPrice[1]).replace(",", "."));
    const lbl = normalizeLabel(directQtyLabelPrice[2]);
    const price = parseMoneyToken(directQtyLabelPrice[3]);

    if (Number.isFinite(q) && q > 0 && Number.isFinite(price) && price > 0) {
      return {
        label: lbl,
        qty: q,
        unitPrice: price,
      };
    }
  }

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

  let label = raw
    .replace(
      /\d{1,3}(?:[., ]\d{3})+(?:\s*(?:f|fcfa))?|\d+(?:[.,]\d+)?\s*(?:mil|mille|k|million|millions)|\d+\s*(?:f|fcfa)?/gi,
      " "
    )
    .replace(
      /\bdevis\b|\bfacture\b|\brecu\b|\breçu\b|\bdécharge\b|\bdecharge\b/gi,
      " "
    )
    .replace(
      /\bqte\b|\bqt[eé]\b|\bquantit[eé]\b|\bpu\b|\bprix\b|\bmontant\b|\bmt\b/gi,
      " "
    )
    .replace(/\bpour\b|\bchez\b|\bclient\b/gi, " ")
    .replace(/\ba\b|\bà\b/gi, " ")
    .replace(/[=:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!label || label.length < 2) return null;

  label = normalizeLabel(label);

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
  const itemsText = stripClientClauseFromText(text, client);
  const segments = splitNaturalSegments(itemsText);

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
    .replace(
      /\bdevis\b|\bfacture\b|\brecu\b|\breçu\b|\bdecharge\b|\bdécharge\b/gi,
      " "
    );

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

module.exports = {
  detectDocTypeFromText,
  extractClientFromText,
  parseNaturalWhatsAppMessage,
};