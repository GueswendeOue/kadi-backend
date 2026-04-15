"use strict";

// ===============================
// Utils
// ===============================
function isWithin24h(lastActivityAt) {
  if (!lastActivityAt) return false;

  const ts = new Date(lastActivityAt).getTime();
  if (!Number.isFinite(ts) || ts <= 0) return false;

  return Date.now() - ts < 24 * 60 * 60 * 1000;
}

// ===============================
// MAIN FUNCTION
// ===============================
async function sendSmartReengagement({
  waId,
  lastActivityAt,
  sendText,
  sendTemplateMessage = null,
  messageText,
  templateName = null,
  templateLanguageCode = "fr",
  templateComponents = [],
}) {
  const to = String(waId || "").trim();

  if (!to) {
    return { ok: false, reason: "missing_wa_id" };
  }

  if (typeof sendText !== "function") {
    return { ok: false, reason: "send_text_missing" };
  }

  const safeMessageText = String(messageText || "").trim();
  const safeTemplateName = String(templateName || "").trim();

  if (!safeMessageText && !safeTemplateName) {
    return { ok: false, reason: "missing_message_payload" };
  }

  try {
    // ===============================
    // CASE 1 → fenêtre 24h ouverte
    // ===============================
    if (isWithin24h(lastActivityAt)) {
      if (!safeMessageText) {
        return { ok: false, reason: "empty_free_message" };
      }

      await sendText(to, safeMessageText);

      return {
        ok: true,
        mode: "free",
      };
    }

    // ===============================
    // CASE 2 → hors 24h → template obligatoire
    // ===============================
    if (safeTemplateName && typeof sendTemplateMessage === "function") {
      await sendTemplateMessage({
        to,
        name: safeTemplateName,
        language: templateLanguageCode,

        // ✅ sécurité Meta
        components: Array.isArray(templateComponents)
          ? templateComponents
          : [],
      });

      return {
        ok: true,
        mode: "template",
      };
    }

    // ===============================
    // CASE 3 → bloqué Meta
    // ===============================
    return {
      ok: false,
      reason: "blocked_24h",
    };
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