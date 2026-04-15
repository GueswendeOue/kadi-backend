"use strict";

require("dotenv").config();
const express = require("express");

const {
  verifyRequestSignature,
  extractStatusesFromWebhookValue,
  sendTemplate, // ✅ centralisé ici
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
const FOLLOWUP_INTERVAL_MS = Number(process.env.KADI_DEVIS_FOLLOWUP_INTERVAL_MS || 5 * 60 * 1000);
const FOLLOWUP_BATCH_SIZE = Number(process.env.KADI_DEVIS_FOLLOWUP_BATCH_SIZE || 20);

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

const WEEKLY_REPORT_DAY = Number(process.env.KADI_WEEKLY_REPORT_DAY || 0);
const WEEKLY_REPORT_HOUR = Number(process.env.KADI_WEEKLY_REPORT_HOUR || 18);
const WEEKLY_REPORT_MINUTE = Number(process.env.KADI_WEEKLY_REPORT_MINUTE || 0);

const KADI_ADMIN_WA = process.env.KADI_ADMIN_WA || "";

// ===============================
// HEALTH
// ===============================
app.get("/", (_, res) => res.status(200).send("✅ Kadi backend is running"));

app.get("/health", (_, res) => {
  res.status(200).json({ ok: true, ts: new Date().toISOString() });
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
            handleIncomingStatuses(statuses).catch(console.error);
          }

          if (value.messages?.length) {
            handleIncomingMessage(value).catch(console.error);
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
    console.log(`⏱ Followups worker started (${FOLLOWUP_INTERVAL_MS} ms)`);

    setInterval(async () => {
      try {
        const sent = await processDevisFollowups(FOLLOWUP_BATCH_SIZE);
        console.log("✅ followups:", sent);
      } catch (e) {
        console.error("💥 followups error:", e);
      }
    }, FOLLOWUP_INTERVAL_MS);
  }

  // ===============================
  // REENGAGEMENT (🔥 IMPORTANT)
  // ===============================
  if (
    REENGAGEMENT_ENABLED &&
    getZeroDocUsersBySegment &&
    getInactiveUsers
  ) {
    console.log(`🤖 Reengagement started (${REENGAGEMENT_INTERVAL_MS} ms)`);

    const run = async () => {
      try {
        const result = await runReengagementCycle({
          sendText,
          sendTemplateMessage: sendTemplate, // ✅ CRITIQUE
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

    setTimeout(run, 30000);
    setInterval(run, REENGAGEMENT_INTERVAL_MS);
  }

  // ===============================
  // WEEKLY REPORT
  // ===============================
  if (WEEKLY_REPORT_ENABLED && KADI_ADMIN_WA) {
    console.log("📅 Weekly report started");

    setInterval(async () => {
      try {
        const reporter = makeKadiWeeklyReport({
          sendText,
          adminWaId: KADI_ADMIN_WA,
        });

        await reporter.sendWeeklyReport();
      } catch (e) {
        console.error("💥 weekly report error:", e);
      }
    }, WEEKLY_REPORT_CHECK_INTERVAL_MS);
  }
});