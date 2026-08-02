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

const FLOW_LOG_MAX_DEPTH = 3;
const FLOW_LOG_MAX_ITEMS = 20;
const FLOW_LOG_MAX_INPUT_LENGTH = 4000;
const FLOW_LOG_MAX_VALUE_LENGTH = 500;
const FLOW_LOG_SENSITIVE_KEY = /^(?:authorization|access[_-]?token|token|secret|headers?|config|request|response|body|payload|to|recipient|phone(?:_number)?|wa_id|flow[_-]?token|draft[_-]?id|client|address|adresse|email|articles?)$/i;

function redactFlowDiagnosticText(value) {
  try {
    if (value == null) return null;
    return String(value)
      .slice(0, FLOW_LOG_MAX_INPUT_LENGTH)
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/\b(?:authorization|access[_-]?token|token|secret)\s*[:=]\s*[^\s,;}]+/gi, "$1=[REDACTED]")
      .replace(/([?&](?:access[_-]?token|token|key|secret)=)[^&#\s]+/gi, "$1[REDACTED]")
      .replace(/\bkadi_invoice_v1:[A-Za-z0-9_-]+:[0-9]+\b/g, "[REDACTED_FLOW_TOKEN]")
      .replace(/\bEA[A-Za-z0-9_-]{18,}\b/g, "[REDACTED_ACCESS_TOKEN]")
      .replace(/\b(?:draft[_-]?id|draftId)\s*[:=]\s*[^\s,;}]+/gi, "draft_id=[REDACTED]")
      .replace(/\b(?:flow[_-]?token|flowToken)\s*[:=]\s*[^\s,;}]+/gi, "flow_token=[REDACTED]")
      .replace(/\b(?:to|recipient|phone|wa_id|client|address|adresse|email|article)\s*[:=]\s*[^\s,;}]+/gi, "$1=[REDACTED]")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
      .replace(/\b[0-9]{8,20}\b/g, "[REDACTED_NUMBER]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, FLOW_LOG_MAX_VALUE_LENGTH);
  } catch {
    return "[REDACTED_UNSAFE_VALUE]";
  }
}

function redactFlowDiagnosticValue(value, depth = 0, seen = new WeakSet()) {
  try {
    if (value == null || typeof value !== "object") return redactFlowDiagnosticText(value);
    if (depth >= FLOW_LOG_MAX_DEPTH) return "[REDACTED_DEPTH_LIMIT]";
    if (seen.has(value)) return "[REDACTED_CIRCULAR]";
    seen.add(value);
    const output = Array.isArray(value) ? [] : {};
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors).slice(0, FLOW_LOG_MAX_ITEMS)) {
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, "value")) {
        output[key] = "[REDACTED_ACCESSOR]";
      } else if (FLOW_LOG_SENSITIVE_KEY.test(key)) {
        output[key] = "[REDACTED]";
      } else {
        output[key] = redactFlowDiagnosticValue(descriptor.value, depth + 1, seen);
      }
    }
    return redactFlowDiagnosticText(JSON.stringify(output));
  } catch {
    return "[REDACTED_UNSAFE_VALUE]";
  }
}

function ownDiagnosticValue(value, key) {
  try {
    if (value == null || (typeof value !== "object" && typeof value !== "function")) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeFlowSendErrorLog(error, meta = {}) {
  try {
    const errorMeta = ownDiagnosticValue(error, "meta") || {};
    const status = ownDiagnosticValue(error, "status");
    const code = ownDiagnosticValue(errorMeta, "code");
    const subcode = ownDiagnosticValue(errorMeta, "subcode");
    const message = ownDiagnosticValue(errorMeta, "message") || ownDiagnosticValue(error, "message") || "META_SEND_FAILED";
    const flowId = ownDiagnosticValue(meta, "flow_id");
    const targetScreen = ownDiagnosticValue(meta, "target_screen");
    const mode = ownDiagnosticValue(meta, "mode");
    return {
      status: Number.isInteger(status) ? status : null,
      type: redactFlowDiagnosticValue(ownDiagnosticValue(errorMeta, "type")),
      code: Number.isInteger(code) ? code : null,
      error_subcode: Number.isInteger(subcode) ? subcode : null,
      message: redactFlowDiagnosticValue(message),
      details: redactFlowDiagnosticValue(ownDiagnosticValue(errorMeta, "details")),
      error_user_title: redactFlowDiagnosticValue(ownDiagnosticValue(errorMeta, "error_user_title")),
      error_user_msg: redactFlowDiagnosticValue(ownDiagnosticValue(errorMeta, "error_user_msg")),
      fbtrace_id: redactFlowDiagnosticValue(ownDiagnosticValue(errorMeta, "fbtrace_id")),
      flow_id: /^\d{1,40}$/.test(String(flowId || "")) ? String(flowId) : null,
      target_screen: /^[A-Z][A-Z0-9_]{1,63}$/.test(String(targetScreen || "")) ? String(targetScreen) : null,
      mode: ["draft", "published"].includes(mode) ? mode : null,
    };
  } catch {
    return {
      status: null, type: null, code: null, error_subcode: null,
      message: "META_SEND_FAILED", details: null, error_user_title: null,
      error_user_msg: null, fbtrace_id: null, flow_id: null,
      target_screen: null, mode: null,
    };
  }
}

function logError(context, error, meta = {}) {
  if (context === "sendFlow") {
    const safe = safeFlowSendErrorLog(error, meta);
    console.error(`[WA/ERROR/${context}]`, safe.message, safe);
    return;
  }
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
    message,
    details: metaError?.error_data?.details || null,
    error_user_title: metaError?.error_user_title || null,
    error_user_msg: metaError?.error_user_msg || null,
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

async function sendTypingIndicator(messageId) {
  const id = String(messageId || "").trim();
  if (!id) return { accepted: false, skipped: true };

  const payload = {
    messaging_product: "whatsapp",
    status: "read",
    message_id: id,
    typing_indicator: {
      type: "text",
    },
  };

  try {
    const resp = await axios.post(graphUrl(`${PHONE_NUMBER_ID}/messages`), payload, {
      headers: waHeadersJson(),
      timeout: 5000,
    });

    return {
      accepted: true,
      raw: resp.data,
      messageId: extractMessageId(resp.data),
    };
  } catch (error) {
    const finalError = buildMetaApiError(error);
    logError("sendTypingIndicator", finalError, { messageId: id });
    return { accepted: false, error: finalError.message };
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

async function sendFlow(payload) {
  if (!payload || payload.type !== "interactive" || payload.interactive?.type !== "flow") {
    throw new Error("sendFlow: payload invalide");
  }
  const parameters = payload.interactive?.action?.parameters || {};
  return postJsonMessage(payload, 15000, "sendFlow", {
    flow_id: parameters.flow_id,
    target_screen: parameters.flow_action_payload?.screen,
    mode: parameters.mode,
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
  buildMetaApiError,
  redactFlowDiagnosticValue,
  safeFlowSendErrorLog,
  verifyRequestSignature,
  sendText,
  sendTypingIndicator,
  sendTemplate,
  sendButtons,
  sendList,
  getMediaInfo,
  downloadMediaToBuffer,
  uploadMediaBuffer,
  sendDocument,
  sendFlow,
  sendImage,
  sendImageByLink,
  extractStatusesFromWebhookValue,
};
