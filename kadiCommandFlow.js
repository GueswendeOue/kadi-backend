"use strict";

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
    handleReengageZeroDocsCommand,
    handleReengageInactiveCommand,

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
      "Une fois activé, KADI proposera avant chaque PDF :\n" +
      "• *Avec tampon* : 2 crédits\n" +
      "• *Sans tampon* : 1 crédit\n\n" +
      "📷 L’envoi direct d’une photo de tampon n’est pas encore disponible.";

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

  // ===============================
  // USER COMMANDS
  // ===============================
  async function handleUserCommand(from, text) {
    const t = lowerText(text);
    if (!t) return false;

    if (isOneOf(t, ["menu", "home", "accueil"])) {
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
