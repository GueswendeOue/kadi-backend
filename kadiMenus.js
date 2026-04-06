"use strict";

function makeKadiMenus(deps) {
  const {
    sendButtons,
    getOrCreateProfile,
  } = deps;

  // ===============================
  // HOME MENU (ENTRY POINT)
  // ===============================
  async function sendHomeMenu(to) {
    return sendButtons(
      to,
      `👋 *KADI*\n\n` +
        `Devis · Facture · Reçu · Décharge\n` +
        `PDF en 30 secondes ⚡\n\n` +
        `👉 Écrivez directement :\n` +
        `"Devis Moussa 15000"\n\n` +
        `Ou choisissez 👇`,
      [
        { id: "HOME_DOCS", title: "📄 Créer document" },
        { id: "HOME_OCR", title: "📷 Transformer photo" },
        { id: "HOME_CREDITS", title: "💳 Crédits" },
      ]
    );
  }

  // ===============================
  // DOCUMENTS MENU (CORE PRODUCT)
  // ===============================
  async function sendDocsMenu(to) {
    return sendButtons(
      to,
      `📄 *Créer un document*\n\n` +
        `Choisissez le type 👇`,
      [
        { id: "DOC_DEVIS", title: "📋 Devis" },
        { id: "DOC_FACTURE", title: "🧾 Facture" },
        { id: "DOC_RECU", title: "✅ Reçu" },
        { id: "DOC_DECHARGE", title: "📝 Décharge" },
      ]
    );
  }

  // ===============================
  // CREDITS MENU
  // ===============================
  async function sendCreditsMenu(to) {
    return sendButtons(
      to,
      `💳 *Crédits KADI*\n\n` +
        `Consultez votre solde ou rechargez 👇`,
      [
        { id: "CREDITS_SOLDE", title: "💰 Mon solde" },
        { id: "CREDITS_RECHARGE", title: "➕ Recharger" },
        { id: "BACK_HOME", title: "🏠 Menu" },
      ]
    );
  }

  // ===============================
  // PROFILE MENU (SECONDARY)
  // ===============================
  async function sendProfileMenu(to) {
    return sendButtons(
      to,
      `👤 *Profil entreprise*\n\n` +
        `Gérez vos informations 👇`,
      [
        { id: "PROFILE_EDIT", title: "✏️ Modifier" },
        { id: "PROFILE_STAMP", title: "🟦 Tampon" },
        { id: "BACK_HOME", title: "🏠 Menu" },
      ]
    );
  }

  // ===============================
  // FACTURE TYPE
  // ===============================
  async function sendFactureKindMenu(to) {
    return sendButtons(
      to,
      `🧾 *Type de facture*\n\n` +
        `Choisissez 👇`,
      [
        { id: "FAC_DEFINITIVE", title: "✅ Définitive" },
        { id: "FAC_PROFORMA", title: "📄 Proforma" },
        { id: "BACK_DOCS", title: "⬅️ Retour" },
      ]
    );
  }

  // ===============================
  // PREVIEW MENU (IMPORTANT UX)
  // ===============================
  async function sendPreviewMenu(to) {
    return sendButtons(
      to,
      `📄 *Vérifiez votre document*\n\n` +
        `Tout est correct ? 👇`,
      [
        { id: "DOC_CONFIRM", title: "📤 Envoyer le PDF" },
        { id: "DOC_ADD_MORE", title: "✏️ Modifier" },
        { id: "DOC_CANCEL", title: "🏠 Menu" },
      ]
    );
  }

  // ===============================
  // AFTER ITEMS MENU
  // ===============================
  async function sendAfterProductMenu(to) {
    return sendButtons(
      to,
      `Que voulez-vous faire ?`,
      [
        { id: "DOC_ADD_MORE", title: "➕ Ajouter" },
        { id: "DOC_FINISH", title: "✅ Terminer" },
        { id: "DOC_CANCEL", title: "🏠 Menu" },
      ]
    );
  }

  // ===============================
  // RECEIPT FORMAT
  // ===============================
  async function sendReceiptFormatMenu(to) {
    return sendButtons(
      to,
      `🧾 *Format du reçu*\n\n` +
        `Choisissez 👇`,
      [
        { id: "RECEIPT_FORMAT_COMPACT", title: "🎫 Ticket" },
        { id: "RECEIPT_FORMAT_A4", title: "📄 A4" },
        { id: "BACK_DOCS", title: "⬅️ Retour" },
      ]
    );
  }

  // ===============================
  // STAMP MENU (TEMPORARY VERSION)
  // ===============================
  async function sendStampMenu(to) {
    return sendButtons(
      to,
      `🟦 *Tampon*\n\n` +
        `Configurez votre tampon 👇`,
      [
        { id: "STAMP_TOGGLE", title: "✅ Activer / Désactiver" },
        { id: "STAMP_MORE", title: "⚙️ Options" },
        { id: "BACK_HOME", title: "🏠 Menu" },
      ]
    );
  }

  async function sendStampMoreMenu(to) {
    return sendButtons(
      to,
      `⚙️ *Options du tampon*`,
      [
        { id: "STAMP_EDIT_TITLE", title: "✏️ Fonction" },
        { id: "STAMP_POS", title: "📍 Position" },
        { id: "STAMP_SIZE", title: "📏 Taille" },
      ]
    );
  }

  async function sendStampPositionMenu(to) {
    return sendButtons(
      to,
      `📍 *Position du tampon*`,
      [
        { id: "STAMP_POS_BR", title: "↘️ Bas droite" },
        { id: "STAMP_POS_BL", title: "↙️ Bas gauche" },
        { id: "STAMP_POS_TR", title: "↗️ Haut droite" },
      ]
    );
  }

  async function sendStampPositionMenu2(to) {
    return sendButtons(
      to,
      `📍 *Autre position*`,
      [
        { id: "STAMP_POS_TL", title: "↖️ Haut gauche" },
        { id: "PROFILE_STAMP", title: "🟦 Tampon" },
        { id: "BACK_HOME", title: "🏠 Menu" },
      ]
    );
  }

  async function sendStampSizeMenu(to) {
    return sendButtons(
      to,
      `📏 *Taille du tampon*`,
      [
        { id: "STAMP_SIZE_S", title: "S" },
        { id: "STAMP_SIZE_M", title: "M" },
        { id: "STAMP_SIZE_L", title: "L" },
      ]
    );
  }

  // ===============================
  // PRE-GENERATE STAMP (TEMP)
  // ===============================
  async function sendPreGenerateStampMenu(to) {
    return sendButtons(
      to,
      `🟦 Voulez-vous ajouter le tampon ?`,
      [
        { id: "PRESTAMP_ADD_ONCE", title: "🟦 Ajouter" },
        { id: "PRESTAMP_SKIP", title: "⏭️ Ignorer" },
        { id: "DOC_CANCEL", title: "🏠 Menu" },
      ]
    );
  }

  // ===============================
  // ALREADY GENERATED
  // ===============================
  async function sendAlreadyGeneratedMenu(to) {
    return sendButtons(
      to,
      `📄 Ce document existe déjà.\n\nQue faire ?`,
      [
        { id: "DOC_RESEND_LAST_PDF", title: "📩 Renvoyer" },
        { id: "DOC_EDIT_AFTER_GENERATED", title: "✏️ Modifier" },
        { id: "DOC_CANCEL", title: "🏠 Menu" },
      ]
    );
  }

  return {
    sendHomeMenu,
    sendDocsMenu,
    sendCreditsMenu,
    sendProfileMenu,
    sendFactureKindMenu,
    sendPreviewMenu,
    sendAfterProductMenu,
    sendReceiptFormatMenu,
    sendStampMenu,
    sendStampMoreMenu,
    sendStampPositionMenu,
    sendStampPositionMenu2,
    sendStampSizeMenu,
    sendPreGenerateStampMenu,
    sendAlreadyGeneratedMenu,
  };
}

module.exports = {
  makeKadiMenus,
};