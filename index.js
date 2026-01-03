require("dotenv").config();
const express = require("express");
const app = express(); // <-- This line DEFINES 'app'
app.use(express.json({ limit: "2mb" }));

const { handleIncomingMessage } = require("./kadiEngine");

const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN;

// ✅ Render health check
app.get("/", (req, res) => res.status(200).send("✅ Kadi backend is running"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// ✅ Webhook verification (GET) - For Meta
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const ok = mode === "subscribe" && token && VERIFY_TOKEN && token === VERIFY_TOKEN;
  console.log("[GET /webhook] verify:", { mode, ok });

  if (ok) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ✅ Webhook receive (POST) - For Meta messages
app.post("/webhook", async (req, res) => {
  console.log("📩 INCOMING WEBHOOK - Body keys:", Object.keys(req.body || {}));

  try {
    const body = req.body || {};
    console.log("📦 Full body structure:", JSON.stringify(body).substring(0, 500));

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Check if payload contains a valid value
    if (!value) {
      console.log("❌ No value in payload");
      return res.status(200).send("EVENT_RECEIVED");
    }

    // Log message details
    if (value.messages && value.messages[0]) {
      const msg = value.messages[0];
      console.log(`📱 Message received: ${msg.text?.body} (Type: ${msg.type})`);
    }

    // Send immediate response to Meta
    res.status(200).send("EVENT_RECEIVED");

    // Process message asynchronously
    handleIncomingMessage(value).catch(err => {
      console.error("💥 Error in handleIncomingMessage:", err);
    });

  } catch (e) {
    console.error("💥 CRITICAL ERROR in webhook:", e?.message || e);
    res.status(200).send("EVENT_RECEIVED");
  }
});

// ✅ Start server
app.listen(PORT, () => {
  console.log(`🚀 Kadi backend listening on port ${PORT}`);
});