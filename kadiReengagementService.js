"use strict";

const { sendSmartReengagement } = require("./kadiSmartReengagement");
const { notifyAdminReengagement } = require("./kadiAdminNotifier");
const {
  getZeroDocMessageByVariant,
  buildInactiveMessage,
  buildRecentActiveZeroDocMessage,
  buildExhaustedCreditsMessage,
} = require("./kadiReengagementMessages");

const SEGMENT_RECENT_ACTIVE_ZERO_DOC = "recent_active_zero_doc";
const SEGMENT_EXHAUSTED_CREDITS = "exhausted_credits";
const RECENT_ACTIVE_ZERO_DOC_TEMPLATE = "kadi_recent_active_zero_doc_v1";
const EXHAUSTED_CREDITS_TEMPLATE = "kadi_exhausted_credits_v1";
const MANUAL_COOLDOWN_DAYS = 7;
const MANUAL_MAX_LIMIT = 20;

function normalizeUsers(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      wa_id: String(row?.wa_id || "").trim(),
      last_activity_at: row?.last_activity_at || row?.created_at || null,
      owner_name: row?.owner_name || null,
      days_since_activity: row?.days_since_activity ?? null,
      last_reengagement_at: row?.last_reengagement_at || null,
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
    aborted: false,
    abortReason: null,
    abortMessage: null,
  };
}

function isReasonableSendHour(date = new Date()) {
  const h = date.getUTCHours();
  return h >= 8 && h <= 19;
}

function buildManualCycleKey(segment, date = new Date()) {
  return `manual_${segment}_${date.toISOString()}`;
}

function dedupeUsers(users = []) {
  const seen = new Set();

  return (Array.isArray(users) ? users : []).filter((user) => {
    const waId = String(user?.wa_id || "").trim();
    if (!waId) return false;
    if (seen.has(waId)) return false;
    seen.add(waId);
    return true;
  });
}

function resolveSegmentConfig(segment) {
  const safeSegment = String(segment || "").trim().toLowerCase();

  if (safeSegment === SEGMENT_EXHAUSTED_CREDITS) {
    return {
      segment: SEGMENT_EXHAUSTED_CREDITS,
      campaignType: SEGMENT_EXHAUSTED_CREDITS,
      templateName: EXHAUSTED_CREDITS_TEMPLATE,
      messageText: buildExhaustedCreditsMessage(),
    };
  }

  if (safeSegment !== SEGMENT_RECENT_ACTIVE_ZERO_DOC) return null;

  return {
    segment: SEGMENT_RECENT_ACTIVE_ZERO_DOC,
    campaignType: SEGMENT_RECENT_ACTIVE_ZERO_DOC,
    templateName: RECENT_ACTIVE_ZERO_DOC_TEMPLATE,
    messageText: buildRecentActiveZeroDocMessage(),
  };
}

async function safeLogReengagementSend(logReengagementSend, payload) {
  if (typeof logReengagementSend !== "function") return false;

  try {
    await logReengagementSend(payload);
    return true;
  } catch (err) {
    console.warn("[KADI/REENGAGEMENT] manual log failed:", err?.message || err);
    return false;
  }
}

