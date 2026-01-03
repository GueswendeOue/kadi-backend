require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

function mask(v) {
  if (!v) return "❌ missing";
  return "✅ set";
}

// ---------- Health ----------
app.get("/", (req, res) => {
  res.status(200).send("✅ Kadi backend is running");
});

// ---------- Webhook Verification ----------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("🔎 [GET /webhook] verify:", { mode, token_ok: token === VERIFY_TOKEN });

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  console.log("❌ Webhook verify failed");
  return res.sendStatus(403);
});

// ---------- Webhook Receiver ----------
app.post("/webhook", async (req, res) => {
  // Important: répondre vite à Meta
  res.sendStatus(200);

  console.log("📩 [POST /webhook] RECEIVED");
  console.log("📦 body:", JSON.stringify(req.body || {}, null, 2).slice(0, 4000)); // limite logs

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // message incoming
    const message = value?.messages?.[0];
    const contact = value?.contacts?.[0];

    if (!message) {
      console.log("ℹ️ No message in webhook (status update or other field). field=", change?.field);
      return;
    }

    const from = message.from;
    const text = message.text?.body?.trim() || "";
    const lower = text.toLowerCase();

    console.log("👤 From:", from);
    console.log("🧾 Contact:", contact?.profile?.name);
    console.log("💬 Text:", text);
    console.log("🆔 Incoming phone_number_id(meta):", value?.metadata?.phone_number_id);

    let reply = "👋 Salut, je suis Kadi. Écris *menu* pour voir les options.";

    if (lower === "menu") {
      reply =
        "📋 *Menu Kadi*\n" +
        "1️⃣ Devis\n" +
        "2️⃣ Facture\n" +
        "3️⃣ Reçu\n\n" +
        "Écris le numéro de ton choix.";
    }

    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
    const payload = {
      messaging_product: "whatsapp",
      to: from,
      type: "text",
      text: { body: reply },
    };

    console.log("➡️ Sending reply:", { url, to: from, graph: GRAPH_VERSION, phone_number_id: PHONE_NUMBER_ID });

    const r = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    });

    console.log("✅ Reply sent:", r.data);
  } catch (err) {
    console.error("❌ Send error");
    console.error("status:", err.response?.status);
    console.error("data:", err.response?.data);
    console.error("message:", err.message);
  }
});

// ---------- Debug send (manual test) ----------
app.get("/debug/send", async (req, res) => {
  try {
    const to = (req.query.to || "").trim();
    const text = (req.query.text || "Hello from Kadi debug").trim();

    if (!to) return res.status(400).send("Missing ?to= (ex: 22670626055)");

    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    };

    const r = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    });

    return res.status(200).json({ ok: true, data: r.data });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
    });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log("🚀 Kadi backend running on port:", PORT);
  console.log("VERIFY_TOKEN:", mask(VERIFY_TOKEN));
  console.log("WHATSAPP_TOKEN:", mask(WHATSAPP_TOKEN));
  console.log("WHATSAPP_PHONE_NUMBER_ID:", PHONE_NUMBER_ID ? `✅ set (${PHONE_NUMBER_ID})` : "❌ missing");
  console.log("GRAPH_VERSION:", GRAPH_VERSION);
});