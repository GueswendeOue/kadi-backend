"use strict";

function makeKadiMenus(deps) {
  const {
    sendButtons,
    sendList,
    getOrCreateProfile,
    STAMP_ONE_TIME_COST,
  } = deps;

  async function sendHomeMenu(to) {
    return sendList(to, {
      header: "👋 KADI",
      body:
        `Devis · Facture · Reçu · Décharge\n` +
        `PDF propre en quelques secondes ⚡\n\n` +
        `💬 Vous pouvez aussi écrire directement :\n` +
        `"Devis pour Moussa, 2 portes à 25000"`,
      buttonText: "Ouvrir le menu",
      footer: "Appuyez sur un élément pour le sélectionner",
      sections: [
        {
          title: "Documents",
          rows: [
            {
              id: "DOC_DEVIS",
              title: "📋 Devis",
              description: "Créer un nouveau devis",
            },
            {
              id: "DOC_FACTURE_MENU",
              title: "🧾 Facture",
              description: "Définitive ou proforma",
            },
            {
              id: "DOC_RECU",
              title: "✅ Reçu",
              description: "Créer un reçu",
            },
            {
              id: "DOC_DECHARGE",
              title: "📝 Décharge",
              description: "Créer une décharge",
            },
            {
              id: "HOME_OCR",
              title: "📷 Photo vers PDF",
              description: "Transformer une photo",
            },
          ],
        },
        {
          title: "Compte",
          rows: [
            {
              id: "CREDITS_SOLDE",
              title: "💰 Solde",
              description: "Voir mes crédits",
            },
            {
              id: "CREDITS_RECHARGE",
              title: "🔄 Recharger",
              description: "Acheter des crédits",
            },
            {
              id: "HOME_HISTORY",
              title: "📚 Historique",
              description: "Mes derniers documents",
            },
            {
              id: "HOME_PROFILE",
              title: "👤 Profil",
              description: "Voir ou modifier profil",
            },
          ],
        },
        {
          title: "Assistance",
          rows: [
            {
              id: "HOME_TUTORIAL",
              title: "📚 Exemples",
              description: "Voir des exemples",
            },
            {
              id: "HOME_HELP",
              title: "❓ Aide rapide",
              description: "Commandes utiles",
            },
          ],
        },
      ],
    });
  }

  async function sendDocsMenu(to) {
    return sendList(to, {
      header: "📄 Créer un document",
      body: "Choisissez le type de document 👇",
      buttonText: "Choisir",
      footer: "Sélectionnez un document",
      sections: [
        {
          title: "Documents",
          rows: [
            {
              id: "DOC_DEVIS",
              title: "📋 Devis",
              description: "Avant le travail",
            },
            {
              id: "DOC_FACTURE_MENU",
              title: "🧾 Facture",
              description: "Définitive ou proforma",
            },
            {
              id: "DOC_RECU",
              title: "✅ Reçu",
              description: "Pour un paiement reçu",
            },
            {
              id: "DOC_DECHARGE",
              title: "📝 Décharge",
              description: "Protection officielle",
            },
            {
              id: "HOME_OCR",
              title: "📷 Photo vers PDF",
              description: "Transformer une photo",
            },
          ],
        },
      ],
    });
  }

  async function sendFactureCatalogMenu(to) {
    return sendList(to, {
      header: "🧾 Facture",
      body: "Choisissez le type de facture 👇",
      buttonText: "Choisir",
      footer: "Sélectionnez un type",
      sections: [
        {
          title: "Types de facture",
          rows: [
            {
              id: "FAC_DEFINITIVE",
              title: "✅ Définitive",
              description: "Facture normale",
            },
            {
              id: "FAC_PROFORMA",
              title: "📄 Proforma",
              description: "Avant validation finale",
            },
            {
              id: "BACK_DOCS",
              title: "⬅️ Retour",
              description: "Revenir aux documents",
            },
          ],
        },
      ],
    });
  }

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

  async function sendProfileMenu(to) {
    const p = await getOrCreateProfile(to);

    const stampStatus =
      p?.stamp_enabled === true
        ? "✅ Tampon activé"
        : p?.stamp_paid === true
        ? "🟨 Tampon disponible"
        : `🟦 Tampon : ${STAMP_ONE_TIME_COST || 5} crédits`;

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

  async function sendFactureKindMenu(to) {
    return sendButtons(
      to,
      `🧾 *Type de facture*\n\nChoisissez 👇`,
      [
        { id: "FAC_DEFINITIVE", title: "✅ Définitive" },
        { id: "FAC_PROFORMA", title: "📄 Proforma" },
        { id: "BACK_DOCS", title: "⬅️ Retour" },
      ]
    );
  }

  async function sendPreviewMenu(to) {
    return sendButtons(
      to,
      `📄 *Vérifiez votre document*\n\nTout est correct ? 👇`,
      [
        { id: "DOC_CONFIRM", title: "📤 Envoyer PDF" },
        { id: "DOC_ADD_MORE", title: "✏️ Modifier" },
        { id: "DOC_CANCEL", title: "🏠 Menu" },
      ]
    );
  }

  async function sendAfterProductMenu(to) {
    return sendButtons(to, `Que voulez-vous faire ?`, [
      { id: "DOC_ADD_MORE", title: "➕ Ajouter" },
      { id: "DOC_FINISH", title: "✅ Terminer" },
      { id: "DOC_CANCEL", title: "🏠 Menu" },
    ]);
  }

  async function sendReceiptFormatMenu(to) {
    return sendButtons(
      to,
      `🧾 *Format du reçu*\n\nChoisissez 👇`,
      [
        { id: "RECEIPT_FORMAT_COMPACT", title: "🎫 Ticket" },
        { id: "RECEIPT_FORMAT_A4", title: "📄 A4" },
        { id: "BACK_DOCS", title: "⬅️ Retour" },
      ]
    );
  }

  async function sendStampMenu(to) {
    return sendButtons(
      to,
      `🟦 *Tampon officiel*\n\nConfigurez votre tampon 👇`,
      [
        { id: "STAMP_TOGGLE", title: "✅ Activer / Stop" },
        { id: "STAMP_MORE", title: "⚙️ Options" },
        { id: "BACK_HOME", title: "🏠 Menu" },
      ]
    );
  }

  async function sendStampMoreMenu(to) {
    return sendButtons(
      to,
      `⚙️ *Options du tampon*\n\nPersonnalisez votre tampon 👇`,
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
      `📍 *Position du tampon*\n\nChoisissez 👇`,
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
      `📏 *Taille du tampon*\n\nChoisissez 👇`,
      [
        { id: "STAMP_SIZE_S", title: "S - Petit" },
        { id: "STAMP_SIZE_M", title: "M - Moyen" },
        { id: "STAMP_SIZE_L", title: "L - Grand" },
      ]
    );
  }

  async function sendPreGenerateStampMenu(to) {
    return sendButtons(
      to,
      `🟦 *Ajouter le tampon ?*\n\nLe tampon rend votre document plus crédible.`,
      [
        { id: "PRESTAMP_ADD_ONCE", title: "🟦 Oui" },
        { id: "PRESTAMP_SKIP", title: "⏭️ Non" },
        { id: "DOC_CANCEL", title: "🏠 Menu" },
      ]
    );
  }

  async function sendAlreadyGeneratedMenu(to) {
    return sendButtons(
      to,
      `📄 *Ce document existe déjà.*\n\nQue souhaitez-vous faire ?`,
      [
        { id: "DOC_RESEND_LAST_PDF", title: "📩 Renvoyer" },
        { id: "DOC_EDIT_AFTER_GENERATED", title: "✏️ Modifier" },
        { id: "DOC_CANCEL", title: "🏠 Menu" },
      ]
    );
  }

  async function sendZeroCreditsBlock(to) {
    return sendButtons(
      to,
      `🔴 *Crédits épuisés.*\n\nRechargez pour continuer 👇`,
      [
        { id: "RECHARGE_1000", title: "1 000 F" },
        { id: "RECHARGE_2000", title: "2 000 F" },
        { id: "CREDITS_RECHARGE", title: "💳 Voir packs" },
      ]
    );
  }

  async function sendLowCreditsAlert(to, balance = 0) {
    return sendButtons(
      to,
      `⚠️ Il vous reste *${balance} crédit${balance > 1 ? "s" : ""}*.\n\nRechargez maintenant 👇`,
      [
        { id: "RECHARGE_1000", title: "1 000 F" },
        { id: "RECHARGE_2000", title: "2 000 F" },
        { id: "CREDITS_RECHARGE", title: "💳 Voir packs" },
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
    sendZeroCreditsBlock,
    sendLowCreditsAlert,
  };
}

module.exports = {
  makeKadiMenus,
};