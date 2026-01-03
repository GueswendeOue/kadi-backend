require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v24.0"; // <= plus safe
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

function mask(v) {
  if (!v) return "❌ missing";
  return `✅ set (${String(v).slice(0, 6)}...${String(v).slice(-4)})`;
}

app.get("/", (req, res) => {
  res.status(200).send("✅ Kadi backend is running");
});

// Petit debug safe (sans exposer les secrets)
app.get("/debug-env", (req, res) => {
  res.json({
    VERIFY_TOKEN: VERIFY_TOKEN ? "✅ set" : "❌ missing",
    WHATSAPP_TOKEN: WHATSAPP_TOKEN ? "✅ set" : "❌ missing",
    WHATSAPP_PHONE_NUMBER_ID: PHONE_NUMBER_ID || "❌ missing",
    GRAPH_VERSION,
  });
});

/* ==========================
   WEBHOOK VERIFICATION (GET)
========================== */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  // Quand tu ouvres /webhook dans le navigateur => mode/token/challenge seront undefined (normal)
  console.log("🔎 GET /webhook verify params:", { mode, token: token ? "present" : "missing", challenge });

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified (Meta)");
    return res.status(200).send(challenge);
  }

  console.log("❌ Webhook verify failed (not Meta verify call or bad token)");
  return res.sendStatus(403);
});

/* ==========================
   WEBHOOK RECEIVER (POST)
========================== */
app.post("/webhook", async (req, res) => {
  // Répondre vite à Meta
  res.sendStatus(200);

  try {
    console.log("📩 POST /webhook received");

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const message = value?.messages?.[0];
    const contact = value?.contacts?.[0];

    if (!message) {
      console.log("ℹ️ No message in webhook (status update maybe). field=", change?.field);
      return;
    }

    const from = message.from;
    const text = message.text?.body?.trim() || "";
    const lower = text.toLowerCase();

    console.log("👤 From:", from);
    console.log("🧾 Contact name:", contact?.profile?.name);
    console.log("📩 Text:", text);
    console.log("📌 phone_number_id in payload:", value?.metadata?.phone_number_id);

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
    console.log("➡️ Using PHONE_NUMBER_ID:", PHONE_NUMBER_ID);
    console.log("➡️ Token:", WHATSAPP_TOKEN ? "present" : "missing");

    const r = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });

    console.log("✅ Reply sent:", r.data);
  } catch (err) {
    console.error("❌ Webhook handler error");
    console.error("Message:", err.message);
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Data:", JSON.stringify(err.response.data, null, 2));
    }
  }
});

/* ==========================
   SEND TEST (sans webhook)
   Exemple:
   /send-test?to=22670626055&text=Hello
========================== */
app.get("/send-test", async (req, res) => {
  try {
    const to = (req.query.to || "").trim();
    const text = (req.query.text || "Hello from Kadi").trim();

    if (!to) return res.status(400).json({ error: "Missing ?to= (wa_id)" });

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
      timeout: 15000,
    });

    return res.json({ ok: true, data: r.data });
  } catch (err) {
    const out = {
      ok: false,
      message: err.message,
      status: err.response?.status,
      data: err.response?.data,
    };
    return res.status(500).json(out);
  }
});

/* ==========================
   START SERVER
========================== */
app.listen(PORT, () => {
  console.log("🚀 Kadi backend running on port:", PORT);
  console.log("VERIFY_TOKEN:", VERIFY_TOKEN ? "✅ set" : "❌ missing");
  console.log("WHATSAPP_TOKEN:", mask(WHATSAPP_TOKEN));
  console.log("WHATSAPP_PHONE_NUMBER_ID:", PHONE_NUMBER_ID ? `✅ set (${PHONE_NUMBER_ID})` : "❌ missing");
  console.log("GRAPH_VERSION:", GRAPH_VERSION);
});