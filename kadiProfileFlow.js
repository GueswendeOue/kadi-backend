"use strict";

function makeKadiProfileFlow(deps) {
  const {
    getSession,
    sendText,
    sendButtons,
    updateProfile,
    sendHomeMenu,
  } = deps;

  function cleanText(v, max = 80) {
    return String(v || "").trim().slice(0, max);
  }

  function isProfileComplete(p) {
    return !!(p?.business_name && p?.phone);
  }

  async function startProfileFlow(from) {
    const s = getSession(from);
    if (!s) return false;

    s.step = "profile_name";
    s.profileStep = null;

    await sendText(
      from,
      "🏢 Nom de votre entreprise ?\n(Ex: Faso Tech / Boutique Awa)"
    );

    return true;
  }

  async function handleProfileText(from, text, message) {
    const s = getSession(from);
    if (!s) return false;

    // ===============================
    // NAME
    // ===============================
    if (s.step === "profile_name") {
      const businessName = cleanText(text, 80);

      if (!businessName) {
        await sendText(
          from,
          "⚠️ Nom invalide.\nTapez le nom de votre entreprise."
        );
        return true;
      }

      await updateProfile(from, {
        business_name: businessName,
      });

      s.step = "profile_phone";

      await sendText(from, "📞 Numéro ou contact ?\n(Ex: 70 00 00 00)");
      return true;
    }

    // ===============================
    // PHONE
    // ===============================
    if (s.step === "profile_phone") {
      const phone = cleanText(text, 30);

      if (!phone) {
        await sendText(
          from,
          "⚠️ Contact invalide.\nTapez un numéro ou un contact."
        );
        return true;
      }

      await updateProfile(from, {
        phone,
      });

      s.step = "profile_logo_choice";
      s.profileStep = null;

      await sendButtons(from, "🖼️ Logo de votre entreprise ?", [
        { id: "PROFILE_LOGO_UPLOAD", title: "📤 Envoyer logo" },
        { id: "PROFILE_LOGO_SKIP", title: "⏭️ Pas de logo" },
      ]);

      return true;
    }

    // ===============================
    // LOGO UPLOAD TEXT FALLBACK
    // Image upload is handled in kadiImageFlow via profile_logo_upload.
    // ===============================
    if (s.step === "profile_logo_upload") {
      await sendText(
        from,
        "📤 Envoyez une image pour votre logo.\nOu tapez MENU pour annuler."
      );
      return true;
    }

    return false;
  }

  async function handleProfileReply(from, replyId) {
    const s = getSession(from);
    if (!s) return false;

    if (replyId === "PROFILE_SETUP_START") {
      return startProfileFlow(from);
    }

    if (replyId === "PROFILE_LOGO_UPLOAD") {
      s.step = "profile_logo_upload";
      s.profileStep = "logo";

      await sendText(
        from,
        "📤 Envoyez maintenant votre logo sous forme d’image."
      );

      return true;
    }

    if (replyId === "PROFILE_LOGO_SKIP") {
      s.step = null;
      s.profileStep = null;

      await sendText(
        from,
        "✅ Profil configuré sans logo.\nVous pourrez ajouter un logo plus tard depuis le menu Profil."
      );

      return finishProfile(from, s);
    }

    return false;
  }

  async function finishProfile(from, s) {
    s.step = null;
    s.profileStep = null;

    await sendText(
      from,
      "✅ Profil configuré !\n📄 Vos documents seront maintenant plus professionnels."
    );

    if (s.lastDocDraft) {
      await sendButtons(from, "📄 On reprend votre document 👇", [
        { id: "DOC_CONFIRM", title: "📤 Envoyer PDF" },
        { id: "DOC_ADD_MORE", title: "✏️ Modifier" },
      ]);

      return true;
    }

    await sendHomeMenu(from);
    return true;
  }

  return {
    startProfileFlow,
    handleProfileText,
    handleProfileReply,
    isProfileComplete,
  };
}

module.exports = {
  makeKadiProfileFlow,
};