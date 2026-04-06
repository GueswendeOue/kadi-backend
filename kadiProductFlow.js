"use strict";

function makeKadiProductFlow(deps) {
  const {
    getSession,
    sendText,
    sendButtons,
    LIMITS,
    formatDateISO,
    makeDraftMeta,
    computeFinance,
    makeItem,
    parseNumberSmart,
    buildPreviewMessage,
    computeBasePdfCost,
    formatBaseCostLine,
    sendPreviewMenu,
    sendAfterProductMenu,
    sendReceiptFormatMenu,
    detectDechargeType,
    buildDechargePreviewMessage,
    initDechargeDraft,
    money,
    safe,
    isValidWhatsAppId,
  } = deps;

  // ===============================
  // START FLOW
  // ===============================
  async function startDocFlow(from, mode, factureKind = null) {
    const s = getSession(from);

    const type = String(mode || "").toLowerCase();

    if (type === "decharge") {
      s.lastDocDraft = initDechargeDraft({
        dateISO: formatDateISO(),
        makeDraftMeta,
      });

      s.step = "decharge_client";

      await sendText(from, "📄 Décharge\n\n👤 Nom de la personne ?");
      return;
    }

    s.lastDocDraft = {
      type,
      factureKind,
      date: formatDateISO(),
      client: null,
      items: [],
      finance: null,
      meta: makeDraftMeta(),
    };

    if (type === "recu") {
      s.step = "receipt_format";
      return sendReceiptFormatMenu(from);
    }

    s.step = "doc_client";

    await sendText(from, "👤 Nom du client ?");
  }

  // ===============================
  // PRODUIT FLOW
  // ===============================
  async function askItemLabel(from) {
    const s = getSession(from);

    s.step = "item_label";

    await sendText(
      from,
      `🧾 Produit ${(s.lastDocDraft.items.length || 0) + 1}\nNom ?`
    );
  }

  async function handleProductFlowText(from, text) {
    const s = getSession(from);
    if (!s.lastDocDraft) return false;

    const t = String(text || "").trim();

    // CLIENT
    if (s.step === "doc_client") {
      s.lastDocDraft.client = t.slice(0, LIMITS.maxClientNameLength);
      return askItemLabel(from);
    }

    // PRODUIT NOM
    if (s.step === "item_label") {
      s.itemDraft = {
        label: t,
        qty: 1,
      };

      s.step = "item_price";

      await sendText(from, `💰 Prix pour *${t}* ?`);
      return true;
    }

    // PRODUIT PRIX
    if (s.step === "item_price") {
      const n = parseNumberSmart(t);

      if (n == null) {
        await sendText(from, "❌ Prix invalide (ex: 5000)");
        return true;
      }

      const item = makeItem(s.itemDraft.label, 1, n);

      s.lastDocDraft.items.push(item);
      s.lastDocDraft.finance = computeFinance(s.lastDocDraft);

      s.itemDraft = null;

      await sendText(from, "✅ Produit ajouté");

      await sendAfterProductMenu(from);
      return true;
    }

    // ===============================
    // DECHARGE FLOW
    // ===============================
    if (s.step === "decharge_client") {
      s.lastDocDraft.client = t;
      s.step = "decharge_motif";
      await sendText(from, "📝 Motif ?");
      return true;
    }

    if (s.step === "decharge_motif") {
      s.lastDocDraft.motif = t;
      s.lastDocDraft.dechargeType = detectDechargeType(t);

      s.step = "decharge_amount";
      await sendText(from, "💰 Montant ?");
      return true;
    }

    if (s.step === "decharge_amount") {
      const n = parseNumberSmart(t);

      if (n == null) {
        await sendText(from, "❌ Montant invalide");
        return true;
      }

      s.lastDocDraft.items = [
        makeItem(s.lastDocDraft.motif || "Décharge", 1, n),
      ];

      s.lastDocDraft.finance = computeFinance(s.lastDocDraft);

      s.step = "doc_review";

      const preview = buildDechargePreviewMessage({
        doc: s.lastDocDraft,
        money,
      });

      await sendText(from, preview);

      const cost = computeBasePdfCost(s.lastDocDraft);
      await sendText(from, formatBaseCostLine(cost));

      await sendPreviewMenu(from);
      return true;
    }

    // ===============================
    // FINAL REVIEW
    // ===============================
    if (s.step === "missing_client_pdf") {
      s.lastDocDraft.client = t;

      s.step = "doc_review";

      const preview = buildPreviewMessage({ doc: s.lastDocDraft });
      await sendText(from, preview);

      const cost = computeBasePdfCost(s.lastDocDraft);
      await sendText(from, formatBaseCostLine(cost));

      await sendPreviewMenu(from);
      return true;
    }

    return false;
  }

  return {
    startDocFlow,
    askItemLabel,
    handleProductFlowText,
  };
}

module.exports = {
  makeKadiProductFlow,
};