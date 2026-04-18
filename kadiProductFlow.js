"use strict";

const {
  detectVagueRequest,
  buildSmartGuidanceMessage,
} = require("./kadiNaturalGuidance");

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
      confirmation: draft.confirmation ? { ...draft.confirmation } : null,
    };
  }

  function validateDraftForUi(draft) {
    if (typeof normalizeAndValidateDraft !== "function") {
      return {
        ok: true,
        draft: clonePlainDraft(draft),
        issues: [],
      };
    }

    return normalizeAndValidateDraft(clonePlainDraft(draft));
  }

  function resetItemCaptureState(session) {
    if (!session) return;
    session.itemDraft = null;
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
        ? buildDechargePreviewMessage({ doc: finalDraft, money })
        : buildPreviewMessage({ doc: finalDraft });

    await sendText(from, preview);

    const cost = computeBasePdfCost(finalDraft);
    await sendText(from, formatBaseCostLine(cost));

    await sendPreviewMenu(from, finalDraft);
    return true;
  }

  function sanitizeClientName(value = "") {
    return String(value || "").trim().slice(0, LIMITS.maxClientNameLength);
  }

  function sanitizeItemLabel(value = "") {
    return String(value || "").trim().slice(0, LIMITS.maxItemLabelLength);
  }

  function sanitizeSubject(value = "") {
    return String(value || "").trim().slice(0, LIMITS.maxItemLabelLength);
  }

  function sanitizePhone(value = "") {
    const digits = String(value || "").replace(/\D/g, "");
    return digits || null;
  }

  function isSkipValue(value = "") {
    const t = String(value || "").trim().toLowerCase();
    return t === "0";
  }

  function isCancelValue(value = "") {
    const t = String(value || "").trim().toLowerCase();
    return (
      t === "annuler" ||
      t === "cancel" ||
      t === "retour" ||
      t === "stop" ||
      t === "abandonner"
    );
  }

  async function continueAfterSubjectInput(from, s) {
    const target = s.subjectReturnTarget || "ask_item";
    s.subjectReturnTarget = null;

    if (target === "after_product_menu") {
      s.step = "doc_after_item_choice";
      await sendAfterProductMenu(from, s.lastDocDraft);
      return true;
    }

    s.clientPhoneReturnTarget = target;
    s.step = "client_phone_input";
    await sendText(
      from,
      "📱 Numéro du client ?\nExemple : 22670123456\n\nTapez 0 pour ignorer."
    );
    return true;
  }

  async function continueAfterClientPhoneInput(from, s) {
    const target = s.clientPhoneReturnTarget || "ask_item";
    s.clientPhoneReturnTarget = null;

    if (target === "after_product_menu") {
      s.step = "doc_after_item_choice";
      await sendAfterProductMenu(from, s.lastDocDraft);
      return true;
    }

    if (target === "finish_preview") {
      s.step = "doc_review";
      return sendSafePreview(from, s.lastDocDraft);
    }

    return askItemLabel(from);
  }

  async function startDocFlow(from, mode, factureKind = null) {
    const s = getSession(from);
    const type = String(mode || "").toLowerCase();

    resetItemCaptureState(s);
    s.subjectReturnTarget = null;
    s.clientPhoneReturnTarget = null;

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
      clientPhone: null,
      subject: null,
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

  async function askItemLabel(from) {
    const s = getSession(from);

    if (!s?.lastDocDraft) {
      await sendText(
        from,
        "📄 Je ne vois pas encore de document en cours.\nTapez MENU pour commencer."
      );
      return;
    }

    resetItemCaptureState(s);
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

    // ===== CLIENT =====
    if (s.step === "doc_client") {
      const client = sanitizeClientName(t);

      if (!client) {
        await sendText(from, "❌ Nom client invalide.");
        return true;
      }

      s.lastDocDraft.client = client;
      return askItemLabel(from);
    }

    // ===== SUBJECT INPUT =====
    if (s.step === "doc_subject_input") {
      resetItemCaptureState(s);

      if (isSkipValue(t)) {
        s.lastDocDraft.subject = null;
      } else if (isCancelValue(t)) {
        return continueAfterSubjectInput(from, s);
      } else {
        const subject = sanitizeSubject(t);

        if (!subject) {
          await sendText(
            from,
            "❌ Objet invalide.\nExemple : Réparation voiture"
          );
          return true;
        }

        s.lastDocDraft.subject = subject;
      }

      return continueAfterSubjectInput(from, s);
    }

    // ===== CLIENT PHONE INPUT =====
    if (s.step === "client_phone_input") {
      resetItemCaptureState(s);

      if (isCancelValue(t)) {
        return continueAfterClientPhoneInput(from, s);
      }

      if (isSkipValue(t)) {
        s.lastDocDraft.clientPhone = null;
        return continueAfterClientPhoneInput(from, s);
      }

      const phone = sanitizePhone(t);

      if (!phone || phone.length < 8) {
        await sendText(
          from,
          "❌ Numéro invalide.\nExemple : 22670123456"
        );
        return true;
      }

      s.lastDocDraft.clientPhone = phone;
      return continueAfterClientPhoneInput(from, s);
    }

    // ===== ITEM LABEL =====
    if (s.step === "item_label") {
      if (isCancelValue(t) || isSkipValue(t)) {
        resetItemCaptureState(s);

        if (
          Array.isArray(s.lastDocDraft.items) &&
          s.lastDocDraft.items.length > 0
        ) {
          s.step = "doc_after_item_choice";
          await sendAfterProductMenu(from, s.lastDocDraft);
          return true;
        }

        await sendText(
          from,
          "⚠️ Entrez un nom de ligne.\nExemple : Loyer du mois de mai"
        );
        return true;
      }

      const label = sanitizeItemLabel(t);

      if (!label) {
        await sendText(from, "❌ Nom du produit invalide.");
        return true;
      }

      s.itemDraft = { label, qty: 1 };
      s.step = "item_price";

      await sendText(from, `💰 Prix pour *${label}* ?`);
      return true;
    }

    // ===== ITEM PRICE =====
    if (s.step === "item_price") {
      if (isCancelValue(t) || isSkipValue(t)) {
        resetItemCaptureState(s);

        if (
          Array.isArray(s.lastDocDraft.items) &&
          s.lastDocDraft.items.length > 0
        ) {
          s.step = "doc_after_item_choice";
          await sendAfterProductMenu(from, s.lastDocDraft);
          return true;
        }

        return askItemLabel(from);
      }

      const n = parseNumberSmart(t);

      if (n == null || n <= 0) {
        const vagueCheck = detectVagueRequest(t);

        if (vagueCheck.isVague) {
          await sendText(
            from,
            "⚠️ On était en train d’ajouter un prix.\n\n" +
              buildSmartGuidanceMessage(t)
          );
          return true;
        }

        if (t.length > 12) {
          await sendButtons(
            from,
            "⚠️ J’attends un prix ici.\n\nQue voulez-vous faire ?",
            [
              { id: "DOC_ADD_MORE", title: "✏️ Corriger" },
              { id: "DOC_RESTART", title: "🔁 Recommencer" },
              { id: "DOC_CANCEL", title: "🏠 Menu" },
            ]
          );
          return true;
        }

        await sendText(from, "❌ Prix invalide.\nExemple : 5000");
        return true;
      }

      const label = sanitizeItemLabel(s.itemDraft?.label || "Produit");
      const item = makeItem(label, 1, n);

      s.lastDocDraft.items.push(item);

      const checked = validateDraftForUi(s.lastDocDraft);

      if (!checked.ok) {
        s.lastDocDraft = checked.draft;
        resetItemCaptureState(s);
        await sendBlockedDraft(from, checked.issues);
        return true;
      }

      s.lastDocDraft = checked.draft;
      resetItemCaptureState(s);
      s.step = "doc_after_item_choice";

      await sendText(from, "✅ Produit ajouté");
      await sendAfterProductMenu(from, s.lastDocDraft);
      return true;
    }

    // ===== DECHARGE =====
    if (s.step === "decharge_client") {
      const client = sanitizeClientName(t);

      if (!client) {
        await sendText(from, "❌ Nom invalide.");
        return true;
      }

      s.lastDocDraft.client = client;
      s.step = "decharge_motif";
      await sendText(from, "📝 Motif ?");
      return true;
    }

    if (s.step === "decharge_motif") {
      const motif = sanitizeItemLabel(t);

      if (!motif) {
        await sendText(from, "❌ Motif invalide.");
        return true;
      }

      s.lastDocDraft.motif = motif;
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

    // ===== CLIENT MANQUANT =====
    if (s.step === "missing_client_pdf") {
      const client = sanitizeClientName(t);

      if (!client) {
        await sendText(from, "❌ Nom client invalide.");
        return true;
      }

      s.lastDocDraft.client = client;
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