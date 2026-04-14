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

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function buildStats() {
  return {
    targeted: 0,
    sent: 0,
    template: 0,
    blocked: 0,
    failed: 0,
  };
}

async function runCampaign({
  users,
  sendText,
  sendTemplateMessage,
  messageText,
}) {
  const stats = buildStats();
  const normalizedUsers = normalizeUsers(users);

  stats.targeted = normalizedUsers.length;

  for (const user of normalizedUsers) {
    try {
      const res = await sendSmartReengagement({
        waId: user.wa_id,
        lastActivityAt: user.last_activity_at,
        sendText,
        sendTemplateMessage,
        messageText,
        templateName: null,
      });

      if (res?.ok && res?.mode === "free") {
        stats.sent += 1;
      } else if (res?.ok && res?.mode === "template") {
        stats.template += 1;
      } else if (res?.reason === "blocked_24h") {
        stats.blocked += 1;
      } else {
        stats.failed += 1;
      }
    } catch (_) {
      stats.failed += 1;
    }
  }

  return stats;
}

async function sendCampaignReport({
  sendText,
  from,
  title,
  metaLines = [],
  stats,
}) {
  await sendText(
    from,
    [
      `✅ ${title}`,
      ...metaLines,
      `Ciblés : ${stats.targeted}`,
      `Envoyés : ${stats.sent}`,
      `Templates : ${stats.template}`,
      `Bloqués : ${stats.blocked}`,
      `Échecs : ${stats.failed}`,
    ].join("\n")
  );
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

    const limit = clampInt(match[1], 1, 500, 50);
    const variant = String(match[2] || "A").toUpperCase();

    const rawUsers = await getZeroDocUsersBySegment(limit, variant);

    const stats = await runCampaign({
      users: rawUsers,
      sendText,
      sendTemplateMessage,
      messageText: getZeroDocMessageByVariant(variant),
    });

    await sendCampaignReport({
      sendText,
      from,
      title: "Re-engagement zéro docs terminé.",
      metaLines: [`Segment : ${variant}`],
      stats,
    });

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

    const days = clampInt(match[1], 1, 365, 30);
    const limit = clampInt(match[2], 1, 500, 50);

    const rawUsers = await getInactiveUsers(days, limit);

    const stats = await runCampaign({
      users: rawUsers,
      sendText,
      sendTemplateMessage,
      messageText: buildInactiveMessage(days),
    });

    await sendCampaignReport({
      sendText,
      from,
      title: "Re-engagement inactifs terminé.",
      metaLines: [`Jours : ${days}`],
      stats,
    });

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