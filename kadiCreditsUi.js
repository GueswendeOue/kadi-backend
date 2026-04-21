"use strict";

function makeKadiCreditsUi(deps) {
  const {
    sendText,
    sendButtons = null,
    getBalance,
    sendRechargePacksMenu,
    trackConversionEvent = null,
  } = deps;

  function toNum(v, def = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }

  function resolveBalanceValue(res) {
    return toNum(
      res?.balance ??
        res?.data?.balance ??
        res?.credits ??
        res?.wallet?.balance ??
        0,
      0
    );
  }

  function formatCredits(balance) {
    return `${balance} crédit${balance > 1 ? "s" : ""}`;
  }

  async function track(from, eventKey, meta = {}) {
    if (typeof trackConversionEvent !== "function") return;

    try {
      await trackConversionEvent({
        waId: from,
        eventKey,
        requestId: null,
        docType: null,
        docNumber: null,
        source: "credits_ui",
        meta: meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {},
      });
    } catch (err) {
      console.warn("[KADI/CREDITS_UI] track failed:", err?.message || err);
    }
  }

  async function sendRechargeShortcut(from, message) {
    if (typeof sendButtons === "function") {
      await sendButtons(from, message, [
        { id: "RECHARGE_1000", title: "1000F" },
        { id: "RECHARGE_2000", title: "2000F" },
        { id: "BACK_HOME", title: "🏠 Menu" },
      ]);
      return;
    }

    await sendText(from, message);
    await sendRechargePacksMenu(from);
  }

  async function sendPositiveBalanceActions(from) {
    if (typeof sendButtons !== "function") return;

    await sendButtons(from, "Que voulez-vous faire maintenant ?", [
      { id: "HOME_DOCS", title: "📄 Créer doc" },
      { id: "CREDITS_RECHARGE", title: "🔄 Recharger" },
      { id: "BACK_HOME", title: "🏠 Menu" },
    ]);
  }

  async function replyBalance(from) {
    try {
      const res = await getBalance({ waId: from });
      const balance = resolveBalanceValue(res);

      await track(from, "balance_checked", { balance });

      if (balance <= 0) {
        await track(from, "balance_zero_shown", { balance });

        await sendRechargeShortcut(
          from,
          "🔴 *Vous n’avez plus de crédits.*\n\n" +
            "Rechargez maintenant pour continuer à créer vos documents avec KADI."
        );
        return true;
      }

      if (balance === 1) {
        await track(from, "balance_low_shown", { balance });

        await sendRechargeShortcut(
          from,
          "⚠️ *Il vous reste 1 crédit.*\n\n" +
            "Vous pouvez encore générer un document simple, " +
            "mais il vaut mieux recharger maintenant."
        );
        return true;
      }

      if (balance <= 3) {
        await track(from, "balance_low_shown", { balance });

        await sendRechargeShortcut(
          from,
          `⚠️ *Solde faible : ${formatCredits(balance)}.*\n\n` +
            "Rechargez maintenant pour éviter une interruption pendant la génération."
        );
        return true;
      }

      await sendText(
        from,
        `💳 Votre solde actuel est de *${formatCredits(balance)}*.\n\n` +
          "Vous pouvez continuer à créer vos documents normalement."
      );

      await sendPositiveBalanceActions(from);
      return true;
    } catch (err) {
      console.error("[KADI/CREDITS_UI] replyBalance error:", err?.message || err);

      await sendText(
        from,
        "⚠️ Je n’ai pas pu vérifier votre solde pour le moment.\n" +
          "Vous pouvez tout de même ouvrir les packs de recharge."
      );

      await sendRechargePacksMenu(from);
      return true;
    }
  }

  async function replyRechargeInfo(from) {
    await track(from, "recharge_menu_opened");
    await sendRechargePacksMenu(from);
    return true;
  }

  return {
    replyBalance,
    replyRechargeInfo,
  };
}

module.exports = {
  makeKadiCreditsUi,
};