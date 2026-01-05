// index.js
require("dotenv").config();
const express = require("express");
const { sendTextMessage } = require("./whatsapp");

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

app.get("/", (req, res) => res.status(200).send("✅ Kadi backend is running"));

/**
 * Meta Webhook verification (GET)
 */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("[GET /webhook]", { mode, token_received: token });

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  console.log("❌ Webhook verify failed");
  return res.sendStatus(403);
});

/**
 * Webhook events (POST)
 */
app.post("/webhook", async (req, res) => {
  // Toujours répondre vite à Meta
  res.status(200).send("EVENT_RECEIVED");

  try {
    const body = req.body;
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (!value) {
      console.log("⚠️ POST /webhook sans value:", JSON.stringify(body));
      return;
    }

    const phoneNumberIdIncoming = value?.metadata?.phone_number_id; // IMPORTANT
    const message = value?.messages?.[0];

    if (!message) {
      console.log("ℹ️ Webhook reçu (pas de message) - probablement status update");
      return;
    }

    const from = message.from;
    const text = message?.text?.body?.trim() || "";
    console.log("📩 Message entrant:", { from, text, phoneNumberIdIncoming });

    if (!text) return;

    if (text.toLowerCase() === "menu") {
      await sendTextMessage({
        to: from,
        text:
          "✅ *KADI BOT EST EN LIGNE !*\n\n📋 *MENU PRINCIPAL*\n1️⃣ - Créer un devis\n2️⃣ - Créer une facture\n3️⃣ - Créer un reçu\n\n👉 Tape 1, 2 ou 3",
        // OPTIONNEL: si tu gères plusieurs numéros, utilise celui du webhook entrant
        phoneNumberIdOverride: phoneNumberIdIncoming,
      });
      console.log("✅ Réponse menu envoyée");
      return;
    }

    await sendTextMessage({
      to: from,
      text: `Je n’ai pas compris. Tape "menu".`,
      phoneNumberIdOverride: phoneNumberIdIncoming,
    });
  } catch (err) {
    console.error("❌ Erreur webhook:", err?.response?.data || err.message);
  }
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));