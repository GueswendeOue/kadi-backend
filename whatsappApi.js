"use strict";

const crypto = require("crypto");
const axios = require("axios");

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const APP_SECRET = process.env.APP_SECRET;
const VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";

// --- checks ---
if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
  throw new Error("WHATSAPP_TOKEN / PHONE_NUMBER_ID manquants dans .env");
}

/**
 * Vérifie la signature Meta (X-Hub-Signature-256)
 * - Doit être appelé via express.json({ verify })
 * - N'applique la vérif que sur POST /webhook
 */
function verifyRequestSignature(req, res, buf) {
  // Vérifie seulement les POST du webhook (évite de casser /test-simple etc)
  if (req.method !== "POST") return;
  if (!req.originalUrl || !req.originalUrl.includes("/webhook")) return;

  const signature = req.headers["x-hub-signature-256"];
  if (!signature) {
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

  // comparaison timing-safe
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("Invalid request signature.");
  }
}

// ------------------------------
// Helpers Graph API
// ------------------------------
function graphUrl(path) {
  return `https://graph.facebook.com/${VERSION}/${path}`;
}

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    ...extra,
  };
}

async function postMessages(payload) {
  const url = graphUrl(`${PHONE_NUMBER_ID}/messages`);
  const resp = await axios.post(url, payload, {
    headers: authHeaders({ "Content-Type": "application/json" }),
    timeout: 15000,
  });
  return resp.data;
}

// ------------------------------
// Send text
// ------------------------------
async function sendText(to, text) {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };

  return postMessages(payload);
}

// ------------------------------
// Send interactive buttons (max 3)
// buttons = [{id,title}, ...]
// ------------------------------
async function sendButtons(to, bodyText, buttons) {
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
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  };

  return postMessages(payload);
}

// ------------------------------
// Media info & download
// ------------------------------
async function getMediaInfo(mediaId) {
  // GET /{mediaId} => { url, mime_type, sha256, file_size, id }
  const url = graphUrl(`${mediaId}`);
  const resp = await axios.get(url, {
    headers: authHeaders(),
    timeout: 15000,
  });
  return resp.data;
}

async function downloadMediaToBuffer(mediaUrl) {
  const resp = await axios.get(mediaUrl, {
    headers: authHeaders(),
    responseType: "arraybuffer",
    timeout: 30000,
  });
  return Buffer.from(resp.data);
}

// ------------------------------
// Upload a document (PDF) then send as message
// - buffer: Buffer du PDF
// - filename: ex "FAC-0001.pdf"
// - caption: texte optionnel
// ------------------------------
async function uploadMedia({ buffer, mimeType, filename }) {
  const url = graphUrl(`${PHONE_NUMBER_ID}/media`);

  // axios form-data (sans lib externe): on utilise FormData global si Node 18+
  // Render Node récent => OK. Sinon, dis-moi et je te donne version "form-data" package.
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append(
    "file",
    new Blob([buffer], { type: mimeType || "application/pdf" }),
    filename || "document.pdf"
  );

  const resp = await axios.post(url, form, {
    headers: authHeaders(form.getHeaders ? form.getHeaders() : {}),
    // si FormData global, axios gère; si getHeaders existe, on le passe
    timeout: 30000,
    maxBodyLength: Infinity,
  });

  return resp.data; // { id: "MEDIA_ID" }
}

async function sendDocument(to, { buffer, filename, caption }) {
  const up = await uploadMedia({
    buffer,
    mimeType: "application/pdf",
    filename: filename || "document.pdf",
  });

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "document",
    document: {
      id: up.id,
      filename: filename || "document.pdf",
    },
  };

  if (caption) payload.document.caption = caption;

  return postMessages(payload);
}

module.exports = {
  verifyRequestSignature,
  sendText,
  sendButtons,
  getMediaInfo,
  downloadMediaToBuffer,
  sendDocument,
};