"use strict";

const crypto = require("node:crypto");
const { FLOW_KEYS } = require("./kadiV1FlowCommandRuntime");
const { ROLLOUT_MODES, isKadiV1OwnerAllowed } = require("./kadiV1CanaryIngress");

const OWNER_PATTERN = /^\d{8,20}$/;
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const MAX_RESPONSE_JSON_BYTES = 16 * 1024;
const MAX_TEXT_LENGTH = 4000;
const RECOVERABLE_TEXT = "Je n’ai pas pu terminer cette étape. Réessayez dans un instant.";
const FLOW_REPLY_KEYS = new Set(["session_id", "flow_key", "action", "data", "flow_token"]);

function ok(value) { return { ok: true, value }; }
function fail(error) { return { ok: false, error }; }

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function assertPort(target, methods, name) {
  if (!target || typeof target !== "object") throw new TypeError(`${name}_REQUIRED`);
  for (const method of methods) if (typeof target[method] !== "function") throw new TypeError(`${name}_METHOD_REQUIRED:${method}`);
  return target;
}

function normalizeOwner(value) {
  const normalized = String(value || "").replace(/[^0-9]/g, "");
  return OWNER_PATTERN.test(normalized) ? normalized : null;
}

function stableRef(value) {
  return crypto.createHash("sha256").update(String(value || "missing"), "utf8").digest("hex").slice(0, 16);
}

function correlationFor(message) {
  return `meta:${stableRef(message?.id || JSON.stringify(message || {}))}`;
}

function idempotencyFor(prefix, message) {
  return `${prefix}:${stableRef(message?.id || JSON.stringify(message || {}))}`;
}

function isNfmReply(message) {
  return message?.type === "interactive" && message?.interactive?.type === "nfm_reply";
}

function parseNfmReply(message, ownerWaId) {
  if (!isNfmReply(message)) return fail("KADI_V1_FLOW_REPLY_NOT_APPLICABLE");
  const raw = message?.interactive?.nfm_reply?.response_json;
  if (typeof raw !== "string" || !raw.trim()) return fail("KADI_V1_FLOW_REPLY_RESPONSE_JSON_MISSING");
  if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_JSON_BYTES) return fail("KADI_V1_FLOW_REPLY_RESPONSE_JSON_TOO_LARGE");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return fail("KADI_V1_FLOW_REPLY_RESPONSE_JSON_INVALID"); }
  if (!isPlainObject(parsed)) return fail("KADI_V1_FLOW_REPLY_RESPONSE_JSON_INVALID");
  if (Object.keys(parsed).some((key) => !FLOW_REPLY_KEYS.has(key))) return fail("KADI_V1_FLOW_REPLY_ENVELOPE_FIELD_FORBIDDEN");
  if (!ID_PATTERN.test(parsed.session_id || "")) return fail("KADI_V1_FLOW_REPLY_SESSION_INVALID");
  if (parsed.flow_token != null) {
    if (!ID_PATTERN.test(parsed.flow_token || "")) return fail("KADI_V1_FLOW_REPLY_TOKEN_INVALID");
    if (parsed.flow_token !== parsed.session_id) return fail("KADI_V1_FLOW_REPLY_TOKEN_MISMATCH");
  }
  if (!FLOW_KEYS.includes(parsed.flow_key)) return fail("KADI_V1_FLOW_REPLY_KEY_INVALID");
  if (typeof parsed.action !== "string" || !/^[A-Z][A-Z0-9_]{1,79}$/.test(parsed.action)) return fail("KADI_V1_FLOW_REPLY_ACTION_INVALID");
  if (!isPlainObject(parsed.data || {})) return fail("KADI_V1_FLOW_REPLY_DATA_INVALID");
  return ok(Object.freeze({
    ownerWaId,
    sessionId: parsed.session_id,
    flowKey: parsed.flow_key,
    action: parsed.action,
    data: structuredClone(parsed.data || {}),
    idempotencyKey: idempotencyFor("reply", message),
  }));
}

function normalizeResolved(result, fallbackError) {
  if (!result || typeof result !== "object") return fail(fallbackError);
  if (typeof result.ok === "boolean") return result;
  return ok(result);
}

function interactiveAction(message) {
  return message?.interactive?.button_reply?.title ||
    message?.interactive?.button_reply?.id ||
    message?.interactive?.list_reply?.title ||
    message?.interactive?.list_reply?.id ||
    null;
}

