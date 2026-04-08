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
    normalizeAndValidateDraft,
  } = deps;

  function clonePlainDraft(draft) {
    if (!draft || typeof draft !== "object") return null;
    return {
      ...draft,
      items: Array.isArray(draft.items)
        ? draft.items.map((it) => ({ ...it }))
        : [],
      finance: draft.finance ? { ...draft.finance } : null,
      meta: draft.meta ? { ...draft.meta } : null,
    };
  }

  function validateDraftForUi(draft) {
    return normalizeAndValidateDraft(clonePlainDraft(draft));
  }

  async function sendBlockedDraft(from, issues = []) {
    await sendText(
      from,
      "⚠️ Je préfère bloquer ce document pour éviter une erreur de calcul.\n\n" +
        (issues.length ? `Détail: ${issues.join(", ")}` : "")
    );

    await sendButtons(from, "Que voulez-vous faire ?", [
      { id: "DOC_ADD_MORE", title: "✏️ Corriger" },
      { id: "DOC_RESTART", title: "🔁 Recommencer" },
      { id: "DOC_CANCEL", title: "🏠 Menu" },
    ]);
  }

  async function sendSafePreview(from, draft) {
    const checked = validateDraftForUi(draft);

    if (!checked.ok) {
      const s = getSession(from);
      s.lastDocDraft = checked.draft;
      await sendBlockedDraft(from, checked.issues);
      return true;
    }

    const s = getSession(from);
    s.lastDocDraft = checked.draft;

    const finalDraft = s.lastDocDraft;
    const preview =
      finalDraft.type === "decharge"
        ? buildDechargePreviewMessage({
            doc: finalDraft,
            money,
          })
        : buildPreviewMessage({ doc: finalDraft });

    await sendText(from, preview);

    const cost = computeBasePdfCost(finalDraft);
    await sendText(from, formatBaseCostLine(cost));

    await sendPreviewMenu(from);
    return true;
  }

  function sanitizeClientName(value = "") {
    return String(value || "").trim().slice(0, LIMITS.maxClientNameLength);
  }

  function sanitizeItemLabel(value = "") {
    return String(value || "").trim().slice(0, LIMITS.maxItemLabelLength);
  }

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

    if (!s?.lastDocDraft) {
      await sendText(
        from,
        "📄 Je ne vois pas encore de document en cours.\nTapez MENU pour commencer."
      );
      return;
    }

    s.step = "item_label";

    await sendText(
      from,
      `🧾 Produit ${(s.lastDocDraft.items.length || 0) + 1}\nNom ?`
    );
  }

  async function handleProductFlowText(from, text) {
    const s = getSession(from);
    if (!s?.lastDocDraft) return false;

    const t = String(text || "").trim();
    if (!t) return false;

    // CLIENT
    if (s.step === "doc_client") {
      s.lastDocDraft.client = sanitizeClientName(t);
      return askItemLabel(from);
    }

    // PRODUIT NOM
    if (s.step === "item_label") {
      const label = sanitizeItemLabel(t);

      if (!label) {
        await sendText(from, "❌ Nom du produit invalide.");
        return true;
      }

      s.itemDraft = {
        label,
        qty: 1,
      };

      s.step = "item_price";

      await sendText(from, `💰 Prix pour *${label}* ?`);
      return true;
    }

    // PRODUIT PRIX
    if (s.step === "item_price") {
      const n = parseNumberSmart(t);

      if (n == null || n <= 0) {
        await sendText(from, "❌ Prix invalide.\nExemple : 5000");
        return true;
      }

      const label = sanitizeItemLabel(s.itemDraft?.label || "Produit");
      const item = makeItem(label, 1, n);

      s.lastDocDraft.items.push(item);

      const checked = validateDraftForUi(s.lastDocDraft);

      if (!checked.ok) {
        s.lastDocDraft = checked.draft;
        s.itemDraft = null;
        await sendBlockedDraft(from, checked.issues);
        return true;
      }

      s.lastDocDraft = checked.draft;
      s.itemDraft = null;

      await sendText(from, "✅ Produit ajouté");
      await sendAfterProductMenu(from);
      return true;
    }

    // ===============================
    // DECHARGE FLOW
    // ===============================
    if (s.step === "decharge_client") {
      s.lastDocDraft.client = sanitizeClientName(t);
      s.step = "decharge_motif";
      await sendText(from, "📝 Motif ?");
      return true;
    }

    if (s.step === "decharge_motif") {
      s.lastDocDraft.motif = sanitizeItemLabel(t);
      s.lastDocDraft.dechargeType = detectDechargeType(t);

      s.step = "decharge_amount";
      await sendText(from, "💰 Montant ?");
      return true;
    }

    if (s.step === "decharge_amount") {
      const n = parseNumberSmart(t);

      if (n == null || n < 0) {
        await sendText(from, "❌ Montant invalide");
        return true;
      }

      s.lastDocDraft.items = [
        makeItem(s.lastDocDraft.motif || "Décharge", 1, n),
      ];
      s.lastDocDraft.finance = computeFinance(s.lastDocDraft);
      s.step = "doc_review";

      return sendSafePreview(from, s.lastDocDraft);
    }

    // ===============================
    // FINAL REVIEW
    // ===============================
    if (s.step === "missing_client_pdf") {
      s.lastDocDraft.client = sanitizeClientName(t);
      s.step = "doc_review";

      return sendSafePreview(from, s.lastDocDraft);
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