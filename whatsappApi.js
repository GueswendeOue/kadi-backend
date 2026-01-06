// whatsappApi.js (✅ complet + APP_SECRET partout)
"use strict";

const crypto = require("crypto");
const axios = require("axios");

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const APP_SECRET = process.env.APP_SECRET; // ✅ APP_SECRET partout
const VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";

if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
  throw new Error("WHATSAPP_TOKEN / PHONE_NUMBER_ID manquants dans .env");
}

// ✅ Vérification signature Meta (x-hub-signature-256)
function verifyRequestSignature(req, res, buf) {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) {
    // En prod, ce header doit être là
    throw new Error('Missing "x-hub-signature-256" header.');
  }
  if (!APP_SECRET) {
    throw new Error("APP_SECRET manquant: impossible de vérifier la signature.");
  }

  const [algo, hash] = String(signature).split("=");
  if (algo !== "sha256" || !hash) {
    throw new Error("Invalid signature header format.");
  }

  const expected = crypto
    .createHmac("sha256", APP_SECRET)
    .update(buf)
    .digest("hex");

  if (hash !== expected) {
    throw new Error("Invalid request signature.");
  }
}

// ====== Senders ======

async function sendText(to, text) {
  const url = `https://graph.facebook.com/${VERSION}/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
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

/**
 * Boutons interactifs (reply buttons)
 * buttons = [{ id: "MENU_DEVIS", title: "Créer un devis" }, ...]
 * ⚠️ max 3 boutons
 */
async function sendButtons(to, bodyText, buttons) {
  const url = `https://graph.facebook.com/${VERSION}/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: (buttons || []).slice(0, 3).map((b) => ({
          type: "reply",
          reply: {
            id: String(b.id),
            title: String(b.title).slice(0, 20), // WhatsApp limite titre
          },
        })),
      },
    },
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

// ====== Media ======

async function getMediaInfo(mediaId) {
  const url = `https://graph.facebook.com/${VERSION}/${mediaId}`;

  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    timeout: 15000,
  });

  // resp.data: { url, mime_type, sha256, file_size, id }
  return resp.data;
}

async function downloadMediaToBuffer(mediaUrl) {
  const resp = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    responseType: "arraybuffer",
    timeout: 30000,
  });

  return Buffer.from(resp.data);
}

module.exports = {
  verifyRequestSignature,
  sendText,
  sendButtons,
  getMediaInfo,
  downloadMediaToBuffer,
};