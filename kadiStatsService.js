"use strict";

function makeKadiStatsService(deps) {
  const { sendText, getStats, packCredits, packPriceFcfa, money } = deps;

  async function handleStatsCommand(from) {
    try {
      const stats = await getStats({
        packCredits,
        packPriceFcfa,
      });

      const msg =
        `📊 *KADI STATS*\n\n` +
        `👥 Utilisateurs: ${stats?.users?.totalUsers || 0}\n` +
        `🔥 Actifs 7j: ${stats?.users?.active7 || 0}\n` +
        `📄 Docs total: ${stats?.docs?.total || 0}\n` +
        `📅 Docs 30j: ${stats?.docs?.last30 || 0}\n` +
        `💰 Volume total: ${money(stats?.docs?.sumAll || 0)} FCFA`;

      await sendText(from, msg);
      return true;
    } catch (e) {
      await sendText(
        from,
        "⚠️ Je n’ai pas pu charger les statistiques pour le moment."
      );
      return true;
    }
  }

  return {
    handleStatsCommand,
  };
}

module.exports = {
  makeKadiStatsService,
};