"use strict";

const { sendSmartReengagement } = require("./kadiSmartReengagement");
const { notifyAdminReengagement } = require("./kadiAdminNotifier");
const {
  buildInactiveMessage,
  getZeroDocMessageByVariant,
} = require("./kadiReengagementMessages");

function normalizeUsers(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      wa_id: String(row?.wa_id || "").trim(),
      last_activity_at: row?.last_activity_at || row?.created_at || null,
    }))
    .filter((row) => !!row.wa_id);
}

async function runBatch({
  users,
  sendText,
  sendTemplateMessage = null,
  messageText,
  templateName = null,
}) {
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
      messageText,
      templateName,
    });

    if (res.ok && res.mode === "free") stats.sent += 1;
    else if (res.ok && res.mode === "template") stats.template += 1;
    else if (res.reason === "blocked_24h") stats.blocked += 1;
    else stats.failed += 1;
  }

  return stats;
}

async function runReengagementCycle({
  sendText,
  sendTemplateMessage = null,
  getZeroDocUsersBySegment,
  getInactiveUsers,
  adminWaId = null,
  zeroDocsLimit = 30,
  inactiveDays = 30,
  inactiveLimit = 30,
}) {
  if (typeof sendText !== "function") {
    throw new Error("sendText manquant");
  }

  if (typeof getZeroDocUsersBySegment !== "function") {
    throw new Error("getZeroDocUsersBySegment manquant");
  }

  if (typeof getInactiveUsers !== "function") {
    throw new Error("getInactiveUsers manquant");
  }

  console.log("[KADI/REENGAGEMENT] cycle start");

  const zeroDocsUsers = normalizeUsers(
    await getZeroDocUsersBySegment(zeroDocsLimit, "A")
  );

  const zeroStats = await runBatch({
    users: zeroDocsUsers,
    sendText,
    sendTemplateMessage,
    messageText: getZeroDocMessageByVariant("A"),
    templateName: null,
  });

  if (adminWaId) {
    await notifyAdminReengagement({
      sendText,
      adminWaId,
      type: "auto_zero_docs",
      stats: zeroStats,
    });
  }

  const inactiveUsers = normalizeUsers(
    await getInactiveUsers(inactiveDays, inactiveLimit)
  );

  const inactiveStats = await runBatch({
    users: inactiveUsers,
    sendText,
    sendTemplateMessage,
    messageText: buildInactiveMessage(inactiveDays),
    templateName: null,
  });

  if (adminWaId) {
    await notifyAdminReengagement({
      sendText,
      adminWaId,
      type: `auto_inactive_${inactiveDays}d`,
      stats: inactiveStats,
    });
  }

  console.log("[KADI/REENGAGEMENT] cycle done", {
    zeroDocs: zeroStats,
    inactive: inactiveStats,
  });

  return {
    zeroDocs: zeroStats,
    inactive: inactiveStats,
  };
}

module.exports = {
  runReengagementCycle,
};