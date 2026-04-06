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

  async function handleAdminBroadcastImage(from, msg) {
    const s = getSession(from);

    if (!ensureAdmin(from)) return false;

    const mediaId = msg?.image?.id;
    if (!mediaId) {
      await sendText(from, "❌ Image reçue mais sans media_id. Réessayez.");
      return true;
    }

    try {
      const info = await getMediaInfo(mediaId);

      if (info?.file_size && info.file_size > LIMITS.maxImageSize) {
        await sendText(from, "❌ Image trop grande. Envoyez une image plus légère.");
        return true;
      }

      const mime = info?.mime_type || "image/jpeg";
      const ext = guessExtFromMime(mime);
      const buf = await downloadMediaToBuffer(info.url);

      // ===============================
      // 1) Broadcast image classique
      // ===============================
      if (s.adminPendingAction === "broadcast_image") {
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
          imageBuffer: buf,
          mimeType: mime,
          filename: `broadcast-${Date.now()}.${ext}`,
          caption,
          audience: "all_known",
        });

        return true;
      }

      // ===============================
      // 2) Broadcast template avec image header
      // ===============================
      if (s.adminPendingAction === "broadcast_template_image") {
        await sendText(from, "🧩 Image reçue. Préparation du template en cours...");

        if (!kadiBroadcast?.broadcastTemplateToAll) {
          resetAdminBroadcastState(s);
          await sendText(from, "⚠️ Module broadcast template absent.");
          return true;
        }

        const { filePath } = await uploadCampaignImageBuffer({
          userId: "admin",
          buffer: buf,
          mimeType: mime,
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

  async function handleIncomingImage(from, msg) {
    const s = getSession(from);

    // ===============================
    // 1) Admin broadcast image
    // ===============================
    if (await handleAdminBroadcastImage(from, msg)) return true;

    // ===============================
    // 2) Logo profil
    // ===============================
    if (s.step === "profile" && s.profileStep === "logo") {
      await handleLogoImage(from, msg);
      return true;
    }

    const mediaId = msg?.image?.id;
    if (!mediaId) {
      await sendText(from, "❌ Image reçue mais sans media_id. Réessayez.");
      return true;
    }

    // ===============================
    // 3) Preuve recharge Orange Money
    // ===============================
    if (s.step === "recharge_proof") {
      let topup = null;

      if (s.pendingTopupId) {
        topup = await readTopup(s.pendingTopupId);
      }

      if (!topup) {
        topup = await getPendingTopupByWaId(from);
      }

      if (!topup) {
        await sendText(from, "❌ Aucune recharge en attente trouvée.");
        return true;
      }

      // Pour l’instant on garde une référence WhatsApp media.
      // Plus tard on pourra uploader vers Supabase Storage.
      const proofImageUrl = `whatsapp://media/${mediaId}`;

      const updated = await markTopupProofImageReceived(topup.id, proofImageUrl);

      await sendText(
        from,
        "⏳ Capture reçue.\n\nVotre recharge est en attente de validation.\nVous recevrez un message dès que ce sera validé."
      );

      await notifyAdminTopupReview(from, updated, "image");
      return true;
    }

    // ===============================
    // 4) OCR document
    // ===============================
    s.pendingOcrMediaId = mediaId;

    await sendButtons(from, "📷 Photo reçue. Générer quel document ?", [
      { id: "OCR_DEVIS", title: "Devis" },
      { id: "OCR_FACTURE", title: "Facture" },
      { id: "OCR_RECU", title: "Reçu" },
    ]);

    return true;
  }

  return {
    handleIncomingImage,
    handleAdminBroadcastImage,
  };
}

module.exports = {
  makeKadiImageFlow,
};