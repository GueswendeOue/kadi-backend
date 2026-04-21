"use strict";

function makeKadiPriorityRouter(deps) {
  const {
    norm,
    logger,
    sendText,
    sendButtons = null,
    sendHomeMenu,
    sendDocsMenu,
    startProfileFlow,
    replyBalance,
    sendRechargePacksMenu,
    sendStampMenu,
    sendProfileMenu,
    sendCreditsMenu,

    // docs
    startDocFlow = null,
    sendFactureCatalogMenu = null,
    sendFactureKindMenu = null,

    // history
    sendHistoryHome = null,

    // FEC
    startCertifiedInvoiceFlow = null,
    sendRecentCertifiedInvoices = null,
  } = deps;

  function normalizeText(rawText = "") {
    return String(norm(rawText) || "")
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ");
  }

  function countWords(text = "") {
    if (!text) return 0;
    return text.split(" ").filter(Boolean).length;
  }

  function isExactMatch(text, options = []) {
    return options.includes(text);
  }

  function looksLikeNaturalDocumentRequest(text = "") {
    if (!text) return false;

    const hasDocWord =
      /\b(devis|facture|recu|reçu|decharge|décharge|fec)\b/.test(text);

    if (!hasDocWord) return false;

    const strongBusinessSignals = [
      /\bpour\b/,
      /\bclient\b/,
      /\bloyer\b/,
      /\bmois\b/,
      /\bavril\b/,
      /\bmai\b/,
      /\bjuin\b/,
      /\bjuillet\b/,
      /\baout\b/,
      /\baoût\b/,
      /\bseptembre\b/,
      /\boctobre\b/,
      /\bnovembre\b/,
      /\bdecembre\b/,
      /\bdécembre\b/,
      /\bfcfa\b/,
      /\bf\b/,
      /\bmontant\b/,
      /\bprix\b/,
      /\bquantite\b/,
      /\bquantité\b/,
      /\barticle\b/,
      /\bproduit\b/,
      /\bservice\b/,
      /\bversement\b/,
      /\bpaiement\b/,
      /\blocatio?n\b/,
      /\breparation\b/,
      /\bréparation\b/,
      /\binstallation\b/,
      /\bconsultation\b/,
      /\bhonoraires\b/,
      /\d{4,}/,
    ];

    return strongBusinessSignals.some((re) => re.test(text));
  }

  function detectPriorityIntent(rawText) {
    const t = normalizeText(rawText);
    if (!t) return null;

    // Très important :
    // si ça ressemble déjà à une vraie demande métier,
    // on laisse le parseur naturel travailler.
    if (looksLikeNaturalDocumentRequest(t)) {
      return null;
    }

    const words = countWords(t);

    // ===============================
    // MENU / NAV
    // ===============================
    if (isExactMatch(t, ["menu", "accueil", "home", "retour"])) {
      return "menu";
    }

    // ===============================
    // FEC HISTORY
    // ===============================
    if (
      isExactMatch(t, [
        "historique fec",
        "mes fec",
        "mes factures electroniques certifiees",
        "mes factures électroniques certifiées",
        "dernier fec",
        "derniere fec",
        "dernière fec",
        "renvoyer fec",
        "renvoie fec",
        "renvoyer facture electronique certifiee",
        "renvoyer facture électronique certifiée",
      ])
    ) {
      return "fec_history";
    }

    // ===============================
    // FEC
    // ===============================
    if (
      isExactMatch(t, [
        "fec",
        "facture electronique certifiee",
        "facture électronique certifiée",
        "facture certifiee",
        "facture certifiée",
        "creer fec",
        "créer fec",
        "nouvelle fec",
        "facture fiscale",
      ])
    ) {
      return "fec";
    }

    // ===============================
    // DOCS DIRECTS
    // ===============================
    if (words <= 2 && isExactMatch(t, ["devis"])) {
      return "doc_devis";
    }

    if (words <= 2 && isExactMatch(t, ["recu", "reçu"])) {
      return "doc_recu";
    }

    if (words <= 2 && isExactMatch(t, ["decharge", "décharge"])) {
      return "doc_decharge";
    }

    if (words <= 2 && isExactMatch(t, ["facture"])) {
      return "doc_facture";
    }

    if (
      words <= 2 &&
      isExactMatch(t, ["doc", "docs", "document", "documents"])
    ) {
      return "docs";
    }

    // ===============================
    // PROFILE
    // ===============================
    if (
      isExactMatch(t, [
        "profil",
        "profile",
        "mon profil",
        "modifier profil",
        "configurer profil",
      ])
    ) {
      return "profile";
    }

    // ===============================
    // CREDITS / BALANCE
    // ===============================
    if (
      isExactMatch(t, [
        "solde",
        "credit",
        "credits",
        "crédit",
        "crédits",
        "mon solde",
        "mes credits",
        "mes crédits",
        "solde restant",
        "il me reste combien",
      ])
    ) {
      return "balance";
    }

    if (
      isExactMatch(t, [
        "recharge",
        "recharger",
        "acheter credits",
        "acheter crédits",
        "payer",
        "paiement",
        "comment payer",
        "comment recharger",
        "je veux recharger",
        "ou payer",
        "où payer",
        "orange money",
        "numero om",
        "numéro om",
        "compte orange money",
      ])
    ) {
      return "recharge";
    }

    // ===============================
    // OCR / PHOTO
    // ===============================
    if (
      isExactMatch(t, [
        "ocr",
        "photo",
        "image",
        "scanner",
        "scanner facture",
        "photo facture",
        "transformer photo",
        "photo en pdf",
        "envoyer photo",
      ])
    ) {
      return "ocr_help";
    }

    // ===============================
    // STAMP / TAMPON
    // ===============================
    if (
      isExactMatch(t, [
        "tampon",
        "cachet",
        "stamp",
        "signature",
        "activer tampon",
        "configurer tampon",
      ])
    ) {
      return "stamp";
    }

    // ===============================
    // HISTORY / LAST DOC
    // ===============================
    if (
      isExactMatch(t, [
        "historique",
        "dernier document",
        "dernier pdf",
        "renvoyer pdf",
        "renvoie pdf",
        "renvoyer document",
        "mes documents",
      ])
    ) {
      return "history";
    }

    // ===============================
    // HELP / TUTORIAL
    // ===============================
    if (
      isExactMatch(t, [
        "aide",
        "help",
        "comment ca marche",
        "comment ça marche",
        "comment utiliser",
        "comment tu fonctionnes",
        "tutoriel",
        "exemple",
        "exemples",
        "que peux tu faire",
        "quels documents",
        "que fais tu",
      ])
    ) {
      return "help";
    }

    // ===============================
    // BUG / SUPPORT
    // ===============================
    if (
      isExactMatch(t, [
        "bug",
        "probleme",
        "problème",
        "ca ne marche pas",
        "ça ne marche pas",
        "ca bloque",
        "ça bloque",
        "erreur",
      ])
    ) {
      return "support";
    }

    return null;
  }

  async function sendOcrQuickHelp(from) {
    await sendText(
      from,
      "📷 Envoyez simplement une photo claire de votre facture, devis ou reçu.\n\nKADI va lire la photo et préparer un document propre."
    );

    if (typeof sendButtons === "function") {
      await sendButtons(from, "Que voulez-vous faire maintenant ?", [
        { id: "HOME_OCR", title: "📷 Envoyer photo" },
        { id: "HOME_DOCS", title: "📄 Créer doc" },
        { id: "BACK_HOME", title: "🏠 Menu" },
      ]);
    }
  }

  async function sendHelpQuickActions(from) {
    await sendText(
      from,
      `❓ *Aide rapide KADI*\n\n` +
        `KADI peut créer :\n` +
        `• Devis\n` +
        `• Factures\n` +
        `• Reçus\n` +
        `• Décharges\n` +
        `• FEC\n\n` +
        `Vous pouvez aussi envoyer :\n` +
        `• un vocal\n` +
        `• une photo\n\n` +
        `Exemples :\n` +
        `• Devis pour Moussa, 2 portes à 25000\n` +
        `• Facture pour Awa, 5 pagnes à 3000\n` +
        `• Reçu pour Ouedraogo, loyer avril 100000`
    );

    if (typeof sendButtons === "function") {
      await sendButtons(from, "Choisissez une action 👇", [
        { id: "DOC_DEVIS", title: "📋 Créer devis" },
        { id: "HOME_OCR", title: "📷 Envoyer photo" },
        { id: "BACK_HOME", title: "🏠 Menu" },
      ]);
    }
  }

  async function handleUltraPriorityText(from, rawText) {
    const normalized = normalizeText(rawText);
    const intent = detectPriorityIntent(rawText);
    if (!intent) return false;

    try {
      if (intent === "menu") {
        await sendHomeMenu(from);
        return true;
      }

      if (intent === "fec") {
        if (typeof startCertifiedInvoiceFlow === "function") {
          await startCertifiedInvoiceFlow(from);
        } else {
          await sendText(
            from,
            "🧾 La FEC est disponible depuis le menu Documents."
          );
          if (typeof sendDocsMenu === "function") {
            await sendDocsMenu(from);
          }
        }
        return true;
      }

      if (intent === "fec_history") {
        if (typeof sendRecentCertifiedInvoices === "function") {
          await sendRecentCertifiedInvoices(from);
        } else {
          await sendText(from, "📚 L’historique FEC arrive bientôt.");
        }
        return true;
      }

      if (intent === "doc_devis") {
        if (typeof startDocFlow === "function") {
          await startDocFlow(from, "devis");
        } else {
          await sendDocsMenu(from);
        }
        return true;
      }

      if (intent === "doc_recu") {
        if (typeof startDocFlow === "function") {
          await startDocFlow(from, "recu");
        } else {
          await sendDocsMenu(from);
        }
        return true;
      }

      if (intent === "doc_decharge") {
        if (typeof startDocFlow === "function") {
          await startDocFlow(from, "decharge");
        } else {
          await sendDocsMenu(from);
        }
        return true;
      }

      if (intent === "doc_facture") {
        if (typeof sendFactureCatalogMenu === "function") {
          await sendFactureCatalogMenu(from);
        } else if (typeof sendFactureKindMenu === "function") {
          await sendFactureKindMenu(from);
        } else {
          await sendDocsMenu(from);
        }
        return true;
      }

      if (intent === "docs") {
        await sendDocsMenu(from);
        return true;
      }

      if (intent === "profile") {
        if (typeof startProfileFlow === "function") {
          await startProfileFlow(from);
        } else if (typeof sendProfileMenu === "function") {
          await sendProfileMenu(from);
        } else {
          await sendText(from, "👤 Ouvrez le profil depuis le menu.");
        }
        return true;
      }

      if (intent === "balance") {
        if (typeof replyBalance === "function") {
          await replyBalance(from);
        } else if (typeof sendCreditsMenu === "function") {
          await sendCreditsMenu(from);
        } else {
          await sendText(
            from,
            "💳 Vérification du solde indisponible pour le moment."
          );
        }
        return true;
      }

      if (intent === "recharge") {
        if (typeof sendRechargePacksMenu === "function") {
          await sendRechargePacksMenu(from);
        } else {
          await sendText(
            from,
            "💳 Pour recharger, ouvrez le menu Crédits puis choisissez un pack."
          );
        }
        return true;
      }

      if (intent === "ocr_help") {
        await sendOcrQuickHelp(from);
        return true;
      }

      if (intent === "stamp") {
        if (typeof sendStampMenu === "function") {
          await sendStampMenu(from);
        } else {
          await sendText(
            from,
            "🟦 Le tampon peut être configuré depuis votre profil entreprise."
          );
        }
        return true;
      }

      if (intent === "history") {
        if (typeof sendHistoryHome === "function") {
          await sendHistoryHome(from);
        } else {
          await sendText(from, "📚 Historique indisponible pour le moment.");
        }
        return true;
      }

      if (intent === "help") {
        await sendHelpQuickActions(from);
        return true;
      }

      if (intent === "support") {
        await sendText(
          from,
          "⚠️ D’accord. Décrivez-moi le problème en une phrase.\n\nExemple :\nLe PDF ne se génère pas\nou\nJe n’arrive pas à recharger."
        );

        if (typeof sendButtons === "function") {
          await sendButtons(from, "Que voulez-vous faire ?", [
            { id: "HOME_HELP", title: "❓ Aide" },
            { id: "CREDITS_RECHARGE", title: "💳 Recharger" },
            { id: "BACK_HOME", title: "🏠 Menu" },
          ]);
        }

        return true;
      }

      return false;
    } catch (e) {
      if (logger?.error) {
        logger.error("priority_router", e, {
          from,
          rawText,
          normalized,
          intent,
        });
      }

      await sendText(
        from,
        "⚠️ Je n’ai pas pu ouvrir cette option pour le moment.\nTapez MENU pour continuer."
      );
      return true;
    }
  }

  return {
    detectPriorityIntent,
    handleUltraPriorityText,
  };
}

module.exports = {
  makeKadiPriorityRouter,
};