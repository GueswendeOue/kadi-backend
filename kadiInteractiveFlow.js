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

    // draft helpers
    makeDraftMeta,
    cloneDraftToNewDocType,
    buildPreviewMessage,
    computeBasePdfCost,
    formatBaseCostLine,
    resetDraftSession,

    // product/natural flows
    startDocFlow,
    askItemLabel,
    tryHandleNaturalMessage,
    handleSmartItemsBlockText,

    // OCR / PDF
    processOcrImageToDraft,
    createAndSendPdf,

    // profile / stamp
    getOrCreateProfile,
    updateProfile,
    hasStampProfileReady,
    resetStampChoice,
    consumeFeature,
    STAMP_ONE_TIME_COST,

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

    // misc
    formatDateISO,
    sendDocument,
    startProfileFlow,
    replyBalance,
    replyRechargeInfo,
  } = deps;

  async function sendCurrentDraftPreview(from, draft) {
    if (!draft) {
      await sendText(from, "❌ Aucun document en cours.");
      return;
    }

    const preview = buildPreviewMessage({ doc: draft });
    await sendText(from, preview);

    const cost = computeBasePdfCost(draft);
    await sendText(from, formatBaseCostLine(cost));

    return sendPreviewMenu(from);
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

  async function handleInteractiveReply(from, replyId) {
    const s = getSession(from);

    // ===============================
    // INTENT REVIEW (VOICE / IA)
    // ===============================
    if (replyId === "INTENT_OK") {
      const intent = s.intent || null;

      if (!intent) {
        await sendText(from, "❌ Analyse introuvable. Renvoyez votre message.");
        return;
      }

      if (Array.isArray(intent.missing) && intent.missing.length > 0) {
        if (intent.missing.includes("client")) {
          s.step = "intent_fix_client";
          await sendText(from, "👤 Quel est le nom du client ?");
          return;
        }

        if (intent.missing.includes("price")) {
          const item = Array.isArray(intent.items)
            ? intent.items.find((i) => !i?.unitPrice)
            : null;

          s.step = "intent_fix_price";
          s.intentPendingItemLabel = item?.label || null;

          await sendText(
            from,
            `💰 Quel est le prix pour : *${item?.label || "cet article"}* ?`
          );
          return;
        }

        if (intent.missing.includes("items")) {
          s.step = "intent_fix_items";
          await sendText(
            from,
            "📦 Je n’ai pas bien compris les éléments.\n\nÉcrivez-les clairement."
          );
          return;
        }
      }

      s.lastDocDraft = buildDraftFromIntent(intent);
      s.step = "doc_review";
      s.intent = null;
      s.intentPendingItemLabel = null;

      return sendCurrentDraftPreview(from, s.lastDocDraft);
    }

    if (replyId === "INTENT_FIX") {
      const intent = s.intent || null;

      if (!intent) {
        await sendText(from, "❌ Analyse introuvable. Renvoyez votre message.");
        return;
      }

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
        "✍️ D’accord. Ajoutez ou corrigez les lignes, puis renvoyez le texte."
      );
      return;
    }

    if (replyId === "SMARTBLOCK_CONTINUE") {
      const draft = s.lastDocDraft;

      if (!draft) {
        await sendText(from, "❌ Aucun document en cours.");
        return;
      }

      s.step = "doc_review";
      return sendCurrentDraftPreview(from, draft);
    }

    // ===============================
    // NAVIGATION
    // ===============================
    if (replyId === "BACK_HOME") return sendHomeMenu(from);
    if (replyId === "BACK_DOCS") return sendDocsMenu(from);

    // ===============================
    // HOME / ONBOARDING / HELP
    // ===============================
    if (replyId === "HOME_DOCS") return sendDocsMenu(from);
    if (replyId === "HOME_CREDITS") return sendCreditsMenu(from);
    if (replyId === "HOME_PROFILE") return sendProfileMenu(from);

    if (replyId === "HOME_OCR") {
      s.step = "awaiting_ocr_image";
      await sendText(
        from,
        "📷 Envoyez la photo de votre facture, devis ou reçu.\n\nJe vais la transformer en document propre."
      );
      return;
    }

    if (replyId === "HOME_TUTORIAL") {
      await sendText(
        from,
        `📚 *Exemples KADI*\n\n` +
          `• Devis pour Moussa, 2 portes à 25000\n` +
          `• Facture pour Awa, 5 pagnes à 3000\n` +
          `• Reçu loyer avril 100000 pour Adama\n` +
          `• Décharge pour prêt de 50000 à Issa\n\n` +
          `Vous pouvez aussi envoyer un vocal ou une photo.`
      );
      return;
    }

    if (replyId === "HOME_HELP") {
      await sendText(
        from,
        `❓ *Aide rapide*\n\n` +
          `Vous pouvez écrire naturellement :\n\n` +
          `• Devis pour Moussa, 2 portes à 25000\n` +
          `• Facture pour Awa, 5 pagnes à 3000\n` +
          `• Reçu loyer 100000 pour Adama\n` +
          `• Décharge pour prêt de 50000 à Issa\n\n` +
          `Commandes utiles : MENU, PROFIL, SOLDE, RECHARGE`
      );
      return;
    }

    if (replyId === "HOME_HISTORY") {
      await sendText(
        from,
        "📚 Historique en cours de préparation.\n\nTapez MENU pour continuer."
      );
      return;
    }

    if (
      replyId === "RECHARGE_1000" ||
      replyId === "RECHARGE_2000" ||
      replyId === "RECHARGE_3500"
    ) {
      return sendRechargePacksMenu(from);
    }

    // ===============================
    // REÇU FORMAT
    // ===============================
    if (replyId === "RECEIPT_FORMAT_COMPACT") {
      if (!s.lastDocDraft) {
        await sendText(from, "❌ Aucun document en cours.");
        return;
      }

      s.lastDocDraft.receiptFormat = "compact";
      s.step = "doc_client";

      await sendText(from, "🧾 Format ticket sélectionné.");
      await sendText(from, "👤 *Nom du client ?*\n(Ex: Awa / Ben / Société X)");
      return;
    }

    if (replyId === "RECEIPT_FORMAT_A4") {
      if (!s.lastDocDraft) {
        await sendText(from, "❌ Aucun document en cours.");
        return;
      }

      s.lastDocDraft.receiptFormat = "a4";
      s.step = "doc_client";

      await sendText(from, "📄 Format A4 sélectionné.");
      await sendText(from, "👤 *Nom du client ?*\n(Ex: Awa / Ben / Société X)");
      return;
    }

    // ===============================
    // FOLLOWUPS DEVIS
    // ===============================
    const followupFacture = replyId.match(/^FOLLOWUP_FACTURE_(.+)$/);
    if (followupFacture) {
      const followupId = followupFacture[1];
      const row = await getDevisFollowupById(followupId);

      if (!row || !row.source_doc) {
        await sendText(from, "❌ Devis introuvable.");
        return;
      }

      s.lastDocDraft = cloneDraftToNewDocType(
        {
          type: "devis",
          factureKind: null,
          docNumber: row.doc_number,
          date: row.source_doc?.date || formatDateISO(),
          client: row.source_doc?.client || null,
          items: row.source_doc?.items || [],
          finance: row.source_doc?.finance || null,
          source: row.source_doc?.source || "product",
          meta: makeDraftMeta(),
        },
        "facture"
      );

      s.step = "doc_review";

      await markDevisFollowupConverted(followupId, "facture");
      await sendText(from, "✅ J’ai repris votre devis pour créer une facture.");

      return sendCurrentDraftPreview(from, s.lastDocDraft);
    }

    const followupRecu = replyId.match(/^FOLLOWUP_RECU_(.+)$/);
    if (followupRecu) {
      const followupId = followupRecu[1];
      const row = await getDevisFollowupById(followupId);

      if (!row || !row.source_doc) {
        await sendText(from, "❌ Devis introuvable.");
        return;
      }

      s.lastDocDraft = cloneDraftToNewDocType(
        {
          type: "devis",
          factureKind: null,
          docNumber: row.doc_number,
          date: row.source_doc?.date || formatDateISO(),
          client: row.source_doc?.client || null,
          items: row.source_doc?.items || [],
          finance: row.source_doc?.finance || null,
          source: row.source_doc?.source || "product",
          meta: makeDraftMeta(),
        },
        "recu"
      );

      s.step = "doc_review";

      await markDevisFollowupConverted(followupId, "recu");
      await sendText(from, "✅ J’ai repris votre devis pour créer un reçu.");

      return sendCurrentDraftPreview(from, s.lastDocDraft);
    }

    const followupLater = replyId.match(/^FOLLOWUP_LATER_(.+)$/);
    if (followupLater) {
      const followupId = followupLater[1];
      await postponeDevisFollowup(followupId, 24);
      await sendText(from, "⏳ D’accord, je vous le rappellerai dans 24h.");
      return;
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
        await sendText(from, "❌ Texte introuvable. Renvoyez votre message.");
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
        motif: null,
        items: [],
        finance: null,
        source: "natural_text",
        meta: makeDraftMeta(),
      };

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
      s.step = "item_pu";
      return;
    }

    // ===============================
    // CATALOGUE DOCS
    // ===============================
    if (replyId === "DOC_DEVIS") return startDocFlow(from, "devis");
    if (replyId === "DOC_RECU") return startDocFlow(from, "recu");
    if (replyId === "DOC_DECHARGE") return startDocFlow(from, "decharge");

    if (replyId === "DOC_FACTURE_MENU") {
      return sendFactureCatalogMenu
        ? sendFactureCatalogMenu(from)
        : sendFactureKindMenu(from);
    }

    if (replyId === "DOC_FACTURE") {
      s.step = "facture_kind";
      return sendFactureKindMenu(from);
    }

    if (replyId === "FAC_PROFORMA" || replyId === "FAC_DEFINITIVE") {
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
        await sendText(from, "❌ Photo introuvable. Renvoyez-la.");
        return;
      }

      const mode = replyId === "OCR_RECU" ? "recu" : "devis";
      s.lastDocDraft = {
        type: mode,
        factureKind: null,
        docNumber: null,
        date: formatDateISO(),
        client: null,
        items: [],
        finance: null,
        source: "ocr",
        meta: makeDraftMeta(),
      };

      return processOcrImageToDraft(from, mediaId);
    }

    if (replyId === "OCR_FACTURE") {
      const mediaId = s.pendingOcrMediaId;
      s.pendingOcrMediaId = null;

      if (!mediaId) {
        await sendText(from, "❌ Photo introuvable. Renvoyez-la.");
        return;
      }

      s.lastDocDraft = {
        type: "facture",
        factureKind: "definitive",
        docNumber: null,
        date: formatDateISO(),
        client: null,
        items: [],
        finance: null,
        source: "ocr",
        meta: makeDraftMeta(),
      };

      return processOcrImageToDraft(from, mediaId);
    }

    // ===============================
    // PROFIL / TAMPON
    // ===============================
    if (replyId === "PROFILE_STAMP") return sendStampMenu(from);

    if (replyId === "PROFILE_EDIT") {
      return startProfileFlow(from);
    }

    if (replyId === "STAMP_TOGGLE") {
      const p = await getOrCreateProfile(from);

      if (p?.stamp_enabled === true) {
        await updateProfile(from, { stamp_enabled: false });
        await sendText(from, "🟦 Tampon désactivé.");
        return sendStampMenu(from);
      }

      if (p?.stamp_paid !== true) {
        const res = await consumeFeature(
          { waId: from },
          "stamp_addon",
          `stamp:addon:${from}`,
          { feature: "stamp_addon" }
        );

        if (!res?.ok) {
          await sendText(
            from,
            `❌ Solde insuffisant.\nLe tampon coûte *${STAMP_ONE_TIME_COST} crédits* (paiement unique).\n👉 Tapez RECHARGE.`
          );
          return sendStampMenu(from);
        }

        await updateProfile(from, {
          stamp_paid: true,
          stamp_paid_at: new Date().toISOString(),
          stamp_enabled: true,
        });

        await sendText(
          from,
          `🟦 *Tampon activé !*\n✅ Paiement unique effectué: *${STAMP_ONE_TIME_COST} crédits*\n📄 Le tampon sera ajouté gratuitement à vos PDF.`
        );

        return sendStampMenu(from);
      }

      await updateProfile(from, { stamp_enabled: true });
      await sendText(from, "🟦 Tampon activé.");
      return sendStampMenu(from);
    }

    if (replyId === "STAMP_EDIT_TITLE") {
      s.step = "stamp_title";
      await sendText(
        from,
        "✍️ Fonction (tampon) ?\nEx: GERANT / DIRECTEUR / COMMERCIAL\n\nTapez 0 pour effacer."
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

    const selectedOffer = getRechargeOfferById(replyId);
    if (selectedOffer) {
      s.pendingRechargePack = selectedOffer.id;
      s.pendingRechargeAmount = selectedOffer.amountFcfa;
      s.pendingRechargeCredits = selectedOffer.credits;
      s.pendingRechargeIncludesStamp = !!selectedOffer.includesStamp;
      s.pendingTopupId = null;
      s.pendingTopupReference = null;
      s.pendingTopupMethod = null;

      return sendRechargePaymentMethodMenu(from, selectedOffer);
    }

    if (replyId.startsWith("PAY_OM_")) {
      const amount = Number(replyId.replace("PAY_OM_", ""));
      const offer = Object.values(getRechargeOffers()).find(
        (x) => x.amountFcfa === amount
      );

      if (!offer) {
        await sendText(from, "❌ Pack introuvable.");
        return sendRechargePacksMenu(from);
      }

      const topup = await createManualOrangeMoneyTopup({
        waId: from,
        amountFcfa: offer.amountFcfa,
        credits: offer.credits,
        includesStamp: !!offer.includesStamp,
      });

      s.pendingRechargePack = offer.id;
      s.pendingRechargeAmount = offer.amountFcfa;
      s.pendingRechargeCredits = offer.credits;
      s.pendingRechargeIncludesStamp = !!offer.includesStamp;
      s.pendingTopupId = topup.id;
      s.pendingTopupReference = topup.reference;
      s.pendingTopupMethod = "orange_money";
      s.step = "recharge_proof";

      return sendOrangeMoneyInstructions(from, offer);
    }

    if (replyId.startsWith("PAY_PISPI_")) {
      const amount = Number(replyId.replace("PAY_PISPI_", ""));
      const offer = Object.values(getRechargeOffers()).find(
        (x) => x.amountFcfa === amount
      );

      if (!offer) {
        await sendText(from, "❌ Pack introuvable.");
        return sendRechargePacksMenu(from);
      }

      s.pendingRechargePack = offer.id;
      s.pendingRechargeAmount = offer.amountFcfa;
      s.pendingRechargeCredits = offer.credits;
      s.pendingRechargeIncludesStamp = !!offer.includesStamp;
      s.pendingTopupId = null;
      s.pendingTopupReference = null;
      s.pendingTopupMethod = "pispi";
      s.step = "pispi_pending";

      return sendPispiInstructions(from, offer);
    }

    if (replyId.startsWith("OM_PAID_")) {
      s.step = "recharge_proof";
      await sendText(
        from,
        "⏳ D’accord.\n\nEnvoyez maintenant :\n• le message de transaction\nOU\n• une capture d’écran du paiement."
      );
      return;
    }

    if (replyId.startsWith("OM_SEND_PROOF_")) {
      s.step = "recharge_proof";
      await sendText(
        from,
        "📎 Envoyez la preuve ici :\n• capture d’écran\nOU\n• message de confirmation Orange Money"
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
      const topupId = approveTopupMatch[1];
      const topup = await readTopup(topupId);

      if (!topup) {
        await sendText(from, "❌ Recharge introuvable.");
        return;
      }

      if (topup.status === "approved") {
        await sendText(from, "ℹ️ Cette recharge est déjà validée.");
        return;
      }

      if (topup.status === "rejected") {
        await sendText(from, "⚠️ Cette recharge a déjà été refusée.");
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
        }
      );

      await approveTopup(topup.id);

      if (topup.includes_stamp === true) {
        await updateProfile(topup.wa_id, {
          stamp_paid: true,
          stamp_enabled: true,
          stamp_paid_at: new Date().toISOString(),
        });
      }

      await sendText(
        from,
        `✅ Recharge validée.\n\nRéférence : ${topup.reference || "-"}`
      );

      await sendText(
        topup.wa_id,
        `✅ Paiement validé !\n\n🎉 ${topup.credits} crédits ajoutés à votre compte${
          topup.includes_stamp ? "\n🟦 Tampon activé." : ""
        }`
      );
      return;
    }

    const rejectTopupMatch = replyId.match(/^TOPUP_REJECT_(.+)$/);
    if (rejectTopupMatch) {
      const topupId = rejectTopupMatch[1];
      const topup = await readTopup(topupId);

      if (!topup) {
        await sendText(from, "❌ Recharge introuvable.");
        return;
      }

      if (topup.status === "approved") {
        await sendText(from, "⚠️ Cette recharge a déjà été validée.");
        return;
      }

      if (topup.status === "rejected") {
        await sendText(from, "ℹ️ Cette recharge est déjà refusée.");
        return;
      }

      await rejectTopup(topup.id, "rejected_by_admin");

      await sendText(
        from,
        `❌ Recharge refusée.\n\nRéférence : ${topup.reference || "-"}`
      );

      await sendText(
        topup.wa_id,
        "❌ Votre recharge n’a pas été validée.\n\nVérifiez la preuve envoyée ou réessayez."
      );
      return;
    }

    // ===============================
    // PRODUIT / PREVIEW / PDF
    // ===============================
    if (replyId === "ITEM_EDIT") return askItemLabel(from);
    if (replyId === "DOC_ADD_MORE") return askItemLabel(from);

    if (replyId === "DOC_FINISH") {
      s.step = "doc_review";
      return sendCurrentDraftPreview(from, s.lastDocDraft);
    }

    if (replyId === "DECHARGE_SEND_CONFIRMATION") {
      const draft = s.lastDocDraft;

      if (!draft || draft.type !== "decharge") {
        await sendText(from, "❌ Aucune décharge en cours.");
        return;
      }

      const targetWaId = draft?.confirmation?.targetWaId;
      if (!targetWaId) {
        await sendText(from, "❌ Numéro de confirmation manquant.");
        return;
      }

      const confirmationMessage = buildDechargeConfirmationMessage({
        doc: draft,
        money,
      });

      await sendText(targetWaId, confirmationMessage);

      s.step = "doc_review";

      const preview = buildDechargePreviewMessage({
        doc: draft,
        money,
      });
      await sendText(from, preview);

      const cost = computeBasePdfCost(draft);
      await sendText(from, formatBaseCostLine(cost));

      await sendPreviewMenu(from);
      return;
    }

    if (replyId === "DOC_CONFIRM") {
      const draft = s.lastDocDraft;

      if (!draft) {
        await sendText(from, "❌ Aucun document en cours.");
        return;
      }

      if (draft._saving === true || s.isGeneratingPdf === true) {
        await sendText(from, "⏳ Génération en cours...");
        return;
      }

      if (draft.savedDocumentId || draft.savedPdfMediaId) {
        s.step = "doc_already_generated";
        await sendAlreadyGeneratedMenu(from);
        return;
      }

      const p = await getOrCreateProfile(from);

      if (p?.stamp_paid === true && p?.stamp_enabled === true) {
        resetStampChoice(s);

        draft._saving = true;
        try {
          await createAndSendPdf(from);
          return;
        } finally {
          draft._saving = false;
        }
      }

      await sendPreGenerateStampMenu(from);
      return;
    }

    if (replyId === "PRESTAMP_SKIP") {
      resetStampChoice(s);

      const draft = s.lastDocDraft;
      if (!draft) {
        await sendText(from, "❌ Aucun document en cours.");
        return;
      }

      draft._saving = true;
      try {
        await createAndSendPdf(from);
        return;
      } finally {
        draft._saving = false;
      }
    }

    if (replyId === "PRESTAMP_ADD_ONCE") {
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
        await sendText(from, "❌ Aucun document en cours.");
        return;
      }

      draft._saving = true;
      try {
        await createAndSendPdf(from);
        return;
      } finally {
        draft._saving = false;
      }
    }

    if (replyId === "DOC_RESTART") {
      resetDraftSession(s);
      await sendText(from, "🔁 Recommençons.");
      return sendDocsMenu(from);
    }

    if (replyId === "DOC_CANCEL") {
      resetDraftSession(s);
      await sendText(from, "✅ Retour au menu.");
      return sendHomeMenu(from);
    }

    if (replyId === "DOC_RESEND_LAST_PDF") {
      const draft = s.lastDocDraft;

      if (!draft?.savedPdfMediaId) {
        await sendText(from, "❌ Aucun PDF déjà généré à renvoyer.");
        return;
      }

      await sendDocument({
        to: from,
        mediaId: draft.savedPdfMediaId,
        filename:
          draft.savedPdfFilename || `${draft.docNumber || "document"}.pdf`,
        caption:
          draft.savedPdfCaption ||
          "📄 Voici à nouveau votre document.\nAucun crédit supplémentaire n’a été consommé.",
      });

      s.step = "doc_already_generated";
      await sendAlreadyGeneratedMenu(from);
      return;
    }

    if (replyId === "DOC_EDIT_AFTER_GENERATED") {
      const draft = s.lastDocDraft;

      if (!draft) {
        await sendText(from, "❌ Aucun document à modifier.");
        return;
      }

      draft.savedDocumentId = null;
      draft.savedPdfMediaId = null;
      draft.savedPdfFilename = null;
      draft.savedPdfCaption = null;
      draft.status = "draft";
      draft.requestId = null;

      s.step = "doc_review";

      await sendText(
        from,
        "✏️ *Mode modification activé.*\n\n" +
          "Vous pouvez corriger puis régénérer le document.\n" +
          "Chaque nouvelle génération consommera le coût normal du document."
      );

      await sendButtons(from, "Que voulez-vous faire ?", [
        { id: "DOC_ADD_MORE", title: "➕ Modifier" },
        { id: "DOC_CONFIRM", title: "📄 Régénérer" },
        { id: "DOC_CANCEL", title: "🏠 Menu" },
      ]);
      return;
    }

    await sendText(from, "⚠️ Action non reconnue. Tapez MENU.");
  }

  return {
    handleInteractiveReply,
  };
}

module.exports = {
  makeKadiInteractiveFlow,
};