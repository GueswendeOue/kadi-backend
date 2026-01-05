"use strict";

require("dotenv").config();
const express = require("express");

const { verifyRequestSignature } = require("./whatsappApi");
const { handleIncomingMessage } = require("./kadiEngine");

console.log("🟢 KADI booting...");
console.log("ENV CHECK:", {
  PORT: process.env.PORT,
  HAS_WHATSAPP_TOKEN: !!process.env.WHATSAPP_TOKEN,
  HAS_PHONE_NUMBER_ID: !!process.env.PHONE_NUMBER_ID,
  HAS_VERIFY_TOKEN: !!process.env.VERIFY_TOKEN,
  HAS_META_APP_SECRET: !!process.env.META_APP_SECRET,
  HAS_SUPABASE_URL: !!process.env.SUPABASE_URL,
  HAS_SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
});

const app = express();
const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "kadi_verify_12345";

// ✅ Body parsing standard (AUCUNE vérif signature ici)
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => res.status(200).send("✅ Kadi backend is running"));
app.get("/health", (req, res) =>
  res.status(200).json({ ok: true, ts: new Date().toISOString() })
);

// ✅ Webhook verification (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const ok = mode === "subscribe" && token && token === VERIFY_TOKEN;
  if (!ok) return res.sendStatus(403);

  return res.status(200).send(challenge);
});

// ✅ JSON + signature verify UNIQUEMENT sur /webhook POST
app.post(
  "/webhook",
  express.json({
    limit: "2mb",
    verify: (req, res, buf) => {
      // Vérifie signature Meta uniquement ici
      verifyRequestSignature(req, res, buf);
      req.rawBody = buf.toString();
    },
  }),
  (req, res) => {
    // Réponse immédiate à Meta
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

          Promise.resolve(handleIncomingMessage(value)).catch((e) => {
            console.error("💥 handleIncomingMessage error:", e.message);
          });
        }
      }
    } catch (e) {
      console.error("💥 Webhook fatal error:", e.message);
    }
  }
);

app.listen(PORT, () => {
  console.log("🚀 KADI server listening on", PORT);
});