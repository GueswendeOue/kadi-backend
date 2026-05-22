"use strict";

const { isGlobalMenuText } = require("./kadiGlobalNav");

function makeKadiCommandFlow(deps) {
  const {
    sendText,
    sendButtons = null,

    // user actions
    startProfileFlow,
    sendHomeMenu,
    sendCreditsMenu,
    sendRechargePacksMenu,
    sendDocsMenu,

    // admin / services
    ensureAdmin,
    handleStatsCommand,
    handleTopUsersCommand,
    handleTopClientsCommand,
    handleWeeklyReportCommand,
    handleExportExcelCommand,
    handleBroadcastCommand,
    handleReengagePreviewCommand,
    handleReengageTestCommand,
    handleReengageSegmentCommand,
    handleReengageZeroDocsCommand,
    handleReengageInactiveCommand,
    startCertifiedInvoiceFlow,
    supportCommandHandlers = null,
    supportPrincipalWaId = "22670626055",

    // credits
    addCredits = null,

    // helpers
    norm,
  } = deps;

  function normalizeText(text = "") {
    return String(norm ? norm(text) : text || "").trim();
  }

  function lowerText(text = "") {
    return normalizeText(text).toLowerCase();
  }

  function splitArgs(text = "") {
    return String(text || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }

  function isOneOf(value, allowed = []) {
    const v = String(value || "").trim().toLowerCase();
    return allowed.includes(v);
  }

  function looksLikeStampIntent(text = "") {
    const t = lowerText(text);
    if (!t) return false;

    if (isOneOf(t, ["tampon", "cachet", "signature"])) return true;

    return (
      /\b(tampon|cachet|signature)\b/i.test(t) &&
      /\b(ajouter|ajoute|mettre|met|configurer|modifier|activer|desactiver|désactiver|envoyer|photo|image|mon|ma)\b/i.test(
        t
      )
    );
  }

  async function sendStampGuidance(from) {
    const message =
      "🟦 *Tampon KADI*\n\n" +
      "Le tampon se configure dans *Profil → Tampon*.\n\n" +
      "Une fois prêt, KADI proposera avant chaque PDF :\n" +
      "• *Avec tampon* : 2 crédits\n" +
      "• *Sans tampon* : 1 crédit\n\n" +
      "📷 Dans *Profil → Tampon*, vous pouvez aussi choisir *Envoyer mon tampon* pour importer une image de votre tampon/cachet.";

    if (typeof sendButtons === "function") {
      await sendButtons(from, message, [
        { id: "PROFILE_STAMP", title: "Profil/Tampon" },
        { id: "HOME_DOCS", title: "Créer document" },
        { id: "BACK_HOME", title: "Menu" },
      ]);
      return true;
    }

    await sendText(from, message);
    return true;
  }

  function startsWithCommand(text = "", command = "") {
    const t = lowerText(text);
    const c = String(command || "").trim().toLowerCase();
    return t === c || t.startsWith(`${c} `);
  }

  function isStatsLikeCommand(text = "") {
    const t = lowerText(text);

    return (
      t === "/stats" ||
      t === "stats" ||
      t === "/dashboard" ||
      t === "dashboard" ||
      t === "kpi" ||
      t === "kpis" ||
      t.startsWith("/stats ") ||
      t.startsWith("stats ") ||
      t.startsWith("/dashboard ") ||
      t.startsWith("dashboard ")
    );
  }

  function toInt(value, def = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return def;
    return Math.trunc(n);
  }

  function normalizeWaId(value = "") {
    let digits = String(value || "").replace(/\D/g, "");

    if (!digits) return null;

    if (digits.startsWith("00")) {
      digits = digits.slice(2);
    }

    if (digits.length === 8) {
      digits = `226${digits}`;
    }

    if (digits.length < 8 || digits.length > 15) {
      return null;
    }

    return digits;
  }

  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function safeReference(value = "") {
    return String(value || "")
      .trim()
      .replace(/[^a-zA-Z0-9._:-]/g, "_")
      .slice(0, 80);
  }

  function buildManualTopupOperationKey({
    waId,
    credits,
    amountFcfa,
    reference,
  }) {
    const ref = safeReference(reference);

    if (ref) {
      return `manual_om_topup:${waId}:${credits}:${amountFcfa}:${ref}`;
    }

    return `manual_om_topup:${waId}:${credits}:${amountFcfa}:${Date.now()}`;
  }

  function isSupportAdmin(identity) {
    const from = normalizeWaId(identity?.wa_id || identity?.from || identity?.id || "");
    const principal = normalizeWaId(supportPrincipalWaId);
    return ensureAdmin(identity) || (!!from && !!principal && from === principal);
  }

  function isSupportCommand(text = "") {
    const t = lowerText(text);
    return (
      t === "/support_list" ||
      t === "/support_agents" ||
      startsWithCommand(t, "/support_reply") ||
      startsWithCommand(t, "/support_close") ||
      startsWithCommand(t, "/support_status") ||
      startsWithCommand(t, "/support_agent_add") ||
      startsWithCommand(t, "/support_agent_disable")
    );
  }

  function extractSupportReply(raw = "") {
    const match = String(raw || "").match(/^\/support_reply\s+(\S+)\s+([\s\S]+)$/i);
    if (!match) return null;
    return {
      waId: normalizeWaId(match[1]),
      message: String(match[2] || "").trim(),
    };
  }

  async function handleSupportAdminCommand(from, raw) {
    const t = lowerText(raw);
    const handlers = supportCommandHandlers || {};

    if (t === "/support_list") {
      if (typeof handlers.listOpenSessionsText !== "function") {
        return sendUnavailable(from, "Support");
      }
      await sendText(from, await handlers.listOpenSessionsText());
      return true;
    }

    if (t === "/support_agents") {
      if (typeof handlers.agentsText !== "function") {
        return sendUnavailable(from, "Support agents");
      }
      await sendText(from, await handlers.agentsText());
      return true;
    }

    if (startsWithCommand(t, "/support_reply")) {
      if (typeof handlers.replyToClient !== "function") {
        return sendUnavailable(from, "Support reply");
      }

      const parsed = extractSupportReply(raw);
      if (!parsed?.waId || !parsed.message) {
        await sendText(
          from,
          "❌ Format invalide.\n\nFormat : /support_reply <wa_id> <message>"
        );
        return true;
      }

      const result = await handlers.replyToClient({
        agentWaId: from,
        clientWaId: parsed.waId,
        message: parsed.message,
      });

      await sendText(
        from,
        result?.ok
          ? `✅ Réponse envoyée à +${parsed.waId}.`
          : `❌ ${result?.error || "Réponse non envoyée."}`
      );
      return true;
    }

    if (startsWithCommand(t, "/support_close")) {
      if (typeof handlers.closeSession !== "function") {
        return sendUnavailable(from, "Support close");
      }

      const targetWaId = normalizeWaId(splitArgs(raw)[1]);
      if (!targetWaId) {
        await sendText(from, "❌ Format invalide.\n\nFormat : /support_close <wa_id>");
        return true;
      }

      const result = await handlers.closeSession({
        agentWaId: from,
        clientWaId: targetWaId,
      });

      await sendText(
        from,
        result?.ok
          ? `✅ Session support fermée pour +${targetWaId}.`
          : `❌ ${result?.error || "Session non fermée."}`
      );
      return true;
    }

    if (startsWithCommand(t, "/support_status")) {
      if (typeof handlers.statusText !== "function") {
        return sendUnavailable(from, "Support status");
      }

      const targetWaId = normalizeWaId(splitArgs(raw)[1]);
      if (!targetWaId) {
        await sendText(from, "❌ Format invalide.\n\nFormat : /support_status <wa_id>");
        return true;
      }

      await sendText(from, await handlers.statusText(targetWaId));
      return true;
    }

    if (startsWithCommand(t, "/support_agent_add")) {
      if (typeof handlers.addAgent !== "function") {
        return sendUnavailable(from, "Support agent add");
      }

      const parts = splitArgs(raw);
      const targetWaId = normalizeWaId(parts[1]);
      const name = parts.slice(2).join(" ").trim();
      if (!targetWaId || !name) {
        await sendText(
          from,
          "❌ Format invalide.\n\nFormat : /support_agent_add <wa_id> <nom>"
        );
        return true;
      }

      await handlers.addAgent({ waId: targetWaId, name });
      await sendText(from, `✅ Agent support ajouté : ${name} (+${targetWaId}).`);
      return true;
    }

    if (startsWithCommand(t, "/support_agent_disable")) {
      if (typeof handlers.disableAgent !== "function") {
        return sendUnavailable(from, "Support agent disable");
      }

      const targetWaId = normalizeWaId(splitArgs(raw)[1]);
      if (!targetWaId) {
        await sendText(
          from,
          "❌ Format invalide.\n\nFormat : /support_agent_disable <wa_id>"
        );
        return true;
      }

      await handlers.disableAgent(targetWaId);
      await sendText(from, `✅ Agent support désactivé : +${targetWaId}.`);
      return true;
    }

    return false;
  }

  function safeNote(value = "") {
    return String(value || "")
      .trim()
      .replace(/[^\p{L}\p{N}\s._:-]/gu, "_")
      .replace(/\s+/g, " ")
      .slice(0, 160);
  }

  function buildTestCreditOperationKey({ waId, credits, note }) {
    const cleanNote = safeReference(note);

    if (cleanNote) {
      return `admin_test_credit:${waId}:${credits}:${cleanNote}`;
    }

    return `admin_test_credit:${waId}:${credits}:${Date.now()}`;
  }

  function formatMoney(value) {
    return `${Math.round(toInt(value, 0)).toLocaleString("fr-FR")} FCFA`;
  }

  async function sendUnavailable(from, label) {
    await sendText(from, `❌ ${label} non disponible.`);
    return true;
  }

  async function runIfExists(from, handler, label, ...args) {
    if (typeof handler !== "function") {
      return sendUnavailable(from, label);
    }

    return handler(...args);
  }

  async function handleManualCreditCommand(from, raw) {
    if (typeof addCredits !== "function") {
      await sendText(
        from,
        "❌ Recharge admin indisponible.\n\nLe service addCredits n’est pas branché dans kadiEngine.js."
      );
      return true;
    }

    const parts = splitArgs(raw);

    if (parts.length < 4) {
      await sendText(
        from,
        "❌ Format invalide.\n\n" +
          "Format attendu :\n" +
          "/credit numero credits montant [reference]\n\n" +
          "Exemple :\n" +
          "/credit 22671630608 10 1000\n\n" +
          "Avec référence :\n" +
          "/credit 22671630608 10 1000 OM12345"
      );
      return true;
    }

    const targetWaId = normalizeWaId(parts[1]);
    const credits = toInt(parts[2], 0);
    const amountFcfa = toInt(parts[3], 0);
    const reference = safeReference(parts[4] || "");

    if (!targetWaId) {
      await sendText(
        from,
        "❌ Numéro invalide.\n\nExemple : /credit 22671630608 10 1000"
      );
      return true;
    }

    if (credits <= 0 || credits > 10000) {
      await sendText(
        from,
        "❌ Nombre de crédits invalide.\n\nExemple : /credit 22671630608 10 1000"
      );
      return true;
    }

    if (amountFcfa <= 0 || amountFcfa > 10000000) {
      await sendText(
        from,
        "❌ Montant invalide.\n\nExemple : /credit 22671630608 10 1000"
      );
      return true;
    }

    const operationKey = buildManualTopupOperationKey({
      waId: targetWaId,
      credits,
      amountFcfa,
      reference,
    });

    let result = null;

    try {
      result = await addCredits(
        { waId: targetWaId },
        credits,
        "manual_om_topup",
        operationKey,
        {
          amountFcfa,
          credits,
          paymentMethod: "orange_money_manual",
          source: "admin_command",
          adminWaId: from,
          waId: targetWaId,
          reference: reference || null,
          date: todayKey(),
          note: `Recharge admin ${formatMoney(amountFcfa)} pour ${credits} crédits`,
        }
      );
    } catch (err) {
      await sendText(
        from,
        "❌ Recharge non effectuée.\n\n" +
          `Erreur : ${String(err?.message || err || "unknown_error")}`
      );
      return true;
    }

    const balance = toInt(result?.balance, 0);
    const idempotent = result?.idempotent === true;

    let clientNotified = false;
    let notifyError = null;

    try {
      await sendText(
        targetWaId,
        "✅ Votre recharge KADI a été validée.\n\n" +
          `🎉 ${credits} crédits ont été ajoutés à votre compte.\n` +
          `Votre solde actuel est de ${balance} crédit(s).\n\n` +
          "Vous pouvez maintenant créer vos devis, factures ou reçus sur WhatsApp.\n\n" +
          "Tapez “solde” pour vérifier vos crédits."
      );

      clientNotified = true;
    } catch (err) {
      notifyError = String(err?.message || err || "notification_failed");
    }

    let adminMessage = "";
    adminMessage += idempotent
      ? "ℹ️ Recharge déjà enregistrée.\n\n"
      : "✅ Recharge validée.\n\n";

    adminMessage += `👤 Client : +${targetWaId}\n`;
    adminMessage += `💳 Crédits ajoutés : ${credits}\n`;
    adminMessage += `💰 Montant : ${formatMoney(amountFcfa)}\n`;
    adminMessage += `📊 Nouveau solde : ${balance} crédit(s)\n`;
    adminMessage += `🔑 Opération : ${operationKey}\n`;

    if (reference) {
      adminMessage += `🧾 Référence : ${reference}\n`;
    }

    adminMessage += clientNotified
      ? "\n📩 Client notifié automatiquement."
      : `\n⚠️ Crédit ajouté, mais notification client non envoyée.\nRaison : ${notifyError}`;

    await sendText(from, adminMessage);
    return true;
  }

  async function handleTestCreditCommand(from, raw) {
    if (typeof addCredits !== "function") {
      await sendText(
        from,
        "❌ Crédit test indisponible.\n\nLe service addCredits n’est pas branché dans kadiEngine.js."
      );
      return true;
    }

    const parts = splitArgs(raw);

    if (parts.length < 3) {
      await sendText(
        from,
        "❌ Format invalide.\n\n" +
          "Format attendu :\n" +
          "/test_credit wa_id credits [note]\n\n" +
          "Exemple :\n" +
          "/test_credit 22671630608 20 test_tampon"
      );
      return true;
    }

    const targetWaId = normalizeWaId(parts[1]);
    const credits = toInt(parts[2], 0);
    const note = safeNote(parts.slice(3).join(" "));

    if (!targetWaId) {
      await sendText(
        from,
        "❌ Numéro invalide.\n\nExemple : /test_credit 22671630608 20 test_tampon"
      );
      return true;
    }

    if (credits <= 0 || credits > 10000) {
      await sendText(
        from,
        "❌ Nombre de crédits invalide.\n\nExemple : /test_credit 22671630608 20 test_tampon"
      );
      return true;
    }

    const operationKey = buildTestCreditOperationKey({
      waId: targetWaId,
      credits,
      note,
    });

    try {
      await addCredits(
        { waId: targetWaId },
        credits,
        "admin_test_credit",
        operationKey,
        {
          source: "admin_test_command",
          isTestCredit: true,
          excludeFromRevenue: true,
          amountFcfa: 0,
          revenueFcfa: 0,
          credits,
          adminWaId: from,
          waId: targetWaId,
          note: note || null,
          date: todayKey(),
        }
      );
    } catch (err) {
      await sendText(
        from,
        "❌ Crédit test non ajouté.\n\n" +
          `Erreur : ${String(err?.message || err || "unknown_error")}`
      );
      return true;
    }

    await sendText(
      from,
      `✅ ${credits} crédits test ajoutés à ${targetWaId}. Aucun paiement réel enregistré.`
    );
    return true;
  }

  // ===============================
  // USER COMMANDS
  // ===============================
  async function handleUserCommand(from, text) {
    const t = lowerText(text);
    if (!t) return false;

    if (isGlobalMenuText(t)) {
      await sendHomeMenu(from);
      return true;
    }

    if (isOneOf(t, ["profil", "profile"])) {
      await startProfileFlow(from);
      return true;
    }

    if (looksLikeStampIntent(text)) {
      return sendStampGuidance(from);
    }

    if (
      isOneOf(t, [
        "solde",
        "credit",
        "credits",
        "crédit",
        "crédits",
      ])
    ) {
      await sendCreditsMenu(from);
      return true;
    }

    if (isOneOf(t, ["recharge", "recharger", "acheter"])) {
      await sendRechargePacksMenu(from);
      return true;
    }

    if (isOneOf(t, ["doc", "docs", "document", "documents"])) {
      await sendDocsMenu(from);
      return true;
    }

    return false;
  }

  // ===============================
  // ADMIN COMMANDS
  // ===============================
  async function handleAdmin(identity, text) {
    const from = identity?.wa_id || identity?.from || identity?.id;
    const raw = String(text || "");
    const t = lowerText(text);

    if (!from) return false;
    if (!t) return false;

    if (isSupportCommand(t)) {
      if (!isSupportAdmin(identity)) return false;
      return handleSupportAdminCommand(from, raw);
    }

    if (!ensureAdmin(identity)) return false;

    // broadcast
    if (startsWithCommand(t, "/broadcast")) {
      return runIfExists(
        from,
        handleBroadcastCommand,
        "Service broadcast",
        from,
        raw
      );
    }

    // stats family
    if (isStatsLikeCommand(t)) {
      return runIfExists(from, handleStatsCommand, "Stats", from, raw);
    }

    // manual paid credit topup
    if (startsWithCommand(t, "/credit")) {
      return handleManualCreditCommand(from, raw);
    }

    // admin/test credits, excluded from real payment metrics
    if (startsWithCommand(t, "/test_credit")) {
      return handleTestCreditCommand(from, raw);
    }

    // internal Pré-FEC test mode, admin only
    if (startsWithCommand(t, "/prefec") || startsWithCommand(t, "/admin_fec")) {
      return runIfExists(
        from,
        startCertifiedInvoiceFlow,
        "Mode test FEC interne",
        from
      );
    }

    // optional legacy dedicated stats commands
    if (startsWithCommand(t, "/top_users")) {
      return runIfExists(
        from,
        handleTopUsersCommand,
        "Top users",
        from,
        raw
      );
    }

    if (startsWithCommand(t, "/top_clients")) {
      return runIfExists(
        from,
        handleTopClientsCommand,
        "Top clients",
        from,
        raw
      );
    }

    if (startsWithCommand(t, "/weekly_report")) {
      return runIfExists(
        from,
        handleWeeklyReportCommand,
        "Weekly report",
        from,
        raw
      );
    }

    if (startsWithCommand(t, "/export_excel")) {
      return runIfExists(
        from,
        handleExportExcelCommand,
        "Export Excel",
        from,
        raw
      );
    }

    // re-engagement
    if (startsWithCommand(t, "/reengage_preview")) {
      return runIfExists(
        from,
        handleReengagePreviewCommand,
        "Service re-engagement preview",
        from,
        raw
      );
    }

    if (startsWithCommand(t, "/reengage_test")) {
      return runIfExists(
        from,
        handleReengageTestCommand,
        "Service re-engagement test",
        from,
        raw
      );
    }

    if (startsWithCommand(t, "/reengage_segment")) {
      return runIfExists(
        from,
        handleReengageSegmentCommand,
        "Service re-engagement segment",
        from,
        raw
      );
    }

    if (startsWithCommand(t, "/reengage_zero_docs")) {
      return runIfExists(
        from,
        handleReengageZeroDocsCommand,
        "Service re-engagement zero-docs",
        from,
        raw
      );
    }

    if (startsWithCommand(t, "/reengage_inactive")) {
      return runIfExists(
        from,
        handleReengageInactiveCommand,
        "Service re-engagement inactifs",
        from,
        raw
      );
    }

    return false;
  }

  // ===============================
  // MAIN ENTRY
  // ===============================
  async function handleCommand(from, text, identity) {
    if (!text) return false;

    if (await handleAdmin(identity, text)) return true;
    if (await handleUserCommand(from, text)) return true;

    return false;
  }

  return {
    handleCommand,
    handleAdmin,
    handleUserCommand,
  };
}

module.exports = {
  makeKadiCommandFlow,
};
