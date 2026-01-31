"use strict";

const crypto = require("crypto");
const axios = require("axios");
const FormData = require("form-data");

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const APP_SECRET = process.env.APP_SECRET;
const VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";

// ✅ NOTE: on ne throw plus au top-level pour éviter crash Render si env manquantes.
// On validera dans les fonctions qui en ont besoin.
function assertEnv() {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error("WHATSAPP_TOKEN / PHONE_NUMBER_ID manquants dans .env");
  }
}

function verifyRequestSignature(req, res, buf) {
  // ✅ Si APP_SECRET absent, on ne casse pas le serveur (mais on log)
  if (!APP_SECRET) {
    console.warn("⚠️ APP_SECRET manquant: signature non vérifiée.");
    return;
  }

  const signature = req.headers["x-hub-signature-256"];
  if (!signature) {
    // Meta peut envoyer d'autres requêtes sans header selon contexte
    console.warn('⚠️ Missing "x-hub-signature-256" header (skip verify).');
    return;
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

function graphUrl(path) {
  return `https://graph.facebook.com/${VERSION}/${path}`;
}

async function sendText(to, text) {
  assertEnv();
  const url = graphUrl(`${PHONE_NUMBER_ID}/messages`);
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };

  const resp = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    timeout: 15000,
  });
  return resp.data;
}

async function sendButtons(to, bodyText, buttons) {
  assertEnv();
  const url = graphUrl(`${PHONE_NUMBER_ID}/messages`);
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  };

  const resp = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    timeout: 15000,
  });
  return resp.data;
}

async function getMediaInfo(mediaId) {
  assertEnv();
  const url = graphUrl(`${mediaId}`);
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    timeout: 15000,
  });
  return resp.data; // { url, mime_type, sha256, file_size, id }
}

async function downloadMediaToBuffer(mediaUrl) {
  assertEnv();
  const resp = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    responseType: "arraybuffer",
    timeout: 30000,
  });
  return Buffer.from(resp.data);
}

/**
 * Upload buffer as WhatsApp media (PDF)
 * returns: { id: "MEDIA_ID" }
 */
async function uploadMediaBuffer({ buffer, filename, mimeType }) {
  assertEnv();
  const url = graphUrl(`${PHONE_NUMBER_ID}/media`);

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType || "application/pdf");
  form.append("file", buffer, {
    filename: filename || "document.pdf",
    contentType: mimeType || "application/pdf",
  });

  const resp = await axios.post(url, form, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      ...form.getHeaders(),
    },
    maxBodyLength: Infinity,
    timeout: 60000,
  });

  return resp.data; // { id }
}

async function sendDocument({ to, mediaId, filename, caption }) {
  assertEnv();
  const url = graphUrl(`${PHONE_NUMBER_ID}/messages`);
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "document",
    document: {
      id: mediaId,
      filename: filename || "document.pdf",
      caption: caption || "",
    },
  };

  const resp = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    timeout: 15000,
  });

  return resp.data;
}

module.exports = {
  verifyRequestSignature,
  sendText,
  sendButtons,
  getMediaInfo,
  downloadMediaToBuffer,
  uploadMediaBuffer,
  sendDocument,
};