async function mapMetaMessageToConversationInput({ ownerWaId, message, value, mediaResolver }) {
  const correlationId = correlationFor(message);
  const idempotencyKey = idempotencyFor("conversation", message);

  if (message?.type === "text") {
    const text = String(message?.text?.body || "").trim();
    if (!text || text.length > MAX_TEXT_LENGTH) return fail("KADI_V1_WEBHOOK_TEXT_INVALID");
    return ok({ ownerWaId, inputType: "TEXT", text, correlationId, idempotencyKey });
  }

  if (message?.type === "interactive" && !isNfmReply(message)) {
    const action = String(interactiveAction(message) || "").trim();
    if (!action || action.length > 200) return fail("KADI_V1_WEBHOOK_MENU_ACTION_INVALID");
    return ok({ ownerWaId, inputType: "MENU_ACTION", action, correlationId, idempotencyKey });
  }

  if (message?.type === "audio") {
    const resolved = normalizeResolved(await mediaResolver.resolveAudio({ ownerWaId, message, value, correlationId }), "KADI_V1_WEBHOOK_AUDIO_RESOLVE_FAILED");
    const text = resolved.ok ? String(resolved.value?.text || "").trim() : "";
    if (!resolved.ok || !text || text.length > MAX_TEXT_LENGTH) return fail(resolved.error || "KADI_V1_WEBHOOK_AUDIO_TRANSCRIPTION_INVALID");
    return ok({ ownerWaId, inputType: "TRANSCRIPTION", text, correlationId, idempotencyKey });
  }

  if (message?.type === "image") {
    const resolved = normalizeResolved(await mediaResolver.resolveImage({ ownerWaId, message, value, correlationId }), "KADI_V1_WEBHOOK_IMAGE_RESOLVE_FAILED");
    if (!resolved.ok || !isPlainObject(resolved.value?.media)) return fail(resolved.error || "KADI_V1_WEBHOOK_IMAGE_MEDIA_INVALID");
    return ok({ ownerWaId, inputType: "IMAGE", media: structuredClone(resolved.value.media), correlationId, idempotencyKey });
  }

  if (message?.type === "document" && String(message?.document?.mime_type || "").toLowerCase() === "application/pdf") {
    const resolved = normalizeResolved(await mediaResolver.resolvePdf({ ownerWaId, message, value, correlationId }), "KADI_V1_WEBHOOK_PDF_RESOLVE_FAILED");
    if (!resolved.ok || !isPlainObject(resolved.value?.media)) return fail(resolved.error || "KADI_V1_WEBHOOK_PDF_MEDIA_INVALID");
    return ok({ ownerWaId, inputType: "PDF", media: structuredClone(resolved.value.media), correlationId, idempotencyKey });
  }

  return fail("KADI_V1_WEBHOOK_MESSAGE_UNSUPPORTED");
}

function createDisabledRuntime(reason = "KADI_V1_WEBHOOK_DISABLED") {
  return Object.freeze({
    handleIncomingValue: async () => ({ handled: false, reason }),
  });
}

