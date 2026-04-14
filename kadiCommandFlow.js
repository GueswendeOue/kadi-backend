"use strict";

function makeKadiCommandFlow(deps) {
  const {
    sendText,

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

    // helpers
    norm,
  } = deps;

  function normalizeText(text = "") {
    return String(norm ? norm(text) : text || "").trim();
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

  // ===============================
  // USER COMMANDS
  // ===============================
  async function handleUserCommand(from, text) {
    const t = normalizeText(text);
    if (!t) return false;

    if (isOneOf(t, ["menu", "home", "accueil"])) {
      await sendHomeMenu(from);
      return true;
    }

    if (isOneOf(t, ["profil", "profile"])) {
      await startProfileFlow(from);
      return true;
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
    const t = normalizeText(text);

    if (!from) return false;
    if (!t) return false;
    if (!ensureAdmin(identity)) return false;

    // broadcast
    if (t.startsWith("/broadcast ")) {
      return runIfExists(
        from,
        handleBroadcastCommand,
        "Service broadcast",
        from,
        raw
      );
    }

    // stats
    if (t === "/stats") {
      return runIfExists(from, handleStatsCommand, "Stats", from, raw);
    }

    if (t === "/top_users") {
      return runIfExists(from, handleTopUsersCommand, "Top users", from, raw);
    }

    if (t === "/top_clients") {
      return runIfExists(from, handleTopClientsCommand, "Top clients", from, raw);
    }

    if (t === "/weekly_report") {
      return runIfExists(
        from,
        handleWeeklyReportCommand,
        "Weekly report",
        from,
        raw
      );
    }

    if (t === "/export_excel") {
      return runIfExists(
        from,
        handleExportExcelCommand,
        "Export Excel",
        from,
        raw
      );
    }

    // manual credit command placeholder
    if (t.startsWith("/credit ")) {
      const parts = splitArgs(raw);

      if (parts.length < 3) {
        await sendText(from, "❌ Format: /credit numero montant");
        return true;
      }

      const target = String(parts[1] || "").trim();
      const amount = Number(parts[2]);

      if (!target || !Number.isFinite(amount) || amount <= 0) {
        await sendText(from, "❌ Données invalides.");
        return true;
      }

      await sendText(
        from,
        `✅ Commande reçue.\nNuméro: ${target}\nMontant: ${amount}`
      );
      return true;
    }

    // re-engagement
    if (t.startsWith("/reengage_zero_docs")) {
      return runIfExists(
        from,
        handleReengageZeroDocsCommand,
        "Service re-engagement zero-docs",
        from,
        raw
      );
    }

    if (t.startsWith("/reengage_inactive")) {
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