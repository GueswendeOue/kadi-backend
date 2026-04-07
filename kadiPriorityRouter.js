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
  } = deps;

  async function handleUltraPriorityText(from, rawText) {
    const t = norm(rawText).toLowerCase();
    if (!t) return false;

    try {
      if (t === "menu" || t === "home" || t === "accueil") {
        await sendHomeMenu(from);
        return true;
      }

      if (t === "doc" || t === "docs" || t === "document" || t === "documents") {
        await sendDocsMenu(from);
        return true;
      }

      if (t === "profil" || t === "profile") {
        await startProfileFlow(from);
        return true;
      }

      if (
        t === "solde" ||
        t === "credit" ||
        t === "credits" ||
        t === "crédit" ||
        t === "crédits"
      ) {
        await replyBalance(from);
        return true;
      }

      if (t === "recharge" || t === "recharger") {
        await sendRechargePacksMenu(from);
        return true;
      }

      if (t === "aide" || t === "help") {
        await sendText(
          from,
          `❓ *Aide rapide*\n\n` +
            `Vous pouvez écrire simplement :\n` +
            `• Devis pour Moussa, 2 portes à 25000\n` +
            `• Facture pour Awa, 5 pagnes à 3000\n` +
            `• Reçu loyer avril 100000 pour Adama\n` +
            `• Décharge pour prêt de 50000 à Issa\n\n` +
            `Tapez aussi : MENU, PROFIL, SOLDE ou RECHARGE`
        );
        return true;
      }

      return false;
    } catch (e) {
      if (logger?.error) {
        logger.error("priority_router", e, { from, rawText });
      }

      await sendText(
        from,
        "⚠️ Je n’ai pas pu ouvrir cette option pour le moment.\nTapez MENU pour continuer."
      );
      return true;
    }
  }

  return {
    handleUltraPriorityText,
  };
}

module.exports = {
  makeKadiPriorityRouter,
};