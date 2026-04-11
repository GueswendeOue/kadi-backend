"use strict";

function makeKadiStatsService(deps) {
  const {
    sendText,
    getStats,
    money,
    buildInsights,
    exportKadiExcel,
  } = deps;

  function n(v, def = 0) {
    const x = Number(v);
    return Number.isFinite(x) ? x : def;
  }

  function txt(v, def = "") {
    const t = String(v ?? "").trim();
    return t || def;
  }

  function arr(v) {
    return Array.isArray(v) ? v : [];
  }

  function safeMoney(formatter, value) {
    try {
      if (typeof formatter === "function") return formatter(value || 0);
    } catch (_) {}
    return String(n(value, 0));
  }

  function normalizeStats(raw) {
    const src = raw && typeof raw === "object" ? raw : {};

    const usersSrc =
      src.users && typeof src.users === "object" ? src.users : {};
    const docsSrc =
      src.docs && typeof src.docs === "object" ? src.docs : {};
    const comparisonsSrc =
      src.comparisons && typeof src.comparisons === "object"
        ? src.comparisons
        : {};
    const revenueSrc =
      src.revenue && typeof src.revenue === "object" ? src.revenue : {};
    const funnelSrc =
      src.funnel && typeof src.funnel === "object" ? src.funnel : {};

    return {
      users: {
        total:
          n(usersSrc.total) ||
          n(usersSrc.totalUsers) ||
          0,
        active7:
          n(usersSrc.active7) ||
          n(usersSrc.active_users_7d) ||
          0,
        active30:
          n(usersSrc.active30) ||
          n(usersSrc.active_users_30d) ||
          0,
        paid:
          n(usersSrc.paid) ||
          n(usersSrc.usersRecharged) ||
          n(usersSrc.users_recharged) ||
          0,
      },

      docs: {
        created:
          n(docsSrc.created) ||
          n(docsSrc.totalCreated) ||
          n(docsSrc.total) ||
          0,
        generated:
          n(docsSrc.generated) ||
          n(docsSrc.pdfGenerated) ||
          n(docsSrc.pdf_total) ||
          0,
        creationToPdfRate:
          n(docsSrc.creationToPdfRate) ||
          n(docsSrc.pdfConversionRate) ||
          0,
        last7:
          n(docsSrc.last7) ||
          n(docsSrc.docs7) ||
          0,
        last30:
          n(docsSrc.last30) ||
          n(docsSrc.docs30) ||
          0,
      },

      comparisons: {
        docs7Growth:
          n(comparisonsSrc.docs7Growth) ||
          n(comparisonsSrc.docs_growth_7d) ||
          0,
        revenue30Growth:
          n(comparisonsSrc.revenue30Growth) ||
          n(comparisonsSrc.revenue_growth_30d) ||
          0,
      },

      revenue: {
        month:
          n(revenueSrc.month) ||
          n(revenueSrc.est30) ||
          n(revenueSrc.estimated30) ||
          0,
      },

      funnel: {
        signupToActive30Rate:
          n(funnelSrc.signupToActive30Rate) ||
          n(funnelSrc.signup_to_active_30_rate) ||
          0,
        activeToCreatedRate:
          n(funnelSrc.activeToCreatedRate) ||
          n(funnelSrc.active_to_created_rate) ||
          0,
        createdToGeneratedRate:
          n(funnelSrc.createdToGeneratedRate) ||
          n(funnelSrc.created_to_generated_rate) ||
          0,
        generatedToPaidRate:
          n(funnelSrc.generatedToPaidRate) ||
          n(funnelSrc.generated_to_paid_rate) ||
          0,
      },

      alerts: arr(src.alerts),
      topClients: arr(src.topClients),
      topUsers: arr(src.topUsers),
    };
  }

  async function handleStatsCommand(from) {
    try {
      const raw = await getStats();
      const s = normalizeStats(raw);

      const alertsText =
        s.alerts.length > 0
          ? `🚨 *ALERTES*\n${s.alerts.join("\n")}\n\n`
          : "";

      const msg =
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📊 *KADI — DASHBOARD*\n` +
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
        `CA 30j          ${safeMoney(money, s.revenue.month)} FCFA\n` +
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
      const raw = await getStats();
      const s = normalizeStats(raw);
      const rows = s.topClients;

      if (!rows.length) {
        await sendText(from, "📭 Aucun client trouvé.");
        return true;
      }

      let msg = "⭐ *TOP CLIENTS (30j)*\n\n";

      rows.forEach((r, i) => {
        msg += `${i + 1}. ${txt(r.client, "-")}\n`;
        msg += `   Docs: ${n(r.docs || r.doc_count, 0)}\n`;
        msg += `   Total: ${safeMoney(money, r.total_fcfa || r.total_sum)} FCFA\n\n`;
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
      const raw = await getStats();
      const s = normalizeStats(raw);
      const rows = s.topUsers;

      if (!rows.length) {
        await sendText(from, "📭 Aucun utilisateur trouvé.");
        return true;
      }

      let msg = "🔥 *TOP USERS*\n\n";

      rows.forEach((r, i) => {
        msg += `${i + 1}. ${txt(r.wa_id, "-")}\n`;
        msg += `   Docs: ${n(r.docs || r.doc_count, 0)}\n`;
        msg += `   Total: ${safeMoney(money, r.total_fcfa || r.total_sum)} FCFA\n\n`;
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
      const raw = await getStats();
      const s = normalizeStats(raw);

      const analysis =
        typeof buildInsights === "function"
          ? buildInsights(raw || s)
          : {
              alerts: [],
              insights: [],
              priorityAction: "Continuer à observer les métriques.",
            };

      const alerts = arr(analysis.alerts);
      const insights = arr(analysis.insights);

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
        `CA 30j          ${safeMoney(money, s.revenue.month)} FCFA\n` +
        `Payants         ${s.users.paid}\n\n` +

        `🎯 *FUNNEL*\n` +
        `Signup→Actif    ${s.funnel.signupToActive30Rate}%\n` +
        `Actif→Créé      ${s.funnel.activeToCreatedRate}%\n` +
        `Créé→PDF        ${s.funnel.createdToGeneratedRate}%\n` +
        `PDF→Payé        ${s.funnel.generatedToPaidRate}%\n\n` +

        (alerts.length
          ? `🚨 *ALERTES*\n${alerts.join("\n")}\n\n`
          : "") +

        `🧠 *INSIGHT*\n` +
        `${insights[0] || "Rien de critique cette semaine."}\n\n` +

        `✅ *ACTION PRIORITAIRE*\n` +
        `${txt(
          analysis.priorityAction,
          "Continuer à observer les métriques cette semaine."
        )}\n\n` +

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
      await sendText(from, `✅ Export Excel généré.\nFichier: ${filePath}`);
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