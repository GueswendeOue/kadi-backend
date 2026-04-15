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

  function pickNumber(...values) {
    for (const v of values) {
      const x = Number(v);
      if (Number.isFinite(x)) return x;
    }
    return 0;
  }

  function normalizeYcStats(raw) {
    const src = raw && typeof raw === "object" ? raw : {};

    const growth = src.growth && typeof src.growth === "object" ? src.growth : {};
    const usage = src.usage && typeof src.usage === "object" ? src.usage : {};
    const monetization =
      src.monetization && typeof src.monetization === "object"
        ? src.monetization
        : {};
    const funnel = src.funnel && typeof src.funnel === "object" ? src.funnel : {};
    const retention =
      src.retention && typeof src.retention === "object" ? src.retention : {};

    return {
      growth: {
        totalUsers: pickNumber(
          growth.totalUsers,
          src.users?.totalUsers,
          src.users?.total
        ),
        active30: pickNumber(
          growth.active30,
          src.users?.active30
        ),
        active30Rate: pickNumber(growth.active30Rate),
        active7: pickNumber(
          growth.active7,
          src.users?.active7
        ),
        active7Rate: pickNumber(growth.active7Rate),
        estimatedNewUsers30: pickNumber(
          growth.estimatedNewUsers30,
          growth.newUsers30,
          src.users?.newUsers30
        ),
      },

      usage: {
        docsTotal: pickNumber(
          usage.docsTotal,
          src.docs?.total,
          src.docs?.generated,
          src.docs?.created
        ),
        docs30d: pickNumber(
          usage.docs30d,
          src.docs?.last30,
          src.docs?.docs30
        ),
        docs7d: pickNumber(
          usage.docs7d,
          src.docs?.last7,
          src.docs?.docs7
        ),
        docsPerActive30User: pickNumber(usage.docsPerActive30User),
      },

      monetization: {
        revenue30d: pickNumber(
          monetization.revenue30d,
          src.revenue?.month,
          src.revenue?.est30
        ),
        payingUsers: pickNumber(
          monetization.payingUsers,
          src.users?.paid,
          src.users?.usersRecharged
        ),
        usersZeroCredits: pickNumber(
          monetization.usersZeroCredits,
          src.conversion?.usersZeroCredits
        ),
        usersLowCredits: pickNumber(
          monetization.usersLowCredits,
          src.conversion?.usersLowCredits
        ),
      },

      funnel: {
        signupToActive30Rate: pickNumber(
          funnel.signupToActive30Rate,
          src.funnel?.signupToActive30Rate
        ),
        activeToCreatedRate: pickNumber(
          funnel.activeToCreatedRate,
          src.funnel?.activeToCreatedRate
        ),
        generatedToPaidRate: pickNumber(
          funnel.generatedToPaidRate,
          src.funnel?.generatedToPaidRate
        ),
      },

      retention: {
        retention7Approx: pickNumber(retention.retention7Approx),
      },

      topClients: arr(src.topClients),
      topUsers: arr(src.topUsers),
      alerts: arr(src.alerts),
      insights: arr(src.insights),
      priorityAction: txt(src.priorityAction),
      summary: txt(src.summary),
    };
  }

  function buildDashboardMessage(s) {
    return (
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 *KADI — DASHBOARD*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +

      `📈 *TRACTION*\n` +
      `Users total       ${n(s.growth.totalUsers)}\n` +
      `Actifs 30j        ${n(s.growth.active30)} (${n(s.growth.active30Rate)}%)\n` +
      `Actifs 7j         ${n(s.growth.active7)} (${n(s.growth.active7Rate)}%)\n` +
      `Nouveaux ~30j     ${n(s.growth.estimatedNewUsers30)}\n\n` +

      `⚡ *ACTIVATION / USAGE*\n` +
      `Docs total        ${n(s.usage.docsTotal)}\n` +
      `Docs 30j          ${n(s.usage.docs30d)}\n` +
      `Docs 7j           ${n(s.usage.docs7d)}\n` +
      `Docs/actif 30j    ${n(s.usage.docsPerActive30User)}\n\n` +

      `💰 *MONÉTISATION*\n` +
      `CA 30j            ${safeMoney(money, s.monetization.revenue30d)} FCFA\n` +
      `Payants           ${n(s.monetization.payingUsers)}\n` +
      `0 crédit          ${n(s.monetization.usersZeroCredits)}\n` +
      `Crédits faibles   ${n(s.monetization.usersLowCredits)}\n\n` +

      `🎯 *FUNNEL*\n` +
      `Signup→Actif      ${n(s.funnel.signupToActive30Rate)}%\n` +
      `Actif→Doc         ${n(s.funnel.activeToCreatedRate)}%\n` +
      `Doc→Payé          ${n(s.funnel.generatedToPaidRate)}%\n\n` +

      `🔁 *RÉTENTION*\n` +
      `Retour 7j/30j     ${n(s.retention.retention7Approx)}%\n\n` +

      (s.alerts.length
        ? `🚨 *ALERTES*\n${s.alerts.join("\n")}\n\n`
        : "") +

      `🧠 *INSIGHT*\n` +
      `${txt(s.summary, "Aucun insight pour le moment.")}\n\n` +

      `✅ *ACTION PRIORITAIRE*\n` +
      `${txt(s.priorityAction, "Continuer à observer les métriques.")}\n\n` +

      `━━━━━━━━━━━━━━━━━━━━`
    );
  }

  function buildWeeklyReportMessage(s, analysis) {
    const alerts = arr(analysis?.alerts);
    const insights = arr(analysis?.insights);

    return (
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 *KADI — WEEKLY REPORT*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +

      `📈 *TRACTION*\n` +
      `Users total       ${n(s.growth.totalUsers)}\n` +
      `Actifs 30j        ${n(s.growth.active30)}\n` +
      `Actifs 7j         ${n(s.growth.active7)}\n\n` +

      `⚡ *USAGE*\n` +
      `Docs total        ${n(s.usage.docsTotal)}\n` +
      `Docs 30j          ${n(s.usage.docs30d)}\n` +
      `Docs 7j           ${n(s.usage.docs7d)}\n\n` +

      `💰 *MONÉTISATION*\n` +
      `CA 30j            ${safeMoney(money, s.monetization.revenue30d)} FCFA\n` +
      `Payants           ${n(s.monetization.payingUsers)}\n` +
      `0 crédit          ${n(s.monetization.usersZeroCredits)}\n\n` +

      `🎯 *FUNNEL*\n` +
      `Signup→Actif      ${n(s.funnel.signupToActive30Rate)}%\n` +
      `Actif→Doc         ${n(s.funnel.activeToCreatedRate)}%\n` +
      `Doc→Payé          ${n(s.funnel.generatedToPaidRate)}%\n\n` +

      (alerts.length
        ? `🚨 *ALERTES*\n${alerts.join("\n")}\n\n`
        : "") +

      `🧠 *INSIGHT*\n` +
      `${txt(insights[0] || s.summary, "Rien de critique cette semaine.")}\n\n` +

      `✅ *ACTION PRIORITAIRE*\n` +
      `${txt(
        analysis?.priorityAction || s.priorityAction,
        "Continuer à observer les métriques."
      )}\n\n` +

      `━━━━━━━━━━━━━━━━━━━━`
    );
  }

  async function handleStatsCommand(from) {
    try {
      const raw = await getStats();
      const s = normalizeYcStats(raw);
      const msg = buildDashboardMessage(s);

      await sendText(from, msg);
      return true;
    } catch (e) {
      console.error("[KADI/STATS] error:", e);
      await sendText(from, "⚠️ Impossible de charger les stats YC.");
      return true;
    }
  }

  async function handleTopClientsCommand(from) {
    try {
      const raw = await getStats();
      const s = normalizeYcStats(raw);
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
      const s = normalizeYcStats(raw);
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
      const s = normalizeYcStats(raw);

      const fallbackAnalysis = {
        alerts: s.alerts,
        insights: s.insights,
        priorityAction:
          s.priorityAction || "Continuer à observer les métriques.",
      };

      const analysis =
        typeof buildInsights === "function"
          ? buildInsights(raw || s)
          : fallbackAnalysis;

      const msg = buildWeeklyReportMessage(s, analysis);

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