"use strict";

require("dotenv").config();
const express = require("express");

const {
  verifyRequestSignature,
  extractStatusesFromWebhookValue,
  sendTemplate,
} = require("./whatsappApi");

const {
  handleIncomingMessage,
  handleIncomingStatuses,
  processDevisFollowups,
} = require("./kadiEngine");

const { sendText } = require("./kadiMessaging");
const { runReengagementCycle } = require("./kadiReengagementWorker");
const { makeKadiWeeklyReport } = require("./kadiWeeklyReport");

let getZeroDocUsersBySegment = null;
let getInactiveUsers = null;

try {
  ({ getZeroDocUsersBySegment, getInactiveUsers } = require("./kadiReengagementRepo"));
} catch (e) {
  console.warn("⚠️ Reengagement repo not loaded:", e?.message);
}

console.log("🟢 KADI booting...");

// ===============================
// APP INIT
// ===============================
const app = express();
const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "kadi_verify_12345";

// ===============================
// CONFIG
// ===============================
const FOLLOWUP_INTERVAL_MS = Number(
  process.env.KADI_DEVIS_FOLLOWUP_INTERVAL_MS || 5 * 60 * 1000
);
const FOLLOWUP_BATCH_SIZE = Number(
  process.env.KADI_DEVIS_FOLLOWUP_BATCH_SIZE || 20
);

const REENGAGEMENT_ENABLED =
  String(process.env.KADI_REENGAGEMENT_ENABLED || "false").toLowerCase() === "true";

const REENGAGEMENT_INTERVAL_MS = Number(
  process.env.KADI_REENGAGEMENT_INTERVAL_MS || 6 * 60 * 60 * 1000
);

const REENGAGEMENT_ZERO_DOCS_LIMIT = Number(
  process.env.KADI_REENGAGEMENT_ZERO_DOCS_LIMIT || 20
);

const REENGAGEMENT_INACTIVE_DAYS = Number(
  process.env.KADI_REENGAGEMENT_INACTIVE_DAYS || 30
);

const REENGAGEMENT_INACTIVE_LIMIT = Number(
  process.env.KADI_REENGAGEMENT_INACTIVE_LIMIT || 20
);

const WEEKLY_REPORT_ENABLED =
  String(process.env.KADI_WEEKLY_REPORT_ENABLED || "true").toLowerCase() === "true";

const WEEKLY_REPORT_CHECK_INTERVAL_MS = Number(
  process.env.KADI_WEEKLY_REPORT_CHECK_INTERVAL_MS || 15 * 60 * 1000
);

// Burkina = UTC
// 0 = dimanche
const WEEKLY_REPORT_DAY = Number(process.env.KADI_WEEKLY_REPORT_DAY || 0);
const WEEKLY_REPORT_HOUR = Number(process.env.KADI_WEEKLY_REPORT_HOUR || 9);
const WEEKLY_REPORT_MINUTE = Number(process.env.KADI_WEEKLY_REPORT_MINUTE || 0);

const KADI_ADMIN_WA = process.env.KADI_ADMIN_WA || "";

// ===============================
// WEEKLY REPORT CONTROL
// ===============================
let lastWeeklyReportRunKey = null;

function getWeeklyRunKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}-${h}:${min}`;
}

function shouldRunWeeklyReport(now = new Date()) {
  if (!KADI_ADMIN_WA) return false;

  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();

  if (day !== WEEKLY_REPORT_DAY) return false;
  if (hour !== WEEKLY_REPORT_HOUR) return false;
  if (minute !== WEEKLY_REPORT_MINUTE) return false;

  const runKey = getWeeklyRunKey(now);
  if (lastWeeklyReportRunKey === runKey) return false;

  lastWeeklyReportRunKey = runKey;
  return true;
}

async function maybeRunWeeklyReport() {
  try {
    if (!WEEKLY_REPORT_ENABLED) return;
    if (!KADI_ADMIN_WA) return;

    const now = new Date();
    if (!shouldRunWeeklyReport(now)) return;

    console.log("[KADI/WEEKLY] sending report...", {
      utc: now.toISOString(),
      adminWaId: KADI_ADMIN_WA,
    });

    const reporter = makeKadiWeeklyReport({
      sendText,
      adminWaId: KADI_ADMIN_WA,
    });

    await reporter.sendWeeklyReport();

    console.log("[KADI/WEEKLY] sent ✅");
  } catch (e) {
    console.error("💥 weekly report error:", e);
  }
}

// ===============================
// HEALTH
// ===============================
app.get("/", (_, res) => res.status(200).send("✅ Kadi backend is running"));

app.get("/health", (_, res) => {
  res.status(200).json({
    ok: true,
    ts: new Date().toISOString(),
  });
});

// ===============================
// WEBHOOK VERIFY
// ===============================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// ===============================
// WEBHOOK RECEIVE
// ===============================
app.post(
  "/webhook",
  express.json({
    limit: "2mb",
    verify: (req, res, buf) => {
      verifyRequestSignature(req, res, buf);
    },
  }),
  (req, res) => {
    res.status(200).send("EVENT_RECEIVED");

    try {
      const body = req.body;
      if (body.object !== "whatsapp_business_account") return;

      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value;
          if (!value) continue;

          const statuses = extractStatusesFromWebhookValue(value);

          if (statuses.length) {
            handleIncomingStatuses(statuses).catch((e) => {
              console.error("💥 handleIncomingStatuses error:", e);
            });
          }

          if (value.messages?.length) {
            handleIncomingMessage(value).catch((e) => {
              console.error("💥 handleIncomingMessage error:", e);
            });
          }
        }
      }
    } catch (e) {
      console.error("💥 Webhook fatal error:", e);
    }
  }
);

// ===============================
// SERVER START
// ===============================
app.listen(PORT, () => {
  console.log("🚀 KADI server listening on", PORT);

  // ===============================
  // FOLLOWUPS
  // ===============================
  if (typeof processDevisFollowups === "function") {
    console.log(
      `⏱ Followups worker started (${FOLLOWUP_INTERVAL_MS} ms, batch ${FOLLOWUP_BATCH_SIZE})`
    );

    setTimeout(async () => {
      try {
        const sent = await processDevisFollowups(FOLLOWUP_BATCH_SIZE);
        console.log("✅ followups startup:", sent);
      } catch (e) {
        console.error("💥 followups startup error:", e);
      }
    }, 15000);

    setInterval(async () => {
      try {
        const sent = await processDevisFollowups(FOLLOWUP_BATCH_SIZE);
        console.log("✅ followups interval:", sent);
      } catch (e) {
        console.error("💥 followups interval error:", e);
      }
    }, FOLLOWUP_INTERVAL_MS);
  } else {
    console.warn("⚠️ processDevisFollowups not available");
  }

  // ===============================
  // REENGAGEMENT
  // ===============================
  if (
    REENGAGEMENT_ENABLED &&
    typeof getZeroDocUsersBySegment === "function" &&
    typeof getInactiveUsers === "function"
  ) {
    console.log(`🤖 Reengagement started (${REENGAGEMENT_INTERVAL_MS} ms)`);

    const runReengagement = async () => {
      try {
        const result = await runReengagementCycle({
          sendText,
          sendTemplateMessage: sendTemplate,
          getZeroDocUsersBySegment,
          getInactiveUsers,
          adminWaId: KADI_ADMIN_WA,
          zeroDocsLimit: REENGAGEMENT_ZERO_DOCS_LIMIT,
          inactiveDays: REENGAGEMENT_INACTIVE_DAYS,
          inactiveLimit: REENGAGEMENT_INACTIVE_LIMIT,
        });

        console.log("✅ reengagement:", result);
      } catch (e) {
        console.error("💥 reengagement error:", e);
      }
    };

    setTimeout(runReengagement, 30000);
    setInterval(runReengagement, REENGAGEMENT_INTERVAL_MS);
  } else {
    console.warn("⚠️ Reengagement disabled or repo unavailable");
  }

  // ===============================
  // WEEKLY REPORT
  // ===============================
  if (WEEKLY_REPORT_ENABLED && KADI_ADMIN_WA) {
    console.log(
      `📅 Weekly report checker started (every ${WEEKLY_REPORT_CHECK_INTERVAL_MS} ms, target UTC day=${WEEKLY_REPORT_DAY} hour=${WEEKLY_REPORT_HOUR}:${String(
        WEEKLY_REPORT_MINUTE
      ).padStart(2, "0")})`
    );

    setTimeout(async () => {
      await maybeRunWeeklyReport();
    }, 45000);

    setInterval(async () => {
      await maybeRunWeeklyReport();
    }, WEEKLY_REPORT_CHECK_INTERVAL_MS);
  } else {
    console.warn("⚠️ Weekly report disabled or missing KADI_ADMIN_WA");
  }
});