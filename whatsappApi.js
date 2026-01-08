"use strict";

const crypto = require("crypto");
const axios = require("axios");

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const APP_SECRET = process.env.APP_SECRET;
const VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";

if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
  throw new Error("WHATSAPP_TOKEN / PHONE_NUMBER_ID manquants dans .env");
}

function verifyRequestSignature(req, res, buf) {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) throw new Error('Missing "x-hub-signature-256" header.');
  if (!APP_SECRET) throw new Error("APP_SECRET manquant: impossible de vérifier la signature.");

  const [algo, hash] = signature.split("=");
  if (algo !== "sha256" || !hash) throw new Error("Invalid signature header format.");

  const expected = crypto.createHmac("sha256", APP_SECRET).update(buf).digest("hex");
  if (hash !== expected) throw new Error("Invalid request signature.");
}

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    ...extra,
  };
}

async function sendText(to, text) {
  const url = `https://graph.facebook.com/${VERSION}/${PHONE_NUMBER_ID}/messages`;
  const payload = { messaging_product: "whatsapp", to, type: "text", text: { body: text } };

  const resp = await axios.post(url, payload, {
    headers: authHeaders({ "Content-Type": "application/json" }),
    timeout: 15000,
  });
  return resp.data;
}

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
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  };

  const resp = await axios.post(url, payload, {
    headers: authHeaders({ "Content-Type": "application/json" }),
    timeout: 15000,
  });
  return resp.data;
}

async function getMediaInfo(mediaId) {
  const url = `https://graph.facebook.com/${VERSION}/${mediaId}`;
  const resp = await axios.get(url, { headers: authHeaders(), timeout: 15000 });
  return resp.data; // { url, mime_type, sha256, file_size, id }
}

async function downloadMediaToBuffer(mediaUrl) {
  const resp = await axios.get(mediaUrl, {
    headers: authHeaders(),
    responseType: "arraybuffer",
    timeout: 30000,
  });
  return Buffer.from(resp.data);
}

/**
 * Upload un buffer (PDF) sur WhatsApp -> retourne { id }
 */
async function uploadMediaBuffer({ buffer, filename, mimeType }) {
  const url = `https://graph.facebook.com/${VERSION}/${PHONE_NUMBER_ID}/media`;

  // Axios form-data (sans lib) : on passe par multipart via FormData natif Node? (pas stable)
  // 👉 Solution simple & fiable : utiliser "form-data" package.
  // npm i form-data
  const FormData = require("form-data");
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", buffer, { filename, contentType: mimeType });

  const resp = await axios.post(url, form, {
    headers: {
      ...authHeaders(),
      ...form.getHeaders(),
    },
    maxBodyLength: Infinity,
    timeout: 60000,
  });

  return resp.data; // { id }
}

async function sendDocument({ to, mediaId, filename, caption }) {
  const url = `https://graph.facebook.com/${VERSION}/${PHONE_NUMBER_ID}/messages`;
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
    headers: authHeaders({ "Content-Type": "application/json" }),
    timeout: 30000,
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