"use strict";

const { sendSmartReengagement } = require("./kadiSmartReengagement");
const {
  notifyAdminReengagement,
  notifyAdminReengagementCycleSummary,
} = require("./kadiAdminNotifier");
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

// Burkina = UTC+0
function isReasonableSendHour(date = new Date()) {
  const h = date.getUTCHours();
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

function diffCount(beforeSet, afterSet) {
  return Math.max(0, afterSet.size - beforeSet.size);
}

function toSafeDelayMs(value, fallback = 1500) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(Math.trunc(n), 10000));
}

function sleep(ms) {
  const delay = toSafeDelayMs(ms, 0);
  if (delay <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delay));
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

async function safeLogReengagementSend(payload) {
  try {
    await logReengagementSend(payload);
  } catch (err) {
    console.warn("[KADI/REENGAGEMENT] log failed:", err?.message || err);
  }
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
  sendDelayMs = Number(process.env.KADI_REENGAGEMENT_SEND_DELAY_MS || 1500),
}) {
  const cleanUsers = dedupeUsers(users).filter(
    (u) => !alreadyTargetedSet.has(u.wa_id)
  );

  const stats = buildStats();
  stats.targeted = cleanUsers.length;

  const delayMs = toSafeDelayMs(sendDelayMs, 1500);

  for (let i = 0; i < cleanUsers.length; i += 1) {
    const user = cleanUsers[i];

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

        await safeLogReengagementSend({
          waId: user.wa_id,
          campaignType,
          templateName: null,
          messageMode: "free",
          status: "sent",
          cycleKey,
          meta: {
            owner_name: user.owner_name || null,
            last_activity_at: user.last_activity_at || null,
            sendDelayMs: delayMs,
          },
        });
      } else if (res?.ok && res?.mode === "template") {
        stats.template += 1;
        alreadyTargetedSet.add(user.wa_id);

        await safeLogReengagementSend({
          waId: user.wa_id,
          campaignType,
          templateName,
          messageMode: "template",
          status: "template_sent",
          cycleKey,
          meta: {
            owner_name: user.owner_name || null,
            last_activity_at: user.last_activity_at || null,
            sendDelayMs: delayMs,
          },
        });
      } else if (res?.reason === "blocked_24h") {
        stats.blocked += 1;
      } else {
        stats.failed += 1;

        await safeLogReengagementSend({
          waId: user.wa_id,
          campaignType,
          templateName,
          messageMode: templateName ? "template" : "free",
          status: "failed",
          cycleKey,
          meta: {
            owner_name: user.owner_name || null,
            last_activity_at: user.last_activity_at || null,
            reason: res?.reason || "unknown",
            error: res?.error || null,
          },
        });
      }
    } catch (err) {
      stats.failed += 1;

      await safeLogReengagementSend({
        waId: user.wa_id,
        campaignType,
        templateName,
        messageMode: templateName ? "template" : "free",
        status: "failed",
        cycleKey,
        meta: {
          owner_name: user.owner_name || null,
          last_activity_at: user.last_activity_at || null,
          error: String(err?.message || err || "send_error"),
        },
      });
    }

    if (i < cleanUsers.length - 1 && delayMs > 0) {
      await sleep(delayMs);
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
  sendDelayMs = Number(process.env.KADI_REENGAGEMENT_SEND_DELAY_MS || 1500),
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
  const safeDelayMs = toSafeDelayMs(sendDelayMs, 1500);

  console.log("[KADI/REENGAGEMENT] cycle start", {
    cycleKey,
    cooldownDays: reengagementCooldownDays,
    sendDelayMs: safeDelayMs,
  });

  // ===============================
  // ZERO DOC USERS
  // ===============================
  const zeroExcludedBefore = alreadyTargetedSet.size;

  const zeroDocsUsers = normalizeUsers(
    await getZeroDocUsersBySegment("A", zeroDocsLimit, {
      cooldownDays: reengagementCooldownDays,
      excludeWaIds: Array.from(alreadyTargetedSet),
    })
  );

  const zeroBeforeSend = new Set(alreadyTargetedSet);

  const zeroStats = await runBatch({
    users: zeroDocsUsers,
    sendText,
    sendTemplateMessage,
    messageText: getZeroDocMessageByVariant("A"),
    templateName: "kadi_zero_doc_a_v1",
    campaignType: "zero_docs_a",
    cycleKey,
    alreadyTargetedSet,
    sendDelayMs: safeDelayMs,
  });

  const zeroUniqueTouched = diffCount(zeroBeforeSend, alreadyTargetedSet);

  if (adminWaId) {
    await notifyAdminReengagement({
      sendText,
      adminWaId,
      type: "auto_zero_docs",
      stats: zeroStats,
      meta: {
        cycleKey,
        cooldownDays: reengagementCooldownDays,
        sendDelayMs: safeDelayMs,
        uniqueTouched: zeroUniqueTouched,
        excludedThisSegment: zeroExcludedBefore,
        alreadyTargetedInCycle: zeroExcludedBefore,
        timestamp: new Date().toISOString(),
      },
    });
  }

  // ===============================
  // INACTIVE USERS
  // ===============================
  const inactiveExcludedBefore = alreadyTargetedSet.size;

  const inactiveUsers = normalizeUsers(
    await getInactiveUsers(inactiveDays, inactiveLimit, {
      cooldownDays: reengagementCooldownDays,
      excludeWaIds: Array.from(alreadyTargetedSet),
    })
  );

  const inactiveBeforeSend = new Set(alreadyTargetedSet);

  const inactiveStats = await runBatch({
    users: inactiveUsers,
    sendText,
    sendTemplateMessage,
    messageText: buildInactiveMessage(inactiveDays),
    templateName: "kadi_inactive_v1",
    campaignType: `inactive_${inactiveDays}d`,
    cycleKey,
    alreadyTargetedSet,
    sendDelayMs: safeDelayMs,
  });

  const inactiveUniqueTouched = diffCount(
    inactiveBeforeSend,
    alreadyTargetedSet
  );

  if (adminWaId) {
    await notifyAdminReengagement({
      sendText,
      adminWaId,
      type: `auto_inactive_${inactiveDays}d`,
      stats: inactiveStats,
      meta: {
        cycleKey,
        cooldownDays: reengagementCooldownDays,
        sendDelayMs: safeDelayMs,
        uniqueTouched: inactiveUniqueTouched,
        excludedThisSegment: inactiveExcludedBefore,
        alreadyTargetedInCycle: inactiveExcludedBefore,
        timestamp: new Date().toISOString(),
      },
    });
  }

  // ===============================
  // GLOBAL SUMMARY
  // ===============================
  if (adminWaId) {
    await notifyAdminReengagementCycleSummary({
      sendText,
      adminWaId,
      cycleKey,
      cooldownDays: reengagementCooldownDays,
      zeroStats,
      inactiveStats,
      targetedUnique: alreadyTargetedSet.size,
    });
  }

  console.log("[KADI/REENGAGEMENT] cycle done", {
    cycleKey,
    cooldownDays: reengagementCooldownDays,
    sendDelayMs: safeDelayMs,
    targetedUnique: alreadyTargetedSet.size,
    zeroDocs: zeroStats,
    inactive: inactiveStats,
  });

  return {
    cycleKey,
    cooldownDays: reengagementCooldownDays,
    sendDelayMs: safeDelayMs,
    targetedUnique: alreadyTargetedSet.size,
    zeroDocs: zeroStats,
    inactive: inactiveStats,
  };
}

module.exports = {
  runReengagementCycle,
};