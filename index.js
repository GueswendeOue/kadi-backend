"use strict";

require("dotenv").config();
const express = require("express");

const {
  verifyRequestSignature,
  extractStatusesFromWebhookValue,
} = require("./whatsappApi");

const {
  handleIncomingMessage,
  handleIncomingStatuses,
  processDevisFollowups,
} = require("./kadiEngine");

const { sendText } = require("./kadiMessaging");
const { runReengagementCycle } = require("./kadiReengagementWorker");

let getZeroDocUsersBySegment = null;
let getInactiveUsers = null;

try {
  ({ getZeroDocUsersBySegment, getInactiveUsers } = require("./kadiReengagementRepo"));
} catch (_) {}

console.log("🟢 KADI booting...");
console.log("ENV CHECK:", {
  PORT: process.env.PORT,
  HAS_WHATSAPP_TOKEN: !!process.env.WHATSAPP_TOKEN,
  HAS_PHONE_NUMBER_ID: !!process.env.PHONE_NUMBER_ID,
  HAS_VERIFY_TOKEN: !!process.env.VERIFY_TOKEN,
  HAS_APP_SECRET: !!process.env.APP_SECRET,
  HAS_SUPABASE_URL: !!process.env.SUPABASE_URL,
  HAS_SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
});

const app = express();
const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "kadi_verify_12345";

const FOLLOWUP_INTERVAL_MS = Number(
  process.env.KADI_DEVIS_FOLLOWUP_INTERVAL_MS || 5 * 60 * 1000
);
const FOLLOWUP_BATCH_SIZE = Number(
  process.env.KADI_DEVIS_FOLLOWUP_BATCH_SIZE || 20
);

const REENGAGEMENT_ENABLED =
  String(process.env.KADI_REENGAGEMENT_ENABLED || "false").toLowerCase() ===
  "true";
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
const KADI_ADMIN_WA = process.env.KADI_ADMIN_WA || "";

// Standard parsing
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => res.status(200).send("✅ Kadi backend is running"));

app.get("/health", (req, res) => {
  return res.status(200).json({
    ok: true,
    ts: new Date().toISOString(),
  });
});

// Webhook verification (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const ok = mode === "subscribe" && token && token === VERIFY_TOKEN;
  if (!ok) return res.sendStatus(403);

  return res.status(200).send(challenge);
});

// Webhook receive (POST)
app.post(
  "/webhook",
  express.json({
    limit: "2mb",
    verify: (req, res, buf) => {
      verifyRequestSignature(req, res, buf);
      req.rawBody = buf.toString();
    },
  }),
  (req, res) => {
    res.status(200).send("EVENT_RECEIVED");

    try {
      const body = req.body || {};
      if (body.object !== "whatsapp_business_account") return;

      const entries = body.entry || [];

      for (const entry of entries) {
        const changes = entry.changes || [];

        for (const change of changes) {
          const value = change.value;
          if (!value) continue;

          const statuses = extractStatusesFromWebhookValue(value);
          if (statuses.length) {
            Promise.resolve(handleIncomingStatuses(statuses)).catch((e) => {
              console.error("💥 handleIncomingStatuses error:", e);
            });
          }

          if (value.messages?.length) {
            Promise.resolve(handleIncomingMessage(value)).catch((e) => {
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

app.listen(PORT, () => {
  console.log("🚀 KADI server listening on", PORT);

  if (typeof processDevisFollowups === "function") {
    console.log(
      `⏱ Devis follow-up worker started (every ${FOLLOWUP_INTERVAL_MS} ms, batch ${FOLLOWUP_BATCH_SIZE})`
    );

    setTimeout(async () => {
      try {
        const sent = await processDevisFollowups(FOLLOWUP_BATCH_SIZE);
        console.log(`✅ processDevisFollowups startup ok: ${sent} followup(s) sent`);
      } catch (e) {
        console.error("💥 processDevisFollowups startup error FULL:", e);
      }
    }, 15000);

    setInterval(async () => {
      try {
        const sent = await processDevisFollowups(FOLLOWUP_BATCH_SIZE);
        console.log(`✅ processDevisFollowups interval ok: ${sent} followup(s) sent`);
      } catch (e) {
        console.error("💥 processDevisFollowups interval error FULL:", e);
      }
    }, FOLLOWUP_INTERVAL_MS);
  } else {
    console.warn("⚠️ processDevisFollowups is not available from kadiEngine");
  }

  if (
    REENGAGEMENT_ENABLED &&
    typeof getZeroDocUsersBySegment === "function" &&
    typeof getInactiveUsers === "function"
  ) {
    console.log(
      `🤖 Re-engagement worker started (every ${REENGAGEMENT_INTERVAL_MS} ms)`
    );

    setTimeout(async () => {
      try {
        const result = await runReengagementCycle({
          sendText,
          getZeroDocUsersBySegment,
          getInactiveUsers,
          adminWaId: KADI_ADMIN_WA,
          zeroDocsLimit: REENGAGEMENT_ZERO_DOCS_LIMIT,
          inactiveDays: REENGAGEMENT_INACTIVE_DAYS,
          inactiveLimit: REENGAGEMENT_INACTIVE_LIMIT,
        });

        console.log("✅ reengagement startup ok:", result);
      } catch (e) {
        console.error("💥 reengagement startup error FULL:", e);
      }
    }, 30000);

    setInterval(async () => {
      try {
        const result = await runReengagementCycle({
          sendText,
          getZeroDocUsersBySegment,
          getInactiveUsers,
          adminWaId: KADI_ADMIN_WA,
          zeroDocsLimit: REENGAGEMENT_ZERO_DOCS_LIMIT,
          inactiveDays: REENGAGEMENT_INACTIVE_DAYS,
          inactiveLimit: REENGAGEMENT_INACTIVE_LIMIT,
        });

        console.log("✅ reengagement interval ok:", result);
      } catch (e) {
        console.error("💥 reengagement interval error FULL:", e);
      }
    }, REENGAGEMENT_INTERVAL_MS);
  } else {
    console.warn("⚠️ Re-engagement worker disabled or repo unavailable");
  }
});