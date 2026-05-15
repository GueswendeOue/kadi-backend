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
          title: "Menu principal",
          rows: [
            {
              id: "HOME_DOCS",
              title: "📄 Créer document",
              description: "Facture, devis, reçu, photo",
            },
            {
              id: "HOME_HISTORY",
              title: "📚 Historique",
              description: "Voir vos documents récents",
            },
            {
              id: "HOME_CREDITS",
              title: "💳 Crédits / Recharge",
              description: "Solde et achat de crédits",
            },
            {
              id: "HOME_PROFILE",
              title: "🏢 Profil",
              description: "Voir ou modifier votre profil",
            },
            {
              id: "PROFILE_STAMP",
              title: "🟦 Tampon",
              description: "Configurer votre tampon",
            },
            {
              id: "HOME_SUPPORT",
              title: "🆘 Support & assistance",
              description: "Aide, paiement, bug, support",
            },
          ],
        },
      ],
    });
  }

  async function sendSupportMenu(to) {
    return sendList(to, {
      body:
        "🆘 *Support & assistance Kadi*\n\n" +
        "Choisissez ce dont vous avez besoin.",
      buttonText: "Choisir",
      footer: "Aide, paiement, bug ou support",
      sections: [
        {
          title: "Assistance",
          rows: [
            {
              id: "SUPPORT_TUTORIAL",
              title: "Voir le tutoriel",
              description: "Exemples rapides pour utiliser Kadi",
            },
            {
              id: "SUPPORT_HUMAN",
              title: "Parler au support",
              description: "Être mis en relation avec Kadi",
            },
            {
              id: "SUPPORT_PAYMENT",
              title: "Problème paiement",
              description: "Recharge, crédits, Orange Money",
            },
            {
              id: "SUPPORT_BUG",
              title: "Signaler un bug",
              description: "Un blocage ou comportement anormal",
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
        ? "✅ Tampon prêt ou à compléter"
        : p?.stamp_paid === true
        ? "🟨 Tampon à configurer"
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
    const hasImage = !!String(p?.stamp_image_path || "").trim();
    const stampSource =
      p?.stamp_source === "generated"
        ? "Tampon Kadi"
        : hasImage
        ? "Mon tampon importé"
        : "Tampon Kadi";

    const body =
      `🟦 *Tampon officiel*\n\n` +
      `${
        hasImage || isEnabled
          ? "Statut : Tampon prêt"
          : "Statut : Tampon non configuré"
      }\n` +
      `Tampon utilisé : ${stampSource}\n\n` +
      `Le tampon peut être ajouté sur vos documents PDF.`;

    if (typeof sendList === "function") {
      return sendList(to, {
        body,
        buttonText: "Choisir",
        sections: [
          {
            title: "Actions",
            rows: [
              {
                id: "STAMP_UPLOAD_IMAGE",
                title: hasImage ? "Remplacer mon tampon" : "Envoyer mon tampon",
              },
              { id: "STAMP_USE_UPLOADED", title: "Utiliser mon tampon" },
              { id: "STAMP_USE_KADI", title: "Utiliser Tampon Kadi" },
              { id: "STAMP_MORE", title: "Position/Taille" },
            ],
          },
        ],
      });
    }

    return sendButtons(to, body, [
      { id: "STAMP_UPLOAD_IMAGE", title: hasImage ? "Remplacer" : "Envoyer" },
      { id: "STAMP_USE_KADI", title: "Tampon Kadi" },
      { id: "STAMP_MORE", title: "Position/Taille" },
    ]);
  }

  async function sendStampMoreMenu(to) {
    return sendButtons(
      to,
      "⚙️ *Options du tampon*\n\nChoisissez ce que vous voulez modifier.",
      [
        { id: "STAMP_POS", title: "📍 Position" },
        { id: "STAMP_SIZE", title: "📏 Taille" },
        { id: "PROFILE_STAMP", title: "🟦 Retour" },
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
    sendSupportMenu,
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
