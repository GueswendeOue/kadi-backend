"use strict";

const { sendSmartReengagement } = require("./kadiSmartReengagement");
const { notifyAdminReengagement } = require("./kadiAdminNotifier");
const {
  buildInactiveMessage,
  getZeroDocMessageByVariant,
} = require("./kadiReengagementMessages");
const { logReengagementSend } = require("./kadiReengagementRepo");

// ===============================
// Utils
// ===============================
function normalizeUsers(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      wa_id: String(row?.wa_id || "").trim(),
      last_activity_at: row?.last_activity_at || row?.created_at || null,
      owner_name: row?.owner_name || null,
      created_at: row?.created_at || null,
    }))
    .filter((row) => !!row.wa_id);
}

function isReasonableSendHour(date = new Date()) {
  const h = date.getHours();
  return h >= 8 && h <= 19;
}

function dedupeUsers(users = []) {
  const seen = new Set();

  return (Array.isArray(users) ? users : []).filter((u) => {
    const waId = String(u?.wa_id || "").trim();
    if (!waId) return false;
    if (seen.has(waId)) return false;
    seen.add(waId);
    return true;
  });
}

function buildCycleKey(date = new Date()) {
  return `reengagement_${date.toISOString()}`;
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
  campaignType,
  cycleKey,
  alreadyTargetedSet,
}) {
  const cleanUsers = dedupeUsers(users).filter(
    (u) => !alreadyTargetedSet.has(u.wa_id)
  );

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

      if (res?.ok && res?.mode === "free") {
        stats.sent += 1;
        alreadyTargetedSet.add(user.wa_id);

        await logReengagementSend({
          waId: user.wa_id,
          campaignType,
          templateName: null,
          messageMode: "free",
          status: "sent",
          cycleKey,
          meta: {
            owner_name: user.owner_name || null,
            last_activity_at: user.last_activity_at || null,
          },
        });
      } else if (res?.ok && res?.mode === "template") {
        stats.template += 1;
        alreadyTargetedSet.add(user.wa_id);

        await logReengagementSend({
          waId: user.wa_id,
          campaignType,
          templateName,
          messageMode: "template",
          status: "sent",
          cycleKey,
          meta: {
            owner_name: user.owner_name || null,
            last_activity_at: user.last_activity_at || null,
          },
        });
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
  reengagementCooldownDays = Number(
    process.env.KADI_REENGAGEMENT_COOLDOWN_DAYS || 7
  ),
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

  if (!isReasonableSendHour()) {
    console.log("[KADI/REENGAGEMENT] skipped: outside allowed hours");
    return {
      skipped: true,
      reason: "outside_allowed_hours",
    };
  }

  const cycleKey = buildCycleKey();
  const alreadyTargetedSet = new Set();

  console.log("[KADI/REENGAGEMENT] cycle start", {
    cycleKey,
    cooldownDays: reengagementCooldownDays,
  });

  // ===============================
  // ZERO DOC USERS
  // ===============================
  const zeroDocsUsers = normalizeUsers(
    await getZeroDocUsersBySegment("A", zeroDocsLimit, {
      cooldownDays: reengagementCooldownDays,
      excludeWaIds: Array.from(alreadyTargetedSet),
    })
  );

  const zeroStats = await runBatch({
    users: zeroDocsUsers,
    sendText,
    sendTemplateMessage,
    messageText: getZeroDocMessageByVariant("A"),
    templateName: "kadi_zero_doc_a_v1",
    campaignType: "zero_docs_a",
    cycleKey,
    alreadyTargetedSet,
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
    await getInactiveUsers(inactiveDays, inactiveLimit, {
      cooldownDays: reengagementCooldownDays,
      excludeWaIds: Array.from(alreadyTargetedSet),
    })
  );

  const inactiveStats = await runBatch({
    users: inactiveUsers,
    sendText,
    sendTemplateMessage,
    messageText: buildInactiveMessage(inactiveDays),
    templateName: "kadi_inactive_v1",
    campaignType: `inactive_${inactiveDays}d`,
    cycleKey,
    alreadyTargetedSet,
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
    cycleKey,
    targetedUnique: alreadyTargetedSet.size,
    zeroDocs: zeroStats,
    inactive: inactiveStats,
  });

  return {
    cycleKey,
    cooldownDays: reengagementCooldownDays,
    targetedUnique: alreadyTargetedSet.size,
    zeroDocs: zeroStats,
    inactive: inactiveStats,
  };
}

module.exports = {
  runReengagementCycle,
};