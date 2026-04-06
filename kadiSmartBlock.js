"use strict";

function analyzeSmartBlock({ items = [], computedTotal = 0, materialTotal = null, grandTotal = null }) {
  const labels = items.map((it) => String(it?.label || "").toLowerCase()).join(" ");

  const hasMaterial = /fil|cable|prise|boite|ciment|fer|tube|peinture|vis|brique/.test(labels);
  const hasLabor = /main.?d.?oeuvre|pose|installation|montage|réparation|reparation|service/.test(labels);

  let businessType = "general";
  if (hasMaterial && hasLabor) businessType = "mixed";
  else if (hasMaterial) businessType = "material";
  else if (hasLabor) businessType = "service";

  let referenceTotal = grandTotal ?? materialTotal ?? null;
  let gap = 0;

  if (Number.isFinite(referenceTotal) && Number.isFinite(computedTotal)) {
    gap = Math.round(Number(referenceTotal) - Number(computedTotal));
  }

  const absGap = Math.abs(gap);
  let severity = "none";
  if (absGap > 0 && absGap < 1000) severity = "low";
  if (absGap >= 1000 && absGap < 10000) severity = "medium";
  if (absGap >= 10000) severity = "high";

  let hint = "unknown";
  if (hasMaterial && !hasLabor) hint = "missing_labor";
  if (!hasMaterial && hasLabor) hint = "missing_material";
  if (hasMaterial && hasLabor) hint = "mixed";

  return {
    businessType,
    hint,
    gapInfo: {
      gap,
      severity,
      referenceTotal,
      computedTotal,
    },
  };
}

function buildSmartMismatchMessage({ businessType, gapInfo, hint }) {
  const gap = Number(gapInfo?.gap || 0);
  const severity = gapInfo?.severity || "none";

  if (!gap || severity === "none") {
    return {
      warning: false,
      text: "",
    };
  }

  let suggestion = "Vérifiez les lignes du document.";
  if (hint === "missing_labor") suggestion = "Il manque peut-être la main d’œuvre.";
  if (hint === "missing_material") suggestion = "Il manque peut-être les matériaux.";
  if (hint === "mixed") suggestion = "Certaines lignes semblent incomplètes.";

  return {
    warning: true,
    text:
      `⚠️ Écart détecté dans le bloc analysé.\n\n` +
      `• Type: ${businessType || "general"}\n` +
      `• Écart: ${gap}\n` +
      `• Niveau: ${severity}\n\n` +
      `${suggestion}`,
  };
}

function sanitizeOcrLabel(line) {
  return String(line || "")
    .replace(/\b(total|montant|date|client|nom)\b/gi, "")
    .replace(/[0-9]+(?:[.,][0-9]+)*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeRealItemLabel(label) {
  const t = String(label || "").trim();
  if (!t) return false;
  if (t.length < 3) return false;
  if (/^(fcfa|total|montant|date|client)$/i.test(t)) return false;
  return /[a-zA-ZÀ-ÿ]/.test(t);
}

function parseItemsBlockSmart(input) {
  const lines = String(input || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  const items = [];
  const ignored = [];

  for (const line of lines) {
    if (/total|montant|net\s*a\s*payer/i.test(line)) {
      ignored.push(line);
      continue;
    }

    const nums = line.match(/\d+(?:[.,]\d+)?/g) || [];
    const label = sanitizeOcrLabel(line);

    if (!looksLikeRealItemLabel(label) || nums.length === 0) {
      ignored.push(line);
      continue;
    }

    const values = nums
      .map((n) => Number(String(n).replace(",", ".")))
      .filter((n) => Number.isFinite(n) && n > 0);

    if (!values.length) {
      ignored.push(line);
      continue;
    }

    let qty = 1;
    let unitPrice = values[values.length - 1];

    if (values.length >= 2) {
      const maybeQty = values[0];
      if (maybeQty > 0 && maybeQty <= 1000) qty = maybeQty;
    }

    items.push({
      label,
      qty,
      unitPrice,
    });
  }

  return { items, ignored };
}

function extractBlockTotals(input) {
  const text = String(input || "");

  const patterns = [
    /total\s*[:\-]?\s*([0-9\s.,]+)/i,
    /montant\s+total\s*[:\-]?\s*([0-9\s.,]+)/i,
    /net\s*a\s*payer\s*[:\-]?\s*([0-9\s.,]+)/i,
  ];

  let grandTotal = null;

  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const n = Number(String(m[1]).replace(/\s/g, "").replace(",", "."));
      if (Number.isFinite(n)) {
        grandTotal = n;
        break;
      }
    }
  }

  return {
    materialTotal: null,
    grandTotal,
  };
}

module.exports = {
  analyzeSmartBlock,
  parseItemsBlockSmart,
  extractBlockTotals,
  buildSmartMismatchMessage,
  sanitizeOcrLabel,
  looksLikeRealItemLabel,
};