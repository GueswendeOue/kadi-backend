/**
 * KADI BACKEND – WhatsApp Cloud API
 * --------------------------------
 * Webhook verification + message receiver + auto-reply (MENU)
 */

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();

/* ==========================
   CONFIG
========================== */
const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

/* ==========================
   MIDDLEWARE
========================== */
app.use(bodyParser.json());

/* ==========================
   WHATSAPP SENDER
========================== */
async function sendText(to, text) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.log("❌ Missing WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
    return;
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    text: { body: text },
  };

  const headers = {
    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  };

  try {
    const r = await axios.post(url, payload, { headers });
    console.log("✅ Message sent:", r.data);
  } catch (err) {
    console.log("❌ Send message error:", {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
    });
  }
}

/* ==========================
   HEALTH CHECK
========================== */
app.get("/", (req, res) => {
  res.status(200).send("✅ Kadi backend is running");
});

/* ==========================
   WEBHOOK VERIFICATION (GET)
   Meta appelle CET endpoint
========================== */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("🔎 Webhook verification attempt:", { mode, token, challenge });

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified successfully");
    return res.status(200).send(challenge);
  }

  console.log("❌ Webhook verification failed");
  return res.sendStatus(403);
});

/* ==========================
   WEBHOOK RECEIVER (POST)
   Réception des messages
========================== */
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (!value) return res.sendStatus(200);

    const messages = value.messages;
    const contacts = value.contacts;

    if (contacts) {
      console.log("👤 Contact:", contacts[0]);
    }

    if (messages) {
      const msg = messages[0];
      const from = msg.from; // numéro de l’utilisateur (string)
      const text = (msg.text?.body || "").trim().toLowerCase();

      console.log("📩 Incoming message:", {
        from,
        type: msg.type,
        text: msg.text?.body,
      });

      // ✅ Réponse simple : "menu" -> affiche options
      if (text === "menu") {
        await sendText(
          from,
          "👋 Salut ! Je suis Kadi.\n\n1️⃣ Devis\n2️⃣ Facture\n3️⃣ Reçu\n\nRéponds 1, 2 ou 3."
        );
      } else if (text === "1") {
        await sendText(from, "✅ Mode DEVIS activé. Dis-moi : client + articles + prix.");
      } else if (text === "2") {
        await sendText(from, "✅ Mode FACTURE activé. Dis-moi : client + articles + prix.");
      } else if (text === "3") {
        await sendText(from, "✅ Mode REÇU activé. Dis-moi : client + montant + motif.");
      } else {
        // Fallback minimal
        await sendText(from, "Tape *menu* pour commencer. ✅");
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    console.log("❌ Webhook error:", e?.message || e);
    // Toujours répondre 200 à Meta pour éviter des retries infinis
    return res.sendStatus(200);
  }
});

/* ==========================
   START SERVER
========================== */
app.listen(PORT, () => {
  console.log("🚀 Kadi backend running");
  console.log("Port:", PORT);
  console.log("VERIFY_TOKEN:", VERIFY_TOKEN ? "✅ set" : "❌ missing");
  console.log("GRAPH_VERSION:", GRAPH_VERSION);

  console.log("WHATSAPP_TOKEN:", WHATSAPP_TOKEN ? "✅ set" : "❌ missing");
  console.log("WHATSAPP_PHONE_NUMBER_ID:", PHONE_NUMBER_ID ? "✅ set" : "❌ missing");
});