"use strict";

function makeKadiImageFlow(deps) {
  const {
    getSession,
    sendText,
    sendButtons,
    getMediaInfo,
    downloadMediaToBuffer,

    // utils
    LIMITS,
    guessExtFromMime,

    // profile
    handleLogoImage,

    // recharge
    readTopup,
    getPendingTopupByWaId,
    markTopupProofImageReceived,
    notifyAdminTopupReview,

    // OCR
    processOcrImageToDraft,

    // storage / broadcast
    uploadCampaignImageBuffer,
    getSignedCampaignUrl,
    ensureAdmin,
    resetAdminBroadcastState,
    kadiBroadcast,
  } = deps;

  // OCR is started later via interactive reply after user chooses document type.
  void processOcrImageToDraft;

  function isProfileLogoStep(session) {
    if (!session) return false;

    return (
      session.step === "profile_logo_upload" ||
      (session.step === "profile" && session.profileStep === "logo")
    );
  }

  function clearRechargeProofState(session) {
    if (!session || typeof session !== "object") return;

    session.step = null;
    session.pendingTopupId = null;
    session.pendingTopupReference = null;
    session.pendingTopupMethod = null;
    session.pendingRechargePack = null;
    session.pendingRechargeAmount = null;
    session.pendingRechargeCredits = null;
    session.pendingRechargeIncludesStamp = null;
  }

  async function getImagePayload(msg) {
    const mediaId = msg?.image?.id;
    if (!mediaId) {
      return {
        ok: false,
        error: "❌ Image reçue mais sans media_id. Réessayez.",
      };
    }

    const info = await getMediaInfo(mediaId);

    if (info?.file_size && info.file_size > LIMITS.maxImageSize) {
      return {
        ok: false,
        error: "❌ Image trop grande. Envoyez une image plus légère.",
      };
    }

    const mimeType = info?.mime_type || "image/jpeg";
    const ext = guessExtFromMime(mimeType) || "jpg";
    const buffer = await downloadMediaToBuffer(info.url);

    return {
      ok: true,
      mediaId,
      info,
      mimeType,
      ext,
      buffer,
    };
  }

  async function validateOcrImage(mediaId) {
    if (!mediaId) {
      return {
        ok: false,
        error: "❌ Image reçue mais sans media_id. Réessayez.",
      };
    }

    const info = await getMediaInfo(mediaId);

    if (info?.file_size && info.file_size > LIMITS.maxImageSize) {
      return {
        ok: false,
        error: "❌ Image trop grande. Envoyez une image plus légère.",
      };
    }

    return {
      ok: true,
      mediaId,
      info,
    };
  }

  async function handleAdminBroadcastImage(from, msg) {
    const s = getSession(from);

    if (!ensureAdmin(from)) return false;

    const wantsBroadcastImage = s?.adminPendingAction === "broadcast_image";
    const wantsTemplateImage =
      s?.adminPendingAction === "broadcast_template_image";

    if (!wantsBroadcastImage && !wantsTemplateImage) {
      return false;
    }

    try {
      const image = await getImagePayload(msg);

      if (!image.ok) {
        await sendText(from, image.error);
        return true;
      }

      if (wantsBroadcastImage) {
        await sendText(from, "📢 Image reçue. Broadcast en cours...");

        if (!kadiBroadcast?.broadcastImageToAll) {
          resetAdminBroadcastState(s);
          await sendText(from, "⚠️ Module broadcast image absent.");
          return true;
        }

        const caption = s.broadcastCaption || "";
        resetAdminBroadcastState(s);

        await kadiBroadcast.broadcastImageToAll({
          adminWaId: from,
          imageBuffer: image.buffer,
          mimeType: image.mimeType,
          filename: `broadcast-${Date.now()}.${image.ext}`,
          caption,
          audience: "all_known",
        });

        return true;
      }

      if (wantsTemplateImage) {
        await sendText(from, "🧩 Image reçue. Préparation du template en cours...");

        if (!kadiBroadcast?.broadcastTemplateToAll) {
          resetAdminBroadcastState(s);
          await sendText(from, "⚠️ Module broadcast template absent.");
          return true;
        }

        const { filePath } = await uploadCampaignImageBuffer({
          buffer: image.buffer,
          mimeType: image.mimeType,
          filename: `template-${Date.now()}`,
        });

        const headerImageLink = await getSignedCampaignUrl(filePath);

        resetAdminBroadcastState(s);

        await kadiBroadcast.broadcastTemplateToAll({
          adminWaId: from,
          templateName: "kadi_monday_boost",
          language: "fr",
          audience: "all_known",
          headerImageLink,
        });

        return true;
      }

      return false;
    } catch (e) {
      console.error("[KADI/IMAGE/admin_broadcast]", e);
      resetAdminBroadcastState(s);
      await sendText(from, "❌ Erreur lors du traitement de l'image.");
      return true;
    }
  }

  async function handleRechargeProofImage(from, msg) {
    const s = getSession(from);

    if (s?.step !== "recharge_proof") {
      return false;
    }

    const mediaId = msg?.image?.id;
    if (!mediaId) {
      await sendText(from, "❌ Image reçue mais sans media_id. Réessayez.");
      return true;
    }

    let topup = null;

    if (s.pendingTopupId) {
      topup = await readTopup(s.pendingTopupId);
    }

    if (!topup) {
      topup = await getPendingTopupByWaId(from);
    }

    if (!topup) {
      clearRechargeProofState(s);
      await sendText(from, "❌ Aucune recharge en attente trouvée.");
      return true;
    }

    const proofImageUrl = `whatsapp://media/${mediaId}`;
    const updated = await markTopupProofImageReceived(topup.id, proofImageUrl);

    clearRechargeProofState(s);

    await sendText(
      from,
      "⏳ Capture reçue.\n\nVotre recharge est en attente de validation.\nVous recevrez un message dès que ce sera validé."
    );

    await notifyAdminTopupReview(from, updated, "image");
    return true;
  }

  async function handleIncomingImage(from, msg) {
    const s = getSession(from);

    // 1) Admin broadcast image
    if (await handleAdminBroadcastImage(from, msg)) return true;

    // 2) Logo profil
    if (isProfileLogoStep(s)) {
      const handled = await handleLogoImage(from, msg);
      if (handled) return true;
    }

    // 3) Preuve recharge Orange Money
    if (await handleRechargeProofImage(from, msg)) return true;

    // 4) OCR document
    const mediaId = msg?.image?.id;
    if (!mediaId) {
      await sendText(from, "❌ Image reçue mais sans media_id. Réessayez.");
      return true;
    }

    try {
      const checked = await validateOcrImage(mediaId);

      if (!checked.ok) {
        await sendText(from, checked.error);
        return true;
      }

      s.pendingOcrMediaId = mediaId;

      await sendButtons(
        from,
        "📷 Photo reçue.\n\nChoisissez le document que KADI doit préparer à partir de cette image.",
        [
          { id: "OCR_DEVIS", title: "Devis" },
          { id: "OCR_FACTURE", title: "Facture" },
          { id: "OCR_RECU", title: "Reçu" },
        ]
      );

      return true;
    } catch (e) {
      console.error("[KADI/IMAGE/ocr_prepare]", e);
      await sendText(
        from,
        "❌ Je n’ai pas pu préparer cette image.\nEssayez une photo plus nette ou renvoyez-la."
      );
      return true;
    }
  }

  return {
    handleIncomingImage,
    handleAdminBroadcastImage,
  };
}

module.exports = {
  makeKadiImageFlow,
};