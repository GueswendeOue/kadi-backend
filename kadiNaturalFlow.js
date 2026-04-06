"use strict";

function makeKadiNaturalFlow(deps) {
  const {
    getSession,
    sendText,
    sendButtons,
    money,
    LIMITS,
    formatDateISO,
    makeDraftMeta,
    makeItem,
    computeFinance,
    computeBasePdfCost,
    formatBaseCostLine,
    buildPreviewMessage,
    sendPreviewMenu,
    askItemLabel,
    parseNaturalWhatsAppMessage,
    parseNaturalWithOpenAI,
    analyzeSmartBlock,
    logLearningEvent,
    detectDechargeType,
    buildDechargePreviewMessage,
    initDechargeDraft,
    buildPostConfirmationMessage,
    parseItemsBlockSmart,
    extractBlockTotals,
    buildSmartMismatchMessage,
    safe,
    getOrCreateProfile,
  } = deps;

  async function tryHandleNaturalMessage(from, text) {
    const s = getSession(from);
    const rawText = String(text || "").trim();
    if (!rawText) return false;

    // 1) Parser local d'abord
    let parsed = null;
    try {
      parsed = parseNaturalWhatsAppMessage(rawText);
    } catch (e) {
      console.warn("[KADI/NATURAL] local parser failed:", e?.message);
    }

    // 2) Fallback OpenAI si parser local insuffisant
    if (!parsed && typeof parseNaturalWithOpenAI === "function") {
      try {
        const aiParsed = await parseNaturalWithOpenAI(rawText);

        if (
          aiParsed &&
          aiParsed.kind &&
          aiParsed.kind !== "unknown" &&
          aiParsed.shouldFallbackToManual !== true
        ) {
          parsed = aiParsed;
        }
      } catch (e) {
        console.warn("[KADI/NLU] OpenAI parse failed:", e?.message);
      }
    }

    // 3) Cas spécial : si user est en train de saisir un item simple
    if (s.lastDocDraft && s.step === "item_label") {
      const parsedAsStructured =
        parsed &&
        (parsed.kind === "items" || parsed.kind === "simple_payment");

      if (!parsedAsStructured) {
        if (rawText.length < 2) return true;

        s.itemDraft = {
          label: rawText.slice(0, LIMITS.maxItemLabelLength),
          qty: 1,
          unitPrice: null,
        };

        s.step = "item_pu";
        await sendText(from, `💰 Quel est le prix pour : *${rawText}* ?`);
        return true;
      }
    }

    // 4) Rien compris
    if (!parsed) {
      if (!s.lastDocDraft && rawText.length >= 3) {
        s.pendingSmartBlockText = rawText;

        await sendButtons(
          from,
          "🧠 J’ai reconnu un texte.\n\nQuel document voulez-vous créer ?",
          [
            { id: "SMARTBLOCK_DEVIS", title: "Devis" },
            { id: "SMARTBLOCK_FACTURE", title: "Facture" },
            { id: "SMARTBLOCK_RECU", title: "Reçu" },
          ]
        );

        await logLearningEvent({
          waId: from,
          rawText,
          parseSuccess: false,
          failureReason: "natural_text_without_doc_type",
          itemsCount: 0,
        });

        return true;
      }

      await logLearningEvent({
        waId: from,
        rawText,
        parseSuccess: false,
        failureReason: "natural_not_understood",
        itemsCount: 0,
      });

      return false;
    }

    // 5) Créer draft si aucun actif
    if (!s.lastDocDraft) {
      const detectedType = parsed.docType;

      if (!detectedType) {
        s.pendingSmartBlockText = rawText;

        await sendButtons(
          from,
          "🧠 J’ai reconnu un message naturel.\n\nQuel document voulez-vous créer ?",
          [
            { id: "SMARTBLOCK_DEVIS", title: "Devis" },
            { id: "SMARTBLOCK_FACTURE", title: "Facture" },
            { id: "SMARTBLOCK_RECU", title: "Reçu" },
          ]
        );

        return true;
      }

      if (detectedType === "decharge") {
        s.lastDocDraft = initDechargeDraft({
          dateISO: formatDateISO(),
          makeDraftMeta,
        });
        s.lastDocDraft.type = "decharge";
        s.lastDocDraft.source = "natural_text";
      } else {
        s.lastDocDraft = {
          type: detectedType,
          factureKind: detectedType === "facture" ? "definitive" : null,
          docNumber: null,
          date: formatDateISO(),
          client: null,
          motif: null,
          items: [],
          finance: null,
          source: "natural_text",
          meta: makeDraftMeta({
            nluSource: parsed.reasoningShort ? "openai" : "local",
          }),
        };
      }
    }

    const draft = s.lastDocDraft;

    // ===============================
    // SIMPLE PAYMENT
    // ===============================
    if (parsed.kind === "simple_payment") {
      draft.type = parsed.docType || draft.type || "recu";

      if (parsed.client && !draft.client) {
        draft.client = parsed.client.slice(0, LIMITS.maxClientNameLength);
      }

      if (parsed.motif && !draft.motif) {
        draft.motif = parsed.motif.slice(0, LIMITS.maxItemLabelLength);
      }

      if (draft.type === "decharge") {
        draft.dechargeType = detectDechargeType(draft.motif || parsed.motif || "");
      }

      draft.items = [
        makeItem(parsed.motif || "Paiement", 1, parsed.total || 0),
      ];
      draft.finance = computeFinance(draft);

      if (!safe(draft.client)) {
        await logLearningEvent({
          waId: from,
          rawText,
          parseSuccess: true,
          failureReason: "client_missing",
          itemsCount: 1,
        });

        s.step = "missing_client_pdf";
        await sendText(from, "👤 Quel est le nom du client ?");
        return true;
      }

      s.step = "doc_review";

      const preview =
        draft.type === "decharge"
          ? buildDechargePreviewMessage({ doc: draft, money })
          : buildPreviewMessage({ doc: draft });

      await sendText(from, preview);

      const cost = computeBasePdfCost(draft);
      await sendText(from, formatBaseCostLine(cost));

      await sendPreviewMenu(from);
      return true;
    }

    // ===============================
    // INTENT ONLY
    // ===============================
    if (parsed.kind === "intent_only") {
      if (draft.type === "decharge") {
        if (parsed.client && !draft.client) {
          draft.client = parsed.client.slice(0, LIMITS.maxClientNameLength);
        }

        if (parsed.motif && !draft.motif) {
          draft.motif = parsed.motif.slice(0, LIMITS.maxItemLabelLength);
          draft.dechargeType = detectDechargeType(draft.motif);
        }

        if (!safe(draft.client)) {
          s.step = "decharge_client";
          await sendText(from, "👤 Quel est le nom de la personne concernée ?");
          return true;
        }

        if (!safe(draft.motif)) {
          s.step = "decharge_motif";
          await sendText(from, "📝 Quel est le motif de la décharge ?");
          return true;
        }

        s.step = "decharge_amount";
        await sendText(from, "💰 Quel est le montant ?\nSi pas de montant, tapez *0*.");
        return true;
      }

      if (parsed.client && !draft.client) {
        draft.client = parsed.client.slice(0, LIMITS.maxClientNameLength);
      }

      if (parsed.motif && !draft.motif) {
        draft.motif = parsed.motif.slice(0, LIMITS.maxItemLabelLength);
      }

      if (!safe(draft.client)) {
        s.step = "doc_client";
        await sendText(from, "👤 Quel est le nom du client ?");
        return true;
      }

      await sendText(
        from,
        `✅ ${String(draft.type || "").toUpperCase()} en cours\n` +
          `👤 Client : ${draft.client}\n` +
          (draft.motif ? `📝 Motif : ${draft.motif}\n` : "") +
          `\nAjoutez les éléments ou les prix 👇`
      );

      await askItemLabel(from);
      return true;
    }

    // ===============================
    // ITEMS
    // ===============================
    if (parsed.kind === "items") {
      if (parsed.client && !draft.client) {
        draft.client = parsed.client.slice(0, LIMITS.maxClientNameLength);
      }

      draft.items = (parsed.items || []).map((it) =>
        makeItem(it.label, it.qty, it.unitPrice)
      );
      draft.finance = computeFinance(draft);

      const analysis = analyzeSmartBlock({
        items: draft.items,
        computedTotal: draft.finance?.gross || 0,
      });

      draft.meta = makeDraftMeta({
        ...(draft.meta || {}),
        businessType: analysis.businessType,
        totalsGap: analysis.gapInfo.gap,
        totalsGapSeverity: analysis.gapInfo.severity,
        missingHint: analysis.hint,
      });

      if (!safe(draft.client)) {
        await logLearningEvent({
          waId: from,
          rawText,
          parseSuccess: true,
          failureReason: "client_missing",
          itemsCount: draft.items.length || 0,
        });

        s.step = "missing_client_pdf";
        await sendText(from, "👤 Quel est le nom du client ?");
        return true;
      }

      const smartMessage = buildSmartMismatchMessage({
        gapInfo: analysis.gapInfo,
        hint: analysis.hint,
      });

      if (smartMessage.warning) {
        await sendText(from, smartMessage.text);

        await sendButtons(from, "Choisissez une action :", [
          { id: "SMARTBLOCK_FIX", title: "Corriger" },
          { id: "SMARTBLOCK_CONTINUE", title: "Continuer" },
        ]);

        s.step = "smartblock_warning";
        return true;
      }

      s.step = "doc_review";

      const preview = buildPreviewMessage({ doc: draft });
      await sendText(from, preview);

      const cost = computeBasePdfCost(draft);
      await sendText(from, formatBaseCostLine(cost));

      await sendPreviewMenu(from);
      return true;
    }

    await logLearningEvent({
      waId: from,
      rawText,
      parseSuccess: false,
      failureReason: "natural_not_understood",
      itemsCount: 0,
    });

    return false;
  }

  async function tryHandleDechargeConfirmation(from, text) {
    if (String(text || "").trim().toLowerCase() !== "confirmer") return false;

    await sendText(
      from,
      "✅ Votre confirmation a été reçue.\nSi une décharge KADI vous a été envoyée, elle peut maintenant être finalisée."
    );

    const p = await getOrCreateProfile(from);
    const isFirstTime = !p?.onboarding_done;
    const kadiWaLink = `https://wa.me/${process.env.KADI_E164 || "22679239027"}`;

    const followup = buildPostConfirmationMessage({
      isFirstTime,
      kadiWaLink,
    });

    await sendText(from, followup);
    return true;
  }

  async function handleSmartItemsBlockText(from, text) {
    const s = getSession(from);
    const draft = s.lastDocDraft;
    const raw = String(text || "").trim();

    if (!raw || !/\r?\n/.test(raw)) return false;
    if (s.step === "profile" || s.step === "stamp_title") return false;

    const { items, ignored } = parseItemsBlockSmart(raw);

    if (!Array.isArray(items) || items.length < 2) {
      await logLearningEvent({
        waId: from,
        rawText: raw,
        parseSuccess: false,
        failureReason: "no_items_detected",
        itemsCount: items?.length || 0,
      });
      return false;
    }

    if (!draft) {
      return askDocTypeForSmartBlock(from, raw);
    }

    const parsedItems = items.map((it) =>
      makeItem(it.label, it.qty, it.unitPrice)
    );
    draft.items = parsedItems;
    draft.finance = computeFinance(draft);

    const totalsDetected = extractBlockTotals(raw);
    const computedTotal = Number(draft.finance?.gross || 0);

    const analysis = analyzeSmartBlock({
      items: draft.items,
      computedTotal,
      materialTotal: totalsDetected.materialTotal,
      grandTotal: totalsDetected.grandTotal,
    });

    draft.meta = makeDraftMeta({
      ...(draft.meta || {}),
      businessType: analysis.businessType,
      detectedMaterialTotal: totalsDetected.materialTotal,
      detectedGrandTotal: totalsDetected.grandTotal,
      computedTotalFromParsedItems: computedTotal,
      totalsGap: analysis.gapInfo.gap,
      totalsGapSeverity: analysis.gapInfo.severity,
      missingHint: analysis.hint,
    });

    if (!safe(draft.client)) {
      s.step = "missing_client_pdf";
      await sendText(
        from,
        `✅ ${items.length} ligne(s) détectée(s).\n👤 Maintenant, tapez le nom du client :`
      );
      return true;
    }

    const smartMessage = buildSmartMismatchMessage({
      businessType: analysis.businessType,
      gapInfo: analysis.gapInfo,
      hint: analysis.hint,
    });

    if (smartMessage.warning) {
      await sendText(from, smartMessage.text);

      await sendButtons(from, "Choisissez une action :", [
        { id: "SMARTBLOCK_FIX", title: "Corriger" },
        { id: "SMARTBLOCK_CONTINUE", title: "Continuer" },
      ]);

      s.step = "smartblock_warning";
      return true;
    }

    s.step = "doc_review";

    const preview = buildPreviewMessage({ doc: draft });
    await sendText(from, preview);

    const cost = computeBasePdfCost(draft);
    await sendText(from, formatBaseCostLine(cost));

    if (ignored.length > 0) {
      await sendText(
        from,
        `ℹ️ ${ignored.length} ligne(s) non reconnue(s) ont été ignorée(s).`
      );
    }

    await sendPreviewMenu(from);
    return true;
  }

  async function askDocTypeForSmartBlock(from, text) {
    const s = getSession(from);
    const { items } = parseItemsBlockSmart(text);

    if (!items || items.length < 2) return false;

    s.pendingSmartBlockText = String(text || "").trim();

    await sendButtons(
      from,
      `🧠 J’ai détecté ${items.length} ligne(s) de produits.\n\nQuel document voulez-vous créer ?`,
      [
        { id: "SMARTBLOCK_DEVIS", title: "Devis" },
        { id: "SMARTBLOCK_FACTURE", title: "Facture" },
        { id: "SMARTBLOCK_RECU", title: "Reçu" },
      ]
    );

    return true;
  }

  return {
    tryHandleNaturalMessage,
    tryHandleDechargeConfirmation,
    handleSmartItemsBlockText,
    askDocTypeForSmartBlock,
  };
}

module.exports = {
  makeKadiNaturalFlow,
};