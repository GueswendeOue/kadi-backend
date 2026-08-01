"use strict";

const crypto = require("node:crypto");
const { parseInvoiceFlowReply } = require("./kadiInvoiceFlowContract");

function messageRef(value) {
  return crypto.createHash("sha256").update(String(value || "missing"), "utf8").digest("hex").slice(0, 12);
}

function createInvoiceFlowCompletionHandler({ flowSessionService, sendText, logger = console } = {}) {
  const seen = new Set();
  return async function handle({ from, message, identity } = {}) {
    const messageId = message?.id || null;
    const log = (fields) => logger?.log?.("KADI_FLOW_COMPLETION", {
      message_ref: messageRef(messageId),
      sender_ref: messageRef(from || identity?.wa_id),
      ...fields,
    });
    if (message?.type !== "interactive" || message?.interactive?.type !== "nfm_reply") return { handled: false };
    const parsed = parseInvoiceFlowReply(message);
    if (!parsed.ok) {
      log({ response_json_valid: false, draft_id_present: false, duplicate: false, outcome: "ignored", reason: parsed.error });
      return { handled: false, reason: parsed.error };
    }
    const payload = parsed.value;
    if (typeof payload.flow_token !== "string" || !payload.flow_token.trim()) {
      log({ response_json_valid: true, draft_id_present: false, duplicate: false, outcome: "ignored", reason: "FLOW_TOKEN_MISSING" });
      return { handled: false, reason: "FLOW_TOKEN_MISSING" };
    }
    if (messageId && seen.has(messageId)) {
      log({ response_json_valid: true, draft_id_present: Boolean(payload.draft_id), duplicate: true, outcome: "ignored", reason: "DUPLICATE_MESSAGE" });
      return { handled: true, duplicate: true, reason: "DUPLICATE_MESSAGE" };
    }
    const session = await flowSessionService?.resolveInvoiceFlowSession?.(payload.flow_token);
    if (!session?.ok || (payload.draft_id && payload.draft_id !== session.value.draftId)) {
      log({ response_json_valid: true, draft_id_present: Boolean(payload.draft_id), duplicate: false, outcome: "ignored", reason: "FLOW_SESSION_INVALID" });
      return { handled: false, reason: "FLOW_SESSION_INVALID" };
    }
    if (messageId) seen.add(messageId);
    log({ response_json_valid: true, draft_id_present: Boolean(payload.draft_id), duplicate: false, outcome: "handled", reason: "FLOW_COMPLETION_ACCEPTED" });
    if (typeof sendText === "function") await sendText(from, "✅ J’ai bien reçu les informations de votre facture. Voulez-vous relire, modifier ou générer le document ?").catch(() => {});
    return { handled: true, outcome: "handled" };
  };
}

module.exports = { createInvoiceFlowCompletionHandler, messageRef };
