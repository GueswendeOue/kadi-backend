/**
 * KADI BACKEND – WhatsApp Cloud API
 * --------------------------------
 * Webhook verification + message receiver + auto-reply (menu)
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
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

/* ==========================
   MIDDLEWARE
========================== */
app.use(bodyParser.json());

/* ==========================
   HELPERS
========================== */
async function sendWhatsAppText(to, text) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.log("❌ Missing WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
    return;
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  try {
    const resp = await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Message sent:", resp.data?.messages?.[0]?.id || resp.data);
  } catch (err) {
    console.log("❌ Send message error:", err.response?.data || err.message);
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
========================== */
app.post("/webhook", async (req, res) => {
  const entry = req.body?.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;

  if (!value) return res.sendStatus(200);

  const messages = value.messages;
  const contacts = value.contacts;

  if (contacts) console.log("👤 Contact:", contacts[0]);

  if (messages) {
    const msg = messages[0];
    const from = msg.from; // numéro du client au format international sans "+"
    const text = msg.text?.body?.trim() || "";

    console.log("📩 Incoming message:", { from, type: msg.type, text });

    // ---------
    // AUTO-REPLY MENU (Étape 3)
    // ---------
    const lower = text.toLowerCase();

    if (lower === "menu" || lower === "help" || lower === "aide") {
      await sendWhatsAppText(
        from,
        `👋 Salut ! Je suis Kadi.\n\nRéponds avec :\n1) devis\n2) facture\n3) reçu\n\nTape "menu" à tout moment.`
      );
    } else if (lower.includes("devis")) {
      await sendWhatsAppText(from, "✅ Mode DEVIS. Dis-moi : client + produit + prix.");
    } else if (lower.includes("facture")) {
      await sendWhatsAppText(from, "✅ Mode FACTURE. Dis-moi : client + produit + prix.");
    } else if (lower.includes("reçu") || lower.includes("recu")) {
      await sendWhatsAppText(from, "✅ Mode REÇU. Dis-moi : client + montant + motif.");
    } else {
      await sendWhatsAppText(from, `Je t’ai reçu ✅\nTape "menu" pour voir les options.`);
    }
  }

  res.sendStatus(200);
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
  console.log("WHATSAPP_PHONE_NUMBER_ID:", WHATSAPP_PHONE_NUMBER_ID ? "✅ set" : "❌ missing");
});