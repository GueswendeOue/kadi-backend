"use strict";

const { sendSmartReengagement } = require("./kadiSmartReengagement");
const { notifyAdminReengagement } = require("./kadiAdminNotifier");
const {
  getZeroDocMessageByVariant,
  buildInactiveMessage,
} = require("./kadiReengagementMessages");

function normalizeUsers(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      wa_id: String(row?.wa_id || "").trim(),
      last_activity_at: row?.last_activity_at || row?.created_at || null,
    }))
    .filter((row) => !!row.wa_id);
}

function makeKadiReengagementService({
  sendText,
  getZeroDocUsersBySegment,
  getInactiveUsers,
  sendTemplateMessage = null,
  adminWaId = null,
}) {
  async function handleReengageZeroDocsCommand(from, text) {
    const match = String(text || "")
      .trim()
      .match(/^\/reengage_zero_docs\s+(\d+)\s+([AB])$/i);

    if (!match) return false;

    if (typeof getZeroDocUsersBySegment !== "function") {
      await sendText(from, "❌ Re-engagement non branché. Repo manquant.");
      return true;
    }

    const limit = Number(match[1] || 50);
    const variant = String(match[2] || "A").toUpperCase();

    const rawUsers = await getZeroDocUsersBySegment(limit, variant);
    const users = normalizeUsers(rawUsers);

    const stats = {
      targeted: users.length,
      sent: 0,
      template: 0,
      blocked: 0,
      failed: 0,
    };

    for (const user of users) {
      const res = await sendSmartReengagement({
        waId: user.wa_id,
        lastActivityAt: user.last_activity_at,
        sendText,
        sendTemplateMessage,
        messageText: getZeroDocMessageByVariant(variant),
        templateName: null,
      });

      if (res.ok && res.mode === "free") stats.sent += 1;
      else if (res.ok && res.mode === "template") stats.template += 1;
      else if (res.reason === "blocked_24h") stats.blocked += 1;
      else stats.failed += 1;
    }

    await sendText(
      from,
      [
        "✅ Re-engagement zéro docs terminé.",
        `Segment : ${variant}`,
        `Ciblés : ${stats.targeted}`,
        `Envoyés : ${stats.sent}`,
        `Templates : ${stats.template}`,
        `Bloqués : ${stats.blocked}`,
        `Échecs : ${stats.failed}`,
      ].join("\n")
    );

    if (adminWaId) {
      await notifyAdminReengagement({
        sendText,
        adminWaId,
        type: `zero_docs_${variant}`,
        stats,
      });
    }

    return true;
  }

  async function handleReengageInactiveCommand(from, text) {
    const match = String(text || "")
      .trim()
      .match(/^\/reengage_inactive\s+(\d+)\s+(\d+)$/i);

    if (!match) return false;

    if (typeof getInactiveUsers !== "function") {
      await sendText(from, "❌ Re-engagement non branché. Repo manquant.");
      return true;
    }

    const days = Number(match[1] || 30);
    const limit = Number(match[2] || 50);

    const rawUsers = await getInactiveUsers(days, limit);
    const users = normalizeUsers(rawUsers);

    const stats = {
      targeted: users.length,
      sent: 0,
      template: 0,
      blocked: 0,
      failed: 0,
    };

    for (const user of users) {
      const res = await sendSmartReengagement({
        waId: user.wa_id,
        lastActivityAt: user.last_activity_at,
        sendText,
        sendTemplateMessage,
        messageText: buildInactiveMessage(days),
        templateName: null,
      });

      if (res.ok && res.mode === "free") stats.sent += 1;
      else if (res.ok && res.mode === "template") stats.template += 1;
      else if (res.reason === "blocked_24h") stats.blocked += 1;
      else stats.failed += 1;
    }

    await sendText(
      from,
      [
        "✅ Re-engagement inactifs terminé.",
        `Jours : ${days}`,
        `Ciblés : ${stats.targeted}`,
        `Envoyés : ${stats.sent}`,
        `Templates : ${stats.template}`,
        `Bloqués : ${stats.blocked}`,
        `Échecs : ${stats.failed}`,
      ].join("\n")
    );

    if (adminWaId) {
      await notifyAdminReengagement({
        sendText,
        adminWaId,
        type: `inactive_${days}d`,
        stats,
      });
    }

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