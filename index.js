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
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const GRAPH_VERSION = "v22.0";

/* ==========================
   MIDDLEWARE
========================== */
app.use(bodyParser.json());

/* ==========================
   HEALTH CHECK
========================== */
app.get("/", (req, res) => {
  res.send("✅ Kadi backend is running");
});

/* ==========================
   WEBHOOK VERIFICATION
========================== */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

/* ==========================
   SEND MESSAGE FUNCTION
========================== */
async function sendMessage(to, text) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

/* ==========================
   WEBHOOK RECEIVER
========================== */
app.post("/webhook", async (req, res) => {
  const entry = req.body.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];

  if (!message) {
    return res.sendStatus(200);
  }

  const from = message.from;
  const text = message.text?.body?.toLowerCase();

  console.log("📩 Message reçu :", text);

  try {
    if (text === "menu") {
      await sendMessage(
        from,
        "👋 Salut !\n\n1️⃣ Devis\n2️⃣ Facture\n3️⃣ Reçu\n\nRéponds par un numéro."
      );
    } else {
      await sendMessage(from, "🤖 Kadi est en ligne. Tape *menu*.");
    }
  } catch (err) {
    console.error("❌ Erreur envoi message", err.response?.data || err.message);
  }

  res.sendStatus(200);
});

/* ==========================
   START SERVER
========================== */
app.listen(PORT, () => {
  console.log("🚀 Kadi backend running");
});