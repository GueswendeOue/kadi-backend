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

  function computeFinance(doc) {
    let sum = 0;
    for (const it of doc.items || []) {
      sum += Number(it?.amount || 0) || 0;
    }
    return { subtotal: sum, gross: sum };
  }

  function makeItem(label, qty, unitPrice) {
    const q = Number(qty || 0);
    const pu = Number(unitPrice || 0);
    const amt = (Number.isFinite(q) ? q : 0) * (Number.isFinite(pu) ? pu : 0);

    return {
      label: safe(label).slice(0, LIMITS.maxItemLabelLength) || "—",
      qty: Number.isFinite(q) && q > 0 ? q : 1,
      unitPrice: Number.isFinite(pu) && pu >= 0 ? pu : 0,
      amount: Number.isFinite(amt) ? amt : 0,
      raw: "",
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
    if (!draft) throw new Error("Draft manquant");
    if (!Array.isArray(draft.items)) draft.items = [];
    if (!draft.date) draft.date = formatDateISO();

    for (let i = 0; i < draft.items.length; i++) {
      const it = draft.items[i] || {};
      if (Number(it.amount) < 0) {
        throw new Error(`Montant négatif ligne ${i + 1}`);
      }
      if (Number(it.qty) <= 0) {
        throw new Error(`Quantité invalide ligne ${i + 1}`);
      }
    }

    return true;
  }

  function buildPreviewMessage({ doc }) {
    const title = getDocTitle(doc);
    const f = computeFinance(doc);

    const lines = (doc.items || [])
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
      `Date: ${doc.date || "-"}`,
      `Client: ${doc.client || "—"}`,
      ``,
      `Lignes (${(doc.items || []).length})`,
      lines || "—",
      ``,
      `TOTAL: *${money(f.gross)} FCFA*`,
    ].join("\n");
  }

  function cloneDraftToNewDocType(draft, targetType) {
    if (!draft) return null;

    const clonedItems = Array.isArray(draft.items)
      ? draft.items.map((it) => ({ ...it }))
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