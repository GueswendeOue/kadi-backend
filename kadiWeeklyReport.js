"use strict";

const { getStats, money } = require("./kadiStatsRepo");
const { buildInsights } = require("./kadiInsightsEngine");

function makeKadiWeeklyReport(deps) {
  const { sendText, adminWaId } = deps;

  async function sendWeeklyReport() {
    const stats = await getStats();
    const analysis = buildInsights(stats);

    const msg =
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 *KADI — WEEKLY REPORT*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +

      `👥 *USERS*\n` +
      `Total           ${stats.users.total}\n` +
      `Actifs 7j       ${stats.users.active7}\n` +
      `Actifs 30j      ${stats.users.active30}\n\n` +

      `📄 *PRODUIT*\n` +
      `Docs créés      ${stats.docs.created}\n` +
      `Docs PDF        ${stats.docs.generated}\n` +
      `Conversion      ${stats.docs.creationToPdfRate}%\n` +
      `Docs 7j         ${stats.docs.last7}\n\n` +

      `💰 *BUSINESS*\n` +
      `CA 30j          ${money(stats.revenue.month)} FCFA\n` +
      `Payants         ${stats.users.paid}\n\n` +

      `🎯 *FUNNEL*\n` +
      `Signup→Actif    ${stats.funnel.signupToActive30Rate}%\n` +
      `Actif→Créé      ${stats.funnel.activeToCreatedRate}%\n` +
      `Créé→PDF        ${stats.funnel.createdToGeneratedRate}%\n` +
      `PDF→Payé        ${stats.funnel.generatedToPaidRate}%\n\n` +

      (analysis.alerts.length
        ? `🚨 *ALERTES*\n${analysis.alerts.join("\n")}\n\n`
        : "") +

      `🧠 *INSIGHT*\n` +
      `${analysis.insights[0] || "Rien de critique cette semaine."}\n\n` +

      `✅ *ACTION PRIORITAIRE*\n` +
      `${analysis.priorityAction}\n\n` +

      `━━━━━━━━━━━━━━━━━━━━`;

    await sendText(adminWaId, msg);
    return true;
  }

  return {
    sendWeeklyReport,
  };
}

module.exports = {
  makeKadiWeeklyReport,
};