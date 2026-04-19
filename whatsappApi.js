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

// ======================================================
// Constantes Meta / WhatsApp
// ======================================================
const LIMITS = {
  buttonTitle: 20,
  listButton: 20,
  headerText: 60,
  footerText: 60,
  sectionTitle: 24,
  rowTitle: 24,
  rowDescription: 72,
  rowId: 200,
  maxButtons: 3,
  maxSections: 10,
  maxRowsPerSection: 10,
  maxRowsTotal: 10,
};

// ======================================================
// Logging helpers
// ======================================================
function logInfo(context, message, meta = {}) {
  console.log(`[WA/INFO/${context}]`, message, meta);
}

function logError(context, error, meta = {}) {
  console.error(`[WA/ERROR/${context}]`, error?.message || error, {
    ...meta,
    status: error?.status || null,
    waMeta: error?.meta || null,
    raw: error?.raw || null,
  });
}

// ======================================================
// Signature webhook
// ======================================================
function verifyRequestSignature(req, res, buf) {
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

  if (hash !== expected) {
    throw new Error("Invalid request signature.");
  }
}

// ======================================================
// Helpers généraux
// ======================================================
function graphUrl(path) {
  return `https://graph.facebook.com/${VERSION}/${path}`;
}

function waHeadersJson() {
  return {
    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function extractMessageId(respData) {
  return respData?.messages?.[0]?.id || null;
}

function clip(value, max) {
  return String(value || "").trim().slice(0, max);
}

function safeText(value, fallback = "") {
  return String(value || fallback).trim();
}

function buildMetaApiError(error) {
  const status = error?.response?.status || 500;
  const data = error?.response?.data || null;
  const metaError = data?.error || null;

  const code = metaError?.code || null;
  const subcode = metaError?.error_subcode || null;
  const message =
    metaError?.message ||
    error?.message ||
    "WhatsApp API request failed";

  const details = {
    status,
    code,
    subcode,
    type: metaError?.type || null,
    fbtrace_id: metaError?.fbtrace_id || null,
    error_data: metaError?.error_data || null,
  };

  const finalError = new Error(
    `[WhatsApp API] ${message}${code ? ` (code ${code})` : ""}${
      subcode ? ` / subcode ${subcode}` : ""
    }`
  );

  finalError.status = status;
  finalError.meta = details;
  finalError.raw = data;

  return finalError;
}

async function postJsonMessage(payload, timeout = 15000, context = "message", meta = {}) {
  const url = graphUrl(`${PHONE_NUMBER_ID}/messages`);

  try {
    const resp = await axios.post(url, payload, {
      headers: waHeadersJson(),
      timeout,
    });

    const result = {
      accepted: true,
      raw: resp.data,
      messageId: extractMessageId(resp.data),
    };

    if (context === "sendDocument" || context === "sendTemplate") {
      logInfo(context, "accepted_by_meta", {
        ...meta,
        messageId: result.messageId,
      });
    }

    return result;
  } catch (error) {
    const finalError = buildMetaApiError(error);

    logError(context, finalError, meta);
    throw finalError;
  }
}

// ======================================================
// Validation list message
// ======================================================
function normalizeListSections(sections = []) {
  const normalizedSections = [];

  for (const sec of Array.isArray(sections)
    ? sections.slice(0, LIMITS.maxSections)
    : []) {
    const rawRows = Array.isArray(sec?.rows) ? sec.rows : [];

    const safeRows = rawRows
      .slice(0, LIMITS.maxRowsPerSection)
      .map((row) => ({
        id: clip(row?.id, LIMITS.rowId),
        title: clip(row?.title, LIMITS.rowTitle),
        description: clip(row?.description, LIMITS.rowDescription),
      }))
      .filter((row) => row.id && row.title);

    if (!safeRows.length) continue;

    normalizedSections.push({
      title: clip(sec?.title || "Options", LIMITS.sectionTitle),
      rows: safeRows,
    });
  }

  return normalizedSections;
}

function validateListSections(sections) {
  if (!Array.isArray(sections) || !sections.length) {
    throw new Error("sendList: sections vides");
  }

  let totalRows = 0;

  for (const sec of sections) {
    if (!Array.isArray(sec.rows) || !sec.rows.length) {
      throw new Error(`sendList: section "${sec.title || "?"}" sans rows`);
    }

    totalRows += sec.rows.length;

    if (sec.rows.length > LIMITS.maxRowsPerSection) {
      throw new Error(
        `sendList: section "${sec.title}" dépasse ${LIMITS.maxRowsPerSection} rows`
      );
    }

    for (const row of sec.rows) {
      if (!row.id || !row.title) {
        throw new Error("sendList: row invalide (id/title requis)");
      }
    }
  }

  if (totalRows > LIMITS.maxRowsTotal) {
    throw new Error(
      `sendList: too many rows (${totalRows}/${LIMITS.maxRowsTotal} max)`
    );
  }

  return totalRows;
}

// ======================================================
// Messages simples
// ======================================================
async function sendText(to, text) {
  const payload = {
    messaging_product: "whatsapp",
    to: String(to),
    type: "text",
    text: {
      body: safeText(text),
    },
  };

  return postJsonMessage(payload, 15000, "sendText", {
    to: String(to),
    kind: "text",
  });
}

async function sendTemplate({ to, name, language = "fr", components = [] }) {
  const payload = {
    messaging_product: "whatsapp",
    to: String(to),
    type: "template",
    template: {
      name,
      language: {
        code: language,
      },
      components,
    },
  };

  return postJsonMessage(payload, 15000, "sendTemplate", {
    to: String(to),
    name,
    language,
    componentsCount: Array.isArray(components) ? components.length : 0,
  });
}

async function sendButtons(to, bodyText, buttons) {
  const safeButtons = (Array.isArray(buttons) ? buttons : [])
    .slice(0, LIMITS.maxButtons)
    .map((b) => ({
      type: "reply",
      reply: {
        id: clip(b?.id, LIMITS.rowId),
        title: clip(b?.title, LIMITS.buttonTitle),
      },
    }))
    .filter((b) => b.reply.id && b.reply.title);

  if (!safeButtons.length) {
    throw new Error("sendButtons: aucun bouton valide");
  }

  const payload = {
    messaging_product: "whatsapp",
    to: String(to),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: safeText(bodyText, "Choisissez une option") },
      action: { buttons: safeButtons },
    },
  };

  return postJsonMessage(payload, 15000, "sendButtons", {
    to: String(to),
    buttonsCount: safeButtons.length,
  });
}

