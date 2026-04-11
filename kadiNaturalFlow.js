"use strict";

const {
  detectVagueRequest,
  buildSmartGuidanceMessage,
} = require("./kadiNaturalGuidance");

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

  function getNluSource(parsed) {
    if (!parsed || typeof parsed !== "object") return "unknown";
    if (
      parsed.reasoningShort ||
      parsed.correctedText ||
      parsed.confidence != null
    ) {
      return "openai";
    }
    return "local";
  }

  function isParsedResultUsable(parsed) {
    if (!parsed || typeof parsed !== "object") return false;
    if (parsed.kind === "unknown") return false;
    if (parsed.shouldFallbackToManual === true) return false;

    if (parsed.kind === "simple_payment") {
      return Number.isFinite(Number(parsed.total)) && Number(parsed.total) > 0;
    }

    if (parsed.kind === "items") {
      return Array.isArray(parsed.items) && parsed.items.length > 0;
    }

    if (parsed.kind === "intent_only") {
      return true;
    }

    return false;
  }

  function computeDraftFinance(draft) {
    const finance = computeFinance(draft);

    if (!draft || typeof draft !== "object") return finance;

    draft.finance = finance;
    return finance;
  }

  function getDraftTotal(draft) {
    return Number(
      draft?.finance?.gross ??
        draft?.finance?.total ??
        draft?.finance?.subtotal ??
        0
    );
  }

  function validateDraftForPreview(draft) {
    const items = Array.isArray(draft?.items) ? draft.items : [];
    const total = getDraftTotal(draft);
    const issues = [];

    if (items.length > 0) {
      let computed = 0;

      for (const item of items) {
        const qty = Number(item?.qty || 0);
        const unitPrice = Number(item?.unitPrice || 0);
        const lineTotal = Number(
          item?.lineTotal ?? item?.total ?? qty * unitPrice ?? 0
        );

        if (qty <= 0) issues.push("invalid_qty");
        if (unitPrice < 0) issues.push("invalid_unit_price");

        if (qty > 0 && unitPrice > 0) {
          const expected = Math.round(qty * unitPrice);
          computed += expected;

          if (!Number.isFinite(lineTotal) || lineTotal <= 0) {
            issues.push("line_total_zero");
          }
        }
      }

      if (computed > 0 && total <= 0) {
        issues.push("draft_total_zero");
      }
    }

    if (
      typeof draft?.client === "string" &&
      /\d/.test(draft.client) &&
      /\b(porte|portes|fenetre|fenetres|fenêtres|pagne|pagnes|ciment|prix|montant)\b/i.test(
        draft.client
      )
    ) {
      issues.push("client_looks_like_payload");
    }

    return {
      ok: issues.length === 0,
      issues: [...new Set(issues)],
    };
  }

  async function parseNaturalSmart(rawText) {
    let aiParsed = null;
    let localParsed = null;

    if (typeof parseNaturalWithOpenAI === "function") {
      try {
        aiParsed = await parseNaturalWithOpenAI(rawText);

        if (isParsedResultUsable(aiParsed)) {
          console.log("[KADI/NATURAL] using OpenAI parse", {
            kind: aiParsed?.kind || null,
            docType: aiParsed?.docType || null,
            confidence: aiParsed?.confidence ?? null,
          });
          return aiParsed;
        }
      } catch (e) {
        console.warn("[KADI/NLU] OpenAI parse failed:", e?.message);
      }
    }

    try {
      localParsed = parseNaturalWhatsAppMessage(rawText);

      if (isParsedResultUsable(localParsed)) {
        console.log("[KADI/NATURAL] using local parse", {
          kind: localParsed?.kind || null,
          docType: localParsed?.docType || null,
        });
        return localParsed;
      }
    } catch (e) {
      console.warn("[KADI/NATURAL] local parser failed:", e?.message);
    }

    return aiParsed || localParsed || null;
  }

  async function sendDraftPreviewOrRecover(from, draft, rawText) {
    const validation = validateDraftForPreview(draft);

    if (!validation.ok) {
      await logLearningEvent({
        waId: from,
        rawText,
        parseSuccess: false,
        failureReason: `preview_validation_failed:${validation.issues.join(",")}`,
        itemsCount: Array.isArray(draft?.items) ? draft.items.length : 0,
      });

      await sendText(
        from,
        "⚠️ Je préfère revérifier ce document pour éviter une erreur de montant."
      );

      if (!safe(draft.client)) {
        const s = getSession(from);
        s.step = "missing_client_pdf";
        await sendText(from, "👤 Quel est le nom du client ?");
        return true;
      }

      if (!Array.isArray(draft.items) || draft.items.length === 0) {
        await askItemLabel(from);
        return true;
      }

      await sendButtons(from, "Que voulez-vous faire ?", [
        { id: "SMARTBLOCK_FIX", title: "Corriger" },
        { id: "DOC_RESTART", title: "Recommencer" },
      ]);
      return true;
    }

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

  async function tryHandleNaturalMessage(from, text) {
    const s = getSession(from);
    const rawText = String(text || "").trim();
    if (!rawText) return false;

    const vagueCheck = detectVagueRequest(rawText);

    if (vagueCheck.isVague && !s.lastDocDraft) {
      await logLearningEvent({
        waId: from,
        rawText,
        parseSuccess: false,
        failureReason: vagueCheck.reason || "vague_request",
        itemsCount: 0,
      });

      await sendText(from, buildSmartGuidanceMessage(rawText));
      await sendButtons(from, "Que voulez-vous faire ?", [
        { id: "HOME_DOCS", title: "Créer un document" },
        { id: "BACK_HOME", title: "Menu" },
      ]);
      return true;
    }

    if (s.lastDocDraft && s.step === "item_label") {
      const parsedInline = await parseNaturalSmart(rawText);
      const parsedAsStructured =
        parsedInline &&
        (parsedInline.kind === "items" ||
          parsedInline.kind === "simple_payment");

      if (!parsedAsStructured) {
        if (rawText.length < 2) return true;

        s.itemDraft = {
          label: rawText.slice(0, LIMITS.maxItemLabelLength),
          qty: 1,
          unitPrice: null,
        };

        s.step = "item_price";
        await sendText(from, `💰 Quel est le prix pour : *${rawText}* ?`);
        return true;
      }
    }

    const parsed = await parseNaturalSmart(rawText);

    if (!parsed || parsed.kind === "unknown") {
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

    if (parsed.shouldFallbackToManual === true) {
      await logLearningEvent({
        waId: from,
        rawText,
        parseSuccess: false,
        failureReason: parsed.ambiguityReason || "manual_fallback_requested",
        itemsCount: Array.isArray(parsed.items) ? parsed.items.length : 0,
      });

      if (!s.lastDocDraft) {
        s.pendingSmartBlockText = rawText;

        await sendText(from, buildSmartGuidanceMessage(rawText));
        await sendButtons(from, "Quel document voulez-vous créer ?", [
          { id: "SMARTBLOCK_DEVIS", title: "Devis" },
          { id: "SMARTBLOCK_FACTURE", title: "Facture" },
          { id: "SMARTBLOCK_RECU", title: "Reçu" },
        ]);
        return true;
      }

      await sendText(
        from,
        "⚠️ Je veux éviter une erreur sur ce document.\n\n" +
          buildSmartGuidanceMessage(rawText)
      );
      return true;
    }

    if (!s.lastDocDraft) {
      const detectedType = parsed.docType;

      if (!detectedType) {
        s.pendingSmartBlockText = rawText;

        await sendButtons(
          from,
          "🧠 J’ai reconnu le message.\n\nQuel document voulez-vous créer ?",
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
        s.lastDocDraft.subject = null;
        s.lastDocDraft.clientPhone = null;
        s.lastDocDraft.meta = makeDraftMeta({
          nluSource: getNluSource(parsed),
        });
      } else {
        s.lastDocDraft = {
          type: detectedType,
          factureKind: detectedType === "facture" ? "definitive" : null,
          docNumber: null,
          date: formatDateISO(),
          client: null,
          clientPhone: null,
          subject: null,
          motif: null,
          items: [],
          finance: null,
          source: "natural_text",
          meta: makeDraftMeta({
            nluSource: getNluSource(parsed),
          }),
        };
      }
    }

    const draft = s.lastDocDraft;

    if (parsed.kind === "simple_payment") {
      draft.type = parsed.docType || draft.type || "recu";

      if (parsed.client) {
        draft.client = parsed.client.slice(0, LIMITS.maxClientNameLength);
      }

      if (parsed.motif) {
        draft.motif = parsed.motif.slice(0, LIMITS.maxItemLabelLength);
        if (!draft.subject) {
          draft.subject = parsed.motif.slice(0, LIMITS.maxItemLabelLength);
        }
      }

      if (draft.type === "decharge") {
        draft.dechargeType = detectDechargeType(
          draft.motif || parsed.motif || ""
        );
      }

      draft.items = [makeItem(parsed.motif || "Paiement", 1, parsed.total || 0)];
      computeDraftFinance(draft);

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
      return sendDraftPreviewOrRecover(from, draft, rawText);
    }

    if (parsed.kind === "intent_only") {
      if (draft.type === "decharge") {
        if (parsed.client && !draft.client) {
          draft.client = parsed.client.slice(0, LIMITS.maxClientNameLength);
        }

        if (parsed.motif && !draft.motif) {
          draft.motif = parsed.motif.slice(0, LIMITS.maxItemLabelLength);
          draft.dechargeType = detectDechargeType(draft.motif);
          if (!draft.subject) {
            draft.subject = parsed.motif.slice(0, LIMITS.maxItemLabelLength);
          }
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
        await sendText(
          from,
          "💰 Quel est le montant ?\nSi pas de montant, tapez *0*."
        );
        return true;
      }

      if (parsed.client && !draft.client) {
        draft.client = parsed.client.slice(0, LIMITS.maxClientNameLength);
      }

      if (parsed.motif && !draft.motif) {
        draft.motif = parsed.motif.slice(0, LIMITS.maxItemLabelLength);
        if (!draft.subject) {
          draft.subject = parsed.motif.slice(0, LIMITS.maxItemLabelLength);
        }
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
          (draft.subject ? `📝 Objet : ${draft.subject}\n` : "") +
          (draft.motif ? `🧾 Motif : ${draft.motif}\n` : "") +
          `\nAjoutez les éléments ou les prix 👇`
      );

      await askItemLabel(from);
      return true;
    }

    if (parsed.kind === "items") {
      if (parsed.client) {
        draft.client = parsed.client.slice(0, LIMITS.maxClientNameLength);
      }

      if (parsed.motif && !draft.subject) {
        draft.subject = parsed.motif.slice(0, LIMITS.maxItemLabelLength);
      }

      draft.items = (parsed.items || []).map((it) =>
        makeItem(it.label, it.qty, it.unitPrice)
      );

      computeDraftFinance(draft);

      const analysis = analyzeSmartBlock({
        items: draft.items,
        computedTotal: getDraftTotal(draft),
      });

      draft.meta = makeDraftMeta({
        ...(draft.meta || {}),
        businessType: analysis.businessType,
        totalsGap: analysis.gapInfo.gap,
        totalsGapSeverity: analysis.gapInfo.severity,
        missingHint: analysis.hint,
        nluSource: getNluSource(parsed),
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
      return sendDraftPreviewOrRecover(from, draft, rawText);
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
    computeDraftFinance(draft);

    const totalsDetected = extractBlockTotals(raw);
    const computedTotal = getDraftTotal(draft);

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

    const validation = validateDraftForPreview(draft);
    if (!validation.ok) {
      await logLearningEvent({
        waId: from,
        rawText: raw,
        parseSuccess: false,
        failureReason: `smartblock_preview_validation_failed:${validation.issues.join(",")}`,
        itemsCount: Array.isArray(draft?.items) ? draft.items.length : 0,
      });

      await sendText(
        from,
        "⚠️ Je préfère revérifier ce document avant de continuer."
      );

      await sendButtons(from, "Que voulez-vous faire ?", [
        { id: "SMARTBLOCK_FIX", title: "Corriger" },
        { id: "DOC_RESTART", title: "Recommencer" },
      ]);
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