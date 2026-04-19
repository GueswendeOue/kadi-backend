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
    normalizeAndValidateDraft,
    resetStampChoice,
    buildDechargeText,
  } = deps;

  async function applyStampAndSignatureIfAny(
    pdfBuffer,
    profile,
    logoBuffer = null
  ) {
    let buf = pdfBuffer;

    const canStamp = profile?.stamp_enabled === true;

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

  async function sendLowCreditWarning(from, balance) {
    if (Number(balance) !== 1) return;

    await sendText(
      from,
      "⚠️ Il vous reste *1 crédit*.\n\n" +
        "Après ce document, vous devrez recharger pour continuer avec KADI.\n" +
        "💳 2000 FCFA = 25 crédits."
    );
  }

  async function sendNoCreditsBlock(from, balance, totalCost) {
    await sendText(
      from,
      "🚫 Vous n’avez pas assez de crédits.\n\n" +
        `📄 Ce document coûte *${totalCost} crédit(s)*\n` +
        `💳 Votre solde : *${balance || 0} crédit(s)*\n\n` +
        "🔥 Pack conseillé pour continuer maintenant : *1000F = 10 crédits*"
    );

    await sendButtons(from, "Choisissez une option 👇", [
      { id: "CREDITS_RECHARGE", title: "� Recharger 1000F+" },
      { id: "DOC_CANCEL", title: "🏠 Menu" },
    ]);
  }

  async function createAndSendPdf(from) {
    const s = getSession(from);
    const draft = s?.lastDocDraft;

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

    if (typeof normalizeAndValidateDraft !== "function") {
      await sendText(
        from,
        "❌ Vérification interne indisponible.\nMerci de réessayer après mise à jour."
      );
      return;
    }

    let finalDraft = null;
    let baseCost = 0;
    let failedRollbackOperationKey = null;

    const checkedDraft = normalizeAndValidateDraft(draft);

    if (!checkedDraft?.ok) {
      await sendText(
        from,
        "⚠️ Je préfère bloquer ce document pour éviter une erreur de calcul.\n\n" +
          `Détail: ${
            Array.isArray(checkedDraft?.issues)
              ? checkedDraft.issues.join(", ")
              : "données incohérentes"
          }`
      );
      return;
    }

    s.lastDocDraft = checkedDraft.draft;
    finalDraft = s.lastDocDraft;

    try {
      validateDraft(finalDraft);
    } catch (err) {
      await sendText(from, `❌ Erreur dans le document: ${err.message}`);
      return;
    }

    baseCost = computeBasePdfCost(finalDraft);

    const baseReason =
      finalDraft.source === "ocr"
        ? "ocr_pdf"
        : finalDraft.type === "decharge"
        ? "decharge_pdf"
        : "pdf";

    finalDraft.requestId =
      finalDraft.requestId ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const consumeOperationKey = `pdf:consume:${finalDraft.requestId}`;
    failedRollbackOperationKey = `pdf:rollback:${finalDraft.requestId}`;

    s.isGeneratingPdf = true;

    let debited = false;
    let successAfterDebit = false;
    let finalBalance = 0;

    try {
      const profile = await getOrCreateProfile(from);

      const useStampForThisDoc =
        s.addStampForNextDoc === true && s.stampMode === "one_time";

      const stampExtraCost = useStampForThisDoc ? 1 : 0;
      const totalCost = baseCost + stampExtraCost;

      const finalReason = useStampForThisDoc
        ? `${baseReason}_stamp_once`
        : baseReason;

      const cons = await consumeCredit(
        { waId: from },
        totalCost,
        finalReason,
        consumeOperationKey,
        {
          requestId: finalDraft.requestId,
          docType: finalDraft.type || null,
          docNumber: finalDraft.docNumber || null,
          factureKind: finalDraft.factureKind || null,
          source: finalDraft.source || null,
          baseCost,
          stampExtraCost,
          useStampForThisDoc,
        }
      );

      if (!cons?.ok) {
        await sendNoCreditsBlock(from, cons?.balance || 0, totalCost);
        return;
      }

      debited = true;
      finalBalance = cons.balance || 0;

      await sendLowCreditWarning(from, finalBalance);

      finalDraft.finance = computeFinance(finalDraft);

      if (!finalDraft.docNumber) {
        finalDraft.docNumber = await nextDocNumber({
          waId: from,
          mode: finalDraft.type,
          factureKind: finalDraft.factureKind,
          dateISO: finalDraft.date,
        });
      }

      let logoBuf = null;
      if (profile?.logo_path) {
        try {
          const signed = await getSignedLogoUrl(profile.logo_path);
          logoBuf = await downloadSignedUrlToBuffer(signed);
        } catch (e) {
          console.warn("[LOGO DOWNLOAD ERROR]", e?.message);
        }
      }

      const title = getDocTitle(finalDraft);
      const total = Number(finalDraft.finance?.gross || 0);

      if (
        total <= 0 &&
        Array.isArray(finalDraft.items) &&
        finalDraft.items.length > 0
      ) {
        throw new Error("TOTAL_INVALIDE_AVANT_PDF");
      }

      let pdfBuf = await buildPdfBuffer({
        docData: {
          type: title,
          docNumber: finalDraft.docNumber,
          date: finalDraft.date,
          client: finalDraft.client,
          clientPhone: finalDraft.clientPhone || null,
          subject: finalDraft.subject || null,
          motif: finalDraft.motif || null,
          dechargeType: finalDraft.dechargeType || null,
          dechargeText:
            finalDraft.type === "decharge"
              ? buildDechargeText({
                  client: finalDraft.client,
                  businessName: safe(profile?.business_name),
                  motif: finalDraft.motif,
                  total,
                  dechargeType: finalDraft.dechargeType,
                })
              : null,
          items: finalDraft.items || [],
          total,
          receiptFormat: finalDraft.receiptFormat || "a4",
        },
        businessProfile: profile,
        logoBuffer: logoBuf,
      });

      const stampProfile = useStampForThisDoc
        ? {
            ...profile,
            stamp_enabled: true,
          }
        : {
            ...profile,
            stamp_enabled: false,
          };

      pdfBuf = await applyStampAndSignatureIfAny(
        pdfBuf,
        stampProfile,
        logoBuf
      );

      finalDraft.meta = makeDraftMeta({
        ...(finalDraft.meta || {}),
        creditsConsumed: totalCost,
        usedStamp: !!useStampForThisDoc,
        usedGeminiParse: !!finalDraft?.meta?.usedGeminiParse,
        businessSector: finalDraft?.meta?.businessSector || null,
        requestId: finalDraft.requestId,
        stampMode: useStampForThisDoc ? "one_time" : "none",
      });

      finalDraft.status = "generated";

      const fileName = `${finalDraft.docNumber}-${formatDateISO()}.pdf`;

      const up = await uploadMediaBuffer({
        buffer: pdfBuf,
        filename: fileName,
        mimeType: "application/pdf",
      });

      if (!up?.id) {
        throw new Error("UPLOAD_PDF_ECHOUE");
      }

      const saved = await saveDocumentWithRetry({
        waId: from,
        draft: finalDraft,
        maxAttempts: 3,
      });

      finalDraft.savedDocumentId = saved?.id || "generated";
      successAfterDebit = true;

      finalDraft.savedPdfMediaId = up.id;
      finalDraft.savedPdfFilename = fileName;
      finalDraft.savedPdfCaption =
        `✅ ${title} ${finalDraft.docNumber}\n` +
        `Total: ${money(total)} FCFA\n` +
        `Coût: ${totalCost} crédit(s)\n` +
        `Solde: ${finalBalance} crédit(s)`;

      await sendDocument({
        to: from,
        mediaId: finalDraft.savedPdfMediaId,
        filename: finalDraft.savedPdfFilename,
        caption: finalDraft.savedPdfCaption,
      });

      if (finalDraft.type === "devis") {
        try {
          await createDevisFollowup({
            waId: from,
            documentId: finalDraft.savedDocumentId,
            docNumber: finalDraft.docNumber,
            sourceDoc: {
              client: finalDraft.client || null,
              clientPhone: finalDraft.clientPhone || null,
              subject: finalDraft.subject || null,
              items: finalDraft.items || [],
              finance: finalDraft.finance || null,
              date: finalDraft.date || null,
              source: finalDraft.source || null,
            },
            dueAt: Date.now() + 24 * 60 * 60 * 1000,
          });
        } catch (e) {
          console.warn("[FOLLOWUP CREATE ERROR]", e?.message);
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
            s.addStampForNextDoc === true && s.stampMode === "one_time"
              ? 1
              : 0;

          const totalCost = baseCost + stampExtraCost;

          await addCredits(
            { waId: from },
            totalCost,
            "rollback_pdf_failed",
            failedRollbackOperationKey,
            {
              requestId: finalDraft?.requestId || null,
              docType: finalDraft?.type || null,
              docNumber: finalDraft?.docNumber || null,
              factureKind: finalDraft?.factureKind || null,
            }
          );
        } catch (rb) {
          console.error("rollback credits failed:", rb?.message);
        }
      }

      if (String(e?.message || "") === "TOTAL_INVALIDE_AVANT_PDF") {
        await sendText(
          from,
          "⚠️ Le total de votre document est invalide.\nMerci de corriger les lignes avant de générer le PDF."
        );
        return;
      }

      await sendText(from, "❌ Erreur lors de la création du PDF. Réessayez.");
    } finally {
      s.isGeneratingPdf = false;
      if (finalDraft) finalDraft._saving = false;
    }
  }

  async function sendGeneratedSuccessMenu(to) {
    const s = getSession(to);
    const draft = s?.lastDocDraft || null;
    const text = buildGeneratedSuccessMessage(draft);

    const hasClientPhone = !!String(draft?.clientPhone || "").trim();
    const hasGeneratedPdf = !!String(draft?.savedPdfMediaId || "").trim();

    const buttons =
      hasClientPhone && hasGeneratedPdf
        ? [
            { id: "DOC_SEND_TO_CLIENT", title: "📨 Client" },
            { id: "DOC_EDIT_AFTER_GENERATED", title: "✏️ Modifier" },
            { id: "DOC_CANCEL", title: "🏠 Menu" },
          ]
        : [
            { id: "DOC_RESTART", title: "📤 Nouveau doc" },
            { id: "DOC_EDIT_AFTER_GENERATED", title: "✏️ Modifier" },
            { id: "DOC_CANCEL", title: "🏠 Menu" },
          ];

    await sendButtons(to, text, buttons);
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