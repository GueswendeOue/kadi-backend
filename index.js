require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// fallback uniquement (au cas où metadata absent)
const DEFAULT_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

function mask(v) {
  if (!v) return "❌ missing";
  return "✅ set";
}

// Health check
app.get("/", (req, res) => res.status(200).send("✅ Kadi backend is running"));

// Webhook verification (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("🔎 Verify webhook:", { mode, token_ok: token === VERIFY_TOKEN });

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  console.log("❌ Webhook verify failed");
  return res.sendStatus(403);
});

// Webhook receiver (POST)
app.post("/webhook", async (req, res) => {
  // répondre vite
  res.sendStatus(200);

  try {
    const body = req.body || {};
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // 🔥 IMPORTANT: prendre le phone_number_id du payload (test vs prod)
    const phoneNumberIdFromPayload = value?.metadata?.phone_number_id;
    const phoneNumberId = phoneNumberIdFromPayload || DEFAULT_PHONE_NUMBER_ID;

    const message = value?.messages?.[0];
    const contact = value?.contacts?.[0];

    console.log("📩 WEBHOOK RECEIVED:", {
      object: body.object,
      field: change?.field,
      phone_number_id: phoneNumberId,
      has_message: !!message,
    });

    if (!message) {
      console.log("ℹ️ No inbound message (maybe status update).");
      return;
    }

    const from = message.from;
    const text = message.text?.body?.trim() || "";
    const lower = text.toLowerCase();

    console.log("👤 From:", from);
    console.log("🧾 Contact:", contact?.profile?.name);
    console.log("✉️ Text:", text);

    let reply = "👋 Salut, je suis Kadi.";
    if (lower === "menu") {
      reply =
        "📋 *Menu Kadi*\n" +
        "1️⃣ Devis\n" +
        "2️⃣ Facture\n" +
        "3️⃣ Reçu\n\n" +
        "Écris le numéro de ton choix.";
    }

    if (!WHATSAPP_TOKEN) {
      console.log("❌ WHATSAPP_TOKEN missing in env (Render).");
      return;
    }
    if (!phoneNumberId) {
      console.log("❌ phoneNumberId missing (payload + env).");
      return;
    }

    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      to: from,
      type: "text",
      text: { body: reply },
    };

    console.log("➡️ Sending reply:", { url, to: from });

    const r = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    });

    console.log("✅ Reply sent:", r.data);
  } catch (err) {
    // LOGS COMPLETS
    console.error("❌ Webhook handler error:");
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Data:", err.response.data);
    } else {
      console.error(err.message);
    }
  }
});

app.listen(PORT, () => {
  console.log("🚀 Kadi backend running on port:", PORT);
  console.log("VERIFY_TOKEN:", mask(VERIFY_TOKEN));
  console.log("WHATSAPP_TOKEN:", mask(WHATSAPP_TOKEN));
  console.log("DEFAULT_PHONE_NUMBER_ID:", DEFAULT_PHONE_NUMBER_ID ? `✅ set (${DEFAULT_PHONE_NUMBER_ID})` : "❌ missing");
  console.log("GRAPH_VERSION:", GRAPH_VERSION);
});