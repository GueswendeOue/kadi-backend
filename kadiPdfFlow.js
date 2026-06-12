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

    // optional analytics
    trackConversionEvent = null,
  } = deps;

  function safeText(v, def = null) {
    const s = String(v ?? "").trim();
    return s || def;
  }

  function getDocLabel(draft = null) {
    if (draft?.type === "devis") return "Devis";
    if (draft?.type === "facture") return "Facture";
    if (draft?.type === "recu") return "Reçu";
    if (draft?.type === "decharge") return "Décharge";
    return "Document";
  }

  function hasGeneratedStampInfo(profile = {}) {
    return !!(
      safeText(profile?.business_name, "") ||
      safeText(profile?.owner_name, "") ||
      safeText(profile?.phone, "")
    );
  }

  function resolveStampSource(profile = {}) {
    const source = safeText(profile?.stamp_source, "").toLowerCase();
    const hasImage = !!safeText(profile?.stamp_image_path, "");

    if (source === "uploaded" && hasImage) return "uploaded";
    if (source === "generated") return "generated";
    if (hasImage) return "uploaded";
    return "generated";
  }

  function logStampResult({ requested, source, applied, reason }) {
    console.log(
      `[KADI/STAMP] requested=${requested === true} source=${
        source || "none"
      } applied=${applied === true} reason=${reason || "-"}`
    );
  }

  async function prepareStampForPdf({ profile, requested }) {
    const source = resolveStampSource(profile);

    if (requested !== true) {
      return {
        requested: false,
        shouldApply: false,
        source,
        stampBuffer: null,
        profile: { ...profile, stamp_enabled: false },
        reason: "not_requested",
      };
    }

    if (profile?.stamp_enabled !== true) {
      return {
        requested: true,
        shouldApply: false,
        source,
        stampBuffer: null,
        profile: { ...profile, stamp_enabled: false },
        reason: "stamp_disabled",
      };
    }

    if (source === "uploaded") {
      const imagePath = safeText(profile?.stamp_image_path, "");

      if (!imagePath) {
        if (hasGeneratedStampInfo(profile)) {
          return {
            requested: true,
            shouldApply: true,
            source: "generated",
            stampBuffer: null,
            profile: {
              ...profile,
              stamp_enabled: true,
              stamp_paid: true,
              stamp_source: "generated",
              stamp_image_path: null,
            },
            reason: "uploaded_path_missing_fallback_generated",
          };
        }

        return {
          requested: true,
          shouldApply: false,
          source,
          stampBuffer: null,
          profile: { ...profile, stamp_enabled: false },
          reason: "uploaded_path_missing",
        };
      }

      try {
        const signed = await getSignedLogoUrl(imagePath);
        const stampBuffer = await downloadSignedUrlToBuffer(signed);

        return {
          requested: true,
          shouldApply: true,
          source: "uploaded",
          stampBuffer,
          profile: {
            ...profile,
            stamp_enabled: true,
            stamp_paid: true,
            stamp_source: "uploaded",
          },
          reason: "uploaded_ready",
        };
      } catch (e) {
        console.warn("[STAMP IMAGE DOWNLOAD ERROR]", e?.message || e);

        if (hasGeneratedStampInfo(profile)) {
          return {
            requested: true,
            shouldApply: true,
            source: "generated",
            stampBuffer: null,
            profile: {
              ...profile,
              stamp_enabled: true,
              stamp_paid: true,
              stamp_source: "generated",
              stamp_image_path: null,
            },
            reason: "uploaded_download_failed_fallback_generated",
          };
        }

        return {
          requested: true,
          shouldApply: false,
          source,
          stampBuffer: null,
          profile: { ...profile, stamp_enabled: false },
          reason: "uploaded_download_failed_no_generated_fallback",
        };
      }
    }

    if (!hasGeneratedStampInfo(profile)) {
      return {
        requested: true,
        shouldApply: false,
        source,
        stampBuffer: null,
        profile: { ...profile, stamp_enabled: false },
        reason: "generated_profile_missing",
      };
    }

    return {
      requested: true,
      shouldApply: true,
      source: "generated",
      stampBuffer: null,
      profile: {
        ...profile,
        stamp_enabled: true,
        stamp_paid: true,
        stamp_source: "generated",
        stamp_image_path: null,
      },
      reason: "generated_ready",
    };
  }

  async function sendStampUnavailableWarning(from, stampPlan = {}) {
    await sendText(
      from,
      "⚠️ Je n’ai pas pu préparer le tampon pour ce PDF.\n\n" +
        "Je continue sans tampon et sans crédit supplémentaire pour le tampon."
    );

    logStampResult({
      requested: true,
      source: stampPlan?.source,
      applied: false,
      reason: stampPlan?.reason || "unavailable",
    });
  }

  function clearGeneratedArtifacts(draft) {
    if (!draft || typeof draft !== "object") return;

    draft.docNumber = null;

    draft.savedDocumentId = null;
    draft.savedPdfMediaId = null;
    draft.savedPdfFilename = null;
    draft.savedPdfCaption = null;

    // Compatibilité avec variantes anciennes.
    draft.pdf_media_id = null;
    draft.pdfMediaId = null;
    draft.pdf_filename = null;
    draft.pdfFilename = null;
    draft.pdf_caption = null;
    draft.pdfCaption = null;

    draft.status = "draft";
    draft.requestId = null;
    draft._saving = false;
  }

  async function track(from, eventKey, draft = null, meta = {}) {
    if (typeof trackConversionEvent !== "function") return;

    try {
      await trackConversionEvent({
        waId: from,
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

  async function applyStampAndSignatureIfAny(
    pdfBuffer,
    profile,
    logoBuffer = null,
    opts = {}
  ) {
    let buf = pdfBuffer;

    const stampRequested =
      opts.stampRequested === true || profile?.stamp_enabled === true;
    const stampSource = safeText(opts.stampSource, resolveStampSource(profile));
    const stampRequired = opts.stampRequired === true;
    const hasPreparedStampBuffer = Object.prototype.hasOwnProperty.call(
      opts,
      "stampBuffer"
    );
    const canStamp = profile?.stamp_enabled === true;

    if (canStamp && kadiStamp?.applyStampToPdfBuffer) {
      try {
        const paidGateBlocks =
          Object.prototype.hasOwnProperty.call(profile || {}, "stamp_paid") &&
          profile?.stamp_paid !== true &&
          opts.ignorePaidFlag !== true;

        if (paidGateBlocks) {
          logStampResult({
            requested: stampRequested,
            source: stampSource,
            applied: false,
            reason: "stamp_paid_false",
          });
          if (stampRequired) {
            throw new Error("STAMP_NOT_PAID");
          }
          return buf;
        }

        let stampBuf =
          opts.stampBuffer && Buffer.isBuffer(opts.stampBuffer)
            ? opts.stampBuffer
            : null;

        const stampSource = String(profile?.stamp_source || "")
          .trim()
          .toLowerCase();
        const shouldUseUploadedStamp =
          !!profile?.stamp_image_path &&
          (stampSource === "uploaded" || !stampSource);

        if (!stampBuf && !hasPreparedStampBuffer && shouldUseUploadedStamp) {
          try {
            const signed = await getSignedLogoUrl(profile.stamp_image_path);
            stampBuf = await downloadSignedUrlToBuffer(signed);
          } catch (e) {
            console.warn("[STAMP IMAGE DOWNLOAD ERROR]", e?.message || e);
          }
        }

        const stampProfile = stampBuf
          ? profile
          : { ...profile, stamp_image_path: null };

        buf = await kadiStamp.applyStampToPdfBuffer(buf, stampProfile, {
          pages: "last",
          logoBuffer: Buffer.isBuffer(logoBuffer) ? logoBuffer : null,
          stampBuffer: Buffer.isBuffer(stampBuf) ? stampBuf : null,
          required: stampRequired,
          ignorePaidFlag: opts.ignorePaidFlag === true,
        });

        logStampResult({
          requested: stampRequested,
          source: stampSource || stampProfile?.stamp_source || "generated",
          applied: true,
          reason: opts.stampReason || "applied",
        });
      } catch (e) {
        console.warn("[STAMP ERROR]", e?.message || e);
        logStampResult({
          requested: stampRequested,
          source: stampSource,
          applied: false,
          reason: `error:${String(e?.message || e || "unknown_error").slice(
            0,
            120
          )}`,
        });
        if (stampRequired) {
          throw e;
        }
      }
    } else {
      logStampResult({
        requested: stampRequested,
        source: stampSource,
        applied: false,
        reason: canStamp ? "handler_missing" : "not_enabled",
      });
    }

    if (kadiSignature?.applySignatureToPdfBuffer) {
      try {
        buf = await kadiSignature.applySignatureToPdfBuffer(buf, profile);
      } catch (e) {
        console.warn("[SIGNATURE ERROR]", e?.message || e);
      }
    }

    return buf;
  }

  function refreshSavedPdfPresentation({
    draft,
    title,
    total,
    totalCost,
    balance,
  }) {
    if (!draft) return;

    draft.savedPdfFilename = `${draft.docNumber}-${formatDateISO()}.pdf`;
    draft.savedPdfCaption =
      `✅ ${title} ${draft.docNumber}\n` +
      `Total: ${money(total)} FCFA\n` +
      `Coût: ${totalCost} crédit(s)\n` +
      `Solde: ${balance} crédit(s)`;
  }

  function isDocNumberConflictError(err) {
    const msg = String(err?.message || err || "");

    return (
      msg.startsWith("DOC_NUMBER_ALREADY_EXISTS") ||
      msg.includes("kadi_documents_wa_id_doc_number_uniq") ||
      msg.includes("kadi_documents_doc_number_uniq") ||
      (msg.includes("duplicate key value") && msg.includes("doc_number"))
    );
  }

  async function saveDocumentWithRetry({
    waId,
    draft,
    maxAttempts = 3,
    beforeEachSave = null,
  }) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (typeof beforeEachSave === "function") {
          await beforeEachSave();
        }

        const saved = await saveDocument({ waId, doc: draft });
        return saved;
      } catch (e) {
        lastError = e;

        if (!isDocNumberConflictError(e)) {
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
    return `✅ ${getDocLabel(draft)} généré avec succès.\n\nQue voulez-vous faire maintenant ?`;
  }

  function buildAlreadyGeneratedMessage(draft = null) {
    const label =
      draft?.type === "devis"
        ? "Ce devis"
        : draft?.type === "facture"
        ? "Cette facture"
        : draft?.type === "recu"
        ? "Ce reçu"
        : draft?.type === "decharge"
        ? "Cette décharge"
        : "Ce document";

    return `📄 ${label} a déjà été généré.\n\nQue voulez-vous faire ?`;
  }

  async function sendLowCreditWarning(from, balance, draft = null) {
    if (Number(balance) !== 1) return;

    await track(from, "low_credit_warning_shown", draft, {
      balance,
    });

    await sendText(
      from,
      "⚠️ Il vous reste *1 crédit*.\n\n" +
        "Après ce document, vous devrez recharger pour continuer avec KADI."
    );
  }

  async function sendNoCreditsBlock(from, balance, totalCost, draft = null) {
    const currentBalance = Number(balance || 0);
    const cost = Number(totalCost || 0);
    const missingCredits = Math.max(0, cost - currentBalance);
    const label = getDocLabel(draft).toLowerCase();

    await track(from, "pdf_blocked_no_credits", draft, {
      balance: currentBalance,
      totalCost: cost,
      missingCredits,
    });

    await sendText(
      from,
      "📄 *Votre document est prêt.*\n\n" +
        `Il manque seulement les crédits pour envoyer le ${label} en PDF.\n\n` +
        `Coût du PDF : *${cost} crédit(s)*\n` +
        `Votre solde : *${currentBalance} crédit(s)*\n` +
        `Manquant : *${missingCredits} crédit(s)*\n\n` +
        "Rechargez maintenant, puis KADI pourra reprendre ce document ici."
    );

    await sendButtons(from, "Choisissez un pack 👇", [
      { id: "RECHARGE_1000", title: "1000F" },
      { id: "RECHARGE_2000", title: "2000F" },
      { id: "RECHARGE_5000", title: "5000F" },
    ]);
  }

  async function sendDeliveryFailureRecovery(from, draft = null) {
    await sendText(
      from,
      "⚠️ Votre document a bien été généré et sauvegardé, " +
        "mais je n’ai pas pu vous le renvoyer tout de suite.\n\n" +
        "Vous pouvez le renvoyer maintenant ou le retrouver dans l’historique."
    );

    await sendAlreadyGeneratedMenu(from, draft);
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
      await sendAlreadyGeneratedMenu(from, draft);
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
    let totalCost = 0;
    let failedRollbackOperationKey = null;
    let documentPersisted = false;

    const checkedDraft = normalizeAndValidateDraft(draft);

    if (!checkedDraft?.ok) {
      await track(from, "pdf_blocked_invalid_draft", draft, {
        issues: Array.isArray(checkedDraft?.issues) ? checkedDraft.issues : [],
      });

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
    let finalBalance = 0;

    try {
      const profile = await getOrCreateProfile(from);

      const stampRequestedForThisDoc =
        s.addStampForNextDoc === true && s.stampMode === "one_time";

      let logoBuf = null;
      if (profile?.logo_path) {
        try {
          const signed = await getSignedLogoUrl(profile.logo_path);
          logoBuf = await downloadSignedUrlToBuffer(signed);
        } catch (e) {
          console.warn("[LOGO DOWNLOAD ERROR]", e?.message || e);
        }
      }

      const stampPlan = await prepareStampForPdf({
        profile,
        requested: stampRequestedForThisDoc,
      });

      if (stampRequestedForThisDoc && !stampPlan.shouldApply) {
        await sendStampUnavailableWarning(from, stampPlan);
      }

      const useStampForThisDoc = stampPlan.shouldApply === true;
      const stampExtraCost = useStampForThisDoc ? 1 : 0;
      totalCost = baseCost + stampExtraCost;

      const finalReason = useStampForThisDoc
        ? `${baseReason}_stamp_once`
        : baseReason;

      await track(from, "pdf_generation_started", finalDraft, {
        totalCost,
        baseCost,
        stampExtraCost,
        stampRequested: stampRequestedForThisDoc,
        stampSource: stampPlan.source || null,
        stampReason: stampPlan.reason || null,
        useStampForThisDoc,
      });

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
          stampRequested: stampRequestedForThisDoc,
          stampSource: stampPlan.source || null,
          stampReason: stampPlan.reason || null,
          useStampForThisDoc,
        }
      );

      if (!cons?.ok) {
        s.pendingPdfAfterRecharge = true;
        s.lastDocDraft = finalDraft;

        await sendNoCreditsBlock(from, cons?.balance || 0, totalCost, finalDraft);
        return;
      }

      debited = true;
      finalBalance = Number(cons.balance || 0);

      await sendLowCreditWarning(from, finalBalance, finalDraft);

      finalDraft.finance = computeFinance(finalDraft);

      if (!finalDraft.docNumber) {
        finalDraft.docNumber = await nextDocNumber({
          waId: from,
          mode: finalDraft.type,
          factureKind: finalDraft.factureKind,
          dateISO: finalDraft.date,
        });
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
          clientPhone:
            finalDraft.receiver_phone || finalDraft.clientPhone || null,
          subject: finalDraft.object_label || finalDraft.subject || null,
          motif: finalDraft.motif || null,
          dechargeType: finalDraft.dechargeType || null,
          cni_number: finalDraft.cni_number || null,
          receiver_phone: finalDraft.receiver_phone || null,
          object_label: finalDraft.object_label || null,
          amount_received: finalDraft.amount_received || null,
          object_value: finalDraft.object_value || null,
          discharge_purpose: finalDraft.discharge_purpose || null,
          dechargeText:
            finalDraft.type === "decharge"
              ? buildDechargeText({
                  client: finalDraft.client,
                  businessName: safe(profile?.business_name),
                  cni_number: finalDraft.cni_number,
                  receiver_phone:
                    finalDraft.receiver_phone || finalDraft.clientPhone,
                  object_label: finalDraft.object_label,
                  amount_received:
                    finalDraft.amount_received ||
                    (finalDraft.dechargeType === "argent" ||
                    finalDraft.dechargeType === "mixte"
                      ? total
                      : 0),
                  object_value: finalDraft.object_value,
                  discharge_purpose:
                    finalDraft.discharge_purpose || finalDraft.motif,
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
        ? stampPlan.profile
        : { ...profile, stamp_enabled: false };

      pdfBuf = await applyStampAndSignatureIfAny(
        pdfBuf,
        stampProfile,
        logoBuf,
        {
          stampRequested: stampRequestedForThisDoc,
          stampRequired: useStampForThisDoc,
          ignorePaidFlag: useStampForThisDoc,
          stampBuffer: stampPlan.stampBuffer,
          stampSource: stampPlan.source,
          stampReason: stampPlan.reason,
        }
      );

      finalDraft.meta = makeDraftMeta({
        ...(finalDraft.meta || {}),
        creditsConsumed: totalCost,
        usedStamp: !!useStampForThisDoc,
        stampRequested: !!stampRequestedForThisDoc,
        stampApplied: !!useStampForThisDoc,
        stampSource: useStampForThisDoc ? stampPlan.source || null : null,
        stampReason: stampPlan.reason || null,
        usedGeminiParse: !!finalDraft?.meta?.usedGeminiParse,
        businessSector: finalDraft?.meta?.businessSector || null,
        requestId: finalDraft.requestId,
        stampMode: useStampForThisDoc ? "one_time" : "none",
      });

      finalDraft.status = "generated";

      const uploadFilename = `kadi-${finalDraft.requestId}.pdf`;

      const up = await uploadMediaBuffer({
        buffer: pdfBuf,
        filename: uploadFilename,
        mimeType: "application/pdf",
      });

      if (!up?.id) {
        throw new Error("UPLOAD_PDF_ECHOUE");
      }

      finalDraft.savedPdfMediaId = up.id;

      const saved = await saveDocumentWithRetry({
        waId: from,
        draft: finalDraft,
        maxAttempts: 3,
        beforeEachSave: async () => {
          refreshSavedPdfPresentation({
            draft: finalDraft,
            title,
            total,
            totalCost,
            balance: finalBalance,
          });
        },
      });

      finalDraft.savedDocumentId = saved?.id || "generated";
      documentPersisted = true;

      try {
        await sendDocument({
          to: from,
          mediaId: finalDraft.savedPdfMediaId,
          filename: finalDraft.savedPdfFilename,
          caption: finalDraft.savedPdfCaption,
        });
      } catch (deliveryErr) {
        console.error(
          "sendDocument after generation failed:",
          deliveryErr?.message || deliveryErr
        );

        await track(from, "pdf_delivery_failed_after_generation", finalDraft, {
          error: String(deliveryErr?.message || deliveryErr || "delivery_error"),
        });

        s.step = "doc_already_generated";
        await sendDeliveryFailureRecovery(from, finalDraft);
        return;
      }

      await track(from, "pdf_generated_success", finalDraft, {
        totalCost,
        balanceAfter: finalBalance,
        useStampForThisDoc,
        totalFcfa: total,
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
          console.warn("[FOLLOWUP CREATE ERROR]", e?.message || e);
        }
      }

      resetStampChoice(s);
      s.pendingPdfAfterRecharge = false;
      s.step = "doc_generated";

      await sendGeneratedSuccessMenu(from, finalDraft);
    } catch (e) {
      console.error("createAndSendPdf error:", e?.message || e);

      if (debited && !documentPersisted) {
        try {
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
          console.error("rollback credits failed:", rb?.message || rb);
        }

        clearGeneratedArtifacts(finalDraft);
      }

      await track(from, "pdf_generation_failed", finalDraft, {
        error: String(e?.message || e || "unknown_error"),
        documentPersisted,
      });

      if (String(e?.message || "") === "TOTAL_INVALIDE_AVANT_PDF") {
        await sendText(
          from,
          "⚠️ Le total de votre document est invalide.\nMerci de corriger les lignes avant de générer le PDF."
        );
        return;
      }

      if (documentPersisted) {
        s.step = "doc_already_generated";
        await sendDeliveryFailureRecovery(from, finalDraft);
        return;
      }

      await sendText(
        from,
        "❌ Erreur lors de la création du PDF.\nRéessayez."
      );
    } finally {
      s.isGeneratingPdf = false;
      if (finalDraft) finalDraft._saving = false;
    }
  }

  async function sendGeneratedSuccessMenu(to, draftOverride = null) {
    const s = getSession(to);
    const draft = draftOverride || s?.lastDocDraft || null;
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
            { id: "DOC_RESTART", title: "📄 Nouveau" },
            { id: "DOC_EDIT_AFTER_GENERATED", title: "✏️ Modifier" },
            { id: "DOC_CANCEL", title: "🏠 Menu" },
          ];

    await sendButtons(to, text, buttons);
  }

  async function sendAlreadyGeneratedMenu(to, draftOverride = null) {
    const s = getSession(to);
    const draft = draftOverride || s?.lastDocDraft || null;
    const text = buildAlreadyGeneratedMessage(draft);

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
            { id: "DOC_RESEND_LAST_PDF", title: "📩 Renvoyer" },
            { id: "DOC_EDIT_AFTER_GENERATED", title: "✏️ Modifier" },
            { id: "DOC_CANCEL", title: "🏠 Menu" },
          ];

    await sendButtons(to, text, buttons);
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
