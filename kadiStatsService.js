"use strict";

function makeKadiStatsService(deps) {
  const {
    sendText,
    getStats,
    money,
    buildInsights,
    exportKadiExcel,
  } = deps;

  async function handleStatsCommand(from) {
    try {
      const s = await getStats();

      const alertsText =
        Array.isArray(s.alerts) && s.alerts.length
          ? `🚨 *ALERTES*\n${s.alerts.join("\n")}\n\n`
          : "";

      const msg =
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📊 *KADI — DASHBOARD YC*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +

        `👥 *USERS*\n` +
        `Total           ${s.users.total}\n` +
        `Actifs 7j       ${s.users.active7}\n` +
        `Actifs 30j      ${s.users.active30}\n` +
        `Payants         ${s.users.paid}\n\n` +

        `⚡ *PRODUIT*\n` +
        `Docs créés      ${s.docs.created}\n` +
        `Docs PDF        ${s.docs.generated}\n` +
        `Conversion      ${s.docs.creationToPdfRate}%\n\n` +

        `📈 *ENGAGEMENT*\n` +
        `Docs 7j         ${s.docs.last7}\n` +
        `Docs 30j        ${s.docs.last30}\n` +
        `Croissance docs ${s.comparisons.docs7Growth}%\n\n` +

        `💰 *BUSINESS*\n` +
        `CA 30j          ${money(s.revenue.month)} FCFA\n` +
        `Croissance CA   ${s.comparisons.revenue30Growth}%\n\n` +

        `🎯 *FUNNEL*\n` +
        `Signup→Actif    ${s.funnel.signupToActive30Rate}%\n` +
        `Actif→Créé      ${s.funnel.activeToCreatedRate}%\n` +
        `Créé→PDF        ${s.funnel.createdToGeneratedRate}%\n` +
        `PDF→Payé        ${s.funnel.generatedToPaidRate}%\n\n` +

        alertsText +

        `━━━━━━━━━━━━━━━━━━━━`;

      await sendText(from, msg);
      return true;
    } catch (e) {
      console.error("[KADI/STATS] error:", e);
      await sendText(from, "⚠️ Impossible de charger les stats.");
      return true;
    }
  }

  async function handleTopClientsCommand(from) {
    try {
      const s = await getStats();
      const rows = Array.isArray(s.topClients) ? s.topClients : [];

      if (!rows.length) {
        await sendText(from, "📭 Aucun client trouvé.");
        return true;
      }

      let msg = "⭐ *TOP CLIENTS (30j)*\n\n";
      rows.forEach((r, i) => {
        msg += `${i + 1}. ${r.client}\n`;
        msg += `   Docs: ${r.docs}\n`;
        msg += `   Total: ${money(r.total_fcfa)} FCFA\n\n`;
      });

      await sendText(from, msg.trim());
      return true;
    } catch (e) {
      console.error("[KADI/TOP_CLIENTS] error:", e);
      await sendText(from, "⚠️ Impossible de charger les top clients.");
      return true;
    }
  }

  async function handleTopUsersCommand(from) {
    try {
      const s = await getStats();
      const rows = Array.isArray(s.topUsers) ? s.topUsers : [];

      if (!rows.length) {
        await sendText(from, "📭 Aucun utilisateur trouvé.");
        return true;
      }

      let msg = "🔥 *TOP USERS*\n\n";
      rows.forEach((r, i) => {
        msg += `${i + 1}. ${r.wa_id}\n`;
        msg += `   Docs: ${r.docs}\n`;
        msg += `   Total: ${money(r.total_fcfa)} FCFA\n\n`;
      });

      await sendText(from, msg.trim());
      return true;
    } catch (e) {
      console.error("[KADI/TOP_USERS] error:", e);
      await sendText(from, "⚠️ Impossible de charger les top users.");
      return true;
    }
  }

  async function handleWeeklyReportCommand(from) {
    try {
      const s = await getStats();
      const analysis = typeof buildInsights === "function"
        ? buildInsights(s)
        : { alerts: [], insights: [], priorityAction: "Continuer à observer les métriques." };

      const msg =
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📊 *KADI — WEEKLY REPORT*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +

        `👥 *USERS*\n` +
        `Total           ${s.users.total}\n` +
        `Actifs 7j       ${s.users.active7}\n` +
        `Actifs 30j      ${s.users.active30}\n\n` +

        `📄 *PRODUIT*\n` +
        `Docs créés      ${s.docs.created}\n` +
        `Docs PDF        ${s.docs.generated}\n` +
        `Conversion      ${s.docs.creationToPdfRate}%\n` +
        `Docs 7j         ${s.docs.last7}\n\n` +

        `💰 *BUSINESS*\n` +
        `CA 30j          ${money(s.revenue.month)} FCFA\n` +
        `Payants         ${s.users.paid}\n\n` +

        `🎯 *FUNNEL*\n` +
        `Signup→Actif    ${s.funnel.signupToActive30Rate}%\n` +
        `Actif→Créé      ${s.funnel.activeToCreatedRate}%\n` +
        `Créé→PDF        ${s.funnel.createdToGeneratedRate}%\n` +
        `PDF→Payé        ${s.funnel.generatedToPaidRate}%\n\n` +

        ((analysis.alerts || []).length
          ? `🚨 *ALERTES*\n${analysis.alerts.join("\n")}\n\n`
          : "") +

        `🧠 *INSIGHT*\n` +
        `${analysis.insights?.[0] || "Rien de critique cette semaine."}\n\n` +

        `✅ *ACTION PRIORITAIRE*\n` +
        `${analysis.priorityAction || "Continuer à observer les métriques cette semaine."}\n\n` +

        `━━━━━━━━━━━━━━━━━━━━`;

      await sendText(from, msg);
      return true;
    } catch (e) {
      console.error("[KADI/WEEKLY_REPORT] error:", e);
      await sendText(from, "⚠️ Impossible de générer le weekly report.");
      return true;
    }
  }

  async function handleExportExcelCommand(from) {
    try {
      if (typeof exportKadiExcel !== "function") {
        await sendText(from, "⚠️ Export Excel non disponible.");
        return true;
      }

      const filePath = await exportKadiExcel();
      await sendText(
        from,
        `✅ Export Excel généré.\nFichier: ${filePath}`
      );
      return true;
    } catch (e) {
      console.error("[KADI/EXPORT_EXCEL] error:", e);
      await sendText(from, "⚠️ Impossible de générer l’export Excel.");
      return true;
    }
  }

  return {
    handleStatsCommand,
    handleTopClientsCommand,
    handleTopUsersCommand,
    handleWeeklyReportCommand,
    handleExportExcelCommand,
  };
}

module.exports = {
  makeKadiStatsService,
};