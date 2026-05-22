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
      if (isLikelyYear(value) && !hasServiceAmountContext(text)) return null;

      return {
        raw: m,
        value,
      };
    })
    .filter(Boolean);
}

function hasServiceAmountContext(text = "") {
  const t = cleanText(text);

  return /\b(reparation|réparation|pose|main\s+d\s*oeuvre|main\s+d'œuvre|accessoire|accessoires|transport|deplacement|déplacement|livraison|installation|sacs?\s+de\s+ciment|ciment)\b/.test(
    t
  );
}

function findLastMoneyAmount(text = "") {
  const matches = findMoneyMatches(text);
  if (!matches.length) return null;
  return matches[matches.length - 1].value;
}

function removeMoneyTokens(text = "") {
  return String(text || "").replace(
    /\d{1,3}(?:[., ]\d{3})+(?:\s*(?:f|fcfa))?|\d+(?:[.,]\d+)?\s*(?:mil|mille|k|million|millions)|\d+\s*(?:f|fcfa)?/gi,
    " "
  );
}

function stripMoneyTokens(text = "") {
  return String(text || "")
    .replace(
      /\d{1,3}(?:[., ]\d{3})+(?:\s*(?:f|fcfa))?|\d+(?:[.,]\d+)?\s*(?:mil|mille|k|million|millions)|\d+\s*(?:f|fcfa)?/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLabel(label = "") {
  const t = String(label || "").trim();
  if (!t) return "Produit";

  const normalized = t
    .replace(/[.,;:!?]+$/g, "")
    .trim()
    .replace(/^portes?$/i, "Porte")
    .replace(/^fenetres?$/i, "Fenêtre")
    .replace(/^fenêtres?$/i, "Fenêtre")
    .replace(/^tables?$/i, "Table")
    .replace(/^chaises?$/i, "Chaise")
    .replace(/^pagnes?$/i, "Pagne")
    .replace(/\s+/g, " ")
    .trim();

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function parseTrailingNumberColumnsItem(segment = "") {
  const raw = String(segment || "").trim();
  if (!raw) return null;

  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return null;

  const priceToken = tokens[tokens.length - 1];
  const qtyToken = tokens[tokens.length - 2];
  const price = parseMoneyToken(priceToken);
  const qty = Number(String(qtyToken || "").replace(",", "."));

  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(qty) || qty <= 0 || qty > 1000) return null;

  const label = tokens.slice(0, -2).join(" ").trim();
  if (!label || label.length < 2) return null;

  return {
    label: normalizeLabel(label),
    qty,
    unitPrice: price,
  };
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

  const pourRegex = /\bpour\s+([^\n,;]+)/gi;
  let m;
  while ((m = pourRegex.exec(raw)) !== null) {
    const seg = cleanClientSegment(m[1]);
    if (seg) {
      results.push({
        source: "pour",
        value: seg,
        index: m.index,
      });
    }
  }

  const chezRegex = /\bchez\s+([^\n,;]+)/gi;
  while ((m = chezRegex.exec(raw)) !== null) {
    const seg = cleanClientSegment(m[1]);
    if (seg) {
      results.push({
        source: "chez",
        value: seg,
        index: m.index,
      });
    }
  }

  const clientRegex = /\bclient\s*:?\s*([^\n,;]+)/gi;
  while ((m = clientRegex.exec(raw)) !== null) {
    const seg = cleanClientSegment(m[1]);
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

function cleanClientSegment(segment = "") {
  let s = String(segment || "").trim();
  if (!s) return "";

  s = s
    .split(
      /\b(?:avec|paiement|pay[eé]|paye|montant|re[çc]u|facture|devis|d[ée]charge|r[eé]paration|reparation|pose|main\s+d[’' ]?oeuvre|accessoires?|transport|d[eé]placement|livraison|installation|il\s+a\s+re[çc]u|elle\s+a\s+re[çc]u)\b|\d/i
    )[0]
    .trim();

  s = removeMoneyTokens(s).replace(/\s+/g, " ").trim();
  return s;
}

function extractPaymentInfo(text = "") {
  const t = cleanText(text);

  if (/\bpay[eé]\s+en\s+esp[eè]ces\b|\besp[eè]ces\b|\bcash\b/.test(t)) {
    return { paid: true, paymentMethod: "espèces" };
  }

  if (/\bpay[eé]\b|\br[eè]gl[eé]\b|\bregle\b/.test(t)) {
    return { paid: true, paymentMethod: null };
  }

  return { paid: null, paymentMethod: null };
}

function isPaymentOnlySegment(text = "") {
  const t = cleanText(text);
  return (
    !!t &&
    /\bpay[eé]\b|\br[eè]gl[eé]\b|\besp[eè]ces\b|\bcash\b/.test(t) &&
    !Number.isFinite(findLastMoneyAmount(text))
  );
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

  return out
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

// ===============================
// DOC TYPE
// ===============================
function detectDocTypeFromText(text = "") {
  const t = cleanText(text);

  if (/\bdecharge\b|\bdécharge\b/.test(t)) return "decharge";
  if (/\brecu\b|\breçu\b/.test(t)) return "recu";
  if (/\bfacture\b/.test(t)) return "facture";
  if (/\bdevis\b/.test(t)) return "devis";

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

  const paymentPurposeMatch = raw.match(
    /\bpaiement\s+de\s+(?:\d{1,3}(?:[., ]\d{3})+|\d+(?:[.,]\d+)?(?:\s*(?:f|fcfa|mil|mille|k|million|millions))?)\s+pour\s+([^\n,;]+)/i
  ) || raw.match(
    /\b(?:pay[eé]|paye|r[eè]gl[eé]|regle)\s+(?:\d{1,3}(?:[., ]\d{3})+|\d+(?:[.,]\d+)?(?:\s*(?:f|fcfa|mil|mille|k|million|millions))?)\s+pour\s+([^\n,;]+)/i
  );

  if (paymentPurposeMatch) {
    motif = paymentPurposeMatch[1];
  } else {
    motif = removeMoneyTokens(motif);
  }

  motif = motif
    .replace(/\bfais(?:\s+moi)?\b/gi, " ")
    .replace(/\bcree\b|\bcrée\b|\bfaire\b|\bcreer\b|\bcréer\b/gi, " ")
    .replace(/\b(?:il|elle)\s+a\s+(?:pay[eé]|paye)\b/gi, " ")
    .replace(/\bpaiement\s+de\b/gi, " ")
    .replace(/\bpay[eé]\s+en\s+esp[eèe]ces\b|\besp[eèe]ces\b|\bcash\b/gi, " ")
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

  motif = motif
    .replace(/\ben\s*[.,;:!?]*$/i, " ")
    .replace(/[.,;:!?]+$/g, " ")
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
  const payment = extractPaymentInfo(text);

  if (!Number.isFinite(total) || total <= 0) return null;

  return {
    kind: "simple_payment",
    docType,
    client,
    motif,
    total,
    paid: payment.paid,
    paymentMethod: payment.paymentMethod,
  };
}

// ===============================
// DECHARGE MESSAGE
// ===============================
function cleanReceivedObjectLabel(value = "") {
  let label = stripMoneyTokens(value)
    .replace(/\b(il|elle)\s+a\s+re[cç]u\b/gi, " ")
    .replace(/\b(une|un|des|du|de la|de l'|l'|la|le|les)\b/gi, " ")
    .replace(/\bet\b/gi, " ")
    .replace(/[.:;,-]+$/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!label) return null;
  return label.charAt(0).toLowerCase() + label.slice(1);
}

function extractDechargeClient(text = "") {
  const raw = String(text || "");
  const m = raw.match(/\bd[ée]charge\s+pour\s+([^\r\n,;]+)/i);
  if (m) return String(m[1] || "").trim() || null;
  return extractClientFromText(raw);
}

function extractDechargeReceivedClause(text = "") {
  const raw = String(text || "").replace(/\r?\n/g, " ");
  const m = raw.match(/\b(?:il|elle)\s+a\s+re[cç]u\s+(.+)$/i);
  if (!m) return null;

  return String(m[1] || "")
    .replace(/\bvaleur\s+.+$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNaturalDechargeMessage(text = "") {
  const docType = detectDocTypeFromText(text);
  if (docType !== "decharge") return null;

  const raw = String(text || "");
  const receivedClause = extractDechargeReceivedClause(raw);
  const cniMatch = raw.match(
    /\b(?:cni|pi[eè]ce(?:\s+d['’ ]?identit[eé])?)\s*(?:n[°o]\s*)?[:#-]?\s*([a-z0-9-]+)/i
  );
  const phoneMatch = raw.match(
    /\b(?:whatsapp|t[eé]l[eé]phone|tel)\s*[:#-]?\s*(\+?\d[\d .-]{5,})/i
  );
  const valueMatch = raw.match(/\bvaleur\s*[:#-]?\s*(.+?)(?:$|\r?\n)/i);
  const amountInReceived = receivedClause ? findLastMoneyAmount(receivedClause) : null;
  const objectValue = valueMatch ? findLastMoneyAmount(valueMatch[1]) : null;

  let purpose = null;
  let objectLabel = null;

  if (receivedClause) {
    const purposeMatch = receivedClause.match(
      /\b(?:pour|motif\s*:?)\s+(.+)$/i
    );
    if (purposeMatch) {
      purpose = String(purposeMatch[1] || "")
        .replace(/\bvaleur\s+.+$/i, " ")
        .replace(/[.,;:!?]+$/g, " ")
        .trim();
    }

    let objectPart = receivedClause;
    if (purposeMatch) objectPart = objectPart.slice(0, purposeMatch.index);
    objectPart = objectPart.replace(/\bet\s+\d[\d .,-]*(?:f|fcfa)?\b/i, " ");
    objectPart = objectPart.replace(/^\d[\d .,-]*(?:f|fcfa)?\b/i, " ");
    objectLabel = cleanReceivedObjectLabel(objectPart);
  }

  const parsed = {
    kind: "intent_only",
    docType: "decharge",
    client: extractDechargeClient(raw),
    cni_number: cniMatch ? String(cniMatch[1] || "").trim() : null,
    receiver_phone: phoneMatch
      ? String(phoneMatch[1] || "").replace(/\D/g, "")
      : null,
    object_label: objectLabel,
    amount_received: Number.isFinite(amountInReceived) ? amountInReceived : null,
    object_value: Number.isFinite(objectValue) ? objectValue : null,
    discharge_purpose: purpose || null,
    motif: purpose || objectLabel || null,
  };

  if (
    parsed.client ||
    parsed.cni_number ||
    parsed.receiver_phone ||
    parsed.object_label ||
    parsed.amount_received ||
    parsed.object_value ||
    parsed.discharge_purpose
  ) {
    return parsed;
  }

  return null;
}

// ===============================
// ITEMS MESSAGE
// ===============================
function splitNaturalSegments(text = "") {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const source = lines.length > 1 ? lines : [String(text || "").trim()];

  return source
    .flatMap((line) => line.split(/\s+\bet\s+(?=\D*\d)|,/i))
    .map((s) => s.replace(/^\s*avec\s+/i, "").trim())
    .filter(Boolean)
    .filter((s) => !isPaymentOnlySegment(s));
}

function parseStructuredItemSegment(segment = "") {
  const raw = String(segment || "").trim();
  if (!raw) return null;

  const amount = findLastMoneyAmount(raw);
  const numberCount = countNumberTokens(raw);
  const strongSignal = hasStrongStructuredLineSignal(raw);

  if (!Number.isFinite(amount) || amount <= 0) return null;

  const t = cleanText(raw);

  const trailingColumnsItem = parseTrailingNumberColumnsItem(raw);
  if (trailingColumnsItem) return trailingColumnsItem;

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

  let label = removeMoneyTokens(raw)
    .replace(
      /\bdevis\b|\bfacture\b|\brecu\b|\breçu\b|\bdécharge\b|\bdecharge\b/gi,
      " "
    )
    .replace(/\bfais(?:\s+moi)?\b|\bfaire\b|\bcree\b|\bcrée\b|\bcreer\b|\bcréer\b|\bavec\b/gi, " ")
    .replace(
      /\bqte\b|\bqt[eé]\b|\bquantit[eé]\b|\bpu\b|\bprix\b|\bmontant\b|\bmt\b/gi,
      " "
    )
    .replace(/\bpour\b|\bchez\b|\bclient\b/gi, " ")
    .replace(/(^|\s)(?:a|à)(?=\s|$)/gi, " ")
    .replace(/[=:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!label || label.length < 2) return null;
  if (numberCount <= 1 && !strongSignal && label.split(/\s+/).length > 8) {
    return null;
  }

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
  const payment = extractPaymentInfo(text);

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
    paid: payment.paid,
    paymentMethod: payment.paymentMethod,
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

  const decharge = parseNaturalDechargeMessage(text);
  if (decharge) return decharge;

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
  parseNaturalDechargeMessage,
  parseNaturalWhatsAppMessage,
};
