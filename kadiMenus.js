"use strict";

function makeKadiMenus(deps) {
  const {
    sendButtons,
    sendList,
    getOrCreateProfile,
    STAMP_ONE_TIME_COST,
  } = deps;

  const DOC_CATALOG = [
    { id: "DOC_DEVIS", title: "Devis", desc: "Proposition de prix", kind: "devis" },
    { id: "DOC_FACTURE", title: "Facture", desc: "Facture client", kind: "facture" },
    { id: "DOC_RECU", title: "Reçu", desc: "Reçu de paiement", kind: "recu" },
    { id: "DOC_DECHARGE", title: "Décharge", desc: "Décharge simple", kind: "decharge" },
  ];

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

  async function sendHomeMenu(to) {
    return sendButtons(to, "🏠 *Menu KADI* — choisissez :", [
      { id: "HOME_DOCS", title: "Documents" },
      { id: "HOME_CREDITS", title: "Crédits" },
      { id: "HOME_PROFILE", title: "Profil" },
    ]);
  }

  async function sendDocsMenu(to) {
    const canList = typeof sendList === "function";

    if (!canList) {
      return sendButtons(to, "📄 Quel document voulez-vous créer ?", [
        { id: "DOC_DEVIS", title: "Devis" },
        { id: "DOC_FACTURE", title: "Facture" },
        { id: "DOC_RECU", title: "Reçu" },
        { id: "DOC_DECHARGE", title: "Décharge" },
      ]);
    }

    const rows = DOC_CATALOG.map((d) => ({
      id: d.id,
      title: d.title,
      description: d.desc || "",
    }));

    return sendList(to, {
      header: "Documents",
      body: "Quel document voulez-vous créer ?",
      buttonText: "Choisir",
      sections: [{ title: "Création de documents", rows }],
    });
  }

  async function sendFactureKindMenu(to) {
    return sendButtons(to, "🧾 Quel type de facture ?", [
      { id: "FAC_PROFORMA", title: "Pro forma" },
      { id: "FAC_DEFINITIVE", title: "Définitive" },
      { id: "BACK_DOCS", title: "Retour" },
    ]);
  }

  async function sendCreditsMenu(to) {
    return sendButtons(to, "💳 Crédits KADI", [
      { id: "CREDITS_SOLDE", title: "Voir solde" },
      { id: "CREDITS_RECHARGE", title: "Acheter pack" },
      { id: "BACK_HOME", title: "Menu" },
    ]);
  }

  async function sendProfileMenu(to) {
    return sendButtons(to, "🏢 Profil entreprise", [
      { id: "PROFILE_EDIT", title: "Configurer" },
      { id: "PROFILE_STAMP", title: "Tampon" },
      { id: "BACK_HOME", title: "Menu" },
    ]);
  }

  async function sendAfterProductMenu(to) {
    return sendButtons(to, "✅ Produit ajouté. Que faire ?", [
      { id: "DOC_ADD_MORE", title: "➕ Nouveau produit" },
      { id: "DOC_FINISH", title: "✅ Terminer" },
      { id: "DOC_CANCEL", title: "❌ Annuler" },
    ]);
  }

  async function sendPreviewMenu(to) {
    return sendButtons(to, "✅ Valider le document ?", [
      { id: "DOC_CONFIRM", title: "✅ Continuer" },
      { id: "DOC_ADD_MORE", title: "➕ Nouveau produit" },
      { id: "DOC_CANCEL", title: "❌ Annuler" },
    ]);
  }

  async function sendReceiptFormatMenu(to) {
    const text =
      "🧾 *Reçu*\n\n" +
      "Quel format voulez-vous ?\n\n" +
      "• 🧾 Ticket → petit format, facile à envoyer\n" +
      "• 📄 A4 → format professionnel complet";

    return sendButtons(to, text, [
      { id: "RECEIPT_FORMAT_COMPACT", title: "🧾 Ticket" },
      { id: "RECEIPT_FORMAT_A4", title: "📄 A4" },
      { id: "BACK_DOCS", title: "🔙 Retour" },
    ]);
  }

  async function sendStampMenu(to) {
    const p = await getOrCreateProfile(to);

    const enabled = p?.stamp_enabled === true;
    const paid = p?.stamp_paid === true;

    const pos = p?.stamp_position || "bottom-right";
    const size = p?.stamp_size || 170;
    const title = p?.stamp_title || "—";

    const pricingLine = paid
      ? `💳 Prix: *Payé ✅* (tampon gratuit sur tous vos PDF)`
      : `💳 Prix: *${STAMP_ONE_TIME_COST} crédits (paiement unique)*`;

    const header =
      `🟦 *Tampon (PDF)*\n\n` +
      `• Statut : *${enabled ? "ON ✅" : "OFF ❌"}*\n` +
      `• Paiement : *${paid ? "OK ✅" : "Non ❌"}*\n` +
      `• Fonction : *${title}*\n` +
      `• Position : *${stampPosLabel(pos)}*\n` +
      `• Taille : *${stampSizeLabel(size)}*\n\n` +
      `${pricingLine}`;

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

  return {
    DOC_CATALOG,
    stampPosLabel,
    stampSizeLabel,
    sendHomeMenu,
    sendDocsMenu,
    sendFactureKindMenu,
    sendCreditsMenu,
    sendProfileMenu,
    sendAfterProductMenu,
    sendPreviewMenu,
    sendReceiptFormatMenu,
    sendStampMenu,
    sendStampMoreMenu,
    sendStampPositionMenu,
    sendStampPositionMenu2,
    sendStampSizeMenu,
  };
}

module.exports = {
  makeKadiMenus,
};