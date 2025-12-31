/**
 * KADI BACKEND – WhatsApp Cloud API
 * --------------------------------
 * Webhook verification + message receiver
 */

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");

const app = express();

/* ==========================
   CONFIG
========================== */
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";

/* ==========================
   MIDDLEWARE
========================== */
app.use(bodyParser.json());

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

  console.log("🔎 Webhook verification attempt:", {
    mode,
    token,
    challenge,
  });

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
app.post("/webhook", (req, res) => {
  const entry = req.body?.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;

  if (!value) {
    return res.sendStatus(200);
  }

  const messages = value.messages;
  const contacts = value.contacts;

  if (contacts) {
    console.log("👤 Contact:", contacts[0]);
  }

  if (messages) {
    const msg = messages[0];

    console.log("📩 Incoming message:", {
      from: msg.from,
      type: msg.type,
      text: msg.text?.body,
    });

    // 👉 ICI tu brancheras Kadi AI / state machine
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
});