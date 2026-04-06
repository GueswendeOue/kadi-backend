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

    await sendText(from, `💳 Votre solde actuel est de *${balance} crédit(s)*.`);
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