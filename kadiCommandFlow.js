"use strict";

function makeKadiCommandFlow(deps) {
  const {
    sendText,

    // flows
    startProfileFlow,
    sendHomeMenu,
    sendCreditsMenu,
    sendRechargePacksMenu,
    sendDocsMenu,

    // business
    ensureAdmin,
    broadcastToAllKnownUsers,

    // stats
    handleStatsCommand,

    // onboarding / re-engagement
    sendZeroDocReOnboarding,
    sendReactivationNudge,

    // repos / queries
    getZeroDocUsersBySegment,
    getInactiveUsers,

    // helpers
    norm,
  } = deps;

  function parsePositiveInt(value, fallback = 0, max = 500) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.floor(n), max);
  }

  // ===============================
  // USER COMMANDS (STRICT ONLY)
  // ===============================
  async function handleUserCommand(from, text) {
    const t = norm(text);
    if (!t) return false;

    if (["menu", "home", "accueil"].includes(t)) {
      await sendHomeMenu(from);
      return true;
    }

    if (["profil", "profile"].includes(t)) {
      await startProfileFlow(from);
      return true;
    }

    if (["solde", "credit", "credits", "crédit", "crédits"].includes(t)) {
      await sendCreditsMenu(from);
      return true;
    }

    if (["recharge", "recharger", "acheter"].includes(t)) {
      await sendRechargePacksMenu(from);
      return true;
    }

    if (["doc", "docs", "document", "documents"].includes(t)) {
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
    const raw = String(text || "");
    const t = norm(text);

    if (!ensureAdmin(identity)) return false;

    // ===== broadcast texte =====
    if (t.startsWith("/broadcast ")) {
      const msg = raw.slice(11).trim();

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
    if (t === "/stats") {
      if (handleStatsCommand) {
        await handleStatsCommand(from, raw);
      } else {
        await sendText(from, "📊 Stats non disponibles.");
      }
      return true;
    }

    // ===== recharge manuelle =====
    if (t.startsWith("/credit ")) {
      const parts = raw.trim().split(/\s+/);

      if (parts.length < 3) {
        await sendText(from, "❌ Format: /credit numero montant");
        return true;
      }

      const target = parts[1];
      const amount = Number(parts[2]);

      if (!target || !amount || !Number.isFinite(amount) || amount <= 0) {
        await sendText(from, "❌ Données invalides.");
        return true;
      }

      await sendText(from, `✅ Crédit ajouté à ${target}: ${amount}`);
      return true;
    }

    // ===== RE-ENGAGE ZERO DOCS =====
    // Format: /reengage_zero_docs 50 A
    if (t.startsWith("/reengage_zero_docs")) {
      if (
        typeof getZeroDocUsersBySegment !== "function" ||
        typeof sendZeroDocReOnboarding !== "function"
      ) {
        await sendText(
          from,
          "❌ Re-engagement non branché. Il manque le repo ou la fonction d’envoi."
        );
        return true;
      }

      const parts = raw.trim().split(/\s+/);
      const limit = parsePositiveInt(parts[1], 20, 200);
      const segment = String(parts[2] || "A").toUpperCase();

      if (!["A", "B", "C"].includes(segment)) {
        await sendText(from, "❌ Segment invalide. Utilisez A, B ou C.");
        return true;
      }

      await sendText(
        from,
        `🚀 Lancement re-engagement zero-docs\nSegment: ${segment}\nBatch: ${limit}`
      );

      const users = await getZeroDocUsersBySegment(segment, limit);

      if (!Array.isArray(users) || users.length === 0) {
        await sendText(from, "ℹ️ Aucun utilisateur trouvé pour ce segment.");
        return true;
      }

      let sent = 0;
      let failed = 0;

      for (const user of users) {
        try {
          await sendZeroDocReOnboarding(user.wa_id, {
            daysSinceSignup: user.days_since_signup || 0,
            professionCategory: user.profession_category || null,
          });
          sent += 1;
        } catch (e) {
          failed += 1;
          console.warn("[KADI/REENGAGE/ZERO_DOCS]", e?.message, {
            waId: user?.wa_id,
            segment,
          });
        }
      }

      await sendText(
        from,
        `✅ Re-engagement terminé.\nEnvoyés: ${sent}\nÉchecs: ${failed}\nSegment: ${segment}`
      );
      return true;
    }

    // ===== RE-ENGAGE INACTIVE =====
    // Format: /reengage_inactive 30 50
    if (t.startsWith("/reengage_inactive")) {
      if (
        typeof getInactiveUsers !== "function" ||
        typeof sendReactivationNudge !== "function"
      ) {
        await sendText(
          from,
          "❌ Re-engagement inactifs non branché. Il manque le repo ou la fonction d’envoi."
        );
        return true;
      }

      const parts = raw.trim().split(/\s+/);
      const minDaysInactive = parsePositiveInt(parts[1], 30, 365);
      const limit = parsePositiveInt(parts[2], 20, 200);

      await sendText(
        from,
        `🚀 Lancement re-engagement inactifs\nInactivité min: ${minDaysInactive} jours\nBatch: ${limit}`
      );

      const users = await getInactiveUsers(minDaysInactive, limit);

      if (!Array.isArray(users) || users.length === 0) {
        await sendText(from, "ℹ️ Aucun utilisateur inactif trouvé.");
        return true;
      }

      let sent = 0;
      let failed = 0;

      for (const user of users) {
        try {
          await sendReactivationNudge(user.wa_id, {
            daysInactive: user.days_inactive || minDaysInactive,
            professionCategory: user.profession_category || null,
          });
          sent += 1;
        } catch (e) {
          failed += 1;
          console.warn("[KADI/REENGAGE/INACTIVE]", e?.message, {
            waId: user?.wa_id,
          });
        }
      }

      await sendText(
        from,
        `✅ Re-engagement inactifs terminé.\nEnvoyés: ${sent}\nÉchecs: ${failed}`
      );
      return true;
    }

    return false;
  }

  // ===============================
  // GLOBAL ENTRY
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
  };
}

module.exports = {
  makeKadiCommandFlow,
};