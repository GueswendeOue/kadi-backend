"use strict";

function makeKadiMenus(deps) {
  const {
    sendButtons,
    sendList,
    getOrCreateProfile,
    STAMP_ONE_TIME_COST,
  } = deps;

  function hasClientPhone(draft) {
    return !!String(draft?.clientPhone || "").trim();
  }

  function hasSubject(draft) {
    return !!String(draft?.subject || "").trim();
  }

  // ======================================================
  // HOME MENU
  // ======================================================
  async function sendHomeMenu(to) {
    return sendList(to, {
      body:
        "👋 Bienvenue dans le menu KADI\n\n" +
        "Choisissez simplement ce que vous voulez faire",
      buttonText: "Ouvrir le menu",
      footer: "Appuyez sur un élément pour continuer",
      sections: [
        {
          title: "Documents",
          rows: [
            {
              id: "DOC_FACTURE_MENU",
              title: "📄 Facture",
              description: "Créer une facture",
            },
            {
              id: "DOC_DEVIS",
              title: "📋 Devis",
              description: "Créer un devis",
            },
            {
              id: "DOC_RECU",
              title: "🧾 Reçu",
              description: "Créer un reçu",
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
              description: "Voir mon solde",
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
              description: "Voir mes documents récents",
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
              description: "Exemples et commandes utiles",
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
      body:
        "📄 Choisissez le type de document à créer\n\n" +
        "Vous pouvez aussi écrire votre demande directement à KADI.",
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
              description: "Préparer une offre",
            },
            {
              id: "DOC_RECU",
              title: "🧾 Reçu",
              description: "Confirmer un paiement",
            },
            {
              id: "DOC_DECHARGE",
              title: "📝 Décharge",
              description: "Créer une décharge",
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
      body:
        "📄 Choisissez le type de facture\n\n" +
        "Sélectionnez l’option qui correspond à votre besoin.",
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
      `💳 *Crédits KADI*\n\n` +
        `Consultez votre solde ou rechargez votre compte 👇`,
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
      `👤 *Profil entreprise*\n\n` +
        `${stampStatus}\n\n` +
        `Gérez vos informations ci-dessous 👇`,
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
      `📄 *Type de facture*\n\n` +
        `Choisissez une option 👇`,
      [
        { id: "FAC_DEFINITIVE", title: "✅ Définitive" },
        { id: "FAC_PROFORMA", title: "📄 Proforma" },
        { id: "BACK_HOME", title: "🏠 Menu" },
      ]
    );
  }

  // ======================================================
  // PREVIEW MENU
  // draft param optionnel, pour futurs boutons dynamiques
  // ======================================================
  async function sendPreviewMenu(to, draft = null) {
    const buttons = [
      { id: "DOC_CONFIRM", title: "📤 Envoyer PDF" },
      { id: "DOC_ADD_MORE", title: "✏️ Modifier" },
      { id: "DOC_CANCEL", title: "🏠 Menu" },
    ];

    // Future-ready:
    // si plus tard tu veux passer draft ici,
    // on peut choisir d’afficher autre chose selon clientPhone/subject.
    void draft;

    return sendButtons(
      to,
      `📄 *Vérifiez votre document*\n\n` +
        `Tout est correct ?`,
      buttons
    );
  }

  // ======================================================
  // AFTER PRODUCT MENU
  // draft param optionnel pour proposer les bons next steps
  // ======================================================
  async function sendAfterProductMenu(to, draft = null) {
    const hasSubj = hasSubject(draft);
    const hasPhone = hasClientPhone(draft);

    if (draft && !hasSubj) {
      return sendButtons(
        to,
        "Que voulez-vous faire maintenant ?",
        [
          { id: "DOC_ADD_MORE", title: "➕ Ajouter" },
          { id: "DOC_ADD_SUBJECT", title: "📝 Objet" },
          { id: "DOC_FINISH", title: "✅ Terminer" },
        ]
      );
    }

    if (draft && hasSubj && !hasPhone) {
      return sendButtons(
        to,
        "Que voulez-vous faire maintenant ?",
        [
          { id: "DOC_ADD_MORE", title: "➕ Ajouter" },
          { id: "DOC_ADD_CLIENT_PHONE", title: "📱 Client" },
          { id: "DOC_FINISH", title: "✅ Terminer" },
        ]
      );
    }

    return sendButtons(
      to,
      "Que voulez-vous faire maintenant ?",
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
      `🧾 *Format du reçu*\n\n` +
        `Choisissez une option 👇`,
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
      `🟦 *Tampon officiel*\n\n` +
        `Le tampon peut être ajouté sur vos documents PDF.`,
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
      `⚙️ *Options du tampon*\n\n` +
        `Choisissez ce que vous voulez modifier.`,
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
      `📍 *Position du tampon*\n\n` +
        `Choisissez une position.`,
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
      `📍 *Autre position*\n\n` +
        `Choisissez une autre position.`,
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
      `📏 *Taille du tampon*\n\n` +
        `Choisissez la taille.`,
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
      `🟦 *Ajouter le tampon ?*\n\n` +
        `Le tampon rend votre document plus crédible.`,
      [
        { id: "PRESTAMP_ADD_ONCE", title: "🟦 Oui" },
        { id: "PRESTAMP_SKIP", title: "⏭️ Ignorer" },
        { id: "DOC_CANCEL", title: "🏠 Menu" },
      ]
    );
  }

  // ======================================================
  // ALREADY GENERATED
  // draft param optionnel
  // ======================================================
  async function sendAlreadyGeneratedMenu(to, draft = null) {
    const buttons = [
      { id: "DOC_RESEND_LAST_PDF", title: "📩 Renvoyer" },
      { id: "DOC_EDIT_AFTER_GENERATED", title: "✏️ Modifier" },
      { id: "DOC_CANCEL", title: "🏠 Menu" },
    ];

    if (draft && hasClientPhone(draft)) {
      return sendButtons(
        to,
        `📄 *Ce document existe déjà.*\n\n` +
          `Que voulez-vous faire ?`,
        [
          { id: "DOC_RESEND_LAST_PDF", title: "📩 Renvoyer" },
          { id: "DOC_SEND_TO_CLIENT", title: "📨 Client" },
          { id: "DOC_CANCEL", title: "🏠 Menu" },
        ]
      );
    }

    return sendButtons(
      to,
      `📄 *Ce document existe déjà.*\n\n` +
        `Que voulez-vous faire ?`,
      buttons
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