function createKadiV1WebhookRuntime({
  config,
  orchestrator = null,
  flowReplyRuntime = null,
  mediaResolver = null,
  presenter = null,
  logger = console,
} = {}) {
  if (!config || typeof config.enabled !== "boolean" || !config.features) throw new TypeError("KADI_V1_RUNTIME_CONFIG_REQUIRED");
  if (!config.enabled || config.features.webhook !== true) return createDisabledRuntime();
  if (!config.rollout || config.rollout.valid !== true) return createDisabledRuntime("KADI_V1_ROLLOUT_CONFIG_INVALID");
  if (config.rollout.mode === ROLLOUT_MODES.OFF) return createDisabledRuntime("KADI_V1_ROLLOUT_OFF");

  const conversations = assertPort(orchestrator, ["handle"], "KADI_V1_CONVERSATION_ORCHESTRATOR");
  const replies = assertPort(flowReplyRuntime, ["handle"], "KADI_V1_FLOW_REPLY_RUNTIME");
  const media = assertPort(mediaResolver, ["resolveAudio", "resolveImage", "resolvePdf"], "KADI_V1_MEDIA_RESOLVER");
  const output = assertPort(presenter, ["presentConversation", "presentFlowReply", "presentRecoverableError"], "KADI_V1_WEBHOOK_PRESENTER");

  function log(event, message, reason = null) {
    try {
      logger?.log?.("KADI_V1_WEBHOOK", Object.freeze({
        event,
        message_ref: stableRef(message?.id),
        message_type: typeof message?.type === "string" ? message.type.slice(0, 40) : null,
        reason: typeof reason === "string" ? reason.slice(0, 100) : null,
      }));
    } catch { /* logging is non-authoritative */ }
  }

  async function recover(ownerWaId, message, reason) {
    log("recoverable_failure", message, reason);
    try {
      await output.presentRecoverableError({ ownerWaId, messageId: message?.id || null, canonicalText: RECOVERABLE_TEXT, reason });
    } catch { /* one failed presentation must not expose the message to legacy routing */ }
    return { handled: true, accepted: false, reason };
  }

  async function handleMessage(value, message) {
    const ownerWaId = normalizeOwner(message?.from);
    if (!ownerWaId) {
      if (isNfmReply(message)) return { handled: true, accepted: false, reason: "KADI_V1_WEBHOOK_OWNER_INVALID" };
      return { handled: false, reason: "KADI_V1_WEBHOOK_OWNER_INVALID" };
    }

    if (!isKadiV1OwnerAllowed(config.rollout, ownerWaId)) {
      if (isNfmReply(message)) {
        const recognized = parseNfmReply(message, ownerWaId);
        if (recognized.ok) {
          log("canary_owner_blocked", message, "KADI_V1_CANARY_OWNER_NOT_ALLOWED");
          return { handled: true, accepted: false, reason: "KADI_V1_CANARY_OWNER_NOT_ALLOWED" };
        }
      }
      return { handled: false, reason: "KADI_V1_OWNER_NOT_IN_ROLLOUT" };
    }

    if (isNfmReply(message)) {
      const parsed = parseNfmReply(message, ownerWaId);
      if (!parsed.ok) return recover(ownerWaId, message, parsed.error);
      let result;
      try { result = await replies.handle(parsed.value); }
      catch { return recover(ownerWaId, message, "KADI_V1_FLOW_REPLY_RUNTIME_FAILED"); }
      if (!result?.ok) return recover(ownerWaId, message, result?.error || "KADI_V1_FLOW_REPLY_FAILED");
      try {
        await output.presentFlowReply({ ownerWaId, messageId: message?.id || null, result: result.value });
      } catch { return recover(ownerWaId, message, "KADI_V1_FLOW_REPLY_PRESENTATION_FAILED"); }
      log("flow_reply_handled", message, result.value?.duplicate === true ? "DUPLICATE" : null);
      return { handled: true, accepted: true, duplicate: result.value?.duplicate === true };
    }

    let mapped;
    try { mapped = await mapMetaMessageToConversationInput({ ownerWaId, message, value, mediaResolver: media }); }
    catch { mapped = fail("KADI_V1_WEBHOOK_INPUT_RESOLUTION_FAILED"); }
    if (!mapped.ok) {
      if (mapped.error === "KADI_V1_WEBHOOK_MESSAGE_UNSUPPORTED") return { handled: false, reason: mapped.error };
      return recover(ownerWaId, message, mapped.error);
    }

    let response;
    try { response = await conversations.handle(mapped.value); }
    catch { return recover(ownerWaId, message, "KADI_V1_CONVERSATION_RUNTIME_FAILED"); }
    if (!response || response.handled !== true || typeof response.canonical_text !== "string") {
      return recover(ownerWaId, message, "KADI_V1_CONVERSATION_RESULT_INVALID");
    }
    try {
      await output.presentConversation({ ownerWaId, messageId: message?.id || null, response });
    } catch { return recover(ownerWaId, message, "KADI_V1_CONVERSATION_PRESENTATION_FAILED"); }
    log("conversation_handled", message, response.business_action || null);
    return { handled: true, accepted: true };
  }

  async function handleIncomingValue(value) {
    const messages = Array.isArray(value?.messages) ? value.messages : [];
    if (!messages.length) return { handled: false, reason: "KADI_V1_WEBHOOK_NO_MESSAGES" };
    let handled = false;
    const results = [];
    for (const message of messages) {
      const result = await handleMessage(value, message);
      results.push(result);
      handled = handled || result.handled === true;
    }
    return Object.freeze({ handled, results: Object.freeze(results.map((entry) => Object.freeze({ ...entry }))) });
  }

  return Object.freeze({ handleIncomingValue });
}

module.exports = {
  MAX_RESPONSE_JSON_BYTES,
  RECOVERABLE_TEXT,
  correlationFor,
  createKadiV1WebhookRuntime,
  idempotencyFor,
  isNfmReply,
  mapMetaMessageToConversationInput,
  parseNfmReply,
};
