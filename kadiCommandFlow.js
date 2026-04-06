"use strict";

function makeKadiCommandFlow(deps) {
  const {
    getSession,
    sendText,
    sendButtons,

    // flows
    startProfileFlow,
    sendHomeMenu,
    sendCreditsMenu,
    sendRechargePacksMenu,
    sendDocsMenu,

    // business
    ensureAdmin,
    broadcastToAllKnownUsers,

    // stats (optionnel)
    handleStatsCommand,

    // helpers
    norm,
  } = deps;

  // ===============================
  // USER COMMANDS
  // ===============================

  async function handleUserCommand(from, text) {
    const t = norm(text);

    if (!t) return false;

    // menu
    if (t === "menu" || t === "home") {
      await sendHomeMenu(from);
      return true;
    }

    // profil
    if (t === "profil" || t === "profile") {
      await startProfileFlow(from);
      return true;
    }

    // crédits
    if (t.includes("crédit") || t.includes("credit")) {
      await sendCreditsMenu(from);
      return true;
    }

    // recharge
    if (t.includes("recharge") || t.includes("acheter")) {
      await sendRechargePacksMenu(from);
      return true;
    }

    // documents
    if (t.includes("document") || t.includes("facture") || t.includes("devis")) {
      await sendDocsMenu(from);
      return true;
    }

    return false;
  }

  // ===============================
  // ADMIN COMMANDS
  // ===============================

  async function handleAdmin(identity, text) {
    const from = identity?.wa_id;
    const t = norm(text);

    if (!ensureAdmin(identity)) return false;

    // ===== broadcast texte =====
    if (t.startsWith("/broadcast ")) {
      const msg = text.slice(11).trim();

      if (!msg) {
        await sendText(from, "❌ Message vide.");
        return true;
      }

      await sendText(from, "📡 Envoi en cours...");
      await broadcastToAllKnownUsers(from, msg);
      await sendText(from, "✅ Broadcast envoyé.");
      return true;
    }

    // ===== stats =====
    if (t.startsWith("/stats")) {
      if (handleStatsCommand) {
        await handleStatsCommand(from, text);
      } else {
        await sendText(from, "📊 Stats non disponibles.");
      }
      return true;
    }

    // ===== recharge manuelle (simple) =====
    if (t.startsWith("/credit ")) {
      // format: /credit 226XXXX 10
      const parts = t.split(" ");
      if (parts.length < 3) {
        await sendText(from, "❌ Format: /credit numero montant");
        return true;
      }

      const target = parts[1];
      const amount = Number(parts[2]);

      if (!target || !amount) {
        await sendText(from, "❌ Données invalides.");
        return true;
      }

      // ici tu brancheras addCredits
      await sendText(from, `✅ Crédit ajouté à ${target}: ${amount}`);
      return true;
    }

    return false;
  }

  // ===============================
  // GLOBAL ENTRY
  // ===============================

  async function handleCommand(from, text, identity) {
    if (!text) return false;

    // 1. admin prioritaire
    const adminHandled = await handleAdmin(identity, text);
    if (adminHandled) return true;

    // 2. user commands
    const userHandled = await handleUserCommand(from, text);
    if (userHandled) return true;

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