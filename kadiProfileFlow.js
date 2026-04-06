"use strict";

function makeKadiProfileFlow(deps) {
  const {
    getSession,
    sendText,
    sendButtons,
    updateProfile,
    sendHomeMenu,
  } = deps;

  function isProfileComplete(p) {
    return (
      p?.business_name &&
      p?.phone &&
      (p?.logo_media_id || p?.logo_generated || p?.no_logo)
    );
  }

  async function startProfileFlow(from) {
    const s = getSession(from);
    s.step = "profile_name";

    return sendText(
      from,
      "🏢 Nom de ton entreprise ?\n(Ex: Faso Tech / Boutique Awa)"
    );
  }

  async function handleProfileText(from, text, message) {
    const s = getSession(from);

    // ===============================
    // NAME
    // ===============================
    if (s.step === "profile_name") {
      await updateProfile(from, {
        business_name: text.trim().slice(0, 60),
      });

      s.step = "profile_phone";

      return sendText(
        from,
        "📞 Numéro ou contact ?\n(Ex: 70 00 00 00)"
      );
    }

    // ===============================
    // PHONE
    // ===============================
    if (s.step === "profile_phone") {
      await updateProfile(from, {
        phone: text.trim().slice(0, 30),
      });

      s.step = "profile_logo_choice";

      return sendButtons(
        from,
        "🖼️ Logo de votre entreprise ?",
        [
          { id: "PROFILE_LOGO_UPLOAD", title: "📤 Envoyer logo" },
          { id: "PROFILE_LOGO_GENERATE", title: "✨ Créer logo" },
          { id: "PROFILE_LOGO_SKIP", title: "⏭️ Pas de logo" },
        ]
      );
    }

    // ===============================
    // LOGO UPLOAD
    // ===============================
    if (s.step === "profile_logo_upload" && message?.type === "image") {
      await updateProfile(from, {
        logo_media_id: message.image.id,
        no_logo: false,
      });

      return finishProfile(from, s);
    }

    // ===============================
    // LOGO GENERATE
    // ===============================
    if (s.step === "profile_logo_generate_name") {
      await updateProfile(from, {
        logo_text: text.trim().slice(0, 40),
        logo_generated: true,
        no_logo: false,
      });

      await sendText(
        from,
        "✨ Logo créé (version simple)."
      );

      return finishProfile(from, s);
    }

    return false;
  }

  async function handleProfileReply(from, replyId) {
    const s = getSession(from);

    if (replyId === "PROFILE_SETUP_START") {
      return startProfileFlow(from);
    }

    if (replyId === "PROFILE_LOGO_UPLOAD") {
      s.step = "profile_logo_upload";
      return sendText(from, "📤 Envoie ton logo (image)");
    }

    if (replyId === "PROFILE_LOGO_GENERATE") {
      s.step = "profile_logo_generate_name";
      return sendText(from, "✨ Nom du logo ?");
    }

    if (replyId === "PROFILE_LOGO_SKIP") {
      await updateProfile(from, { no_logo: true });
      return finishProfile(from, s);
    }

    return false;
  }

  async function finishProfile(from, s) {
    s.step = null;

    await sendText(
      from,
      "✅ Profil configuré !\n📄 Vos documents seront maintenant professionnels."
    );

    if (s.lastDocDraft) {
      return sendButtons(
        from,
        "📄 On reprend votre document 👇",
        [
          { id: "DOC_CONFIRM", title: "📤 Envoyer le PDF" },
          { id: "DOC_ADD_MORE", title: "✏️ Modifier" },
        ]
      );
    }

    return sendHomeMenu(from);
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