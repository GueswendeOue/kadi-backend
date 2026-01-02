/**
 * KADI BACKEND – WhatsApp Cloud API
 * --------------------------------
 * - GET /webhook : vérification Meta
 * - POST /webhook : réception messages + réponse "menu"
 * - Logs clairs pour debug Render
 */

require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "5mb" }));

// =======================
// ENV
// =======================
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN; // ex: kadi_verify_12345
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// =======================
// Helpers
// =======================
function mask(v) {
  return v ? "✅ set" : "❌ missing";
}

function buildGraphUrl(path) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;
}

async function sendText(to, body) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.warn("⚠️ Missing WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
    return;
  }

  const url = buildGraphUrl(`${PHONE_NUMBER_ID}/messages`);

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  };

  const resp = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });

  return resp.data;
}

// =======================
// Global request logs
// =======================
app.use((req, _res, next) => {
  console.log("🌐 HIT", req.method, req.url);
  next();
});

// =======================
// Health check
// =======================
app.get("/", (_req, res) => {
  res.status(200).send("✅ Kadi backend is running");
});

// =======================
// Webhook verify (Meta GET)
// =======================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("🔎 VERIFY", { mode, token, challenge });

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ WEBHOOK VERIFIED");
    return res.status(200).send(challenge);
  }

  console.log("❌ VERIFY FAILED (token mismatch?)");
  return res.sendStatus(403);
});

// =======================
// Webhook receiver (Meta POST)
// =======================
app.post("/webhook", async (req, res) => {
  try {
    // Répond vite à Meta (ils veulent 200)
    res.sendStatus(200);

    // Logs payload minimal (pour Render)
    console.log("📦 Body keys:", Object.keys(req.body || {}));

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Parfois Meta envoie des statuts (pas de messages)
    const message = value?.messages?.[0];
    const contact = value?.contacts?.[0];

    if (!message) {
      console.log("ℹ️ No message (maybe status update).");
      return;
    }

    const from = message.from; // wa_id de l’utilisateur
    const text = (message.text?.body || "").trim();
    const lower = text.toLowerCase();

    console.log("👤 From:", from);
    console.log("🧾 Contact:", contact?.profile?.name);
    console.log("📩 Text:", text);
    console.log("📌 PhoneNumberID used to reply:", PHONE_NUMBER_ID);

    let reply = `👋 Salut, je suis Kadi.\n\nEnvoie *menu* pour commencer.`;

    if (lower === "menu") {
      reply =
        "📋 *Menu Kadi*\n" +
        "1️⃣ Devis\n" +
        "2️⃣ Facture\n" +
        "3️⃣ Reçu\n\n" +
        "Réponds par: 1, 2 ou 3.";
    }

    const sent = await sendText(from, reply);
    console.log("✅ Reply sent:", sent);
  } catch (err) {
    console.error("❌ Webhook handler error:");
    console.error(err.response?.data || err.message);
    // pas besoin de res ici: on a déjà répondu 200
  }
});

// =======================
// Start server
// =======================
app.listen(PORT, () => {
  console.log("🚀 Kadi backend running on port:", PORT);
  console.log("VERIFY_TOKEN:", mask(VERIFY_TOKEN));
  console.log("WHATSAPP_TOKEN:", mask(WHATSAPP_TOKEN));
  console.log(
    "WHATSAPP_PHONE_NUMBER_ID:",
    PHONE_NUMBER_ID ? `✅ set (${PHONE_NUMBER_ID})` : "❌ missing"
  );
  console.log("GRAPH_VERSION:", GRAPH_VERSION);
});