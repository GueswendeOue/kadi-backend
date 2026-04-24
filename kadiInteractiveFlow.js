"use strict";

function makeKadiInteractiveFlow(deps) {
  const {
    getSession,
    sendText,
    sendButtons,
    money,

    // menus
    sendHomeMenu,
    sendDocsMenu,
    sendCreditsMenu,
    sendProfileMenu,
    sendFactureKindMenu,
    sendFactureCatalogMenu,
    sendPreviewMenu,
    sendStampMenu,
    sendStampMoreMenu,
    sendStampPositionMenu,
    sendStampPositionMenu2,
    sendStampSizeMenu,
    sendAlreadyGeneratedMenu,
    sendPreGenerateStampMenu,
    sendRechargePacksMenu,
    sendRechargePaymentMethodMenu,
    sendOrangeMoneyInstructions,
    sendPispiInstructions,
    sendHistoryHome = null,

    // draft helpers
    makeDraftMeta,
    cloneDraftToNewDocType,
    buildPreviewMessage,
    computeBasePdfCost,
    formatBaseCostLine,
    resetDraftSession,
    normalizeAndValidateDraft,

    // product/natural flows
    startDocFlow,
    askItemLabel,
    tryHandleNaturalMessage,

    // OCR / PDF
    processOcrImageToDraft,
    createAndSendPdf,

    // profile / stamp
    getOrCreateProfile,
    updateProfile,
    hasStampProfileReady,
    resetStampChoice,

    // decharge
    buildDechargeConfirmationMessage,
    buildDechargePreviewMessage,

    // recharge
    getRechargeOffers,
    getRechargeOfferById,
    createManualOrangeMoneyTopup,
    approveTopup,
    rejectTopup,
    readTopup,
    addCredits,

    // followups
    getDevisFollowupById,
    markDevisFollowupConverted,
    postponeDevisFollowup,
    markDevisFollowupDone,
    cancelDevisFollowup,

    // misc
    formatDateISO,
    sendDocument,
    startProfileFlow,
    replyBalance,
    replyRechargeInfo,
    trackConversionEvent = null,
  } = deps;

  const KNOWN_WA_COUNTRY_CODES = [
    "971",
    "351",
    "243",
    "242",
    "237",
    "235",
    "234",
    "229",
    "228",
    "227",
    "226",
    "225",
    "223",
    "221",
    "216",
    "213",
    "212",
    "90",
    "49",
    "44",
    "41",
    "39",
    "34",
    "33",
    "32",
    "31",
    "20",
    "1",
  ];

  function safeText(v, def = null) {
    const s = String(v ?? "").trim();
    return s || def;
  }

  function noDraftMessage() {
    return "📄 Je ne vois pas encore de document en cours.\nTapez MENU pour commencer.";
  }

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

  function resetTransientProductState(session) {
    if (!session) return;
    session.itemDraft = null;
    session.intentPendingItemLabel = null;
  }

  function resetFieldReturnTargets(session) {
    if (!session) return;
    session.subjectReturnTarget = null;
    session.clientPhoneReturnTarget = null;
  }

  function resolveFieldReturnTarget(session, fallback = "after_product_menu") {
    if (!session) return fallback;

    if (session.step === "doc_after_item_choice") {
      return "after_product_menu";
    }

    if (session.step === "doc_review") {
      return "finish_preview";
    }

    return fallback;
  }

  function extractCountryCodeFromWaId(waId = "") {
    const digits = String(waId || "").replace(/\D/g, "");

    for (const code of KNOWN_WA_COUNTRY_CODES) {
      if (digits.startsWith(code)) return code;
    }

    return null;
  }

  function normalizeClientWaId(value = "", senderWaId = "") {
    let digits = String(value || "").replace(/\D/g, "");
    if (!digits) return null;

    if (digits.startsWith("00")) {
      digits = digits.slice(2);
    }

    if (digits.length >= 10 && digits.length <= 15) {
      return digits;
    }

    const senderCode = extractCountryCodeFromWaId(senderWaId);
    if (senderCode && digits.length === 8) {
      return `${senderCode}${digits}`;
    }

    return null;
  }

  function getDraftDocLabel(draft = null) {
    const type = String(draft?.type || "").toLowerCase();
    const kind = String(draft?.factureKind || "").toLowerCase();

    if (type === "facture") {
      return kind === "proforma" ? "Facture proforma" : "Facture définitive";
    }
    if (type === "devis") return "Devis";
    if (type === "recu") return "Reçu";
    if (type === "decharge") return "Décharge";
    return "Document";
  }

  function buildClientDocumentCaption({ draft, businessName }) {
    const docLabel = getDraftDocLabel(draft);
    const docNumber = String(draft?.docNumber || "").trim();
    const client = String(draft?.client || "").trim();
    const sender = String(businessName || "").trim() || "Votre contact";

    let text = `📄 ${docLabel}`;
    if (docNumber) text += ` ${docNumber}`;
    if (client) text += `\n👤 Client : ${client}`;
    text += `\n🏢 Envoyé par : ${sender}`;

    return text;
  }

  function getEditableDraftDocTypeLine(draft = null) {
    const type = String(draft?.type || "").toLowerCase();
    const kind = String(draft?.factureKind || "").toLowerCase();

    if (type === "facture") {
      return kind === "proforma" ? "FACTURE_PROFORMA" : "FACTURE_DEFINITIVE";
    }
    if (type === "devis") return "DEVIS";
    if (type === "recu") return "RECU";
    if (type === "decharge") return "DECHARGE";
    return "DOCUMENT";
  }

  function buildEditableDraftText(draft = null) {
    const lines = [];
    const items = Array.isArray(draft?.items) ? draft.items : [];

    lines.push(`TYPE: ${getEditableDraftDocTypeLine(draft)}`);
    lines.push(`DATE: ${String(draft?.date || "").trim() || formatDateISO()}`);
    lines.push(`CLIENT: ${String(draft?.client || "").trim()}`);
    lines.push(`CLIENT_PHONE: ${String(draft?.clientPhone || "").trim()}`);
    lines.push(`OBJET: ${String(draft?.subject || "").trim()}`);

    if (String(draft?.motif || "").trim()) {
      lines.push(`MOTIF: ${String(draft.motif).trim()}`);
    }

    items.forEach((item, index) => {
      const label = String(item?.label || "").trim();
      const qty = Number(item?.qty || 0);
      const unitPrice = Number(item?.unitPrice || 0);

      lines.push(
        `LIGNE ${index + 1}: ${label} | ${qty} | ${Math.round(unitPrice)}`
      );
    });

    if (items.length === 0) {
      lines.push("LIGNE 1:  | 1 | 0");
    }

    return lines.join("\n");
  }

  function prepareDraftForEdition(draft = null) {
    if (!draft || typeof draft !== "object") return draft;

    const previousDocNumber = safeText(draft.docNumber, null);
    const previousDocumentId = safeText(draft.savedDocumentId, null);

    draft.docNumber = null;

    draft.savedDocumentId = null;
    draft.savedPdfMediaId = null;
    draft.savedPdfFilename = null;
    draft.savedPdfCaption = null;

    draft.pdf_media_id = null;
    draft.pdfMediaId = null;
    draft.pdf_filename = null;
    draft.pdfFilename = null;
    draft.pdf_caption = null;
    draft.pdfCaption = null;

    draft.status = "draft";
    draft.requestId = null;
    draft._saving = false;

    draft.meta = makeDraftMeta({
      ...(draft.meta || {}),
      editedFromDocNumber: previousDocNumber,
      editedFromDocumentId: previousDocumentId,
      editMode: "derived_from_generated",
    });

    return draft;
  }

  function findRechargeOfferByAmount(amountFcfa) {
    const amount = Number(amountFcfa);
    if (!Number.isFinite(amount)) return null;

    const offers = Object.values(getRechargeOffers?.() || {});
    return offers.find((offer) => Number(offer?.amountFcfa) === amount) || null;
  }

  function resolveRechargeOffer(replyId) {
    const directOffer = getRechargeOfferById?.(replyId);
    if (directOffer) return directOffer;

    if (
      replyId === "RECHARGE_1000" ||
      replyId === "RECHARGE_2000" ||
      replyId === "RECHARGE_5000"
    ) {
      const amount = Number(String(replyId).replace("RECHARGE_", ""));
      return findRechargeOfferByAmount(amount);
    }

    return null;
  }

  async function trackForWaId(waId, eventKey, draft = null, meta = {}) {
    if (typeof trackConversionEvent !== "function") return;

    try {
      await trackConversionEvent({
        waId,
        eventKey,
        requestId: safeText(draft?.requestId, null),
        docType: safeText(draft?.type, null),
        docNumber: safeText(draft?.docNumber, null),
        source: safeText(draft?.source, null),
        meta:
          meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {},
      });
    } catch (err) {
      console.warn("[KADI/CONVERSION] track failed:", err?.message || err);
    }
  }

  async function track(from, eventKey, meta = {}) {
    const session = getSession(from);
    return trackForWaId(from, eventKey, session?.lastDocDraft || null, meta);
  }

  function setPendingRechargeState(session, offer, method = null, topup = null) {
    if (!session || !offer) return;

    session.pendingRechargePack = offer.id;
    session.pendingRechargeAmount = offer.amountFcfa;
    session.pendingRechargeCredits = offer.credits;
    session.pendingRechargeIncludesStamp = false;
    session.pendingTopupId = topup?.id || null;
    session.pendingTopupReference = topup?.reference || null;
    session.pendingTopupMethod = method;
  }

  async function sendDraftBlockedMessage(from, checked) {
    const s = getSession(from);
    if (s) s.step = "doc_review";

    const issues = Array.isArray(checked?.issues) ? checked.issues : [];

    await sendText(
      from,
      "⚠️ Je préfère revérifier ce document avant de continuer.\n\n" +
        (issues.length
          ? `Détail: ${issues.join(", ")}`
          : "Certaines données sont incohérentes.")
    );

    await sendButtons(from, "Que voulez-vous faire ?", [
      { id: "DOC_ADD_MORE", title: "➕ Ajouter" },
      { id: "DOC_RESTART", title: "🔁 Refaire" },
      { id: "DOC_CANCEL", title: "🏠 Menu" },
    ]);
  }

  async function sendCurrentDraftPreview(from, draft) {
    if (!draft) {
      await sendText(from, noDraftMessage());
      return;
    }

    const checked = validateDraftForUi(draft);

    if (!checked.ok) {
      const s = getSession(from);
      if (s) s.lastDocDraft = checked.draft;
      return sendDraftBlockedMessage(from, checked);
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

    return sendPreviewMenu(from, finalDraft);
  }

  async function sendEditModeHub(from) {
    await sendText(
      from,
      "✏️ *Mode modification activé.*\n\nChoisissez comment vous voulez modifier ce document."
    );

    await sendButtons(from, "Que voulez-vous faire ?", [
      { id: "DOC_ADD_MORE", title: "➕ Ajouter" },
      { id: "DOC_EDIT_TEXT", title: "✍️ Corriger" },
      { id: "DOC_CANCEL", title: "🏠 Menu" },
    ]);
  }

  async function sendEditTextMode(from, draft) {
    const s = getSession(from);

    const checked = validateDraftForUi(draft);
    s.lastDocDraft = checked.draft;

    if (!checked.ok) {
      return sendDraftBlockedMessage(from, checked);
    }

    s.step = "doc_edit_text_waiting";
    resetTransientProductState(s);
    resetFieldReturnTargets(s);

    await sendText(
      from,
      "✍️ *Correction texte activée.*\n\n" +
        "Copiez ce bloc, corrigez-le puis renvoyez-le dans le chat.\n\n" +
        "Format attendu pour chaque ligne :\n" +
        "LIGNE X: Désignation | Quantité | Prix unitaire"
    );

    await sendText(from, buildEditableDraftText(s.lastDocDraft));
  }

  async function sendHelpQuickActions(from) {
    await sendText(
      from,
      `❓ *Aide rapide*\n\n` +
        `Exemples :\n` +
        `• Devis pour Moussa, 2 portes à 25000\n` +
        `• Facture pour Awa, 5 pagnes à 3000\n` +
        `• Reçu loyer 100000 pour Adama\n` +
        `• Décharge pour prêt de 50000 à Issa`
    );

    await sendButtons(from, "Que voulez-vous faire maintenant ?", [
      { id: "HOME_DOCS", title: "📄 Créer doc" },
      { id: "HOME_OCR", title: "📷 Envoyer photo" },
      { id: "BACK_HOME", title: "🏠 Menu" },
    ]);
  }

  async function sendTutorialQuickActions(from) {
    await sendText(
      from,
      `📚 *Exemples KADI*\n\n` +
        `• Devis pour Moussa, 2 portes à 25000\n` +
        `• Facture pour Awa, 5 pagnes à 3000\n` +
        `• Reçu loyer avril 100000 pour Adama\n` +
        `• Décharge pour prêt de 50000 à Issa\n\n` +
        `Vous pouvez aussi envoyer un vocal ou une photo.`
    );

    await sendButtons(from, "Que voulez-vous faire maintenant ?", [
      { id: "HOME_DOCS", title: "📄 Créer doc" },
      { id: "HOME_OCR", title: "📷 Envoyer photo" },
      { id: "BACK_HOME", title: "🏠 Menu" },
    ]);
  }

  async function sendResumeAfterRecharge(to) {
    const userSession = getSession(to);
    const draft = userSession?.lastDocDraft || null;
    const pendingPdfAfterRecharge = userSession?.pendingPdfAfterRecharge === true;

    await trackForWaId(to, "resume_after_topup_prompt", draft, {
      hasDraft: !!draft,
      pendingPdfAfterRecharge,
      hasGeneratedPdf: !!(draft?.savedPdfMediaId || draft?.savedDocumentId),
    });

    if (!draft) {
      return sendButtons(
        to,
        "✅ *Recharge validée.*\n\nVos crédits sont disponibles.\n\nQue voulez-vous faire maintenant ?",
        [
          { id: "HOME_DOCS", title: "📄 Créer doc" },
          { id: "CREDITS_SOLDE", title: "💳 Solde" },
          { id: "BACK_HOME", title: "🏠 Menu" },
        ]
      );
    }

    if (draft?.savedPdfMediaId || draft?.savedDocumentId) {
      return sendAlreadyGeneratedMenu(to, draft);
    }

    userSession.step = "doc_review";

    const docLabel = getDraftDocLabel(draft).toLowerCase();

    const text = pendingPdfAfterRecharge
      ? `✅ *Recharge validée.*\n\n📄 Votre ${docLabel} est toujours prêt.\n\nVous pouvez maintenant l’envoyer en PDF.`
      : `✅ *Vos crédits sont disponibles.*\n\n📄 Vous pouvez reprendre votre ${docLabel}.`;

    return sendButtons(to, text, [
      { id: "DOC_CONFIRM", title: "📤 Envoyer PDF" },
      { id: "DOC_FINISH", title: "📄 Aperçu" },
      { id: "BACK_HOME", title: "🏠 Menu" },
    ]);
  }

  function buildDraftFromIntent(intent) {
    return {
      type: intent?.docType || "devis",
      factureKind:
        intent?.docType === "facture"
          ? intent?.factureKind || "definitive"
          : null,
      docNumber: null,
      date: formatDateISO(),
      client: intent?.client || null,
      clientPhone: intent?.clientPhone || null,
      subject: intent?.subject || intent?.motif || null,
      motif: intent?.motif || null,
      items: Array.isArray(intent?.items)
        ? intent.items.map((it) => ({
            label: String(it?.label || "Produit").trim(),
            qty: Number(it?.qty || 1),
            unitPrice:
              it?.unitPrice == null ? null : Number(it.unitPrice || 0),
          }))
        : [],
      finance: null,
      source: intent?.source || "voice",
      meta: makeDraftMeta({
        origin: "intent_engine",
        confidence: Number(intent?.confidence || 0),
      }),
    };
  }

  async function askClientPhoneQuestion(from, returnTarget = "finish_preview") {
    const s = getSession(from);
    if (!s?.lastDocDraft) {
      await sendText(from, noDraftMessage());
      return;
    }

    resetTransientProductState(s);
    s.clientPhoneReturnTarget = returnTarget;
    s.step = "doc_client_phone_choice";

    await sendButtons(from, "📱 Voulez-vous ajouter le numéro du client ?", [
      { id: "DOC_ADD_CLIENT_PHONE", title: "Ajouter" },
      { id: "DOC_SKIP_CLIENT_PHONE", title: "Ignorer" },
    ]);
  }

  async function hydrateDraftFromFollowup(row, targetDocType) {
    return cloneDraftToNewDocType(
      {
        type: "devis",
        factureKind: null,
        docNumber: row.doc_number,
        date: row.source_doc?.date || formatDateISO(),
        client: row.source_doc?.client || null,
        clientPhone: row.source_doc?.clientPhone || null,
        subject: row.source_doc?.subject || row.source_doc?.motif || null,
        items: row.source_doc?.items || [],
        finance: row.source_doc?.finance || null,
        source: row.source_doc?.source || "product",
        meta: makeDraftMeta(),
      },
      targetDocType
    );
  }

  async function openFollowupConversion(from, s, followupId, targetDocType) {
    const row = await getDevisFollowupById(followupId);

    if (!row || !row.source_doc) {
      await sendText(
        from,
        "📄 Je n’ai pas retrouvé ce devis.\nRevenez au MENU pour recommencer."
      );
      return;
    }

    s.lastDocDraft = await hydrateDraftFromFollowup(row, targetDocType);

    resetStampChoice(s);
    resetTransientProductState(s);
    resetFieldReturnTargets(s);

    const checked = validateDraftForUi(s.lastDocDraft);
    s.lastDocDraft = checked.draft;

    if (!checked.ok) {
      await sendText(
        from,
        "⚠️ J’ai repris le devis, mais il faut une petite vérification avant de continuer."
      );
      return sendDraftBlockedMessage(from, checked);
    }

    s.step = "doc_review";

    await markDevisFollowupConverted(followupId, targetDocType);

    await sendText(
      from,
      targetDocType === "facture"
        ? "✅ J’ai repris votre devis pour créer une facture."
        : "✅ J’ai repris votre devis pour créer un reçu."
    );

    return sendCurrentDraftPreview(from, s.lastDocDraft);
  }

  async function sendDocumentToClient(from, s) {
    const draft = s?.lastDocDraft;

    if (!draft) {
      await sendText(from, noDraftMessage());
      return;
    }

    const clientWaId = normalizeClientWaId(draft.clientPhone || "", from);

    if (!clientWaId) {
      await sendText(
        from,
        "⚠️ Le numéro du client est manquant ou invalide.\n" +
          "Ajoutez un numéro local ou international.\n" +
          "Exemple : 70000000"
      );
      return;
    }

    if (!draft.savedPdfMediaId) {
      await sendText(
        from,
        "📄 Générez d’abord le PDF, puis utilisez *Envoyer au client*."
      );
      return;
    }

    const profile = await getOrCreateProfile(from);
    const clientCaption = buildClientDocumentCaption({
      draft,
      businessName: profile?.business_name,
    });

    try {
      await sendDocument({
        to: clientWaId,
        mediaId: draft.savedPdfMediaId,
        filename:
          draft.savedPdfFilename || `${draft.docNumber || "document"}.pdf`,
        caption: clientCaption,
      });
    } catch (err) {
      await track(from, "pdf_send_to_client_failed", {
        clientWaId,
        error: String(err?.message || err || "send_failed"),
      });

      await sendText(
        from,
        "⚠️ Je n’ai pas pu envoyer le document au client pour le moment.\n" +
          "Vous pouvez réessayer maintenant."
      );

      s.step = "doc_already_generated";
      await sendAlreadyGeneratedMenu(from, draft);
      return;
    }

    await track(from, "pdf_sent_to_client", {
      clientWaId,
    });

    s.step = "doc_already_generated";

    await sendText(
      from,
      `✅ Document envoyé au client.\n📱 Numéro : +${clientWaId}`
    );

    await sendAlreadyGeneratedMenu(from, draft);
  }

  async function resendLastPdfToOwner(from, s) {
    const draft = s?.lastDocDraft;

    if (!draft?.savedPdfMediaId) {
      await sendText(
        from,
        "📄 Je n’ai pas retrouvé le dernier PDF.\nTapez MENU pour continuer."
      );
      return;
    }

    try {
      await sendDocument({
        to: from,
        mediaId: draft.savedPdfMediaId,
        filename:
          draft.savedPdfFilename || `${draft.docNumber || "document"}.pdf`,
        caption:
          draft.savedPdfCaption ||
          "📄 Voici à nouveau votre document.\nAucun crédit supplémentaire n’a été consommé.",
      });
    } catch (err) {
      await track(from, "pdf_resend_failed", {
        error: String(err?.message || err || "send_failed"),
      });

      await sendText(
        from,
        "⚠️ Je n’ai pas pu renvoyer le PDF pour le moment.\nRéessayez dans un instant."
      );
      return;
    }

    await track(from, "pdf_resend_success");
    s.step = "doc_already_generated";
    await sendAlreadyGeneratedMenu(from, draft);
  }

  async function approveTopupFlow(adminWaId, topupId) {
    const topup = await readTopup(topupId);

    if (!topup) {
      await sendText(adminWaId, "⚠️ Je n’ai pas retrouvé cette recharge.");
      return;
    }

    if (topup.status === "approved") {
      await sendText(adminWaId, "ℹ️ Cette recharge est déjà validée.");
      return;
    }

    if (topup.status === "rejected") {
      await sendText(adminWaId, "⚠️ Cette recharge a déjà été refusée.");
      return;
    }

    await addCredits(
      { waId: topup.wa_id },
      topup.credits,
      "manual_om_topup",
      `topup:${topup.id}`,
      {
        topupId: topup.id,
        reference: topup.reference,
        amountFcfa: topup.amount_fcfa,
        credits: topup.credits,
        paymentMethod: topup.payment_method || "orange_money_manual",
        source: "manual_topup_approval",
      }
    );

    await approveTopup(topup.id);

    await trackForWaId(topup.wa_id, "topup_approved", null, {
      topupId: topup.id,
      reference: topup.reference,
      amountFcfa: topup.amount_fcfa,
      credits: topup.credits,
      method: topup.payment_method || null,
    });

    try {
      await sendText(
        adminWaId,
        `✅ Recharge validée.\n\nRéférence : ${topup.reference || "-"}`
      );
    } catch (err) {
      console.warn("[TOPUP] admin confirmation failed:", err?.message || err);
    }

    try {
      await sendText(
        topup.wa_id,
        `✅ Paiement validé !\n\n🎉 ${topup.credits} crédits ajoutés à votre compte.`
      );
      await sendResumeAfterRecharge(topup.wa_id);
    } catch (err) {
      console.warn("[TOPUP] user success notification failed:", err?.message || err);
    }
  }

  async function rejectTopupFlow(adminWaId, topupId) {
    const topup = await readTopup(topupId);

    if (!topup) {
      await sendText(adminWaId, "⚠️ Je n’ai pas retrouvé cette recharge.");
      return;
    }

    if (topup.status === "approved") {
      await sendText(adminWaId, "⚠️ Cette recharge a déjà été validée.");
      return;
    }

    if (topup.status === "rejected") {
      await sendText(adminWaId, "ℹ️ Cette recharge est déjà refusée.");
      return;
    }

    await rejectTopup(topup.id, "rejected_by_admin");

    await trackForWaId(topup.wa_id, "topup_rejected", null, {
      topupId: topup.id,
      reference: topup.reference,
      amountFcfa: topup.amount_fcfa,
      credits: topup.credits,
      method: topup.payment_method || null,
    });

    try {
      await sendText(
        adminWaId,
        `❌ Recharge refusée.\n\nRéférence : ${topup.reference || "-"}`
      );
    } catch (err) {
      console.warn("[TOPUP] admin rejection notification failed:", err?.message || err);
    }

    try {
      await sendText(
        topup.wa_id,
        "❌ Votre recharge n’a pas été validée.\n\nVérifiez la preuve envoyée ou réessayez."
      );
    } catch (err) {
      console.warn("[TOPUP] user rejection notification failed:", err?.message || err);
    }
  }

  async function handleInteractiveReply(from, replyId) {
    const s = getSession(from);

    if (!replyId) {
      await sendText(
        from,
        "⚠️ Je n’ai pas pu ouvrir cette option.\nTapez MENU pour continuer."
      );
      return;
    }

    if (!s) {
      await sendText(
        from,
        "⚠️ Une petite erreur s’est produite.\nTapez MENU pour reprendre."
      );
      return;
    }

    // ===============================
    // INTENT REVIEW (VOICE / IA)
    // ===============================
    if (replyId === "INTENT_OK") {
      const intent = s.intent || null;

      if (!intent) {
        await sendText(
          from,
          "🎙️ Je n’ai pas retrouvé votre dernière analyse.\nRenvoyez votre message pour recommencer."
        );
        return;
      }

      if (Array.isArray(intent.missing) && intent.missing.length > 0) {
        if (intent.missing.includes("client")) {
          resetTransientProductState(s);
          resetFieldReturnTargets(s);
          s.step = "intent_fix_client";
          await sendText(from, "👤 Quel est le nom du client ?");
          return;
        }

        if (intent.missing.includes("price")) {
          const item = Array.isArray(intent.items)
            ? intent.items.find((i) => i?.unitPrice == null)
            : null;

          resetTransientProductState(s);
          resetFieldReturnTargets(s);
          s.step = "intent_fix_price";
          s.intentPendingItemLabel = item?.label || null;

          await sendText(
            from,
            `💰 Quel est le prix pour : *${item?.label || "cet article"}* ?`
          );
          return;
        }

        if (intent.missing.includes("items")) {
          resetTransientProductState(s);
          resetFieldReturnTargets(s);
          s.step = "intent_fix_items";
          await sendText(
            from,
            "📦 Je n’ai pas bien compris les éléments.\nÉcrivez-les clairement pour continuer."
          );
          return;
        }
      }

      s.lastDocDraft = buildDraftFromIntent(intent);
      resetStampChoice(s);
      resetTransientProductState(s);
      resetFieldReturnTargets(s);
      s.step = "doc_review";
      s.intent = null;

      return sendCurrentDraftPreview(from, s.lastDocDraft);
    }

    if (replyId === "INTENT_FIX") {
      const intent = s.intent || null;

      if (!intent) {
        await sendText(
          from,
          "🎙️ Je n’ai pas retrouvé votre dernière analyse.\nRenvoyez votre message pour recommencer."
        );
        return;
      }

      resetTransientProductState(s);
      resetFieldReturnTargets(s);
      s.step = "intent_fix";
      await sendText(
        from,
        "✏️ Corrigez les informations en une phrase.\n\n" +
          "Exemple :\n" +
          "Devis pour Moussa, 2 portes à 25000 et 2 fenêtres à 5000"
      );
      return;
    }

    // ===============================
    // SMART BLOCK
    // ===============================
    if (replyId === "SMARTBLOCK_FIX") {
      await sendText(
        from,
        "✍️ D’accord. Corrigez ou ajoutez les lignes, puis renvoyez le texte."
      );
      return;
    }

    if (replyId === "SMARTBLOCK_CONTINUE") {
      const draft = s.lastDocDraft;

      if (!draft) {
        await sendText(from, noDraftMessage());
        return;
      }

      resetTransientProductState(s);
      s.step = "doc_review";
      return sendCurrentDraftPreview(from, draft);
    }

    // ===============================
    // NAVIGATION
    // ===============================
    if (replyId === "BACK_HOME") return sendHomeMenu(from);
    if (replyId === "BACK_DOCS") return sendDocsMenu(from);

    // ===============================
    // HOME / HELP
    // ===============================
    if (replyId === "HOME_DOCS") return sendDocsMenu(from);
    if (replyId === "HOME_CREDITS") return sendCreditsMenu(from);
    if (replyId === "HOME_PROFILE") return sendProfileMenu(from);

    if (replyId === "HOME_OCR") {
      resetTransientProductState(s);
      resetFieldReturnTargets(s);
      s.step = "awaiting_ocr_image";
      await sendText(
        from,
        "📷 Envoyez la photo de votre facture, devis ou reçu.\n\nJe vais la transformer en document propre."
      );
      return;
    }

    if (replyId === "HOME_TUTORIAL") {
      await track(from, "tutorial_opened");
      return sendTutorialQuickActions(from);
    }

    if (replyId === "HOME_HELP") {
      await track(from, "help_opened");
      return sendHelpQuickActions(from);
    }

    if (replyId === "HOME_HISTORY") {
      await track(from, "history_opened");

      if (typeof sendHistoryHome === "function") {
        return sendHistoryHome(from);
      }

      await sendText(from, "📚 Historique indisponible pour le moment.");
      return;
    }

    // ===============================
    // QUICK RECHARGE ENTRY
    // ===============================
    if (
      replyId === "RECHARGE_1000" ||
      replyId === "RECHARGE_2000" ||
      replyId === "RECHARGE_5000"
    ) {
      const offer = resolveRechargeOffer(replyId);

      if (!offer) {
        return sendRechargePacksMenu(from);
      }

      const entry =
        s.pendingPdfAfterRecharge === true ? "blocked_pdf" : "quick_reply";

      resetTransientProductState(s);
      setPendingRechargeState(s, offer, null, null);

      await track(from, "recharge_pack_selected", {
        amountFcfa: offer.amountFcfa,
        credits: offer.credits,
        packId: offer.id,
        entry,
        pendingPdfAfterRecharge: s.pendingPdfAfterRecharge === true,
      });

      return sendRechargePaymentMethodMenu(from, offer);
    }

    // ===============================
    // RECEIPT FORMAT
    // ===============================
    if (replyId === "RECEIPT_FORMAT_COMPACT") {
      if (!s.lastDocDraft) {
        await sendText(from, noDraftMessage());
        return;
      }

      resetTransientProductState(s);
      resetFieldReturnTargets(s);
      s.lastDocDraft.receiptFormat = "compact";
      s.step = "doc_client";

      await sendText(from, "🧾 Format ticket sélectionné.");
      await sendText(from, "👤 Nom du client ?\n(Ex: Awa / Ben / Société X)");
      return;
    }

    if (replyId === "RECEIPT_FORMAT_A4") {
      if (!s.lastDocDraft) {
        await sendText(from, noDraftMessage());
        return;
      }

      resetTransientProductState(s);
      resetFieldReturnTargets(s);
      s.lastDocDraft.receiptFormat = "a4";
      s.step = "doc_client";

      await sendText(from, "📄 Format A4 sélectionné.");
      await sendText(from, "👤 Nom du client ?\n(Ex: Awa / Ben / Société X)");
      return;
    }

    // ===============================
    // FOLLOWUPS DEVIS
    // ===============================
    const followupFacture = replyId.match(/^FOLLOWUP_FACTURE_(.+)$/);
    if (followupFacture) {
      return openFollowupConversion(from, s, followupFacture[1], "facture");
    }

    const followupRecu = replyId.match(/^FOLLOWUP_RECU_(.+)$/);
    if (followupRecu) {
      return openFollowupConversion(from, s, followupRecu[1], "recu");
    }

    const followupLater = replyId.match(/^FOLLOWUP_LATER_(.+)$/);
    if (followupLater) {
      await postponeDevisFollowup(followupLater[1], 48);
      await sendText(
        from,
        "⏳ D’accord, je vous le rappellerai une dernière fois plus tard."
      );
      return;
    }

    const followupDone = replyId.match(/^FOLLOWUP_DONE_(.+)$/);
    if (followupDone) {
      if (typeof markDevisFollowupDone === "function") {
        await markDevisFollowupDone(followupDone[1]);
      }

      await sendText(from, "✅ Parfait. Je ferme ce rappel.");
      return;
    }

    const followupCancel = replyId.match(/^FOLLOWUP_CANCEL_(.+)$/);
    if (followupCancel) {
      if (typeof cancelDevisFollowup === "function") {
        await cancelDevisFollowup(followupCancel[1]);
      }

      await sendText(
        from,
        "✅ D’accord, je ne vous relancerai plus pour ce devis."
      );
      return;
    }

    // ===============================
    // SUBJECT / CLIENT PHONE
    // ===============================
    if (replyId === "DOC_ADD_SUBJECT") {
      const returnTarget = resolveFieldReturnTarget(s, "after_product_menu");

      resetTransientProductState(s);
      s.subjectReturnTarget = returnTarget;
      s.step = "doc_subject_input";

      await sendText(
        from,
        "📝 Tapez l’objet du document.\nExemple : Réparation voiture"
      );
      return;
    }

    if (replyId === "DOC_SKIP_SUBJECT") {
      if (s.lastDocDraft) {
        s.lastDocDraft.subject = null;
      }

      return askClientPhoneQuestion(
        from,
        s.subjectReturnTarget || "finish_preview"
      );
    }

    if (replyId === "DOC_ADD_CLIENT_PHONE") {
      const returnTarget = resolveFieldReturnTarget(s, "after_product_menu");

      resetTransientProductState(s);
      s.clientPhoneReturnTarget = returnTarget;
      s.step = "client_phone_input";

      await sendText(
        from,
        "📱 Tapez le numéro du client.\nExemple : 70000000\n\nTapez 0 pour ignorer."
      );
      return;
    }

    if (replyId === "DOC_SKIP_CLIENT_PHONE") {
      if (s.lastDocDraft) {
        s.lastDocDraft.clientPhone = null;
      }

      const target = s.clientPhoneReturnTarget || "finish_preview";
      s.clientPhoneReturnTarget = null;

      if (target === "finish_preview") {
        s.step = "doc_review";
        return sendCurrentDraftPreview(from, s.lastDocDraft);
      }

      s.step = "doc_after_item_choice";
      return sendButtons(from, "Que voulez-vous faire maintenant ?", [
        { id: "DOC_ADD_MORE", title: "➕ Ajouter" },
        { id: "DOC_ADD_CLIENT_PHONE", title: "📱 Client" },
        { id: "DOC_FINISH", title: "📄 Aperçu" },
      ]);
    }

    if (replyId === "DOC_SEND_TO_CLIENT") {
      return sendDocumentToClient(from, s);
    }

    if (replyId === "DOC_SKIP_SEND_TO_CLIENT") {
      await sendText(from, "✅ D’accord.");
      return sendHomeMenu(from);
    }

    // ===============================
    // SMART BLOCK -> NATURAL
    // ===============================
    if (
      replyId === "SMARTBLOCK_DEVIS" ||
      replyId === "SMARTBLOCK_FACTURE" ||
      replyId === "SMARTBLOCK_RECU"
    ) {
      const raw = String(s.pendingSmartBlockText || "").trim();

      if (!raw) {
        await sendText(
          from,
          "⚠️ Je n’ai pas retrouvé ce contenu.\nRenvoyez votre message pour continuer."
        );
        return;
      }

      const mode =
        replyId === "SMARTBLOCK_FACTURE"
          ? "facture"
          : replyId === "SMARTBLOCK_RECU"
          ? "recu"
          : "devis";

      s.lastDocDraft = {
        type: mode,
        factureKind: mode === "facture" ? "definitive" : null,
        docNumber: null,
        date: formatDateISO(),
        client: null,
        clientPhone: null,
        subject: null,
        motif: null,
        items: [],
        finance: null,
        source: "natural_text",
        meta: makeDraftMeta(),
      };

      resetStampChoice(s);
      resetTransientProductState(s);
      resetFieldReturnTargets(s);
      s.pendingSmartBlockText = null;

      const handled = await tryHandleNaturalMessage(from, raw);
      if (handled) return;

      s.step = "item_label";
      s.itemDraft = {
        label: raw,
        qty: 1,
        unitPrice: null,
      };

      await sendText(from, `💰 Prix pour : *${raw}* ?`);
      s.step = "item_price";
      return;
    }

    // ===============================
    // CATALOGUE DOCS
    // ===============================
    if (replyId === "DOC_DEVIS") {
      resetStampChoice(s);
      resetTransientProductState(s);
      resetFieldReturnTargets(s);
      return startDocFlow(from, "devis");
    }

    if (replyId === "DOC_RECU") {
      resetStampChoice(s);
      resetTransientProductState(s);
      resetFieldReturnTargets(s);
      return startDocFlow(from, "recu");
    }

    if (replyId === "DOC_DECHARGE") {
      resetStampChoice(s);
      resetTransientProductState(s);
      resetFieldReturnTargets(s);
      return startDocFlow(from, "decharge");
    }

    if (replyId === "DOC_FACTURE_MENU") {
      return sendFactureCatalogMenu
        ? sendFactureCatalogMenu(from)
        : sendFactureKindMenu(from);
    }

    if (replyId === "DOC_FACTURE") {
      resetTransientProductState(s);
      resetFieldReturnTargets(s);
      s.step = "facture_kind";
      return sendFactureKindMenu(from);
    }

    if (replyId === "FAC_PROFORMA" || replyId === "FAC_DEFINITIVE") {
      resetStampChoice(s);
      resetTransientProductState(s);
      resetFieldReturnTargets(s);
      const kind = replyId === "FAC_PROFORMA" ? "proforma" : "definitive";
      return startDocFlow(from, "facture", kind);
    }

    // ===============================
    // OCR
    // ===============================
    if (replyId === "OCR_DEVIS" || replyId === "OCR_RECU") {
      const mediaId = s.pendingOcrMediaId;
      s.pendingOcrMediaId = null;

      if (!mediaId) {
        await sendText(
          from,
          "📷 Je n’ai pas retrouvé la photo.\nRenvoyez-la pour continuer."
        );
        return;
      }

      const mode = replyId === "OCR_RECU" ? "recu" : "devis";

      s.lastDocDraft = {
        type: mode,
        factureKind: null,
        docNumber: null,
        date: formatDateISO(),
        client: null,
        clientPhone: null,
        subject: null,
        items: [],
        finance: null,
        source: "ocr",
        meta: makeDraftMeta(),
      };

      resetStampChoice(s);
      resetTransientProductState(s);
      resetFieldReturnTargets(s);
      return processOcrImageToDraft(from, mediaId);
    }

    if (replyId === "OCR_FACTURE") {
      const mediaId = s.pendingOcrMediaId;
      s.pendingOcrMediaId = null;

      if (!mediaId) {
        await sendText(
          from,
          "📷 Je n’ai pas retrouvé la photo.\nRenvoyez-la pour continuer."
        );
        return;
      }

      s.lastDocDraft = {
        type: "facture",
        factureKind: "definitive",
        docNumber: null,
        date: formatDateISO(),
        client: null,
        clientPhone: null,
        subject: null,
        items: [],
        finance: null,
        source: "ocr",
        meta: makeDraftMeta(),
      };

      resetStampChoice(s);
      resetTransientProductState(s);
      resetFieldReturnTargets(s);
      return processOcrImageToDraft(from, mediaId);
    }

    // ===============================
    // PROFIL / TAMPON
    // ===============================
    if (replyId === "PROFILE_STAMP") return sendStampMenu(from);

    if (replyId === "PROFILE_EDIT") {
      resetTransientProductState(s);
      return startProfileFlow(from);
    }

    if (replyId === "STAMP_TOGGLE") {
      const p = await getOrCreateProfile(from);
      const nextEnabled = !(p?.stamp_enabled === true);

      await updateProfile(from, { stamp_enabled: nextEnabled });

      await sendText(
        from,
        nextEnabled
          ? "🟦 Tampon activé dans votre profil."
          : "🟦 Tampon désactivé."
      );

      return sendStampMenu(from);
    }

    if (replyId === "STAMP_EDIT_TITLE") {
      resetTransientProductState(s);
      s.step = "stamp_title";
      await sendText(
        from,
        "✍️ Fonction du tampon ?\nEx: GERANT / DIRECTEUR / COMMERCIAL\n\nTapez 0 pour effacer."
      );
      return;
    }

    if (replyId === "STAMP_MORE") return sendStampMoreMenu(from);

    if (replyId === "STAMP_POS") {
      await sendStampPositionMenu(from);
      return sendStampPositionMenu2(from);
    }

    if (replyId === "STAMP_SIZE") return sendStampSizeMenu(from);

    if (replyId === "STAMP_POS_BR") {
      await updateProfile(from, { stamp_position: "bottom-right" });
      return sendStampMenu(from);
    }

    if (replyId === "STAMP_POS_BL") {
      await updateProfile(from, { stamp_position: "bottom-left" });
      return sendStampMenu(from);
    }

    if (replyId === "STAMP_POS_TR") {
      await updateProfile(from, { stamp_position: "top-right" });
      return sendStampMenu(from);
    }

    if (replyId === "STAMP_POS_TL") {
      await updateProfile(from, { stamp_position: "top-left" });
      return sendStampMenu(from);
    }

    if (replyId === "STAMP_SIZE_S") {
      await updateProfile(from, { stamp_size: 150 });
      return sendStampMenu(from);
    }

    if (replyId === "STAMP_SIZE_M") {
      await updateProfile(from, { stamp_size: 170 });
      return sendStampMenu(from);
    }

    if (replyId === "STAMP_SIZE_L") {
      await updateProfile(from, { stamp_size: 200 });
      return sendStampMenu(from);
    }

    // ===============================
    // CRÉDITS / RECHARGE
    // ===============================
    if (replyId === "CREDITS_SOLDE") return replyBalance(from);
    if (replyId === "CREDITS_RECHARGE") return replyRechargeInfo(from);

    const selectedOffer = resolveRechargeOffer(replyId);
    if (selectedOffer) {
      const entry =
        s.pendingPdfAfterRecharge === true ? "blocked_pdf" : "pack_menu";

      resetTransientProductState(s);
      setPendingRechargeState(s, selectedOffer, null, null);

      await track(from, "recharge_pack_selected", {
        amountFcfa: selectedOffer.amountFcfa,
        credits: selectedOffer.credits,
        packId: selectedOffer.id,
        entry,
        pendingPdfAfterRecharge: s.pendingPdfAfterRecharge === true,
      });

      return sendRechargePaymentMethodMenu(from, selectedOffer);
    }

    if (replyId.startsWith("PAY_OM_")) {
      const amount = Number(replyId.replace("PAY_OM_", ""));
      const offer = findRechargeOfferByAmount(amount);

      if (!offer) {
        await sendText(
          from,
          "⚠️ Je n’ai pas retrouvé ce pack.\nRevenez au menu RECHARGE."
        );
        return sendRechargePacksMenu(from);
      }

      const topup = await createManualOrangeMoneyTopup({
        waId: from,
        amountFcfa: offer.amountFcfa,
        credits: offer.credits,
        includesStamp: false,
      });

      resetTransientProductState(s);
      setPendingRechargeState(s, offer, "orange_money", topup);
      s.step = "recharge_proof";

      await track(from, "recharge_payment_method_selected", {
        method: "orange_money",
        amountFcfa: offer.amountFcfa,
        credits: offer.credits,
        packId: offer.id,
        topupId: topup.id,
        reference: topup.reference,
        pendingPdfAfterRecharge: s.pendingPdfAfterRecharge === true,
      });

      return sendOrangeMoneyInstructions(from, offer);
    }

    if (replyId.startsWith("PAY_PISPI_")) {
      const amount = Number(replyId.replace("PAY_PISPI_", ""));
      const offer = findRechargeOfferByAmount(amount);

      if (!offer) {
        await sendText(
          from,
          "⚠️ Je n’ai pas retrouvé ce pack.\nRevenez au menu RECHARGE."
        );
        return sendRechargePacksMenu(from);
      }

      resetTransientProductState(s);
      setPendingRechargeState(s, offer, "pispi", null);
      s.step = "pispi_pending";

      await track(from, "recharge_payment_method_selected", {
        method: "pispi",
        amountFcfa: offer.amountFcfa,
        credits: offer.credits,
        packId: offer.id,
        pendingPdfAfterRecharge: s.pendingPdfAfterRecharge === true,
      });

      return sendPispiInstructions(from, offer);
    }

    if (replyId.startsWith("OM_PAID_")) {
      resetTransientProductState(s);
      s.step = "recharge_proof";

      await track(from, "topup_declared_paid", {
        method: "orange_money",
        amountFcfa: Number(replyId.replace("OM_PAID_", "")),
        pendingPdfAfterRecharge: s.pendingPdfAfterRecharge === true,
      });

      const resumeLine =
        s.pendingPdfAfterRecharge === true
          ? "\n\n📄 Votre document reste prêt. Après validation, vous pourrez l’envoyer en PDF."
          : "\n\n✅ Après validation, vos crédits seront ajoutés.";

      await sendText(
        from,
        "⏳ D’accord.\n\n" +
          "Envoyez maintenant :\n" +
          "• le message de transaction\n" +
          "OU\n" +
          "• une capture d’écran du paiement" +
          resumeLine
      );
      return;
    }

    if (replyId.startsWith("OM_SEND_PROOF_")) {
      resetTransientProductState(s);
      s.step = "recharge_proof";

      await track(from, "topup_proof_prompt_opened", {
        method: "orange_money",
        amountFcfa: Number(replyId.replace("OM_SEND_PROOF_", "")),
        pendingPdfAfterRecharge: s.pendingPdfAfterRecharge === true,
      });

      const resumeLine =
        s.pendingPdfAfterRecharge === true
          ? "\n\n📄 Votre document reste prêt. Après validation, vous pourrez l’envoyer en PDF."
          : "";

      await sendText(
        from,
        "📎 Envoyez la preuve ici :\n" +
          "• capture d’écran\n" +
          "OU\n" +
          "• message de confirmation Orange Money" +
          resumeLine
      );
      return;
    }

    if (replyId.startsWith("PISPI_CHECK_")) {
      await sendText(from, "🔍 Vérification du paiement en cours...");
      await sendText(
        from,
        "⚠️ Paiement non détecté pour le moment.\n\nSi vous êtes en mode test PI-SPI, terminez d’abord le parcours dans l’application compatible puis réessayez."
      );
      return;
    }

    const approveTopupMatch = replyId.match(/^TOPUP_APPROVE_(.+)$/);
    if (approveTopupMatch) {
      return approveTopupFlow(from, approveTopupMatch[1]);
    }

    const rejectTopupMatch = replyId.match(/^TOPUP_REJECT_(.+)$/);
    if (rejectTopupMatch) {
      return rejectTopupFlow(from, rejectTopupMatch[1]);
    }

    // ===============================
    // PRODUIT / PREVIEW / PDF
    // ===============================
    if (replyId === "ITEM_EDIT") {
      resetTransientProductState(s);
      return askItemLabel(from);
    }

    if (replyId === "DOC_ADD_MORE") {
      const draft = s.lastDocDraft;

      if (!draft) {
        await sendText(from, noDraftMessage());
        return;
      }

      const hasGeneratedArtifact = !!(
        draft.savedDocumentId || draft.savedPdfMediaId
      );

      if (hasGeneratedArtifact) {
        prepareDraftForEdition(draft);
        s.lastDocDraft = draft;

        await sendText(
          from,
          "➕ *Mode ajout activé.*\n\nAjoutez une nouvelle ligne au document."
        );
      }

      resetTransientProductState(s);
      resetFieldReturnTargets(s);
      return askItemLabel(from);
    }

    if (replyId === "DOC_EDIT_TEXT") {
      const draft = s.lastDocDraft;

      if (!draft) {
        await sendText(from, noDraftMessage());
        return;
      }

      const hasGeneratedArtifact = !!(
        draft.savedDocumentId || draft.savedPdfMediaId
      );

      if (hasGeneratedArtifact) {
        prepareDraftForEdition(draft);
        s.lastDocDraft = draft;
      }

      return sendEditTextMode(from, s.lastDocDraft);
    }

    if (replyId === "DOC_FINISH") {
      const draft = s.lastDocDraft;
      if (!draft) {
        await sendText(from, noDraftMessage());
        return;
      }

      resetTransientProductState(s);
      resetFieldReturnTargets(s);

      s.step = "doc_review";
      return sendCurrentDraftPreview(from, draft);
    }

    if (replyId === "DECHARGE_SEND_CONFIRMATION") {
      const draft = s.lastDocDraft;

      if (!draft || draft.type !== "decharge") {
        await sendText(
          from,
          "📝 Je ne vois pas encore de décharge en cours.\nTapez MENU pour commencer."
        );
        return;
      }

      const targetWaId = draft?.confirmation?.targetWaId;
      if (!targetWaId) {
        await sendText(
          from,
          "📱 Je n’ai pas retrouvé le numéro de confirmation.\nVérifiez puis recommencez."
        );
        return;
      }

      const checked = validateDraftForUi(draft);
      s.lastDocDraft = checked.draft;

      if (!checked.ok) {
        return sendDraftBlockedMessage(from, checked);
      }

      const confirmationMessage = buildDechargeConfirmationMessage({
        doc: s.lastDocDraft,
        money,
      });

      await sendText(targetWaId, confirmationMessage);

      s.step = "doc_review";

      const preview = buildDechargePreviewMessage({
        doc: s.lastDocDraft,
        money,
      });
      await sendText(from, preview);

      const cost = computeBasePdfCost(s.lastDocDraft);
      await sendText(from, formatBaseCostLine(cost));

      await sendPreviewMenu(from, s.lastDocDraft);
      return;
    }

    if (replyId === "DOC_CONFIRM") {
      const draft = s.lastDocDraft;

      await track(from, "pdf_confirm_clicked", {
        step: s.step || null,
        pendingPdfAfterRecharge: s.pendingPdfAfterRecharge === true,
      });

      if (!draft) {
        await sendText(from, noDraftMessage());
        return;
      }

      const checked = validateDraftForUi(draft);
      if (!checked.ok) {
        s.lastDocDraft = checked.draft;
        return sendDraftBlockedMessage(from, checked);
      }
      s.lastDocDraft = checked.draft;

      const finalDraft = s.lastDocDraft;

      if (finalDraft._saving === true || s.isGeneratingPdf === true) {
        await sendText(from, "⏳ Génération en cours...");
        return;
      }

      if (finalDraft.savedDocumentId || finalDraft.savedPdfMediaId) {
        s.step = "doc_already_generated";
        await sendAlreadyGeneratedMenu(from, finalDraft);
        return;
      }

      const p = await getOrCreateProfile(from);

      if (p?.stamp_enabled === true && hasStampProfileReady(p)) {
        await sendText(
          from,
          "💡 *Ajoutez un tampon professionnel ?*\n\n" +
            "Pour seulement *+1 crédit*, votre document paraît plus crédible et plus pro."
        );
        await sendPreGenerateStampMenu(from);
        return;
      }

      resetStampChoice(s);
      resetTransientProductState(s);

      finalDraft._saving = true;
      try {
        await createAndSendPdf(from);
        return;
      } finally {
        finalDraft._saving = false;
      }
    }

    if (replyId === "PRESTAMP_SKIP") {
      await track(from, "stamp_upsell_skipped", {
        step: s.step || null,
        pendingPdfAfterRecharge: s.pendingPdfAfterRecharge === true,
      });

      resetStampChoice(s);
      resetTransientProductState(s);

      const draft = s.lastDocDraft;
      if (!draft) {
        await sendText(from, noDraftMessage());
        return;
      }

      const checked = validateDraftForUi(draft);
      if (!checked.ok) {
        s.lastDocDraft = checked.draft;
        return sendDraftBlockedMessage(from, checked);
      }
      s.lastDocDraft = checked.draft;

      const finalDraft = s.lastDocDraft;
      finalDraft._saving = true;
      try {
        await createAndSendPdf(from);
        return;
      } finally {
        finalDraft._saving = false;
      }
    }

    if (replyId === "PRESTAMP_ADD_ONCE") {
      await track(from, "stamp_upsell_accepted", {
        mode: "one_time",
        pendingPdfAfterRecharge: s.pendingPdfAfterRecharge === true,
      });

      const p = await getOrCreateProfile(from);

      if (!hasStampProfileReady(p)) {
        await sendText(
          from,
          "⚠️ Pour un tampon propre, complétez d’abord votre profil entreprise.\n\nAllez dans Profil > Configurer, puis revenez générer votre document."
        );
        return sendProfileMenu(from);
      }

      s.addStampForNextDoc = true;
      s.stampMode = "one_time";

      const draft = s.lastDocDraft;
      if (!draft) {
        await sendText(from, noDraftMessage());
        return;
      }

      const checked = validateDraftForUi(draft);
      if (!checked.ok) {
        s.lastDocDraft = checked.draft;
        return sendDraftBlockedMessage(from, checked);
      }
      s.lastDocDraft = checked.draft;

      resetTransientProductState(s);

      const finalDraft = s.lastDocDraft;
      finalDraft._saving = true;
      try {
        await createAndSendPdf(from);
        return;
      } finally {
        finalDraft._saving = false;
      }
    }

    if (replyId === "DOC_RESTART") {
      resetStampChoice(s);
      resetTransientProductState(s);
      resetFieldReturnTargets(s);
      resetDraftSession(s);
      await sendText(from, "🔁 Recommençons.");
      return sendDocsMenu(from);
    }

    if (replyId === "DOC_CANCEL") {
      resetStampChoice(s);
      resetTransientProductState(s);
      resetFieldReturnTargets(s);
      resetDraftSession(s);
      await sendText(from, "✅ Retour au menu.");
      return sendHomeMenu(from);
    }

    if (replyId === "DOC_RESEND_LAST_PDF") {
      return resendLastPdfToOwner(from, s);
    }

    if (replyId === "DOC_EDIT_AFTER_GENERATED") {
      const draft = s.lastDocDraft;

      if (!draft) {
        await sendText(
          from,
          "📄 Je n’ai pas retrouvé de document à modifier.\nTapez MENU pour recommencer."
        );
        return;
      }

      const checked = validateDraftForUi(draft);
      s.lastDocDraft = checked.draft;

      resetTransientProductState(s);
      resetFieldReturnTargets(s);
      s.step = "doc_edit_generated_menu";

      if (!checked.ok) {
        await sendText(
          from,
          "✏️ *Mode modification activé.*\n\nLe document a besoin d’une correction avant régénération."
        );
        return sendDraftBlockedMessage(from, checked);
      }

      return sendEditModeHub(from);
    }

    await sendText(
      from,
      "🤔 Je n’ai pas compris cette action.\nTapez MENU pour continuer."
    );
  }

  return {
    handleInteractiveReply,
  };
}

module.exports = {
  makeKadiInteractiveFlow,
};