"use strict";

function makeKadiProfileFlow(deps) {
  const {
    getSession,
    sendText,
    getOrCreateProfile,
    updateProfile,
    getMediaInfo,
    downloadMediaToBuffer,
    uploadLogoBuffer,
    LIMITS,
    isValidEmail,
  } = deps;

  async function startProfileFlow(from) {
    const s = getSession(from);
    s.step = "profile";
    s.profileStep = "business_name";

    await getOrCreateProfile(from);

    await sendText(
      from,
      "🏢 *Profil entreprise*\n\n1/7 — Nom de l'entreprise ?\nEx: GUESWENDE Technologies\n\n📌 Tapez 0 pour ignorer."
    );
  }

  async function handleProfileAnswer(from, text) {
    const s = getSession(from);
    if (s.step !== "profile" || !s.profileStep) return false;

    const t = String(text || "").trim();
    const skip = t === "0";
    const step = s.profileStep;

    if (step === "business_name") {
      await updateProfile(from, { business_name: skip ? null : t });
      s.profileStep = "address";
      await sendText(from, "2/7 — Adresse ? (ou 0)");
      return true;
    }

    if (step === "address") {
      await updateProfile(from, { address: skip ? null : t });
      s.profileStep = "phone";
      await sendText(from, "3/7 — Téléphone pro ? (ou 0)");
      return true;
    }

    if (step === "phone") {
      await updateProfile(from, { phone: skip ? null : t });
      s.profileStep = "email";
      await sendText(from, "4/7 — Email ? (ou 0)");
      return true;
    }

    if (step === "email") {
      const email = skip ? null : t;

      if (email && !isValidEmail(email)) {
        await sendText(from, "❌ Format email invalide. Réessayez ou tapez 0.");
        return true;
      }

      await updateProfile(from, { email });
      s.profileStep = "ifu";
      await sendText(from, "5/7 — IFU ? (ou 0)");
      return true;
    }

    if (step === "ifu") {
      await updateProfile(from, { ifu: skip ? null : t });
      s.profileStep = "rccm";
      await sendText(from, "6/7 — RCCM ? (ou 0)");
      return true;
    }

    if (step === "rccm") {
      await updateProfile(from, { rccm: skip ? null : t });
      s.profileStep = "logo";
      await sendText(from, "7/7 — Envoyez votre logo en *image* (ou tapez 0)");
      return true;
    }

    if (step === "logo") {
      if (skip) {
        s.step = "idle";
        s.profileStep = null;
        await sendText(from, "✅ Profil enregistré (sans logo).");
        return true;
      }

      await sendText(from, "⚠️ Pour le logo, envoyez une *image*. Ou tapez 0.");
      return true;
    }

    return false;
  }

  async function handleLogoImage(from, msg) {
    const mediaId = msg?.image?.id;
    if (!mediaId) {
      await sendText(from, "❌ Image reçue mais sans media_id. Réessayez.");
      return true;
    }

    const info = await getMediaInfo(mediaId);

    if (info?.file_size && info.file_size > LIMITS.maxImageSize) {
      await sendText(from, "❌ Image trop grande. Envoyez une image plus légère.");
      return true;
    }

    const mime = info?.mime_type || "image/jpeg";
    const buf = await downloadMediaToBuffer(info.url);

    const { filePath } = await uploadLogoBuffer({
      userId: from,
      buffer: buf,
      mimeType: mime,
    });

    await updateProfile(from, { logo_path: filePath });

    const s = getSession(from);

    if (s.step === "profile" && s.profileStep === "logo") {
      s.step = "idle";
      s.profileStep = null;
      await sendText(from, "✅ Logo enregistré. Profil terminé.");
      return true;
    }

    await sendText(from, "✅ Logo enregistré.");
    return true;
  }

  return {
    startProfileFlow,
    handleProfileAnswer,
    handleLogoImage,
  };
}

module.exports = {
  makeKadiProfileFlow,
};