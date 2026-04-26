"use strict";

function makeKadiStampFlow(deps) {
  const {
    getSession,
    sendText,
    sendButtons,
    getOrCreateProfile,
    updateProfile,
  } = deps;

  function hasStampProfileReady(profile) {
    return !!(
      String(profile?.business_name || "").trim() &&
      String(profile?.phone || "").trim() &&
      String(profile?.stamp_title || "").trim()
    );
  }

  function resetStampChoice(session) {
    if (!session) return;
    session.addStampForNextDoc = false;
    session.stampMode = null;
  }

  function buildPreGenerateStampMessage({ baseCost = 1 } = {}) {
    const base = Math.max(1, Number(baseCost) || 1);
    const withStamp = base + 1;

    return (
      "📄 *Votre document est prêt.*\n\n" +
      "🟦 Votre tampon est activé dans le profil.\n\n" +
      `• Générer *avec tampon* : *${withStamp} crédits*\n` +
      `• Générer *sans tampon* : *${base} crédit(s)*\n\n` +
      "Le tampon ajoute *+1 crédit* sur ce PDF."
    );
  }

  async function sendPreGenerateStampMenu(to, opts = {}) {
    const text = buildPreGenerateStampMessage(opts);

    return sendButtons(to, text, [
      { id: "PRESTAMP_ADD_ONCE", title: "Avec tampon" },
      { id: "PRESTAMP_SKIP", title: "Sans tampon" },
      { id: "PROFILE_STAMP", title: "Modifier" },
    ]);
  }

  function stampPosLabel(pos) {
    if (pos === "bottom-left") return "Bas gauche";
    if (pos === "top-right") return "Haut droite";
    if (pos === "top-left") return "Haut gauche";
    return "Bas droite";
  }

  function stampSizeLabel(size) {
    const n = Number(size || 170);
    if (n <= 150) return "Petit";
    if (n >= 200) return "Grand";
    return "Normal";
  }

  async function sendStampMenu(to) {
    const p = await getOrCreateProfile(to);

const enabled = p?.stamp_enabled === true;
    const pos = p?.stamp_position || "bottom-right";
    const size = p?.stamp_size || 170;
    const title = p?.stamp_title || "—";
    const ready = hasStampProfileReady(p);

    const header =
      `🟦 *Tampon (PDF)*\n\n` +
      `• Statut : *${enabled ? "ON ✅" : "OFF ❌"}*\n` +
      `• Fonction : *${title}*\n` +
      `• Position : *${stampPosLabel(pos)}*\n` +
      `• Taille : *${stampSizeLabel(size)}*\n` +
      `• Profil prêt : *${ready ? "Oui ✅" : "Non ❌"}*\n\n` +
      `💳 Le tampon est proposé avant génération à *+1 crédit par document*.`;

    return sendButtons(to, header + "\n\n👇 Choisissez :", [
      { id: "STAMP_TOGGLE", title: enabled ? "Désactiver" : "Activer" },
      { id: "STAMP_EDIT_TITLE", title: "Fonction" },
      { id: "STAMP_MORE", title: "Position/Taille" },
      { id: "BACK_HOME", title: "Menu" },
    ]);
  }

  async function sendStampMoreMenu(to) {
    const p = await getOrCreateProfile(to);
    const pos = p?.stamp_position || "bottom-right";
    const size = p?.stamp_size || 170;

    const txt =
      `🟦 *Réglages tampon*\n\n` +
      `• Position : *${stampPosLabel(pos)}*\n` +
      `• Taille : *${stampSizeLabel(size)}*`;

    return sendButtons(to, txt + "\n\n👇 Choisissez :", [
      { id: "STAMP_POS", title: "Position" },
      { id: "STAMP_SIZE", title: "Taille" },
      { id: "PROFILE_STAMP", title: "Retour" },
    ]);
  }

  async function sendStampPositionMenu(to) {
    return sendButtons(to, "📍 *Position du tampon* :", [
      { id: "STAMP_POS_BR", title: "Bas droite" },
      { id: "STAMP_POS_TR", title: "Haut droite" },
      { id: "STAMP_MORE", title: "Retour" },
    ]);
  }

  async function sendStampPositionMenu2(to) {
    return sendButtons(to, "📍 *Position du tampon* (suite) :", [
      { id: "STAMP_POS_BL", title: "Bas gauche" },
      { id: "STAMP_POS_TL", title: "Haut gauche" },
      { id: "STAMP_MORE", title: "Retour" },
    ]);
  }

  async function sendStampSizeMenu(to) {
    return sendButtons(to, "📏 *Taille du tampon* :", [
      { id: "STAMP_SIZE_S", title: "Petit" },
      { id: "STAMP_SIZE_M", title: "Normal" },
      { id: "STAMP_SIZE_L", title: "Grand" },
    ]);
  }

  async function handleStampFlow(from, text) {
    const s = getSession(from);
    if (!s) return false;

    const t = String(text || "").trim();
    if (!t) return false;

    if (
      s.step === "stamp_title" ||
      s.step === "stamp_function" ||
      s.step === "stamp_role"
    ) {
      const value = t === "0" ? "" : t.slice(0, 40);

      await updateProfile(from, {
        stamp_title: value || null,
      });

      s.step = null;

      await sendText(
        from,
        value
          ? `✅ Fonction enregistrée : *${value}*`
          : "✅ Fonction du tampon effacée."
      );

      await sendStampMenu(from);
      return true;
    }

    return false;
  }

  return {
    hasStampProfileReady,
    resetStampChoice,
    buildPreGenerateStampMessage,
    sendPreGenerateStampMenu,
    stampPosLabel,
    stampSizeLabel,
    sendStampMenu,
    sendStampMoreMenu,
    sendStampPositionMenu,
    sendStampPositionMenu2,
    sendStampSizeMenu,
    handleStampFlow,
  };
}

module.exports = {
  makeKadiStampFlow,
};
