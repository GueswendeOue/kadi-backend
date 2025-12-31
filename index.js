require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();

// ✅ Remplace body-parser
app.use(express.json());

/* ==========================
   CONFIG
========================== */
const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// ⚠️ Assure-toi que le nom EXACT correspond à Render
// Dans tes variables Render tu as: WHATSAPP_PHONE_NUMBER_ID
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

/* ==========================
   HEALTH CHECK
========================== */
app.get("/", (req, res) => {
  res.status(200).send("✅ Kadi backend is running");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

/* ==========================
   WEBHOOK VERIFICATION (GET)
========================== */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("🔎 Webhook verification:", { mode, token, challenge });

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified successfully");
    return res.status(200).send(challenge);
  }

  console.log("❌ Webhook verification failed");
  return res.sendStatus(403);
});

/* ==========================
   WEBHOOK RECEIVER (POST)
========================== */
app.post("/webhook", async (req, res) => {
  // ✅ Répondre vite à Meta
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // On ignore les events non-message
    const message = value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const text = message.text?.body?.trim().toLowerCase();

    console.log("📩 Incoming message:", { from, type: message.type, text });

    let reply = "👋 Salut, je suis Kadi. Écris *menu* pour voir les options.";

    if (text === "menu") {
      reply =
        "📋 *Menu Kadi*\n" +
        "1️⃣ Devis\n" +
        "2️⃣ Facture\n" +
        "3️⃣ Reçu\n\n" +
        "Réponds avec le numéro de ton choix.";
    }

    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
      console.log("❌ Missing env vars:", {
        WHATSAPP_TOKEN: !!WHATSAPP_TOKEN,
        PHONE_NUMBER_ID: !!PHONE_NUMBER_ID,
      });
      return;
    }

    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

    const resp = await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to: from,
        type: "text",
        text: { body: reply },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    console.log("✅ Reply sent:", resp.data);
  } catch (err) {
    console.error("❌ Error sending reply:", err.response?.data || err.message);
  }
});

/* ==========================
   START SERVER
========================== */
app.listen(PORT, () => {
  console.log("🚀 Kadi backend running on port:", PORT);
  console.log("VERIFY_TOKEN:", VERIFY_TOKEN ? "✅ set" : "❌ missing");
  console.log("WHATSAPP_TOKEN:", WHATSAPP_TOKEN ? "✅ set" : "❌ missing");
  console.log(
    "WHATSAPP_PHONE_NUMBER_ID:",
    PHONE_NUMBER_ID ? `✅ set (${PHONE_NUMBER_ID})` : "❌ missing"
  );
  console.log("GRAPH_VERSION:", GRAPH_VERSION);
});