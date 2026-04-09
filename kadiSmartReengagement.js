"use strict";

function isWithin24h(lastActivityAt) {
  if (!lastActivityAt) return false;

  const ts = new Date(lastActivityAt).getTime();
  if (!Number.isFinite(ts) || ts <= 0) return false;

  return Date.now() - ts < 24 * 60 * 60 * 1000;
}

async function sendSmartReengagement({
  waId,
  lastActivityAt,
  sendText,
  sendTemplateMessage = null,
  messageText,
  templateName = null,
  templateLanguageCode = "fr",
  templateComponents = null,
}) {
  const to = String(waId || "").trim();
  if (!to) {
    return { ok: false, reason: "missing_wa_id" };
  }

  if (typeof sendText !== "function") {
    return { ok: false, reason: "send_text_missing" };
  }

  if (!String(messageText || "").trim() && !templateName) {
    return { ok: false, reason: "missing_message_payload" };
  }

  try {
    if (isWithin24h(lastActivityAt)) {
      await sendText(to, String(messageText || "").trim());
      return { ok: true, mode: "free" };
    }

    if (templateName && typeof sendTemplateMessage === "function") {
      await sendTemplateMessage({
        to,
        templateName,
        languageCode: templateLanguageCode,
        components: templateComponents,
      });

      return { ok: true, mode: "template" };
    }

    return { ok: false, reason: "blocked_24h" };
  } catch (error) {
    return {
      ok: false,
      reason: "send_error",
      error: error?.message || "unknown_error",
    };
  }
}

module.exports = {
  isWithin24h,
  sendSmartReengagement,
};