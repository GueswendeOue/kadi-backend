// kadiSmartAnalyzer.js
"use strict";

// ===============================
// BUSINESS TYPE
// ===============================
function detectBusinessType(items = []) {
  const text = items
    .map((it) => String(it?.label || "").toLowerCase())
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (/ciment|fer|fil|cable|prise|tube|sable|tole|chantier|pose|installation/.test(text)) {
    return "artisan";
  }

  if (/riz|sucre|huile|boisson|savon|produit|marchandise|vente/.test(text)) {
    return "commerce";
  }

  if (/service|prestation|consultation|formation|maintenance/.test(text)) {
    return "service";
  }

  return "generic";
}

// ===============================
// GAP ANALYSIS
// ===============================
function computeTotalsGapInfo({ computedTotal, materialTotal, grandTotal }) {
  const computed = Number(computedTotal || 0);
  const material = Number(materialTotal || 0);
  const grand = Number(grandTotal || 0);

  const reference = grand > 0 ? grand : material > 0 ? material : 0;
  const gap = Math.max(0, reference - computed);
  const absGap = Math.abs(reference - computed);

  let severity = "none";

  if (reference > 0 && absGap > 0) {
    const ratio = absGap / reference;

    if (ratio <= 0.05) severity = "small";
    else if (ratio <= 0.2) severity = "medium";
    else severity = "high";
  }

  return {
    computed,
    material,
    grand,
    gap,
    severity,
    hasMismatch: reference > 0 && absGap > 0,
  };
}

// ===============================
// HINT (ULTRA SIMPLE)
// ===============================
function detectMissingHint(items = [], businessType = "generic") {
  const text = items
    .map((it) => String(it?.label || "").toLowerCase())
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const hasMaterial = /ciment|fer|fil|cable|prise|tube|sable|tole/.test(text);
  const hasLabor = /main.?d.?oeuvre|pose|installation|travail/.test(text);
  const hasTransport = /transport|livraison|deplacement|frais|taxi/.test(text);

  if (businessType === "artisan") {
    if (hasMaterial && !hasLabor) return "missing_labor";
    if (!hasMaterial && hasLabor) return "missing_material";
    if ((hasMaterial || hasLabor) && !hasTransport) return "missing_transport";
  }

  if (businessType === "commerce") {
    return "check_quantity";
  }

  if (businessType === "service") {
    return "unknown";
  }

  return "unknown";
}

// ===============================
// MAIN ANALYZER
// ===============================
function analyzeSmartBlock({
  items = [],
  computedTotal = 0,
  materialTotal = 0,
  grandTotal = 0,
}) {
  const businessType = detectBusinessType(items);

  const gapInfo = computeTotalsGapInfo({
    computedTotal,
    materialTotal,
    grandTotal,
  });

  const hint = detectMissingHint(items, businessType);

  return {
    businessType,
    gapInfo,
    hint,
    shouldWarn: gapInfo.hasMismatch,
  };
}

// ===============================
module.exports = {
  analyzeSmartBlock,
};