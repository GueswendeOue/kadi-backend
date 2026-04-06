"use strict";

function makeKadiPdfFlow(deps) {
  const {
    getSession,
    sendText,
    sendButtons,
    sendDocument,

    // storage / media
    uploadMediaBuffer,
    getSignedLogoUrl,
    downloadSignedUrlToBuffer,

    // profile / repo
    getOrCreateProfile,
    saveDocument,
    nextDocNumber,
    createDevisFollowup,

    // credits
    consumeCredit,
    addCredits,

    // pdf + stamp/sign
    buildPdfBuffer,
    kadiStamp,
    kadiSignature,

    // helpers
    safe,
    formatDateISO,
    money,
    makeDraftMeta,
    computeFinance,
    computeBasePdfCost,
    getDocTitle,
    validateDraft,
    resetStampChoice,
    buildDechargeText,

    // menus / messages
    sendGeneratedSuccessMenu,
    sendAlreadyGeneratedMenu,

    // config
    PDF_SIMPLE_CREDITS,
    OCR_PDF_CREDITS,
    DECHARGE_CREDITS,
  } = deps;

  async function applyStampAndSignatureIfAny(pdfBuffer, profile, logoBuffer = null) {
    let buf = pdfBuffer;

    const canStamp = profile?.stamp_enabled === true && profile?.stamp_paid === true;

    if (canStamp && kadiStamp?.applyStampToPdfBuffer) {
      try {
        buf = await kadiStamp.applyStampToPdfBuffer(buf, profile, {
          pages: "last",
          logoBuffer: Buffer.isBuffer(logoBuffer) ? logoBuffer : null,
        });
      } catch (e) {
        console.warn("[STAMP ERROR]", e?.message);
      }
    }

    if (kadiSignature?.applySignatureToPdfBuffer) {
      try {
        buf = await kadiSignature.applySignatureToPdfBuffer(buf, profile);
      } catch (e) {
        console.warn("[SIGNATURE ERROR]", e?.message);
      }
    }

    return buf;
  }

  async function saveDocumentWithRetry({ waId, draft, maxAttempts = 3 }) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const saved = await saveDocument({ waId, doc: draft });
        return saved;
      } catch (e) {
        const msg = String(e?.message || e || "");
        lastError = e;

        if (!msg.startsWith("DOC_NUMBER_ALREADY_EXISTS")) {
          throw e;
        }

        draft.docNumber = await nextDocNumber({
          waId,
          mode: draft.type,
          factureKind: draft.factureKind,
          dateISO: draft.date,
        });
      }
    }

    throw lastError || new Error("SAVE_DOCUMENT_FAILED_AFTER_RETRY");
  }

  function buildGeneratedSuccessMessage(draft = null) {
    return (
      `✅ ${draft?.type === "devis" ? "Devis" : "Document"} généré avec succès.\n\n` +
      "Que voulez-vous faire maintenant ?"
    );
  }

  function buildAlreadyGeneratedMessage(draft = null) {
    return (
      `📄 ${draft?.type === "devis" ? "Ce devis" : "Ce document"} a déjà été généré.\n\n` +
      "Que voulez-vous faire ?"
    );
  }

  async function createAndSendPdf(from) {
    const s = getSession(from);
    const draft = s.lastDocDraft;

    if (!draft) {
      await sendText(from, "❌ Aucun document en cours. Tapez MENU.");
      return;
    }

    if (s.isGeneratingPdf) {
      await sendText(from, "⏳ Génération déjà en cours... veuillez patienter.");
      return;
    }

    if (draft.savedDocumentId || draft.savedPdfMediaId) {
      s.step = "doc_already_generated";
      await sendAlreadyGeneratedMenu(from);
      return;
    }

    if (!safe(draft.client)) {
      s.step = "missing_client_pdf";
      await sendText(from, "⚠️ Client manquant.\nTapez le nom du client :");
      return;
    }

    try {
      validateDraft(draft);
    } catch (err) {
      await sendText(from, `❌ Erreur dans le document: ${err.message}`);
      return;
    }

    const baseCost = computeBasePdfCost(draft);
    const baseReason =
      draft.source === "ocr"
        ? "ocr_pdf"
        : draft.type === "decharge"
        ? "decharge_pdf"
        : "pdf";

    draft.requestId =
      draft.requestId ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const consumeOperationKey = `pdf:consume:${draft.requestId}`;
    const failedRollbackOperationKey = `pdf:rollback:${draft.requestId}`;

    s.isGeneratingPdf = true;

    let debited = false;
    let successAfterDebit = false;
    let finalBalance = 0;

    try {
      const profile = await getOrCreateProfile(from);

      const usePaidStamp =
        profile?.stamp_enabled === true && profile?.stamp_paid === true;

      const useOneTimeStamp =
        s.addStampForNextDoc === true &&
        s.stampMode === "one_time" &&
        profile?.stamp_paid !== true;

      const stampExtraCost = useOneTimeStamp ? 1 : 0;
      const totalCost = baseCost + stampExtraCost;
      const finalReason = useOneTimeStamp ? `${baseReason}_stamp_once` : baseReason;

      const cons = await consumeCredit(
        { waId: from },
        totalCost,
        finalReason,
        consumeOperationKey,
        {
          requestId: draft.requestId,
          docType: draft.type || null,
          docNumber: draft.docNumber || null,
          factureKind: draft.factureKind || null,
          source: draft.source || null,
          baseCost,
          stampExtraCost,
          usePaidStamp,
          useOneTimeStamp,
        }
      );

      if (!cons?.ok) {
        await sendText(
          from,
          `❌ Solde insuffisant.\nVous avez ${cons?.balance || 0} crédit(s).\nCe document coûte ${totalCost} crédit(s).\n👉 Tapez RECHARGE.`
        );
        return;
      }

      debited = true;
      finalBalance = cons.balance || 0;

      const computedFinance = computeFinance(draft);
      draft.finance = {
        subtotal: computedFinance.subtotal,
        gross: draft.finance?.gross ?? computedFinance.gross,
      };

      if (!draft.docNumber) {
        draft.docNumber = await nextDocNumber({
          waId: from,
          mode: draft.type,
          factureKind: draft.factureKind,
          dateISO: draft.date,
        });
      }

      let logoBuf = null;
      if (profile?.logo_path) {
        try {
          const signed = await getSignedLogoUrl(profile.logo_path);
          logoBuf = await downloadSignedUrlToBuffer(signed);
        } catch (e) {
          console.warn("logo download error:", e?.message);
        }
      }

      const title = getDocTitle(draft);
      const total = draft.finance?.gross ?? computeFinance(draft).gross;

      let pdfBuf = await buildPdfBuffer({
        docData: {
          type: title,
          docNumber: draft.docNumber,
          date: draft.date,
          client: draft.client,
          motif: draft.motif || null,
          dechargeType: draft.dechargeType || null,
          dechargeText:
            draft.type === "decharge"
              ? buildDechargeText({
                  client: draft.client,
                  businessName: safe(profile?.business_name),
                  motif: draft.motif,
                  total,
                  dechargeType: draft.dechargeType,
                })
              : null,
          items: draft.items || [],
          total,
          receiptFormat: draft.receiptFormat || "a4",
        },
        businessProfile: profile,
        logoBuffer: logoBuf,
      });

      const stampProfile =
        usePaidStamp || useOneTimeStamp
          ? {
              ...profile,
              stamp_enabled: true,
              stamp_paid: true,
            }
          : profile;

      pdfBuf = await applyStampAndSignatureIfAny(pdfBuf, stampProfile, logoBuf);

      draft.meta = makeDraftMeta({
        ...(draft.meta || {}),
        creditsConsumed: totalCost,
        usedStamp: !!(usePaidStamp || useOneTimeStamp),
        usedGeminiParse: !!draft?.meta?.usedGeminiParse,
        businessSector: draft?.meta?.businessSector || null,
        requestId: draft.requestId,
        stampMode: usePaidStamp ? "unlimited" : useOneTimeStamp ? "one_time" : "none",
      });

      draft.status = "generated";

      const fileName = `${draft.docNumber}-${formatDateISO()}.pdf`;

      const up = await uploadMediaBuffer({
        buffer: pdfBuf,
        filename: fileName,
        mimeType: "application/pdf",
      });

      if (!up?.id) {
        throw new Error("Upload PDF échoué");
      }

      const saved = await saveDocumentWithRetry({
        waId: from,
        draft,
        maxAttempts: 3,
      });

      draft.savedDocumentId = saved?.id || "generated";
      successAfterDebit = true;

      draft.savedPdfMediaId = up.id;
      draft.savedPdfFilename = fileName;
      draft.savedPdfCaption =
        `✅ ${title} ${draft.docNumber}\n` +
        `Total: ${money(total)} FCFA\n` +
        `Coût: ${totalCost} crédit(s)\n` +
        `Solde: ${finalBalance} crédit(s)`;

      await sendDocument({
        to: from,
        mediaId: draft.savedPdfMediaId,
        filename: draft.savedPdfFilename,
        caption: draft.savedPdfCaption,
      });

      if (draft.type === "devis") {
        try {
          await createDevisFollowup({
            waId: from,
            documentId: draft.savedDocumentId,
            docNumber: draft.docNumber,
            sourceDoc: {
              client: draft.client || null,
              items: draft.items || [],
              finance: draft.finance || null,
              date: draft.date || null,
              source: draft.source || null,
            },
            dueAt: Date.now() + 24 * 60 * 60 * 1000,
          });
        } catch (e) {
          console.warn("followup create error:", e?.message);
        }
      }

      resetStampChoice(s);

      s.step = "doc_generated";
      await sendGeneratedSuccessMenu(from);
    } catch (e) {
      console.error("createAndSendPdf error:", e?.message);

      if (debited && !successAfterDebit) {
        try {
          const stampExtraCost =
            s.addStampForNextDoc === true && s.stampMode === "one_time" ? 1 : 0;
          const totalCost = baseCost + stampExtraCost;

          await addCredits(
            { waId: from },
            totalCost,
            "rollback_pdf_failed",
            failedRollbackOperationKey,
            {
              requestId: draft.requestId,
              docType: draft.type || null,
              docNumber: draft.docNumber || null,
              factureKind: draft.factureKind || null,
            }
          );
        } catch (rb) {
          console.error("rollback credits failed:", rb?.message);
        }
      }

      await sendText(from, "❌ Erreur lors de la création du PDF. Réessayez.");
    } finally {
      s.isGeneratingPdf = false;
      if (draft) draft._saving = false;
    }
  }

  async function sendGeneratedSuccessMenu(to) {
    const s = getSession(to);
    const draft = s?.lastDocDraft || null;
    const text = buildGeneratedSuccessMessage(draft);

    await sendButtons(to, text, [
      { id: "DOC_RESTART", title: "📤 Nouveau doc" },
      { id: "DOC_EDIT_AFTER_GENERATED", title: "✏️ Modifier" },
      { id: "DOC_CANCEL", title: "🏠 Menu" },
    ]);
  }

  async function sendAlreadyGeneratedMenu(to) {
    const s = getSession(to);
    const draft = s?.lastDocDraft || null;
    const text = buildAlreadyGeneratedMessage(draft);

    await sendButtons(to, text, [
      { id: "DOC_RESTART", title: "📤 Nouveau doc" },
      { id: "DOC_EDIT_AFTER_GENERATED", title: "✏️ Modifier" },
      { id: "DOC_CANCEL", title: "🏠 Menu" },
    ]);
  }

  return {
    applyStampAndSignatureIfAny,
    saveDocumentWithRetry,
    createAndSendPdf,
    buildGeneratedSuccessMessage,
    buildAlreadyGeneratedMessage,
    sendGeneratedSuccessMenu,
    sendAlreadyGeneratedMenu,
  };
}

module.exports = {
  makeKadiPdfFlow,
};