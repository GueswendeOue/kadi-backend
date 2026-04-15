"use strict";

const { sendSmartReengagement } = require("./kadiSmartReengagement");
const { notifyAdminReengagement } = require("./kadiAdminNotifier");
const {
  buildInactiveMessage,
  getZeroDocMessageByVariant,
} = require("./kadiReengagementMessages");

// ===============================
// Utils
// ===============================
function normalizeUsers(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      wa_id: String(row?.wa_id || "").trim(),
      last_activity_at: row?.last_activity_at || row?.created_at || null,
      owner_name: row?.owner_name || null, // ✅ IMPORTANT pour template
    }))
    .filter((row) => !!row.wa_id);
}

function isReasonableSendHour(date = new Date()) {
  const h = date.getHours();
  return h >= 8 && h <= 19;
}

// Anti spam simple (évite double envoi dans même cycle)
function dedupeUsers(users = []) {
  const seen = new Set();
  return users.filter((u) => {
    if (seen.has(u.wa_id)) return false;
    seen.add(u.wa_id);
    return true;
  });
}

// ===============================
// Batch sender
// ===============================
async function runBatch({
  users,
  sendText,
  sendTemplateMessage = null,
  messageText,
  templateName = null,
}) {
  const cleanUsers = dedupeUsers(users);

  const stats = {
    targeted: cleanUsers.length,
    sent: 0,
    template: 0,
    blocked: 0,
    failed: 0,
  };

  for (const user of cleanUsers) {
    try {
      const res = await sendSmartReengagement({
        waId: user.wa_id,
        lastActivityAt: user.last_activity_at,
        sendText,
        sendTemplateMessage,
        messageText,
        templateName,

        // ✅ 🔥 VARIABLE TEMPLATE (CRITIQUE)
        templateComponents: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: user.owner_name || "Client",
              },
            ],
          },
        ],
      });

      if (res?.ok && res?.mode === "free") stats.sent += 1;
      else if (res?.ok && res?.mode === "template") stats.template += 1;
      else if (res?.reason === "blocked_24h") stats.blocked += 1;
      else stats.failed += 1;
    } catch (e) {
      stats.failed += 1;
    }
  }

  return stats;
}

// ===============================
// MAIN CYCLE
// ===============================
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

  // ✅ respect des horaires (anti ban Meta)
  if (!isReasonableSendHour()) {
    console.log("[KADI/REENGAGEMENT] skipped: outside allowed hours");
    return {
      skipped: true,
      reason: "outside_allowed_hours",
    };
  }

  console.log("[KADI/REENGAGEMENT] cycle start");

  // ===============================
  // ZERO DOC USERS (HIGH PRIORITY)
  // ===============================
  const zeroDocsUsers = normalizeUsers(
    await getZeroDocUsersBySegment("A", zeroDocsLimit)
  );

  const zeroStats = await runBatch({
    users: zeroDocsUsers,
    sendText,
    sendTemplateMessage,
    messageText: getZeroDocMessageByVariant("A"),
    templateName: "kadi_zero_doc_a_v1", // ✅ ton template Meta
  });

  if (adminWaId) {
    await notifyAdminReengagement({
      sendText,
      adminWaId,
      type: "auto_zero_docs",
      stats: zeroStats,
    });
  }

  // ===============================
  // INACTIVE USERS
  // ===============================
  const inactiveUsers = normalizeUsers(
    await getInactiveUsers(inactiveDays, inactiveLimit)
  );

  const inactiveStats = await runBatch({
    users: inactiveUsers,
    sendText,
    sendTemplateMessage,
    messageText: buildInactiveMessage(inactiveDays),
    templateName: "kadi_inactive_v1", // ✅ template Meta
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