"use strict";

function makeKadiCreditsUi(deps) {
  const { sendText, getBalance, sendRechargePacksMenu } = deps;

  const LOW_CREDITS_THRESHOLD = Number(
    process.env.LOW_CREDITS_THRESHOLD || 2
  );

  function toNum(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function parseBalanceResult(res) {
    return toNum(
      res?.balance ??
        res?.data?.balance ??
        res?.credits ??
        res?.data?.credits,
      0
    );
  }

  async function readSafeBalance(from) {
    try {
      const res = await getBalance({ waId: from });
      return parseBalanceResult(res);
    } catch (_) {}

    try {
      const res = await getBalance(from);
      return parseBalanceResult(res);
    } catch (_) {}

    return 0;
  }

  async function replyBalance(from) {
    const balance = await readSafeBalance(from);

    if (balance <= 0) {
      await sendText(
        from,
        "🔴 Vous n’avez plus de crédits.\n\n" +
          "Rechargez maintenant pour continuer à créer vos documents sans interruption."
      );
      return sendRechargePacksMenu(from);
    }

    if (balance <= LOW_CREDITS_THRESHOLD) {
      await sendText(
        from,
        `⚠️ Il vous reste *${balance} crédit${
          balance > 1 ? "s" : ""
        }*.\n\n` +
          "Rechargez maintenant pour éviter d’être bloqué au prochain document."
      );
      return sendRechargePacksMenu(from);
    }

    await sendText(
      from,
      `💳 Votre solde actuel est de *${balance} crédit(s)*.\n\n` +
        "Vous pouvez continuer à créer vos documents."
    );
  }

  async function replyRechargeInfo(from) {
    await sendText(
      from,
      "💳 Choisissez un pack pour continuer sans interrompre votre document."
    );
    return sendRechargePacksMenu(from);
  }

  return {
    replyBalance,
    replyRechargeInfo,
  };
}

module.exports = {
  makeKadiCreditsUi,
};