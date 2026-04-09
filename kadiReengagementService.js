"use strict";

function makeKadiReengagementService(deps) {
  const {
    sendText,
    getZeroDocUsersBySegment,
    getInactiveUsers,
    sendZeroDocReOnboarding,
    sendReactivationNudge,
  } = deps;

  async function handleReengageZeroDocsCommand(from, text) {
    const m = String(text || "")
      .trim()
      .match(/^\/reengage_zero_docs\s+(\d+)\s+([AB])$/i);

    if (!m) return false;

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

    const limit = Number(m[1] || 50);
    const variant = String(m[2] || "A").toUpperCase();

    const users = await getZeroDocUsersBySegment(limit, variant);

    if (!users.length) {
      await sendText(
        from,
        `ℹ️ Aucun utilisateur zéro document trouvé pour le segment ${variant}.`
      );
      return true;
    }

    let sent = 0;
    let failed = 0;

    for (const user of users) {
      try {
        await sendZeroDocReOnboarding(user, variant);
        sent += 1;
      } catch (e) {
        failed += 1;
        console.warn("[KADI/REENGAGE/ZERO_DOCS]", e?.message);
      }
    }

    await sendText(
      from,
      [
        "✅ Re-engagement zéro docs terminé.",
        `Segment : ${variant}`,
        `Ciblés : ${users.length}`,
        `Envoyés : ${sent}`,
        `Échecs : ${failed}`,
      ].join("\n")
    );

    return true;
  }

  async function handleReengageInactiveCommand(from, text) {
    const m = String(text || "")
      .trim()
      .match(/^\/reengage_inactive\s+(\d+)\s+(\d+)$/i);

    if (!m) return false;

    if (
      typeof getInactiveUsers !== "function" ||
      typeof sendReactivationNudge !== "function"
    ) {
      await sendText(
        from,
        "❌ Re-engagement non branché. Il manque le repo ou la fonction d’envoi."
      );
      return true;
    }

    const days = Number(m[1] || 7);
    const limit = Number(m[2] || 50);

    const users = await getInactiveUsers(days, limit);

    if (!users.length) {
      await sendText(
        from,
        `ℹ️ Aucun utilisateur inactif trouvé pour ${days} jour(s).`
      );
      return true;
    }

    let sent = 0;
    let failed = 0;

    for (const user of users) {
      try {
        await sendReactivationNudge(user, days);
        sent += 1;
      } catch (e) {
        failed += 1;
        console.warn("[KADI/REENGAGE/INACTIVE]", e?.message);
      }
    }

    await sendText(
      from,
      [
        "✅ Re-engagement inactifs terminé.",
        `Jours : ${days}`,
        `Ciblés : ${users.length}`,
        `Envoyés : ${sent}`,
        `Échecs : ${failed}`,
      ].join("\n")
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