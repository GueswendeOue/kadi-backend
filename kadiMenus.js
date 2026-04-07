"use strict";

function makeKadiMenus(deps) {
  const {
    sendButtons,
    sendList,
    getOrCreateProfile,
    STAMP_ONE_TIME_COST,
  } = deps;

  // ═══════════════════════════════════════════════════════════════════════
  // HOME MENU — visible, structuré, comme le concurrent mais plus complet
  // ═══════════════════════════════════════════════════════════════════════
  async function sendHomeMenu(to) {
    return sendList(
      to,
      "👋 *KADI*",
      `Choisissez une action.\n\n` +
        `💬 Vous pouvez aussi écrire directement :\n` +
        `_"Devis pour Moussa, 2 portes à 25 000F"_`,
      "Ouvrir le menu",
      [
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
              description: "Créer un nouveau reçu",
            },
            {
              id: "DOC_DECHARGE",
              title: "📝 Décharge",
              description: "Créer une décharge officielle",
            },
            {
              id: "HOME_OCR",
              title: "📷 Photo → PDF",
              description: "Transformer une photo en document",
            },
          ],
        },
        {
          title: "Compte",
          rows: [
            {
              id: "HOME_CREDITS",
              title: "💳 Crédits",
              description: "Voir mes crédits et recharger",
            },
            {
              id: "HOME_HISTORY",
              title: "📚 Historique",
              description: "Voir mes derniers documents",
            },
            {
              id: "HOME_PROFILE",
              title: "👤 Profil",
              description: "Voir ou modifier mon profil",
            },
          ],
        },
        {
          title: "Assistance",
          rows: [
            {
              id: "HOME_TUTORIAL",
              title: "📖 Tutoriel",
              description: "Guide pas à pas pour débutants",
            },
            {
              id: "HOME_HELP",
              title: "❓ Aide rapide",
              description: "Exemples et commandes",
            },
          ],
        },
      ]
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DOCS MENU — si tu veux ouvrir directement le catalogue documents
  // ═══════════════════════════════════════════════════════════════════════
  async function sendDocsMenu(to) {
    return sendList(
      to,
      "📄 *Créer un document*",
      `Choisissez le type de document à générer.\n\n` +
        `💡 Astuce : vous pouvez aussi écrire directement :\n` +
        `_"Devis pour Kaboré, 3 sacs de ciment à 7 500F"_`,
      "Choisir le document",
      [
        {
          title: "Documents disponibles",
          rows: [
            {
              id: "DOC_DEVIS",
              title: "📋 Devis",
              description: "Avant de commencer un travail",
            },
            {
              id: "DOC_FACTURE_MENU",
              title: "🧾 Facture",
              description: "Définitive ou proforma",
            },
            {
              id: "DOC_RECU",
              title: "✅ Reçu",
              description: "À chaque paiement reçu",
            },
            {
              id: "DOC_DECHARGE",
              title: "📝 Décharge",
              description: "Pour se protéger légalement",
            },
            {
              id: "HOME_OCR",
              title: "📷 Photo → PDF",
              description: "Transformer une photo en document",
            },
          ],
        },
      ]
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FACTURE SUBMENU — propre, simple
  // ═══════════════════════════════════════════════════════════════════════
  async function sendFactureCatalogMenu(to) {
    return sendList(
      to,
      "🧾 *Facture*",
      `Choisissez le type de facture à créer.`,
      "Choisir",
      [
        {
          title: "Types de facture",
          rows: [
            {
              id: "FAC_DEFINITIVE",
              title: "✅ Facture définitive",
              description: "Après livraison ou prestation",
            },
            {
              id: "FAC_PROFORMA",
              title: "📄 Facture proforma",
              description: "Avant validation du client",
            },
            {
              id: "BACK_DOCS",
              title: "⬅️ Retour",
              description: "Revenir au menu documents",
            },
          ],
        },
      ]
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CREDITS MENU
  // ═══════════════════════════════════════════════════════════════════════
  async function sendCreditsMenu(to) {
    return sendButtons(
      to,
      `💳 *Crédits KADI*\n\n` +
        `Consultez votre solde ou rechargez 👇`,
      [
        { id: "CREDITS_SOLDE", title: "💰 Mon solde" },
        { id: "CREDITS_RECHARGE", title: "🔄 Recharger" },
        { id: "BACK_HOME", title: "🏠 Menu" },
      ]
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PROFILE MENU
  // ═══════════════════════════════════════════════════════════════════════
  async function sendProfileMenu(to) {
    const p = await getOrCreateProfile(to);

    const hasBusinessName = !!p?.business_name;
    const hasPhone = !!p?.phone;
    const hasLogo = !!(p?.logo_media_id || p?.logo_generated || p?.no_logo);

    const score = [hasBusinessName, hasPhone, hasLogo].filter(Boolean).length;

    const stampStatus =
      p?.stamp_enabled === true
        ? "✅ Tampon activé"
        : p?.stamp_paid === true
        ? "🟨 Tampon disponible"
        : `🟦 Tampon — ${STAMP_ONE_TIME_COST ?? 5} crédits`;

    return sendButtons(
      to,
      `👤 *Profil entreprise*\n\n` +
        `Profil complété : ${score}/3\n` +
        `${stampStatus}\n\n` +
        `Gérez vos informations 👇`,
      [
        { id: "PROFILE_EDIT", title: "✏️ Modifier" },
        { id: "PROFILE_STAMP", title: "🟦 Tampon" },
        { id: "BACK_HOME", title: "🏠 Menu" },
      ]
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FACTURE KIND — fallback si utilisé ailleurs
  // ═══════════════════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════════════════
  // PREVIEW MENU
  // ═══════════════════════════════════════════════════════════════════════
  async function sendPreviewMenu(to) {
    return sendButtons(
      to,
      `📄 *Vérifiez votre document*\n\nTout est correct ? 👇`,
      [
        { id: "DOC_CONFIRM", title: "📤 Envoyer le PDF" },
        { id: "DOC_ADD_MORE", title: "✏️ Modifier" },
        { id: "DOC_CANCEL", title: "🏠 Menu" },
      ]
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // AFTER ITEMS
  // ═══════════════════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════════════════
  // RECEIPT FORMAT
  // ═══════════════════════════════════════════════════════════════════════
  async function sendReceiptFormatMenu(to) {
    return sendButtons(
      to,
      `🧾 *Format du reçu*\n\nChoisissez 👇`,
      [
        { id: "RECEIPT_FORMAT_COMPACT", title: "🎫 Ticket compact" },
        { id: "RECEIPT_FORMAT_A4", title: "📄 A4 standard" },
        { id: "BACK_DOCS", title: "⬅️ Retour" },
      ]
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STAMP MENUS
  // ═══════════════════════════════════════════════════════════════════════
  async function sendStampMenu(to) {
    return sendButtons(
      to,
      `🟦 *Tampon*\n\n` +
        `Le tampon peut être ajouté sur vos documents PDF.\n` +
        `Configurez-le ici 👇`,
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
        { id: "PROFILE_STAMP", title: "🟦 Retour tampon" },
        { id: "BACK_HOME", title: "🏠 Menu" },
      ]
    );
  }

  async function sendStampSizeMenu(to) {
    return sendButtons(
      to,
      `📏 *Taille du tampon*\n\nChoisissez 👇`,
      [
        { id: "STAMP_SIZE_S", title: "S — Petit" },
        { id: "STAMP_SIZE_M", title: "M — Moyen" },
        { id: "STAMP_SIZE_L", title: "L — Grand" },
      ]
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRE-GENERATE STAMP
  // ═══════════════════════════════════════════════════════════════════════
  async function sendPreGenerateStampMenu(to) {
    return sendButtons(
      to,
      `🟦 *Ajouter le tampon ?*\n\n` +
        `Le tampon rend votre document plus professionnel.`,
      [
        { id: "PRESTAMP_ADD_ONCE", title: "🟦 Oui, ajouter" },
        { id: "PRESTAMP_SKIP", title: "⏭️ Ignorer" },
        { id: "DOC_CANCEL", title: "🏠 Menu" },
      ]
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ALREADY GENERATED
  // ═══════════════════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════════════════
  // ZERO CRÉDITS
  // ═══════════════════════════════════════════════════════════════════════
  async function sendZeroCreditsBlock(to) {
    return sendButtons(
      to,
      `🔴 *Crédits épuisés.*\n\nRechargez pour continuer 👇`,
      [
        { id: "RECHARGE_1000", title: "1 000 F" },
        { id: "RECHARGE_2000", title: "2 000 F" },
        { id: "HOME_CREDITS", title: "💳 Voir packs" },
      ]
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LOW CRÉDITS ALERT
  // ═══════════════════════════════════════════════════════════════════════
  async function sendLowCreditsAlert(to, balance = 0) {
    return sendButtons(
      to,
      `⚠️ *Il vous reste ${balance} crédit${balance > 1 ? "s" : ""}.*\n\nRechargez maintenant 👇`,
      [
        { id: "RECHARGE_1000", title: "1 000 F" },
        { id: "RECHARGE_2000", title: "2 000 F" },
        { id: "HOME_CREDITS", title: "💳 Voir packs" },
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