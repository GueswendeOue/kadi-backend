require("dotenv").config();
const express = require("express");

const { handleIncomingMessage } = require("./kadiEngine");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN; // support 2 noms

// ✅ Render health
app.get("/", (req, res) => res.status(200).send("✅ Kadi backend is running"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// ✅ Webhook verify (Meta)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const ok = mode === "subscribe" && token && VERIFY_TOKEN && token === VERIFY_TOKEN;

  console.log("[GET /webhook] verify:", { mode, ok });

  if (ok) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ✅ Webhook receive (Meta)
app.post("/webhook", async (req, res) => {
  // Répondre tout de suite pour éviter les retries / blocage
  res.status(200).send("EVENT_RECEIVED");

  try {
    const body = req.body || {};
    console.log("[POST /webhook] keys:", Object.keys(body));

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // messages OU status updates
    if (!value) {
      console.log("[POST /webhook] No value in payload");
      return;
    }

    // Deleguer à ton engine WhatsApp
    await handleIncomingMessage(value);
  } catch (e) {
    console.error("[POST /webhook] ERROR:", e?.response?.data || e?.message || e);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Kadi backend listening on port ${PORT}`);
});