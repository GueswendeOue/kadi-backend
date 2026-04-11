"use strict";

function makeKadiCommandFlow(deps) {
  const {
    sendText,

    startProfileFlow,
    sendHomeMenu,
    sendCreditsMenu,
    sendRechargePacksMenu,
    sendDocsMenu,

    ensureAdmin,
    handleStatsCommand,
    handleTopUsersCommand,
    handleTopClientsCommand,
    handleWeeklyReportCommand,
    handleExportExcelCommand,
    handleBroadcastCommand,
    handleReengageZeroDocsCommand,
    handleReengageInactiveCommand,

    norm,
  } = deps;

  function splitArgs(text = "") {
    return String(text || "").trim().split(/\s+/).filter(Boolean);
  }

  function isOneOf(value, allowed = []) {
    return allowed.includes(String(value || "").trim().toLowerCase());
  }

  async function handleUserCommand(from, text) {
    const t = norm(text);
    if (!t) return false;

    if (isOneOf(t, ["menu", "home", "accueil"])) {
      await sendHomeMenu(from);
      return true;
    }

    if (isOneOf(t, ["profil", "profile"])) {
      await startProfileFlow(from);
      return true;
    }

    if (isOneOf(t, ["solde", "credit", "credits", "crédit", "crédits"])) {
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

  async function handleAdmin(identity, text) {
    const from = identity?.wa_id || identity?.from || identity?.id;
    const raw = String(text || "");
    const t = norm(text);

    if (!ensureAdmin(identity)) return false;
    if (!t) return false;

    if (t.startsWith("/broadcast ")) {
      if (typeof handleBroadcastCommand !== "function") {
        await sendText(from, "❌ Service broadcast non disponible.");
        return true;
      }
      return handleBroadcastCommand(from, raw);
    }

    if (t === "/stats") {
      if (typeof handleStatsCommand !== "function") {
        await sendText(from, "📊 Stats non disponibles.");
        return true;
      }
      return handleStatsCommand(from, raw);
    }

    if (t === "/top_users") {
      if (typeof handleTopUsersCommand !== "function") {
        await sendText(from, "📊 Top users non disponibles.");
        return true;
      }
      return handleTopUsersCommand(from, raw);
    }

    if (t === "/top_clients") {
      if (typeof handleTopClientsCommand !== "function") {
        await sendText(from, "📊 Top clients non disponibles.");
        return true;
      }
      return handleTopClientsCommand(from, raw);
    }

    if (t === "/weekly_report") {
      if (typeof handleWeeklyReportCommand !== "function") {
        await sendText(from, "📊 Weekly report non disponible.");
        return true;
      }
      return handleWeeklyReportCommand(from, raw);
    }

    if (t === "/export_excel") {
      if (typeof handleExportExcelCommand !== "function") {
        await sendText(from, "📁 Export Excel non disponible.");
        return true;
      }
      return handleExportExcelCommand(from, raw);
    }

    if (t.startsWith("/credit ")) {
      const parts = splitArgs(raw);

      if (parts.length < 3) {
        await sendText(from, "❌ Format: /credit numero montant");
        return true;
      }

      const target = parts[1];
      const amount = Number(parts[2]);

      if (!target || !Number.isFinite(amount) || amount <= 0) {
        await sendText(from, "❌ Données invalides.");
        return true;
      }

      await sendText(from, `✅ Crédit ajouté à ${target}: ${amount}`);
      return true;
    }

    if (t.startsWith("/reengage_zero_docs")) {
      if (typeof handleReengageZeroDocsCommand !== "function") {
        await sendText(from, "❌ Service re-engagement zero-docs non disponible.");
        return true;
      }
      return handleReengageZeroDocsCommand(from, raw);
    }

    if (t.startsWith("/reengage_inactive")) {
      if (typeof handleReengageInactiveCommand !== "function") {
        await sendText(from, "❌ Service re-engagement inactifs non disponible.");
        return true;
      }
      return handleReengageInactiveCommand(from, raw);
    }

    return false;
  }

  async function handleCommand(from, text, identity) {
    if (!text) return false;

    if (await handleAdmin(identity, text)) return true;
    if (await handleUserCommand(from, text)) return true;

    return false;
  }

  return {
    handleCommand,
    handleAdmin,
  };
}

module.exports = {
  makeKadiCommandFlow,
};