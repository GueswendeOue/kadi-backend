"use strict";

function makeDraftHelpers(deps) {
  const {
    money,
    PDF_SIMPLE_CREDITS,
    OCR_PDF_CREDITS,
    DECHARGE_CREDITS,
    LIMITS,
    formatDateISO,
    safe,
  } = deps;

  function makeDraftMeta(overrides = {}) {
    return {
      usedGeminiParse: false,
      businessSector: null,
      usedStamp: false,
      creditsConsumed: null,
      ...overrides,
    };
  }

  function toFiniteNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function cleanLabel(label) {
    return safe(label).slice(0, LIMITS.maxItemLabelLength) || "—";
  }

  function normalizeQty(qty) {
    const q = toFiniteNumber(qty, 1);
    return q > 0 ? q : 1;
  }

  function normalizeUnitPrice(unitPrice) {
    const pu = toFiniteNumber(unitPrice, 0);
    return pu >= 0 ? pu : 0;
  }

  function computeItemAmount(qty, unitPrice) {
    return Math.round(normalizeQty(qty) * normalizeUnitPrice(unitPrice));
  }

  function makeItem(label, qty, unitPrice) {
    const safeQty = normalizeQty(qty);
    const safeUnitPrice = normalizeUnitPrice(unitPrice);

    return {
      label: cleanLabel(label),
      qty: safeQty,
      unitPrice: safeUnitPrice,
      amount: computeItemAmount(safeQty, safeUnitPrice),
      raw: "",
    };
  }

  function normalizeItem(it = {}) {
    const normalized = makeItem(it.label, it.qty, it.unitPrice);

    return {
      ...it,
      ...normalized,
    };
  }

  function normalizeDraftItems(doc) {
    const items = Array.isArray(doc?.items) ? doc.items : [];
    const normalizedItems = items.map(normalizeItem);

    if (doc && Array.isArray(doc.items)) {
      doc.items = normalizedItems;
    }

    return normalizedItems;
  }

  function computeFinance(doc) {
    const items = normalizeDraftItems(doc);

    const subtotal = items.reduce((sum, it) => {
      return sum + toFiniteNumber(it.amount, 0);
    }, 0);

    const roundedSubtotal = Math.round(subtotal);

    const finance = {
      subtotal: roundedSubtotal,
      gross: roundedSubtotal,
      total: roundedSubtotal,
    };

    if (doc && typeof doc === "object") {
      doc.finance = finance;
    }

    return finance;
  }

  function getDraftValidationIssues(draft) {
    const issues = [];

    if (!draft || typeof draft !== "object") {
      return ["draft_missing"];
    }

    const items = Array.isArray(draft.items) ? draft.items : [];

    for (let i = 0; i < items.length; i++) {
      const it = normalizeItem(items[i] || {});
      const expectedAmount = computeItemAmount(it.qty, it.unitPrice);

      if (!safe(it.label) || it.label === "—") {
        issues.push(`invalid_label_line_${i + 1}`);
      }

      if (!Number.isFinite(Number(it.qty)) || Number(it.qty) <= 0) {
        issues.push(`invalid_qty_line_${i + 1}`);
      }

      if (!Number.isFinite(Number(it.unitPrice)) || Number(it.unitPrice) < 0) {
        issues.push(`invalid_unit_price_line_${i + 1}`);
      }

      if (!Number.isFinite(Number(it.amount)) || Number(it.amount) < 0) {
        issues.push(`invalid_amount_line_${i + 1}`);
      }

      if (Number(it.amount) !== expectedAmount) {
        issues.push(`amount_mismatch_line_${i + 1}`);
      }
    }

    const finance = computeFinance({
      items: items.map((it) => ({ ...it })),
    });

    const total = toFiniteNumber(
      draft?.finance?.gross ?? draft?.finance?.total ?? finance.gross,
      0
    );

    if (items.length > 0 && finance.gross <= 0) {
      issues.push("invalid_total");
    }

    if (items.length > 0 && total !== finance.gross) {
      issues.push("finance_mismatch");
    }

    if (
      typeof draft.client === "string" &&
      /\d/.test(draft.client) &&
      /\b(porte|portes|fenetre|fenetres|fenêtres|pagne|pagnes|ciment|prix|montant)\b/i.test(
        draft.client
      )
    ) {
      issues.push("client_suspicious");
    }

    return [...new Set(issues)];
  }

  function normalizeAndValidateDraft(draft) {
    if (!draft || typeof draft !== "object") {
      return {
        ok: false,
        draft,
        issues: ["draft_missing"],
      };
    }

    if (!Array.isArray(draft.items)) {
      draft.items = [];
    }

    if (!draft.date) {
      draft.date = formatDateISO();
    }

    draft.items = draft.items.map(normalizeItem);
    draft.finance = computeFinance(draft);

    const issues = getDraftValidationIssues(draft);

    return {
      ok: issues.length === 0,
      draft,
      issues,
    };
  }

  function getDocTitle(draft) {
    return draft.type === "facture"
      ? draft.factureKind === "proforma"
        ? "FACTURE PRO FORMA"
        : "FACTURE DÉFINITIVE"
      : draft.type === "decharge"
      ? "DÉCHARGE"
      : String(draft.type || "").toUpperCase();
  }

  function computeBasePdfCost(draft) {
    if (draft?.source === "ocr") return OCR_PDF_CREDITS;
    if (draft?.type === "decharge") return DECHARGE_CREDITS;
    return PDF_SIMPLE_CREDITS;
  }

  function formatBaseCostLine(cost) {
    return `💳 Coût: *${cost} crédit(s)*`;
  }

  function validateDraft(draft) {
    const checked = normalizeAndValidateDraft(draft);

    if (!checked.ok) {
      throw new Error(`Draft invalide: ${checked.issues.join(", ")}`);
    }

    return true;
  }

  function buildPreviewMessage({ doc }) {
    const checked = normalizeAndValidateDraft(doc);
    const draft = checked.draft;
    const title = getDocTitle(draft);
    const f = draft.finance || computeFinance(draft);

    const lines = (draft.items || [])
      .slice(0, 50)
      .map(
        (it, idx) =>
          `${idx + 1}) ${it.label} | Qté:${money(it.qty)} | PU:${money(
            it.unitPrice
          )} | Mt:${money(it.amount)}`
      )
      .join("\n");

    return [
      `📄 *APERÇU*`,
      `Type: ${title}`,
      `Date: ${draft.date || "-"}`,
      `Client: ${draft.client || "—"}`,
      ``,
      `Lignes (${(draft.items || []).length})`,
      lines || "—",
      ``,
      `TOTAL: *${money(f.gross)} FCFA*`,
    ].join("\n");
  }

  function cloneDraftToNewDocType(draft, targetType) {
    if (!draft) return null;

    const clonedItems = Array.isArray(draft.items)
      ? draft.items.map((it) => normalizeItem({ ...it }))
      : [];

    const next = {
      ...draft,
      type: targetType,
      factureKind: targetType === "facture" ? "definitive" : null,
      docNumber: null,
      savedDocumentId: null,
      savedPdfMediaId: null,
      savedPdfFilename: null,
      savedPdfCaption: null,
      requestId: null,
      status: "draft",
      source: draft.source || "product",
      items: clonedItems,
      finance: clonedItems.length
        ? computeFinance({ items: clonedItems })
        : draft.finance || null,
      meta: makeDraftMeta({
        ...(draft.meta || {}),
        convertedFromType: draft.type || null,
        convertedAt: new Date().toISOString(),
      }),
    };

    if (targetType === "recu") {
      next.receiptFormat = draft.receiptFormat || "a4";
    } else {
      delete next.receiptFormat;
    }

    return next;
  }

  function resetDraftSession(s) {
    s.step = "idle";
    s.mode = null;
    s.factureKind = null;
    s.lastDocDraft = null;
    s.itemDraft = null;
    s.pendingOcrMediaId = null;
    s.adminPendingAction = null;
    s.broadcastCaption = null;
    s.pendingRechargePack = null;
    s.pendingRechargeAmount = null;
  }

  return {
    makeDraftMeta,
    computeFinance,
    makeItem,
    normalizeItem,
    normalizeAndValidateDraft,
    getDraftValidationIssues,
    getDocTitle,
    computeBasePdfCost,
    formatBaseCostLine,
    validateDraft,
    buildPreviewMessage,
    cloneDraftToNewDocType,
    resetDraftSession,
  };
}

module.exports = {
  makeDraftHelpers,
};