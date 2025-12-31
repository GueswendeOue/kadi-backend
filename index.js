require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();

// IMPORTANT: plus besoin de body-parser
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// ---- Petit helper pour logs safe
function mask(v) {
  if (!v) return "❌ missing";
  return "✅ set";
}

/* ==========================
   HEALTH CHECK
========================== */
app.get("/", (req, res) => {
  res.status(200).send("✅ Kadi backend is running");
});

/* ==========================
   WEBHOOK VERIFICATION (GET)
========================== */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("🔎 Verify webhook:", { mode, token, challenge });

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  console.log("❌ Webhook verify failed");
  return res.sendStatus(403);
});

/* ==========================
   WEBHOOK RECEIVER (POST)
========================== */
app.post("/webhook", async (req, res) => {
  // Répondre vite à Meta (sinon ils peuvent retry)
  res.sendStatus(200);

  try {
    // LOG brut minimal
    console.log("📦 Incoming webhook body keys:", Object.keys(req.body || {}));

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const message = value?.messages?.[0];
    const contact = value?.contacts?.[0];

    if (!message) {
      console.log("ℹ️ No message in webhook (maybe status update).");
      return;
    }

    const from = message.from; // numéro utilisateur (celui qui t’écrit)
    const text = message.text?.body?.trim() || "";
    const lower = text.toLowerCase();

    console.log("👤 From:", from);
    console.log("🧾 Contact name:", contact?.profile?.name);
    console.log("📩 Text:", text);

    let reply = "👋 Salut, je suis Kadi.";

    if (lower === "menu") {
      reply =
        "📋 *Menu Kadi*\n" +
        "1️⃣ Devis\n" +
        "2️⃣ Facture\n" +
        "3️⃣ Reçu\n\n" +
        "Écris le numéro de ton choix.";
    }

    // Envoi réponse WhatsApp
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      to: from,
      type: "text",
      text: { body: reply },
    };

    console.log("➡️ Sending reply via:", url);
    const r = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });

    console.log("✅ Reply sent:", r.data);
  } catch (err) {
    console.error("❌ Webhook handler error:");
    console.error(err.response?.data || err.message);
  }
});

/* ==========================
   START SERVER
========================== */
app.listen(PORT, () => {
  console.log("🚀 Kadi backend running on port:", PORT);
  console.log("VERIFY_TOKEN:", mask(VERIFY_TOKEN));
  console.log("WHATSAPP_TOKEN:", mask(WHATSAPP_TOKEN));
  console.log("WHATSAPP_PHONE_NUMBER_ID:", PHONE_NUMBER_ID ? `✅ set (${PHONE_NUMBER_ID})` : "❌ missing");
  console.log("GRAPH_VERSION:", GRAPH_VERSION);
});