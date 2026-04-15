"use strict";

function makeKadiCreditsUi(deps) {
  const { sendText, getBalance, sendRechargePacksMenu } = deps;

  async function replyBalance(from) {
    const res = await getBalance({ waId: from });
    const balance =
      res?.balance ??
      res?.data?.balance ??
      res?.credits ??
      0;

    if (balance <= 0) {
      await sendText(
        from,
        "🚫 Vous n’avez plus de crédits.\n\n" +
          "Rechargez pour continuer à créer vos documents avec KADI."
      );
      return sendRechargePacksMenu(from);
    }

    if (balance === 1) {
      await sendText(
        from,
        "⚠️ Il vous reste *1 crédit*.\n\n" +
          "Après votre prochain document, vous devrez recharger."
      );
      return;
    }

    await sendText(
      from,
      `💳 Votre solde actuel est de *${balance} crédit(s)*.`
    );
  }

  async function replyRechargeInfo(from) {
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