"use strict";

function makeKadiStatsService(deps) {
  const {
    sendText,
    getStats,
    packCredits = 25,
    packPriceFcfa = 2000,
    money,
  } = deps;

  function safeText(v, def = "") {
    const s = String(v ?? "").trim();
    return s || def;
  }

  function toNum(v, def = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }

  function pct(v, def = 0) {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.max(0, Math.round(n));
  }

  function formatMoney(value) {
    try {
      if (typeof money === "function") return `${money(value)} FCFA`;
    } catch (_) {}

    return `${Math.round(toNum(value, 0)).toLocaleString("fr-FR")} FCFA`;
  }

  function normalizeText(text = "") {
    return String(text || "")
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ");
  }

  function isStatsCommand(text = "") {
    const t = normalizeText(text);

    return (
      t === "/stats" ||
      t === "stats" ||
      t === "dashboard" ||
      t === "/dashboard" ||
      t === "kpi" ||
      t === "kpis" ||
      t.startsWith("/stats ") ||
      t.startsWith("stats ") ||
      t.startsWith("dashboard ") ||
      t.startsWith("/dashboard ")
    );
  }

  function buildDashboard(stats = {}) {
    const totalUsers =
      toNum(stats?.growth?.totalUsers, null) ??
      toNum(stats?.users?.totalUsers, 0);

    const active30 =
      toNum(stats?.growth?.active30, null) ??
      toNum(stats?.users?.active30, 0);

    const active7 =
      toNum(stats?.growth?.active7, null) ??
      toNum(stats?.users?.active7, 0);

    const active30Rate =
      pct(stats?.growth?.active30Rate, null) ??
      pct(stats?.growth?.active30Rate, 0);

    const active7Rate =
      pct(stats?.growth?.active7Rate, null) ??
      pct(stats?.growth?.active7Rate, 0);

    const estimatedNewUsers30 = toNum(
      stats?.growth?.estimatedNewUsers30,
      0
    );

    const docsTotal =
      toNum(stats?.usage?.docsTotal, null) ??
      toNum(stats?.docs?.total, 0);

    const docs30 =
      toNum(stats?.usage?.docs30d, null) ??
      toNum(stats?.docs?.last30, 0);

    const docs7 =
      toNum(stats?.usage?.docs7d, null) ??
      toNum(stats?.docs?.last7, 0);

    const docsPerActive30 = Number(
      stats?.usage?.docsPerActive30User ?? 0
    );

    const revenue30 =
      toNum(stats?.monetization?.revenue30d, null) ??
      toNum(stats?.revenue?.month, 0);

    const payingUsers =
      toNum(stats?.monetization?.payingUsers, null) ??
      toNum(stats?.users?.paid, 0);

    const usersZeroCredits =
      toNum(stats?.monetization?.usersZeroCredits, null) ??
      toNum(stats?.conversion?.usersZeroCredits, 0);

    const usersLowCredits =
      toNum(stats?.monetization?.usersLowCredits, null) ??
      toNum(stats?.conversion?.usersLowCredits, 0);

    const signupToActive30Rate = pct(
      stats?.funnel?.signupToActive30Rate,
      0
    );

    const activeToCreatedRate = pct(
      stats?.funnel?.activeToCreatedRate,
      0
    );

    const generatedToPaidRate = pct(
      stats?.funnel?.generatedToPaidRate,
      0
    );

    const retention7Approx = pct(
      stats?.retention?.retention7Approx,
      0
    );

    const creditsPaid30d = toNum(
      stats?.monetization?.creditsPaid30d ?? stats?.revenue?.creditsPaid,
      0
    );

    const usersWithWallet = toNum(
      stats?.monetization?.usersWithWallet ?? stats?.users?.usersWithWallet,
      0
    );

    const balanceSource = safeText(
      stats?.monetization?.balanceSource,
      ""
    );

    const alerts = Array.isArray(stats?.alerts) ? stats.alerts : [];
    const insights = Array.isArray(stats?.insights) ? stats.insights : [];

    const priorityAction = safeText(
      stats?.priorityAction,
      "Continuer à améliorer la conversion vers le premier document."
    );

    let text = "";
    text += "━━━━━━━━━━━━━━━━━━━━\n";
    text += "📊 *KADI — DASHBOARD*\n";
    text += "━━━━━━━━━━━━━━━━━━━━\n\n";

    text += "📈 *TRACTION*\n";
    text += `Users total       ${totalUsers}\n`;
    text += `Actifs 30j        ${active30} (${active30Rate}%)\n`;
    text += `Actifs 7j         ${active7} (${active7Rate}%)\n`;
    text += `Nouveaux ~30j     ${estimatedNewUsers30}\n\n`;

    text += "⚡ *ACTIVATION / USAGE*\n";
    text += `Docs total        ${docsTotal}\n`;
    text += `Docs 30j          ${docs30}\n`;
    text += `Docs 7j           ${docs7}\n`;
    text += `Docs/actif 30j    ${docsPerActive30.toFixed(2)}\n\n`;

    text += "💰 *MONÉTISATION*\n";
    text += `CA 30j            ${formatMoney(revenue30)}\n`;
    text += `Payants           ${payingUsers}\n`;
    text += `Crédits payés     ${creditsPaid30d}\n`;
    text += `Wallets suivis    ${usersWithWallet}\n`;
    text += `0 crédit réel     ${usersZeroCredits}\n`;
    text += `Crédits faibles   ${usersLowCredits}\n`;

    if (balanceSource) {
      text += `Source soldes     ${balanceSource}\n`;
    }

    text += "\n";

    text += "🎯 *FUNNEL*\n";
    text += `Signup→Actif      ${signupToActive30Rate}%\n`;
    text += `Actif→Doc         ${activeToCreatedRate}%\n`;
    text += `Doc→Payé          ${generatedToPaidRate}%\n\n`;

    text += "🔁 *RÉTENTION*\n";
    text += `Retour 7j/30j     ${retention7Approx}%\n\n`;

    text += "🚨 *ALERTES*\n";
    if (alerts.length) {
      text += `${alerts.join("\n")}\n\n`;
    } else {
      text += "• Aucune alerte majeure\n\n";
    }

    text += "🧠 *INSIGHT*\n";
    text += `${safeText(
      insights[0],
      safeText(stats?.summary, "Pas encore d’insight majeur.")
    )}\n\n`;

    text += "✅ *ACTION PRIORITAIRE*\n";
    text += `${priorityAction}\n\n`;

    text += "━━━━━━━━━━━━━━━━━━━━";

    return text;
  }

  function buildTopUsersText(stats = {}) {
    const rows = Array.isArray(stats?.topUsers) ? stats.topUsers : [];

    if (!rows.length) {
      return "🏆 *Top utilisateurs (30j)*\n\nAucune donnée disponible.";
    }

    return (
      "🏆 *Top utilisateurs (30j)*\n\n" +
      rows
        .slice(0, 5)
        .map((row, idx) => {
          const userLabel = safeText(
            row?.user,
            safeText(
              row?.business_name,
              safeText(row?.owner_name, safeText(row?.wa_id, "-"))
            )
          );

          const waId = safeText(row?.wa_id, "");
          const docs = toNum(row?.docs, 0);
          const total = toNum(row?.total_fcfa, 0);

          let line = `${idx + 1}. ${userLabel}\n`;

          if (waId) {
            line += `   ID: ${waId}\n`;
          }

          line += `   Docs: ${docs}\n`;
          line += `   Total: ${formatMoney(total)}`;

          return line;
        })
        .join("\n\n")
    );
  }

  function buildTopClientsText(stats = {}) {
    const rows = Array.isArray(stats?.topClients) ? stats.topClients : [];

    if (!rows.length) {
      return "📄 *Top clients des documents (30j)*\n\nAucune donnée disponible.";
    }

    return (
      "📄 *Top clients des documents (30j)*\n\n" +
      rows
        .slice(0, 5)
        .map((row, idx) => {
          const client = safeText(row?.client, "-");
          const docs = toNum(row?.docs ?? row?.doc_count, 0);
          const total = toNum(row?.total_fcfa ?? row?.total_sum, 0);

          return (
            `${idx + 1}. ${client}\n` +
            `   Docs: ${docs}\n` +
            `   Total: ${formatMoney(total)}`
          );
        })
        .join("\n\n")
    );
  }

  function buildDetailsText(stats = {}) {
    const ocrDocs30 = toNum(
      stats?.usage?.ocrDocs30d ?? stats?.docs?.ocrDocs30,
      0
    );

    const stampedDocs30 = toNum(
      stats?.usage?.stampedDocs30d ?? stats?.docs?.stampedDocs30,
      0
    );

    const totalValue30 = toNum(
      stats?.usage?.totalDocumentValue30d ?? stats?.docs?.sum30,
      0
    );

    const totalValueAll = toNum(
      stats?.usage?.totalDocumentValueAll ?? stats?.docs?.sumAll,
      0
    );

    const revenueGrowth30d = toNum(
      stats?.comparisons?.revenue30Growth,
      0
    );

    const docs7Growth = toNum(
      stats?.comparisons?.docs7Growth,
      0
    );

    const user30Growth = toNum(
      stats?.comparisons?.user30Growth,
      0
    );

    const docsPerTotalUser = Number(
      stats?.usage?.docsPerTotalUser ?? 0
    );

    const docsPerActive7User = Number(
      stats?.usage?.docsPerActive7User ?? 0
    );

    return (
      "📎 *Détails complémentaires*\n\n" +
      `OCR 30j              ${ocrDocs30}\n` +
      `Tampon 30j           ${stampedDocs30}\n` +
      `Valeur docs 30j      ${formatMoney(totalValue30)}\n` +
      `Valeur docs totale   ${formatMoney(totalValueAll)}\n` +
      `Docs/user total      ${docsPerTotalUser.toFixed(2)}\n` +
      `Docs/actif 7j        ${docsPerActive7User.toFixed(2)}\n` +
      `Croissance CA        ${revenueGrowth30d}%\n` +
      `Croissance docs 7j   ${docs7Growth}%\n` +
      `Croissance users     ${user30Growth}%`
    );
  }

  async function handleStatsCommand(from, text) {
    if (!isStatsCommand(text)) return false;

    const t = normalizeText(text);

    const stats = await getStats({
      packCredits,
      packPriceFcfa,
    });

    // /stats clients
    // stats clients
    // dashboard clients
    if (t.includes("clients")) {
      await sendText(from, buildTopClientsText(stats));
      return true;
    }

    // /stats users
    // /stats utilisateurs
    // stats users
    if (t.includes("users") || t.includes("utilisateurs")) {
      await sendText(from, buildTopUsersText(stats));
      return true;
    }

    // /stats details
    // /stats détails
    if (t.includes("details") || t.includes("détails")) {
      await sendText(from, buildDashboard(stats));
      await sendText(from, buildDetailsText(stats));
      return true;
    }

    // /stats simple = dashboard uniquement
    await sendText(from, buildDashboard(stats));
    return true;
  }

  return {
    handleStatsCommand,
  };
}

module.exports = {
  makeKadiStatsService,
};