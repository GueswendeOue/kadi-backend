"use strict";

function parseSmartNumberToken(token) {
  const raw = String(token || "").trim();
  if (!raw) return null;

  let s = raw.replace(/\s+/g, "");

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if (hasComma && hasDot) {
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    const decimalSep = lastComma > lastDot ? "," : ".";
    const thousandsSep = decimalSep === "," ? "." : ",";

    s = s.split(thousandsSep).join("");
    if (decimalSep === ",") s = s.replace(",", ".");
  } else if (hasComma) {
    const parts = s.split(",");
    if (parts.length === 2 && parts[1].length <= 2) {
      s = `${parts[0]}.${parts[1]}`;
    } else {
      s = parts.join("");
    }
  } else if (hasDot) {
    const parts = s.split(".");
    if (!(parts.length === 2 && parts[1].length <= 2)) {
      s = parts.join("");
    }
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function formatFcfa(value) {
  const n = Math.round(Number(value || 0));
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("fr-FR");
}

function sanitizeOcrLabel(line) {
  return String(line || "")
    .replace(/^[\-\u2022•*]+\s*/g, "")
    .replace(
      /\b(total|montant|date|client|nom|net\s*a\s*payer|grand\s*total|qt[eé]?|qty)\b/gi,
      " "
    )
    .replace(/\b(fcfa|cfa)\b/gi, " ")
    .replace(/[|:]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+(a|à|x)$/i, "")
    .trim();
}

function looksLikeRealItemLabel(label) {
  const t = String(label || "").trim();
  if (!t) return false;
  if (t.length < 3) return false;

  if (
    /^(fcfa|cfa|total|montant|date|client|nom|adresse|telephone|téléphone|facture)$/i.test(
      t
    )
  ) {
    return false;
  }

  return /[a-zA-ZÀ-ÿ]/.test(t);
}

function getNumericMatches(line) {
  const regex = /\d[\d\s.,]*/g;
  const matches = [];
  let m;

  while ((m = regex.exec(String(line || ""))) !== null) {
    const raw = String(m[0] || "").trim();
    const value = parseSmartNumberToken(raw);

    if (!Number.isFinite(value) || value <= 0) continue;

    matches.push({
      raw,
      value,
      start: m.index,
      end: m.index + raw.length,
    });
  }

  return matches;
}

function removeRangesFromText(text, ranges = []) {
  let out = String(text || "");
  const sorted = [...ranges]
    .filter((r) => Number.isFinite(r?.start) && Number.isFinite(r?.end))
    .sort((a, b) => b.start - a.start);

  for (const r of sorted) {
    out = `${out.slice(0, r.start)} ${out.slice(r.end)}`;
  }

  return out;
}

function hasSpecKeyword(label) {
  const t = String(label || "").toLowerCase();
  return /tube|pvc|fer|ciment|prise|cable|câble|fil|porte|fenetre|fenêtre|mm|cm|kg|litre|ampere|ampère|a\b/.test(
    t
  );
}

function detectQtyIndex(line, matches) {
  if (!Array.isArray(matches) || matches.length === 0) return null;
  if (matches.length === 1) return null;

  const text = String(line || "");
  const lastIdx = matches.length - 1;

  if (/(qt[eé]?|qty)\s*[:\-]?\s*\d/i.test(text)) {
    for (let i = 0; i < lastIdx; i++) {
      if (matches[i].value > 0 && matches[i].value <= 1000) return i;
    }
  }

  if (/x\s*\d/i.test(text)) {
    for (let i = 0; i < lastIdx; i++) {
      if (matches[i].value > 0 && matches[i].value <= 1000) return i;
    }
  }

  if (matches.length >= 3) {
    const candidate = matches.length - 2;
    if (matches[candidate].value > 0 && matches[candidate].value <= 1000) {
      return candidate;
    }
  }

  if (matches.length === 2) {
    const first = matches[0];
    const price = matches[1];
    const beforeFirst = text.slice(0, first.start).trim();
    const betweenFirstAndPrice = text.slice(first.end, price.start).trim();
    const tentativeLabel = sanitizeOcrLabel(
      removeRangesFromText(text, [matches[1]])
    );

    if (
      first.start === 0 &&
      Number.isInteger(first.value) &&
      first.value > 0 &&
      first.value <= 1000 &&
      /[a-zA-ZÀ-ÿ]/.test(betweenFirstAndPrice) &&
      /(^|\s)(a|à|x)\s*$/i.test(betweenFirstAndPrice) &&
      !/^(mm|cm|m|kg|g|l|litre|litres|ampere|ampère)\b/i.test(
        betweenFirstAndPrice
      )
    ) {
      return 0;
    }

    if (
      first.start === 0 &&
      first.value > 0 &&
      first.value <= 1000 &&
      !hasSpecKeyword(tentativeLabel)
    ) {
      return 0;
    }

    if (
      beforeFirst &&
      first.value > 0 &&
      first.value <= 20 &&
      !hasSpecKeyword(tentativeLabel)
    ) {
      return 0;
    }
  }

  return null;
}

function buildLabelFromLine(line, matches, qtyIdx, priceIdx) {
  const rangesToRemove = [];

  if (Number.isInteger(priceIdx) && matches[priceIdx]) {
    rangesToRemove.push(matches[priceIdx]);
  }

  if (
    Number.isInteger(qtyIdx) &&
    matches[qtyIdx] &&
    qtyIdx !== priceIdx
  ) {
    rangesToRemove.push(matches[qtyIdx]);
  }

  const rawLabel = removeRangesFromText(line, rangesToRemove);

  return sanitizeOcrLabel(rawLabel);
}

function analyzeSmartBlock({
  items = [],
  computedTotal = 0,
  materialTotal = null,
  grandTotal = null,
}) {
  const labels = items
    .map((it) => String(it?.label || "").toLowerCase())
    .join(" ");

  const hasMaterial =
    /fil|cable|câble|prise|boite|boîte|ciment|fer|tube|peinture|vis|brique/.test(
      labels
    );
  const hasLabor =
    /main.?d.?oeuvre|pose|installation|montage|réparation|reparation|service/.test(
      labels
    );

  let businessType = "general";
  if (hasMaterial && hasLabor) businessType = "mixed";
  else if (hasMaterial) businessType = "material";
  else if (hasLabor) businessType = "service";

  const referenceTotal =
    Number.isFinite(Number(grandTotal)) && Number(grandTotal) > 0
      ? Number(grandTotal)
      : Number.isFinite(Number(materialTotal)) && Number(materialTotal) > 0
      ? Number(materialTotal)
      : null;

  let gap = 0;

  if (
    Number.isFinite(referenceTotal) &&
    Number.isFinite(Number(computedTotal))
  ) {
    gap = Math.round(Number(referenceTotal) - Number(computedTotal));
  }

  const absGap = Math.abs(gap);
  const ratio =
    Number.isFinite(referenceTotal) && referenceTotal > 0
      ? absGap / referenceTotal
      : 0;

  let severity = "none";

  if (referenceTotal != null) {
    if (absGap <= 500 || ratio < 0.02) severity = "none";
    else if (ratio < 0.08) severity = "low";
    else if (ratio < 0.2) severity = "medium";
    else severity = "high";
  }

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
      ratio,
      referenceTotal,
      computedTotal: Number(computedTotal || 0),
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
  if (hint === "missing_labor") {
    suggestion = "Il manque peut-être la main d’œuvre.";
  }
  if (hint === "missing_material") {
    suggestion = "Il manque peut-être les matériaux.";
  }
  if (hint === "mixed") {
    suggestion = "Certaines lignes semblent incomplètes.";
  }

  const gapDirection = gap > 0 ? "manquant" : "en trop";

  return {
    warning: true,
    text:
      `⚠️ Écart détecté dans le bloc analysé.\n\n` +
      `• Type: ${businessType || "general"}\n` +
      `• Écart: ${formatFcfa(Math.abs(gap))} F (${gapDirection})\n` +
      `• Niveau: ${severity}\n\n` +
      `${suggestion}`,
  };
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

    const matches = getNumericMatches(line);
    if (!matches.length) {
      ignored.push(line);
      continue;
    }

    const priceIdx = matches.length - 1;
    const qtyIdx = detectQtyIndex(line, matches);

    let qty = 1;
    if (Number.isInteger(qtyIdx) && matches[qtyIdx]) {
      qty = matches[qtyIdx].value;
    }

    const unitPrice = matches[priceIdx]?.value || null;
    const label = buildLabelFromLine(line, matches, qtyIdx, priceIdx);

    if (!looksLikeRealItemLabel(label) || !Number.isFinite(unitPrice) || unitPrice <= 0) {
      ignored.push(line);
      continue;
    }

    if (!Number.isFinite(qty) || qty <= 0) qty = 1;

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
    /total\s*[:\-]?\s*([0-9][0-9\s.,]*)/i,
    /montant\s+total\s*[:\-]?\s*([0-9][0-9\s.,]*)/i,
    /net\s*a\s*payer\s*[:\-]?\s*([0-9][0-9\s.,]*)/i,
  ];

  let grandTotal = null;

  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const n = parseSmartNumberToken(m[1]);
      if (Number.isFinite(n) && n > 0) {
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
