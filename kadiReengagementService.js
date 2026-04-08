"use strict";

function makeKadiReengagementService(deps) {
  const {
    sendText,
    getZeroDocUsersBySegment,
    getInactiveUsers,
    sendZeroDocReOnboarding,
    sendReactivationNudge,
  } = deps;

  function parsePositiveInt(value, fallback = 0, max = 500) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.floor(n), max);
  }

  function splitArgs(text = "") {
    return String(text || "").trim().split(/\s+/).filter(Boolean);
  }

  async function handleReengageZeroDocsCommand(from, rawText) {
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

    const parts = splitArgs(rawText);
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

  async function handleReengageInactiveCommand(from, rawText) {
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

    const parts = splitArgs(rawText);
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

  return {
    handleReengageZeroDocsCommand,
    handleReengageInactiveCommand,
  };
}

module.exports = {
  makeKadiReengagementService,
};