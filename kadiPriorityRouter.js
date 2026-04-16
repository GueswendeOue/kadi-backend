"use strict";

function makeKadiPriorityRouter(deps) {
  const {
    norm,
    logger,
    sendText,
    sendHomeMenu,
    sendDocsMenu,
    startProfileFlow,
    replyBalance,
    sendRechargePacksMenu,
    sendStampMenu,
    sendProfileMenu,
    sendCreditsMenu,
    sendAlreadyGeneratedMenu = null,

    // FEC
    startCertifiedInvoiceFlow = null,
    sendRecentCertifiedInvoices = null,
  } = deps;

  function hasAny(text, patterns = []) {
    return patterns.some((p) => p.test(text));
  }

  function detectPriorityIntent(rawText) {
    const t = norm(rawText).toLowerCase();
    if (!t) return null;

    // ===============================
    // MENU / NAV
    // ===============================
    if (
      hasAny(t, [
        /\bmenu\b/,
        /\baccueil\b/,
        /\bhome\b/,
        /\bretour\b/,
      ])
    ) {
      return "menu";
    }

    // ===============================
    // FEC HISTORY (avant docs)
    // ===============================
    if (
      hasAny(t, [
        /\bhistorique fec\b/,
        /\bmes fec\b/,
        /\bmes factures electroniques certifiees\b/,
        /\bmes factures électroniques certifiées\b/,
        /\bdernier fec\b/,
        /\bderniere fec\b/,
        /\bdernière fec\b/,
        /\brenvoyer fec\b/,
        /\brenvoie fec\b/,
        /\brenvoyer facture electronique certifiee\b/,
        /\brenvoyer facture électronique certifiée\b/,
      ])
    ) {
      return "fec_history";
    }

    // ===============================
    // FEC (avant docs)
    // ===============================
    if (
      hasAny(t, [
        /\bfec\b/,
        /\bfacture electronique certifiee\b/,
        /\bfacture électronique certifiée\b/,
        /\bfacture certifiee\b/,
        /\bfacture certifiée\b/,
        /\bcreer fec\b/,
        /\bcréer fec\b/,
        /\bnouvelle fec\b/,
        /\bfacture fiscale\b/,
      ])
    ) {
      return "fec";
    }

    // ===============================
    // DOCS / NAV DOCS
    // ===============================
    if (
      hasAny(t, [
        /\bdoc\b/,
        /\bdocs\b/,
        /\bdocument\b/,
        /\bdocuments\b/,
        /\bdevis\b/,
        /\bfacture\b/,
        /\breçu\b/,
        /\brecu\b/,
        /\bdécharge\b/,
        /\bdecharge\b/,
      ])
    ) {
      return "docs";
    }

    if (
      hasAny(t, [
        /\bprofil\b/,
        /\bprofile\b/,
        /mon profil/,
        /modifier profil/,
        /configurer profil/,
      ])
    ) {
      return "profile";
    }

    // ===============================
    // CREDITS / BALANCE
    // ===============================
    if (
      hasAny(t, [
        /\bsolde\b/,
        /\bcredit\b/,
        /\bcredits\b/,
        /\bcrédit\b/,
        /\bcrédits\b/,
        /combien.*credit/,
        /combien.*crédit/,
        /combien.*reste/,
        /il me reste combien/,
        /mes credits/,
        /mes crédits/,
        /mon solde/,
        /solde restant/,
      ])
    ) {
      return "balance";
    }

    if (
      hasAny(t, [
        /\brecharge\b/,
        /\brecharger\b/,
        /\bacheter\b/,
        /\bpayer\b/,
        /\bpaiement\b/,
        /orange money/,
        /numero de compte/,
        /numéro de compte/,
        /envoyer.*numero/,
        /envoyer.*numéro/,
        /comment payer/,
        /comment recharger/,
        /je veux recharger/,
        /ou payer/,
        /où payer/,
        /compte orange money/,
        /numero om/,
        /numéro om/,
      ])
    ) {
      return "recharge";
    }

    // ===============================
    // OCR / PHOTO
    // ===============================
    if (
      hasAny(t, [
        /\bocr\b/,
        /\bphoto\b/,
        /\bimage\b/,
        /\bscanner\b/,
        /scanner facture/,
        /photo facture/,
        /transformer photo/,
        /photo en pdf/,
        /envoyer photo/,
      ])
    ) {
      return "ocr_help";
    }

    // ===============================
    // STAMP / TAMPON
    // ===============================
    if (
      hasAny(t, [
        /\btampon\b/,
        /\bcachet\b/,
        /\bstamp\b/,
        /\bsignature\b/,
        /activer tampon/,
        /configurer tampon/,
      ])
    ) {
      return "stamp";
    }

    // ===============================
    // HISTORY / LAST DOC
    // ===============================
    if (
      hasAny(t, [
        /\bhistorique\b/,
        /dernier document/,
        /dernier pdf/,
        /renvoyer pdf/,
        /renvoie pdf/,
        /renvoyer document/,
        /mes documents/,
      ])
    ) {
      return "history";
    }

    // ===============================
    // HELP / TUTORIAL
    // ===============================
    if (
      hasAny(t, [
        /\baide\b/,
        /\bhelp\b/,
        /comment ça marche/,
        /comment utiliser/,
        /comment tu fonctionnes/,
        /tutoriel/,
        /exemple/,
        /exemples/,
        /que peux tu faire/,
        /quels documents/,
        /que fais tu/,
      ])
    ) {
      return "help";
    }

    // ===============================
    // BUG / SUPPORT
    // ===============================
    if (
      hasAny(t, [
        /\bbug\b/,
        /\bprobleme\b/,
        /\bproblème\b/,
        /ça ne marche pas/,
        /ca ne marche pas/,
        /ça bloque/,
        /ca bloque/,
        /erreur/,
      ])
    ) {
      return "support";
    }

    return null;
  }

  async function handleUltraPriorityText(from, rawText) {
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
          await sendText(
            from,
            "📚 L’historique FEC arrive bientôt."
          );
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
          await sendText(from, "💳 Vérification du solde indisponible pour le moment.");
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
        await sendText(
          from,
          "📷 Envoyez simplement une photo claire de votre facture, devis ou reçu.\n\nKADI peut extraire les informations et générer un document propre."
        );
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
        if (typeof sendAlreadyGeneratedMenu === "function") {
          await sendAlreadyGeneratedMenu(from);
        } else {
          await sendText(
            from,
            "📚 L’historique complet arrive bientôt. Pour l’instant, vous pouvez demander le renvoi du dernier PDF si disponible."
          );
        }
        return true;
      }

      if (intent === "help") {
        await sendText(
          from,
          `❓ *Aide rapide KADI*\n\n` +
            `KADI peut créer :\n` +
            `• Devis\n` +
            `• Factures\n` +
            `• Reçus\n` +
            `• Décharges\n` +
            `• FEC\n\n` +
            `Vous pouvez :\n` +
            `• écrire normalement\n` +
            `• envoyer un vocal\n` +
            `• envoyer une photo\n\n` +
            `Exemples :\n` +
            `• Devis pour Moussa, 2 portes à 25000\n` +
            `• Facture pour Awa, 5 pagnes à 3000\n` +
            `• FEC pour Moussa, 3 sacs de ciment à 7500\n\n` +
            `Tapez aussi : MENU, SOLDE, RECHARGE, PROFIL`
        );
        return true;
      }

      if (intent === "support") {
        await sendText(
          from,
          "⚠️ D’accord. Décrivez-moi le problème en une phrase.\n\nExemple :\nLe PDF ne se génère pas\nou\nJe n’arrive pas à recharger."
        );
        return true;
      }

      return false;
    } catch (e) {
      if (logger?.error) {
        logger.error("priority_router", e, { from, rawText, intent });
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