function getErrorSearchText(value = {}) {
  return [
    value?.error,
    value?.errorMessage,
    value?.message,
    value?.errorDetails,
    value?.details,
    value?.raw?.error?.message,
    value?.raw?.error?.error_data?.details,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isTemplateMissingError(value = {}) {
  const code = Number(value?.errorCode || value?.code || value?.meta?.code);
  const text = getErrorSearchText(value);

  return (
    code === 132001 ||
    text.includes("template name does not exist") ||
    text.includes("template does not exist") ||
    text.includes("does not exist in fr")
  );
}

function buildTemplateMissingAdminMessage(templateName, language = "fr") {
  return `Template WhatsApp manquant : ${templateName} en ${language}. Créez/approuvez ce template dans Meta avant de relancer.`;
}

async function runCampaign({
  users,
  sendText,
  sendTemplateMessage,
  messageText,
  templateName,
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
        templateName,
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

async function runLoggedCampaign({
  users,
  sendText,
  sendTemplateMessage,
  messageText,
  templateName,
  campaignType,
  cycleKey,
  logReengagementSend,
  meta = {},
}) {
  const stats = buildStats();
  const normalizedUsers = dedupeUsers(normalizeUsers(users));

  stats.targeted = normalizedUsers.length;

  for (const user of normalizedUsers) {
    try {
      const res = await sendSmartReengagement({
        waId: user.wa_id,
        lastActivityAt: user.last_activity_at,
        sendText,
        sendTemplateMessage,
        messageText,
        templateName,
      });

      if (res?.ok && res?.mode === "free") {
        stats.sent += 1;

        await safeLogReengagementSend(logReengagementSend, {
          waId: user.wa_id,
          campaignType,
          templateName: null,
          messageMode: "free",
          status: "sent",
          cycleKey,
          meta: {
            ...meta,
            last_activity_at: user.last_activity_at || null,
          },
        });
      } else if (res?.ok && res?.mode === "template") {
        stats.template += 1;

        await safeLogReengagementSend(logReengagementSend, {
          waId: user.wa_id,
          campaignType,
          templateName,
          messageMode: "template",
          status: "template_sent",
          cycleKey,
          meta: {
            ...meta,
            last_activity_at: user.last_activity_at || null,
          },
        });
      } else if (res?.reason === "blocked_24h") {
        stats.blocked += 1;

        await safeLogReengagementSend(logReengagementSend, {
          waId: user.wa_id,
          campaignType,
          templateName,
          messageMode: templateName ? "template" : "free",
          status: "blocked_24h",
          cycleKey,
          meta: {
            ...meta,
            last_activity_at: user.last_activity_at || null,
          },
        });
      } else {
        stats.failed += 1;

        if (isTemplateMissingError(res)) {
          stats.aborted = true;
          stats.abortReason = "template_missing";
          stats.abortMessage = buildTemplateMissingAdminMessage(
            templateName,
            "fr"
          );

          await safeLogReengagementSend(logReengagementSend, {
            waId: user.wa_id,
            campaignType,
            templateName,
            messageMode: "template",
            status: "failed_template_config",
            cycleKey,
            meta: {
              ...meta,
              last_activity_at: user.last_activity_at || null,
              reason: res?.reason || "send_error",
              error: res?.error || null,
              errorCode: res?.errorCode || null,
              errorDetails: res?.errorDetails || null,
              abortedBatch: true,
            },
          });

          break;
        }

        await safeLogReengagementSend(logReengagementSend, {
          waId: user.wa_id,
          campaignType,
          templateName,
          messageMode: templateName ? "template" : "free",
          status: "failed",
          cycleKey,
          meta: {
            ...meta,
            last_activity_at: user.last_activity_at || null,
            reason: res?.reason || "unknown",
            error: res?.error || null,
          },
        });
      }
    } catch (err) {
      stats.failed += 1;

      if (isTemplateMissingError(err)) {
        stats.aborted = true;
        stats.abortReason = "template_missing";
        stats.abortMessage = buildTemplateMissingAdminMessage(
          templateName,
          "fr"
        );

        await safeLogReengagementSend(logReengagementSend, {
          waId: user.wa_id,
          campaignType,
          templateName,
          messageMode: "template",
          status: "failed_template_config",
          cycleKey,
          meta: {
            ...meta,
            last_activity_at: user.last_activity_at || null,
            error: String(err?.message || err || "send_error"),
            errorCode: err?.meta?.code || err?.raw?.error?.code || null,
            errorDetails:
              err?.meta?.error_data?.details ||
              err?.raw?.error?.error_data?.details ||
              null,
            abortedBatch: true,
          },
        });

        break;
      }

      await safeLogReengagementSend(logReengagementSend, {
        waId: user.wa_id,
        campaignType,
        templateName,
        messageMode: templateName ? "template" : "free",
        status: "failed",
        cycleKey,
        meta: {
          ...meta,
          last_activity_at: user.last_activity_at || null,
          error: String(err?.message || err || "send_error"),
        },
      });
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
      stats.aborted && stats.abortMessage ? `Arrêt : ${stats.abortMessage}` : null,
    ]
      .filter((line) => line != null)
      .join("\n")
  );
}

function makeKadiReengagementService({
  sendText,
  getZeroDocUsersBySegment,
  getInactiveUsers,
  getRecentActiveZeroDocUsers = null,
  getExhaustedCreditUsers = null,
  logReengagementSend = null,
  sendTemplateMessage = null,
  adminWaId = null,
}) {
  async function getSegmentUsers(segment, limit) {
    const config = resolveSegmentConfig(segment);
    if (!config) return { config: null, users: [] };

    if (config.segment === SEGMENT_EXHAUSTED_CREDITS) {
      if (typeof getExhaustedCreditUsers !== "function") {
        return { config, users: null };
      }

      const users = await getExhaustedCreditUsers(limit, {
        cooldownDays: MANUAL_COOLDOWN_DAYS,
      });

      return { config, users };
    }

    if (typeof getRecentActiveZeroDocUsers !== "function") {
      return { config, users: null };
    }

    const users = await getRecentActiveZeroDocUsers(limit, {
      activeDays: 30,
      cooldownDays: MANUAL_COOLDOWN_DAYS,
    });

    return { config, users };
  }

  async function handleReengagePreviewCommand(from, text) {
    const match = String(text || "")
      .trim()
      .match(/^\/reengage_preview\s+([a-z0-9_]+)\s+(\d+)$/i);

    if (!match) return false;

    const segment = String(match[1] || "").toLowerCase();
    const limit = clampInt(match[2], 1, MANUAL_MAX_LIMIT, MANUAL_MAX_LIMIT);
    const { config, users } = await getSegmentUsers(segment, limit);

    if (!config) {
      await sendText(from, `❌ Segment inconnu : ${segment}`);
      return true;
    }

    if (!Array.isArray(users)) {
      await sendText(from, "❌ Re-engagement non branché. Repo manquant.");
      return true;
    }

    const normalizedUsers = normalizeUsers(users);
    const lines = [
      "👀 Preview re-engagement",
      `Segment : ${config.segment}`,
      `Limite : ${limit}`,
      `Candidats : ${normalizedUsers.length}`,
      "Envoi : aucun",
      "",
      ...normalizedUsers.slice(0, limit).map((user, index) => {
        const last = user.last_activity_at || "-";
        return `${index + 1}. +${user.wa_id} | last_activity=${last}`;
      }),
    ];

    await sendText(from, lines.join("\n").trim());
    return true;
  }

  async function handleReengageTestCommand(from, text) {
    const match = String(text || "")
      .trim()
      .match(/^\/reengage_test\s+([a-z0-9_]+)$/i);

    if (!match) return false;

    const segment = String(match[1] || "").toLowerCase();
    const config = resolveSegmentConfig(segment);

    if (!config) {
      await sendText(from, `❌ Segment inconnu : ${segment}`);
      return true;
    }

    await sendText(from, config.messageText);
    await sendText(
      from,
      `✅ Test re-engagement envoyé uniquement à cet admin.\nSegment : ${config.segment}\nAucun utilisateur réel ciblé.`
    );
    return true;
  }

  async function handleReengageSegmentCommand(from, text) {
    const match = String(text || "")
      .trim()
      .match(/^\/reengage_segment\s+([a-z0-9_]+)\s+(\d+)$/i);

    if (!match) return false;

    const segment = String(match[1] || "").toLowerCase();
    const limit = clampInt(match[2], 1, MANUAL_MAX_LIMIT, MANUAL_MAX_LIMIT);

    if (!isReasonableSendHour()) {
      await sendText(
        from,
        "⏰ Envoi bloqué : le réengagement part seulement entre 08h et 19h."
      );
      return true;
    }

    const { config, users } = await getSegmentUsers(segment, limit);

    if (!config) {
      await sendText(from, `❌ Segment inconnu : ${segment}`);
      return true;
    }

    if (!Array.isArray(users)) {
      await sendText(from, "❌ Re-engagement non branché. Repo manquant.");
      return true;
    }

    const safeUsers = normalizeUsers(users).slice(0, MANUAL_MAX_LIMIT);
    const cycleKey = buildManualCycleKey(config.segment);

    const stats = await runLoggedCampaign({
      users: safeUsers,
      sendText,
      sendTemplateMessage,
      messageText: config.messageText,
      templateName: config.templateName,
      campaignType: config.campaignType,
      cycleKey,
      logReengagementSend,
      meta: {
        source: "admin_command",
        adminWaId: from,
        segment: config.segment,
        cooldownDays: MANUAL_COOLDOWN_DAYS,
        requestedLimit: limit,
        cappedLimit: MANUAL_MAX_LIMIT,
      },
    });

    await sendCampaignReport({
      sendText,
      from,
      title: "Re-engagement segment terminé.",
      metaLines: [
        `Segment : ${config.segment}`,
        `Limite : ${limit}`,
        `Cycle : ${cycleKey}`,
      ],
      stats,
    });

    if (adminWaId) {
      await notifyAdminReengagement({
        sendText,
        adminWaId,
        type: config.campaignType,
        stats,
        meta: {
          cycleKey,
          cooldownDays: MANUAL_COOLDOWN_DAYS,
        },
      });
    }

    return true;
  }

  async function handleReengageZeroDocsCommand(from, text) {
    const match = String(text || "")
      .trim()
      .match(/^\/reengage_zero_docs\s+(\d+)\s+([ABC])$/i);

    if (!match) return false;

    if (typeof getZeroDocUsersBySegment !== "function") {
      await sendText(from, "❌ Re-engagement non branché. Repo manquant.");
      return true;
    }

    if (!isReasonableSendHour()) {
      await sendText(
        from,
        "⏰ Envoi bloqué : le réengagement part seulement entre 08h et 19h."
      );
      return true;
    }

    const limit = clampInt(match[1], 1, 500, 50);
    const variant = String(match[2] || "A").toUpperCase();

    const rawUsers = await getZeroDocUsersBySegment(variant, limit);

    const templateName =
      variant === "A"
        ? "kadi_zero_doc_a_v1"
        : variant === "B"
        ? "kadi_zero_doc_b_v1"
        : "kadi_zero_doc_c_v1";

    const stats = await runCampaign({
      users: rawUsers,
      sendText,
      sendTemplateMessage,
      messageText: getZeroDocMessageByVariant(variant),
      templateName,
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

    if (!isReasonableSendHour()) {
      await sendText(
        from,
        "⏰ Envoi bloqué : le réengagement part seulement entre 08h et 19h."
      );
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
      templateName: "kadi_inactive_v1",
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
    handleReengagePreviewCommand,
    handleReengageTestCommand,
    handleReengageSegmentCommand,
    handleReengageZeroDocsCommand,
    handleReengageInactiveCommand,
  };
}

module.exports = {
  makeKadiReengagementService,
  resolveSegmentConfig,
  runLoggedCampaign,
  isTemplateMissingError,
};