// ======================================================
// List message
// ======================================================
async function sendList(to, opts = {}) {
  const headerText = clip(opts?.header, LIMITS.headerText);
  const bodyText = safeText(opts?.body, "Choisissez une option");
  const footerText = clip(opts?.footer, LIMITS.footerText);
  const buttonText = clip(opts?.buttonText || "Choisir", LIMITS.listButton);

  const safeSections = normalizeListSections(opts?.sections || []);
  validateListSections(safeSections);

  const payload = {
    messaging_product: "whatsapp",
    to: String(to),
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

  if (headerText) {
    payload.interactive.header = {
      type: "text",
      text: headerText,
    };
  }

  if (footerText) {
    payload.interactive.footer = {
      text: footerText,
    };
  }

  return postJsonMessage(payload, 15000, "sendList", {
    to: String(to),
    sectionsCount: safeSections.length,
  });
}

// ======================================================
// Media
// ======================================================
async function getMediaInfo(mediaId) {
  try {
    const resp = await axios.get(graphUrl(`${mediaId}`), {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      },
      timeout: 15000,
    });

    return resp.data;
  } catch (error) {
    throw buildMetaApiError(error);
  }
}

async function downloadMediaToBuffer(mediaUrl) {
  try {
    const resp = await axios.get(mediaUrl, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      },
      responseType: "arraybuffer",
      timeout: 30000,
    });

    return Buffer.from(resp.data);
  } catch (error) {
    throw buildMetaApiError(error);
  }
}

async function uploadMediaBuffer({ buffer, filename, mimeType }) {
  const url = graphUrl(`${PHONE_NUMBER_ID}/media`);

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType || "application/pdf");
  form.append("file", buffer, {
    filename: filename || "document.pdf",
    contentType: mimeType || "application/pdf",
  });

  try {
    const resp = await axios.post(url, form, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        ...form.getHeaders(),
      },
      maxBodyLength: Infinity,
      timeout: 60000,
    });

    logInfo("uploadMediaBuffer", "uploaded", {
      filename: filename || "document.pdf",
      mimeType: mimeType || "application/pdf",
      mediaId: resp?.data?.id || null,
    });

    return resp.data;
  } catch (error) {
    const finalError = buildMetaApiError(error);
    logError("uploadMediaBuffer", finalError, {
      filename: filename || "document.pdf",
      mimeType: mimeType || "application/pdf",
    });
    throw finalError;
  }
}

async function sendDocument({ to, mediaId, filename, caption }) {
  if (!mediaId) {
    throw new Error("sendDocument: mediaId requis");
  }

  const payload = {
    messaging_product: "whatsapp",
    to: String(to),
    type: "document",
    document: {
      id: String(mediaId),
      filename: filename || "document.pdf",
      caption: caption || "",
    },
  };

  return postJsonMessage(payload, 15000, "sendDocument", {
    to: String(to),
    mediaId: String(mediaId),
    filename: filename || "document.pdf",
    hasCaption: !!caption,
  });
}

async function sendImage({ to, mediaId, caption }) {
  const payload = {
    messaging_product: "whatsapp",
    to: String(to),
    type: "image",
    image: {
      id: String(mediaId),
      caption: caption || "",
    },
  };

  return postJsonMessage(payload, 15000, "sendImage", {
    to: String(to),
    mediaId: String(mediaId),
    hasCaption: !!caption,
  });
}

async function sendImageByLink({ to, imageLink, caption }) {
  const payload = {
    messaging_product: "whatsapp",
    to: String(to),
    type: "image",
    image: {
      link: String(imageLink || ""),
      caption: caption || "",
    },
  };

  return postJsonMessage(payload, 15000, "sendImageByLink", {
    to: String(to),
    hasCaption: !!caption,
  });
}

// ======================================================
// Webhook statuses
// ======================================================
function extractStatusesFromWebhookValue(value) {
  if (!value?.statuses?.length) return [];

  return value.statuses.map((s) => ({
    messageId: s.id || null,
    recipientId: s.recipient_id || null,
    status: s.status || null,
    timestamp: s.timestamp || null,
    conversationId: s.conversation?.id || null,
    pricingCategory: s.pricing?.category || null,
    errorCode: s.errors?.[0]?.code || null,
    errorTitle: s.errors?.[0]?.title || null,
    raw: s,
  }));
}

module.exports = {
  verifyRequestSignature,
  sendText,
  sendTemplate,
  sendButtons,
  sendList,
  getMediaInfo,
  downloadMediaToBuffer,
  uploadMediaBuffer,
  sendDocument,
  sendImage,
  sendImageByLink,
  extractStatusesFromWebhookValue,
};