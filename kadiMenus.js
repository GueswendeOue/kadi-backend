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

  function hasGeneratedPdf(draft) {
    return !!String(draft?.savedPdfMediaId || "").trim();
  }

  function clip(value = "", max = 24) {
    return String(value || "").trim().slice(0, max);
  }

  async function sendHomeMenu(to) {
    return sendList(to, {
      body:
        "👋 Bienvenue sur KADI\n\n" +
        "Choisissez l’action la plus simple pour commencer.",
      buttonText: "Ouvrir",
      footer: "Créez un document ou envoyez une photo",
      sections: [
        {
          title: "Commencer",
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
              id: "HOME_OCR",
              title: "📷 Photo / OCR",
              description: "Transformer une photo en document",
            },
            {
              id: "HOME_HISTORY",
              title: "📚 Historique",
              description: "Voir vos documents récents",
            },
          ],
        },
        {
          title: "Compte",
          rows: [
            {
              id: "CREDITS_SOLDE",
              title: "💳 Crédits",
              description: "Voir votre solde",
            },
            {
              id: "CREDITS_RECHARGE",
              title: "🔄 Recharger",
              description: "Acheter des crédits",
            },
            {
              id: "HOME_PROFILE",
              title: "🏢 Profil",
              description: "Voir ou modifier votre profil",
            },
          ],
        },
        {
          title: "Plus",
          rows: [
            {
              id: "DOC_DECHARGE",
              title: "📝 Décharge",
              description: "Créer une décharge",
            },
            {
              id: "HOME_HELP",
              title: "❓ Aide",
              description: "Exemples et aide rapide",
            },
          ],
        },
      ],
    });
  }

  async function sendDocsMenu(to) {
    return sendList(to, {
      body:
        "📄 Choisissez le type de document à créer.\n\n" +
        "Vous pouvez aussi envoyer directement une photo ou écrire votre demande.",
      buttonText: "Choisir",
      footer: "Sélectionnez une option",
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
              id: "HOME_OCR",
              title: "📷 Photo / OCR",
              description: "Lire une photo et préparer un document",
            },
            {
              id: "DOC_DECHARGE",
              title: "📝 Décharge",
              description: "Créer une décharge",
            },
            {
              id: "DOC_FEC",
              title: "⚡ FEC",
              description: "Facture Électronique Certifiée",
            },
          ],
        },
      ],
    });
  }

  async function sendFactureCatalogMenu(to) {
    return sendList(to, {
      body:
        "📄 Choisissez le type de facture.\n\n" +
        "Sélectionnez l’option qui correspond à votre besoin.",
      buttonText: "Choisir",
      footer: "Facture définitive ou proforma",
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

  async function sendCreditsMenu(to) {
    return sendButtons(
      to,
      "💳 *Crédits KADI*\n\nConsultez votre solde ou rechargez votre compte 👇",
      [
        { id: "CREDITS_SOLDE", title: "💰 Solde" },
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
        : `🟦 Tampon — ${STAMP_ONE_TIME_COST ?? 15} crédits`;

    return sendButtons(
      to,
      `👤 *Profil entreprise*\n\n${stampStatus}\n\nGérez vos informations ci-dessous 👇`,
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
      "📄 *Type de facture*\n\nChoisissez une option 👇",
      [
        { id: "FAC_DEFINITIVE", title: "✅ Définitive" },
        { id: "FAC_PROFORMA", title: "📄 Proforma" },
        { id: "BACK_HOME", title: "🏠 Menu" },
      ]
    );
  }

  async function sendPreviewMenu(to, draft = null) {
    const subjectExists = hasSubject(draft);
    const phoneExists = hasClientPhone(draft);
    const pdfExists = hasGeneratedPdf(draft);

    if (typeof sendList !== "function") {
      return sendButtons(
        to,
        "📄 *Vérifiez votre document*\n\nVous pouvez générer le PDF ou ajouter un détail.",
        [
          { id: "DOC_CONFIRM", title: "📤 PDF" },
          { id: "DOC_ADD_MORE", title: "➕ Ajouter" },
          { id: "DOC_CANCEL", title: "🏠 Menu" },
        ]
      );
    }

    const enrichRows = [
      {
        id: "DOC_ADD_SUBJECT",
        title: subjectExists ? "📝 Modifier objet" : "📝 Ajouter objet",
        description: subjectExists
          ? "Mettre à jour l’objet du document"
          : "Ajouter un objet au document",
      },
      {
        id: "DOC_ADD_CLIENT_PHONE",
        title: phoneExists ? "📱 Modifier n° client" : "📱 Ajouter n° client",
        description: phoneExists
          ? "Mettre à jour le numéro du client"
          : "Ajouter le numéro du client",
      },
    ];

    const clientRows =
      phoneExists && pdfExists
        ? [
            {
              id: "DOC_SEND_TO_CLIENT",
              title: "📨 Envoyer au client",
              description: "Envoyer ce PDF au numéro du client",
            },
          ]
        : [];

    const sections = [
      {
        title: "Actions",
        rows: [
          {
            id: "DOC_CONFIRM",
            title: "📤 Générer PDF",
            description: "Générer et envoyer le PDF maintenant",
          },
          {
            id: "DOC_ADD_MORE",
            title: "➕ Ajouter ligne",
            description: "Ajouter une nouvelle ligne",
          },
          {
            id: "DOC_EDIT_TEXT",
            title: "✍️ Corriger texte",
            description: "Recevoir le document en texte puis corriger",
          },
        ],
      },
      {
        title: "Compléments",
        rows: enrichRows,
      },
    ];

    if (clientRows.length) {
      sections.push({
        title: "Client",
        rows: clientRows,
      });
    }

    sections.push({
      title: "Navigation",
      rows: [
        {
          id: "DOC_CANCEL",
          title: "🏠 Menu",
          description: "Quitter et revenir au menu",
        },
      ],
    });

    return sendList(to, {
      body:
        "📄 Vérifiez votre document\n\n" +
        "S’il est correct, générez le PDF maintenant.",
      buttonText: "Choisir",
      footer: "Vous pouvez aussi enrichir le document avant génération",
      sections,
    });
  }

  async function sendAfterProductMenu(to, draft = null) {
    void draft;

    return sendButtons(to, "Que voulez-vous faire maintenant ?", [
      { id: "DOC_ADD_MORE", title: "➕ Ajouter" },
      { id: "DOC_FINISH", title: "📄 Aperçu" },
      { id: "DOC_CANCEL", title: "🏠 Menu" },
    ]);
  }

  async function sendReceiptFormatMenu(to) {
    return sendButtons(
      to,
      "🧾 *Format du reçu*\n\nChoisissez une option 👇",
      [
        { id: "RECEIPT_FORMAT_COMPACT", title: "🎫 Ticket" },
        { id: "RECEIPT_FORMAT_A4", title: "📄 A4" },
        { id: "BACK_HOME", title: "🏠 Menu" },
      ]
    );
  }

  async function sendStampMenu(to) {
    const p = await getOrCreateProfile(to);
    const isEnabled = p?.stamp_enabled === true;

    return sendButtons(
      to,
      `🟦 *Tampon officiel*\n\n` +
        `${isEnabled ? "Statut : activé" : "Statut : désactivé"}\n\n` +
        `Le tampon peut être ajouté sur vos documents PDF.`,
      [
        {
          id: "STAMP_TOGGLE",
          title: isEnabled ? "⛔ Désactiver" : "✅ Activer",
        },
        { id: "STAMP_MORE", title: "⚙️ Options" },
        { id: "BACK_HOME", title: "🏠 Menu" },
      ]
    );
  }

  async function sendStampMoreMenu(to) {
    return sendButtons(
      to,
      "⚙️ *Options du tampon*\n\nChoisissez ce que vous voulez modifier.",
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
      "📍 *Position du tampon*\n\nChoisissez une position.",
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
      "📍 *Autre position*\n\nChoisissez une autre position.",
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
      "📏 *Taille du tampon*\n\nChoisissez la taille.",
      [
        { id: "STAMP_SIZE_S", title: "S — Petit" },
        { id: "STAMP_SIZE_M", title: "M — Moyen" },
        { id: "STAMP_SIZE_L", title: "L — Grand" },
      ]
    );
  }

  async function sendPreGenerateStampMenu(to) {
    return sendButtons(
      to,
      "🟦 *Ajouter le tampon ?*\n\nLe tampon rend votre document plus crédible.",
      [
        { id: "PRESTAMP_ADD_ONCE", title: "🟦 Oui" },
        { id: "PRESTAMP_SKIP", title: "⏭️ Ignorer" },
        { id: "DOC_CANCEL", title: "🏠 Menu" },
      ]
    );
  }

  async function sendAlreadyGeneratedMenu(to, draft = null) {
    const hasPhone = hasClientPhone(draft);
    const hasPdf = hasGeneratedPdf(draft);

    if (hasPhone && hasPdf) {
      return sendButtons(
        to,
        "📄 *Ce document existe déjà.*\n\nQue voulez-vous faire ?",
        [
          { id: "DOC_SEND_TO_CLIENT", title: "📨 Client" },
          { id: "DOC_EDIT_AFTER_GENERATED", title: "✏️ Modifier" },
          { id: "DOC_CANCEL", title: "🏠 Menu" },
        ]
      );
    }

    return sendButtons(
      to,
      "📄 *Ce document existe déjà.*\n\nQue voulez-vous faire ?",
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