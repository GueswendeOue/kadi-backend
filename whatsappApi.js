// whatsappApi.js
"use strict";

const crypto = require("crypto");
const axios = require("axios");
const FormData = require("form-data");

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const APP_SECRET = process.env.APP_SECRET;
const VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";

if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
  throw new Error("WHATSAPP_TOKEN / PHONE_NUMBER_ID manquants dans .env");
}

/**
 * Vérifie la signature Meta (x-hub-signature-256)
 * Utilisé dans index.js (express.json verify callback)
 */
function verifyRequestSignature(req, res, buf) {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) {
    throw new Error('Missing "x-hub-signature-256" header.');
  }
  if (!APP_SECRET) {
    throw new Error("APP_SECRET manquant: impossible de vérifier la signature.");
  }

  const [algo, hash] = signature.split("=");
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

function waHeadersJson() {
  return {
    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  };
}

/**
 * Envoi d’un message texte
 */
async function sendText(to, text) {
  const url = graphUrl(`${PHONE_NUMBER_ID}/messages`);
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: String(text || "") },
  };

  const resp = await axios.post(url, payload, {
    headers: waHeadersJson(),
    timeout: 15000,
  });

  return resp.data;
}

/**
 * Envoi de boutons (max 3)
 * buttons: [{id, title}]
 */
async function sendButtons(to, bodyText, buttons) {
  const url = graphUrl(`${PHONE_NUMBER_ID}/messages`);

  const safeButtons = (buttons || []).slice(0, 3).map((b) => ({
    type: "reply",
    reply: { id: String(b.id), title: String(b.title || "").slice(0, 20) }, // WA limite title
  }));

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: String(bodyText || "") },
      action: { buttons: safeButtons },
    },
  };

  const resp = await axios.post(url, payload, {
    headers: waHeadersJson(),
    timeout: 15000,
  });

  return resp.data;
}

/**
 * ✅ Envoi d’une LIST (menu long, parfait pour Documents)
 *
 * shape:
 * sendList(to, {
 *   header: "Documents",
 *   body: "Quel document voulez-vous créer ?",
 *   footer: "KADI",
 *   buttonText: "Choisir",
 *   sections: [
 *     { title: "Création", rows: [{id,title,description}] }
 *   ]
 * })
 *
 * WA limits (pratique):
 * - header/body/footer: texte
 * - buttonText: <= 20
 * - row.title <= 24 (souvent), row.description <= 72 (selon clients)
 */
async function sendList(to, opts = {}) {
  const url = graphUrl(`${PHONE_NUMBER_ID}/messages`);

  const headerText = String(opts.header || "").slice(0, 60);
  const bodyText = String(opts.body || "Choisissez une option");
  const footerText = String(opts.footer || "").slice(0, 60);
  const buttonText = String(opts.buttonText || "Choisir").slice(0, 20);

  const sections = Array.isArray(opts.sections) ? opts.sections : [];
  const safeSections = sections.slice(0, 10).map((sec) => {
    const rows = Array.isArray(sec.rows) ? sec.rows : [];
    return {
      title: String(sec.title || "Options").slice(0, 24),
      rows: rows.slice(0, 10).map((r) => ({
        id: String(r.id || "").slice(0, 200),
        title: String(r.title || "").slice(0, 24),
        description: String(r.description || "").slice(0, 72),
      })),
    };
  });

  if (!safeSections.length || !safeSections[0].rows.length) {
    throw new Error("sendList: sections/rows vides");
  }

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: {
        button: buttonText,
        sections: safeSections,
      },
    },
  };

  // header/footer sont optionnels selon templates/clients
  if (headerText) payload.interactive.header = { type: "text", text: headerText };
  if (footerText) payload.interactive.footer = { text: footerText };

  const resp = await axios.post(url, payload, {
    headers: waHeadersJson(),
    timeout: 15000,
  });

  return resp.data;
}

/**
 * Récupère info media (url, mime_type, file_size, ...)
 */
async function getMediaInfo(mediaId) {
  const url = graphUrl(`${mediaId}`);

  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    timeout: 15000,
  });

  return resp.data; // { url, mime_type, sha256, file_size, id }
}

/**
 * Télécharge le media (url retournée par getMediaInfo)
 */
async function downloadMediaToBuffer(mediaUrl) {
  const resp = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    responseType: "arraybuffer",
    timeout: 30000,
  });
  return Buffer.from(resp.data);
}

/**
 * Upload buffer as WhatsApp media (PDF / image / csv)
 * returns: { id: "MEDIA_ID" }
 */
async function uploadMediaBuffer({ buffer, filename, mimeType }) {
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

/**
 * Envoi d’un document déjà uploadé (mediaId)
 */
async function sendDocument({ to, mediaId, filename, caption }) {
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
    headers: waHeadersJson(),
    timeout: 15000,
  });

  return resp.data;
}

module.exports = {
  verifyRequestSignature,
  sendText,
  sendButtons,
  sendList, // ✅ export
  getMediaInfo,
  downloadMediaToBuffer,
  uploadMediaBuffer,
  sendDocument,
};