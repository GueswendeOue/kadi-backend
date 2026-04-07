"use strict";

function makeKadiMenus(deps) {
  const {
    sendButtons,
    sendList,
    getOrCreateProfile,
    STAMP_ONE_TIME_COST,
  } = deps;

  // ======================================================
  // HOME MENU
  // ======================================================
  async function sendHomeMenu(to) {
    return sendList(to, {
      body: "👋 Bienvenue dans le menu KADI",
      buttonText: "Ouvrir le menu",
      footer: "Appuyez sur un élément pour le sélectionner",
      sections: [
        {
          title: "Documents",
          rows: [
            {
              id: "DOC_FACTURE_MENU",
              title: "📄 Facture",
              description: "Créer une nouvelle facture",
            },
            {
              id: "DOC_DEVIS",
              title: "📋 Devis",
              description: "Créer un nouveau devis",
            },
            {
              id: "DOC_RECU",
              title: "🧾 Reçu",
              description: "Créer un nouveau reçu",
            },
            {
              id: "DOC_DECHARGE",
              title: "📝 Décharge",
              description: "Créer une décharge officielle",
            },
          ],
        },
        {
          title: "Compte",
          rows: [
            {
              id: "CREDITS_SOLDE",
              title: "💳 Crédits",
              description: "Voir mon solde actuel",
            },
            {
              id: "CREDITS_RECHARGE",
              title: "🔄 Recharger",
              description: "Acheter des crédits",
            },
            {
              id: "HOME_PROFILE",
              title: "🏢 Profil",
              description: "Voir ou modifier mon profil",
            },
            {
              id: "HOME_HISTORY",
              title: "📚 Historique",
              description: "Voir mes derniers documents",
            },
          ],
        },
        {
          title: "Assistance",
          rows: [
            {
              id: "HOME_TUTORIAL",
              title: "📘 Tutoriel",
              description: "Guide pas à pas",
            },
            {
              id: "HOME_HELP",
              title: "❓ Aide rapide",
              description: "Exemples et commandes",
            },
          ],
        },
      ],
    });
  }

  // ======================================================
  // DOCS MENU
  // ======================================================
  async function sendDocsMenu(to) {
    return sendList(to, {
      body: "Choisissez le type de document",
      buttonText: "Choisir",
      footer: "Sélectionnez un document",
      sections: [
        {
          title: "Documents",
          rows: [
            {
              id: "DOC_FACTURE_MENU",
              title: "📄 Facture",
              description: "Définitive ou proforma",
            },
            {
              id: "DOC_DEVIS",
              title: "📋 Devis",
              description: "Créer un nouveau devis",
            },
            {
              id: "DOC_RECU",
              title: "🧾 Reçu",
              description: "Créer un nouveau reçu",
            },
            {
              id: "DOC_DECHARGE",
              title: "📝 Décharge",
              description: "Créer une décharge officielle",
            },
          ],
        },
      ],
    });
  }

  // ======================================================
  // FACTURE CATALOG MENU
  // ======================================================
  async function sendFactureCatalogMenu(to) {
    return sendList(to, {
      body: "Choisissez le type de facture",
      buttonText: "Choisir",
      footer: "Sélectionnez une option",
      sections: [
        {
          title: "Factures",
          rows: [
            {
              id: "FAC_DEFINITIVE",
              title: "✅ Définitive",
              description: "Facture finale pour le client",
            },
            {
              id: "FAC_PROFORMA",
              title: "📄 Proforma",
              description: "Facture provisoire avant validation",
            },
            {
              id: "BACK_HOME",
              title: "⬅️ Retour menu",
              description: "Revenir au menu principal",
            },
          ],
        },
      ],
    });
  }

  // ======================================================
  // CREDITS MENU
  // ======================================================
  async function sendCreditsMenu(to) {
    return sendButtons(
      to,
      `💳 *Crédits KADI*\n\nConsultez votre solde ou rechargez 👇`,
      [
        { id: "CREDITS_SOLDE", title: "💰 Mon solde" },
        { id: "CREDITS_RECHARGE", title: "🔄 Recharger" },
        { id: "BACK_HOME", title: "🏠 Menu" },
      ]
    );
  }

  // ======================================================
  // PROFILE MENU
  // ======================================================
  async function sendProfileMenu(to) {
    const p = await getOrCreateProfile(to);

    const stampStatus =
      p?.stamp_enabled === true
        ? "✅ Tampon activé"
        : p?.stamp_paid === true
        ? "🟨 Tampon disponible"
        : `🟦 Tampon — ${STAMP_ONE_TIME_COST ?? 15} crédits`;

    return sendButtons(
      to,
      `👤 *Profil entreprise*\n\n${stampStatus}\n\nGérez vos informations 👇`,
      [
        { id: "PROFILE_EDIT", title: "✏️ Modifier" },
        { id: "PROFILE_STAMP", title: "🟦 Tampon" },
        { id: "BACK_HOME", title: "🏠 Menu" },
      ]
    );
  }

  // ======================================================
  // FACTURE KIND MENU
  // ======================================================
  async function sendFactureKindMenu(to) {
    return sendButtons(
      to,
      `📄 *Type de facture*\n\nChoisissez une option 👇`,
      [
        { id: "FAC_DEFINITIVE", title: "✅ Définitive" },
        { id: "FAC_PROFORMA", title: "📄 Proforma" },
        { id: "BACK_HOME", title: "🏠 Menu" },
      ]
    );
  }

  // ======================================================
  // PREVIEW MENU
  // ======================================================
  async function sendPreviewMenu(to) {
    return sendButtons(
      to,
      `📄 *Vérifiez votre document*\n\nTout est correct ?`,
      [
        { id: "DOC_CONFIRM", title: "📤 Envoyer PDF" },
        { id: "DOC_ADD_MORE", title: "✏️ Modifier" },
        { id: "DOC_CANCEL", title: "🏠 Menu" },
      ]
    );
  }

  // ======================================================
  // AFTER PRODUCT MENU
  // ======================================================
  async function sendAfterProductMenu(to) {
    return sendButtons(
      to,
      "Que voulez-vous faire ?",
      [
        { id: "DOC_ADD_MORE", title: "➕ Ajouter" },
        { id: "DOC_FINISH", title: "✅ Terminer" },
        { id: "DOC_CANCEL", title: "🏠 Menu" },
      ]
    );
  }

  // ======================================================
  // RECEIPT FORMAT MENU
  // ======================================================
  async function sendReceiptFormatMenu(to) {
    return sendButtons(
      to,
      `🧾 *Format du reçu*\n\nChoisissez une option 👇`,
      [
        { id: "RECEIPT_FORMAT_COMPACT", title: "🎫 Ticket" },
        { id: "RECEIPT_FORMAT_A4", title: "📄 A4" },
        { id: "BACK_HOME", title: "🏠 Menu" },
      ]
    );
  }

  // ======================================================
  // STAMP MENUS
  // ======================================================
  async function sendStampMenu(to) {
    return sendButtons(
      to,
      `🟦 *Tampon officiel*\n\nLe tampon est ajouté sur vos PDF.`,
      [
        { id: "STAMP_TOGGLE", title: "✅ Activer" },
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
        { id: "STAMP_EDIT_TITLE", title: "✏️ Titre" },
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
        { id: "PROFILE_STAMP", title: "🟦 Retour" },
        { id: "BACK_HOME", title: "🏠 Menu" },
      ]
    );
  }

  async function sendStampSizeMenu(to) {
    return sendButtons(
      to,
      `📏 *Taille du tampon*`,
      [
        { id: "STAMP_SIZE_S", title: "S — Petit" },
        { id: "STAMP_SIZE_M", title: "M — Moyen" },
        { id: "STAMP_SIZE_L", title: "L — Grand" },
      ]
    );
  }

  // ======================================================
  // PRE-GENERATE STAMP
  // ======================================================
  async function sendPreGenerateStampMenu(to) {
    return sendButtons(
      to,
      `🟦 *Ajouter le tampon ?*\n\nLe tampon rend votre document plus crédible.`,
      [
        { id: "PRESTAMP_ADD_ONCE", title: "🟦 Oui" },
        { id: "PRESTAMP_SKIP", title: "⏭️ Ignorer" },
        { id: "DOC_CANCEL", title: "🏠 Menu" },
      ]
    );
  }

  // ======================================================
  // ALREADY GENERATED
  // ======================================================
  async function sendAlreadyGeneratedMenu(to) {
    return sendButtons(
      to,
      `📄 *Ce document existe déjà.*\n\nQue voulez-vous faire ?`,
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
    sendFactureCatalogMenu,
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