"use strict";

const crypto = require("node:crypto");
const { FLOW_KEYS } = require("./kadiV1FlowCommandRuntime");
const { ROLLOUT_MODES, isKadiV1OwnerAllowed } = require("./kadiV1CanaryIngress");

const OWNER_PATTERN = /^\d{8,20}$/;
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const MAX_RESPONSE_JSON_BYTES = 16 * 1024;
const MAX_TEXT_LENGTH = 4000;
const RECOVERABLE_TEXT = "Je n’ai pas pu terminer cette étape. Réessayez dans un instant.";
// T11: config.features.transcription is the sole inbound-voice authority
// (kadiV1RuntimeConfig.js) — distinct from config.features.voice, which
// only ever governs an optional OUTBOUND voice response and must never be
// consulted here. This text is shown before any Meta media lookup,
// download, or OpenAI call is ever made for this message.
const TRANSCRIPTION_DISABLED_REASON = "KADI_V1_TRANSCRIPTION_DISABLED";
const TRANSCRIPTION_DISABLED_TEXT = "Les messages vocaux ne sont pas encore activés ici. Vous pouvez m’écrire les informations.";
// T12: config.features.vision is the sole inbound IMAGE/PDF authority.
// Visual interpretation additionally requires config.features.brain —
// interpretation.interpret() (kadiV1ConversationOrchestrator.js) never
// reaches Gemini without it (BRAIN_DISABLED fires first), so downloading
// and storing media only to hit that dead end would be pure waste. Two
// distinct internal reasons (vision itself off vs. vision on but brain
// off) for precise, safe-to-log diagnostics — both show the identical
// truthful, internals-free user text.
const VISION_DISABLED_REASON = "KADI_V1_VISION_DISABLED";
const VISUAL_BRAIN_DISABLED_REASON = "KADI_V1_VISUAL_BRAIN_DISABLED";
const VISUAL_DISABLED_TEXT = "Les photos et documents ne sont pas encore activés ici. Vous pouvez m’écrire les informations.";
// Every one of these codes comes from kadiV1FinalGenerationService.js's
// generatePrivate — a render/private-storage failure strictly before
// capture, always accompanied by a released reservation and zero debit
// (kadiV1GenerationLifecycleService.js's releaseAndFail). Pressing the same
// confirmation action again reaches kadiV1GenerationLifecycleService.js's
// confirmOrRetryGeneration, which routes to retryFailedGeneration for
// exactly this recorded state — so this text is truthful, not aspirational.
const GENERATION_RETRY_TEXT = "Le document n’a pas pu être généré. Vous pouvez réessayer sans perdre de crédit.";
const GENERATION_RETRY_REASONS = new Set([
  "FINAL_RENDER_FAILED", "FINAL_PDF_INVALID", "FINAL_PDF_CORRUPT",
  "FINAL_PDF_PAGE_COUNT_MISMATCH", "FINAL_STORAGE_FAILED", "FINAL_STORAGE_NOT_PRIVATE",
]);
// A post-capture delivery failure — the PDF was already rendered, paid for
// and promoted; only sending it failed. This must never share the generic
// GENERATION_RETRY_TEXT (which promises "no credit lost" for a render
// failure that never captured one) nor the plain RECOVERABLE_TEXT (which
// offers no way forward at all) — it gets its own presentation with a real,
// reachable retry button. See kadiV1GenerationLifecycleService.js's
// deliverFinal/retryDelivery and docs/KADI_ENGINEERING_MEMORY.md fiche P/Q.
const DELIVERY_RECOVERABLE_REASON = "DELIVERY_RECOVERABLE_FAILURE";
const RETRY_DELIVERY_BUTTON_PATTERN = /^RETRY_DELIVERY:([A-Za-z0-9:_-]{1,200})$/;
// Outcome-unknown resend requires an explicit, distinct second
// confirmation (never the same button id as the ordinary confirmed-failure
// retry) — see kadiV1GenerationLifecycleService.js's runRetryDelivery and
// docs/KADI_ENGINEERING_MEMORY.md fiche R.
const RESEND_UNKNOWN_DELIVERY_BUTTON_PATTERN = /^RESEND_UNKNOWN_DELIVERY:([A-Za-z0-9:_-]{1,200})$/;
const CANCEL_UNKNOWN_DELIVERY_BUTTON_PATTERN = /^CANCEL_UNKNOWN_DELIVERY:([A-Za-z0-9:_-]{1,200})$/;
const FLOW_REPLY_KEYS = new Set(["session_id", "flow_key", "action", "data", "flow_token"]);
// Presentation failures may throw for many reasons (Supabase/Postgres
// errors included); only a closed-set internal code — never raw driver
// text, a payload, or PII — may ever reach the log or the caller.
const SAFE_INTERNAL_REASON_PATTERN = /^KADI_V1_[A-Z0-9_]{1,80}$/;

function safeInternalReason(error, fallback) {
  const message = typeof error?.message === "string" ? error.message : "";
  return SAFE_INTERNAL_REASON_PATTERN.test(message) ? message : fallback;
}

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

// T12: the exact same shape mapMetaMessageToConversationInput() below uses
// to decide whether a message is visual (IMAGE, or a "document" message
// whose declared MIME is application/pdf) — kept as a single source of
// truth so the gate and the mapper can never drift apart. A "document"
// message with any other MIME is not visual: mapMetaMessageToConversationInput
// already fails it closed as KADI_V1_WEBHOOK_MESSAGE_UNSUPPORTED without
// ever touching a media resolver, regardless of config.features.vision.
function isVisualMessage(message) {
  return message?.type === "image" ||
    (message?.type === "document" && String(message?.document?.mime_type || "").toLowerCase() === "application/pdf");
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
  // Optional and deliberately decoupled from `orchestrator`
  // (kadiV1ConversationOrchestrator.js, the conversational-multimodal
  // dispatch surface) and from `flowReplyRuntime` (which requires an open
  // Flow session a plain interactive button never has). A plain WhatsApp
  // reply-button press is intercepted before either — see handleMessage
  // below. Left unconfigured, a delivery-retry button press fails closed
  // (logged, absorbed) rather than crashing or falling through to the
  // wrong handler.
  deliveryRetryRuntime = null,
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
  const deliveryRetry = deliveryRetryRuntime == null ? null : assertPort(deliveryRetryRuntime, ["handle"], "KADI_V1_DELIVERY_RETRY_RUNTIME");

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

  async function recover(ownerWaId, message, reason, documentId = null) {
    log("recoverable_failure", message, reason);
    if (
      reason === DELIVERY_RECOVERABLE_REASON &&
      ID_PATTERN.test(documentId || "") &&
      typeof output.presentDeliveryFailureWithRetry === "function"
    ) {
      try {
        await output.presentDeliveryFailureWithRetry({ ownerWaId, messageId: message?.id || null, documentId });
        return { handled: true, accepted: false, reason };
      } catch { /* fall through to the generic presentation below */ }
    }
    const canonicalText = reason === TRANSCRIPTION_DISABLED_REASON
      ? TRANSCRIPTION_DISABLED_TEXT
      : (reason === VISION_DISABLED_REASON || reason === VISUAL_BRAIN_DISABLED_REASON)
        ? VISUAL_DISABLED_TEXT
        : GENERATION_RETRY_REASONS.has(reason) ? GENERATION_RETRY_TEXT : RECOVERABLE_TEXT;
    try {
      await output.presentRecoverableError({ ownerWaId, messageId: message?.id || null, canonicalText, reason });
    } catch { /* one failed presentation must not expose the message to legacy routing */ }
    return { handled: true, accepted: false, reason };
  }

  function retryButtonId(message) {
    const id = message?.interactive?.button_reply?.id;
    return typeof id === "string" ? id : null;
  }

  async function handleDeliveryRetryButton(ownerWaId, message, documentId, confirmed = false) {
    log("delivery_retry_button_pressed", message, null);
    if (!deliveryRetry) return { handled: true, accepted: false, reason: "KADI_V1_DELIVERY_RETRY_RUNTIME_UNAVAILABLE" };
    let result;
    try {
      result = await deliveryRetry.handle({ ownerWaId, documentId, idempotencyKey: idempotencyFor("delivery_retry", message), confirmed });
    } catch {
      result = { ok: false, error: "KADI_V1_DELIVERY_RETRY_RUNTIME_FAILED" };
    }
    // The outcome is genuinely unknown and this exact press did not carry
    // an explicit confirmation yet — show the two-choice offer instead of
    // the generic outcome text, and never call the provider on this press.
    if (!confirmed && result?.error === "DELIVERY_OUTCOME_UNKNOWN_CONFIRMATION_REQUIRED" && typeof output.presentDeliveryOutcomeUnknownWithRetry === "function") {
      try {
        await output.presentDeliveryOutcomeUnknownWithRetry({ ownerWaId, messageId: message?.id || null, documentId });
        return { handled: true, accepted: false, reason: result.error };
      } catch { /* fall through to the generic presentation below */ }
    }
    if (result?.error === "DELIVERY_ALREADY_IN_PROGRESS" && typeof output.presentDeliveryInProgress === "function") {
      try {
        await output.presentDeliveryInProgress({ ownerWaId, messageId: message?.id || null, documentId });
        return { handled: true, accepted: false, reason: result.error };
      } catch { /* fall through to the generic presentation below */ }
    }
    const outcome = result?.ok
      ? "SUCCEEDED"
      : result?.error === DELIVERY_RECOVERABLE_REASON
        ? "FAILED_PERSISTENT"
        : "REJECTED";
    if (typeof output.presentDeliveryRetryOutcome === "function") {
      try {
        await output.presentDeliveryRetryOutcome({ ownerWaId, messageId: message?.id || null, outcome, reasonCode: result?.ok ? null : (result?.error || null) });
      } catch { /* one failed presentation must not expose the message to legacy routing */ }
    }
    return { handled: true, accepted: result?.ok === true, reason: result?.ok ? null : (result?.error || "KADI_V1_DELIVERY_RETRY_FAILED") };
  }

  // The user explicitly declined to resend an outcome-unknown delivery —
  // never calls the delivery-retry runtime at all, so no provider call and
  // no state change can ever result from this button.
  async function handleCancelUnknownDeliveryButton(ownerWaId, message, documentId) {
    log("delivery_retry_cancelled", message, null);
    if (typeof output.presentDeliveryRetryCancelled === "function") {
      try {
        await output.presentDeliveryRetryCancelled({ ownerWaId, messageId: message?.id || null, documentId });
      } catch { /* non-blocking */ }
    }
    return { handled: true, accepted: false, reason: "DELIVERY_RETRY_CANCELLED" };
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

    // Checked before both isNfmReply and the general MENU_ACTION mapping
    // below — a plain reply-button press has no Flow session (nfm_reply
    // requires one) and must never be fuzzy-matched by the conversational
    // orchestrator's natural-language intent detection. Any button id not
    // matching this exact closed pattern falls through unchanged to
    // existing handling (e.g. the ordinary MENU_ACTION path).
    if (message?.type === "interactive" && !isNfmReply(message)) {
      const buttonId = retryButtonId(message) || "";
      const resendMatch = RESEND_UNKNOWN_DELIVERY_BUTTON_PATTERN.exec(buttonId);
      if (resendMatch) return handleDeliveryRetryButton(ownerWaId, message, resendMatch[1], true);
      const cancelMatch = CANCEL_UNKNOWN_DELIVERY_BUTTON_PATTERN.exec(buttonId);
      if (cancelMatch) return handleCancelUnknownDeliveryButton(ownerWaId, message, cancelMatch[1]);
      const match = RETRY_DELIVERY_BUTTON_PATTERN.exec(buttonId);
      if (match) return handleDeliveryRetryButton(ownerWaId, message, match[1], false);
    }

    if (isNfmReply(message)) {
      const parsed = parseNfmReply(message, ownerWaId);
      if (!parsed.ok) return recover(ownerWaId, message, parsed.error);
      let result;
      try { result = await replies.handle(parsed.value); }
      catch { return recover(ownerWaId, message, "KADI_V1_FLOW_REPLY_RUNTIME_FAILED"); }
      if (!result?.ok) return recover(ownerWaId, message, result?.error || "KADI_V1_FLOW_REPLY_FAILED", result?.documentId || null);
      try {
        await output.presentFlowReply({ ownerWaId, messageId: message?.id || null, result: result.value });
      } catch (presentationError) {
        return recover(ownerWaId, message, safeInternalReason(presentationError, "KADI_V1_FLOW_REPLY_PRESENTATION_FAILED"));
      }
      log("flow_reply_handled", message, result.value?.duplicate === true ? "DUPLICATE" : null);
      return { handled: true, accepted: true, duplicate: result.value?.duplicate === true };
    }

    // T11 (inbound voice transcription gate): the earliest safe
    // application boundary, strictly before
    // mediaResolver.resolveAudio() is ever reached, so a disabled owner
    // triggers ZERO Meta media lookup, ZERO Meta media download, ZERO
    // temporary audio ingestion and ZERO OpenAI transcription call.
    // config.features.voice (the separate, OUTBOUND voice response
    // authority) is never consulted here — an operator enabling voice
    // replies must never silently re-open inbound audio processing.
    if (message?.type === "audio" && config.features.transcription !== true) {
      return recover(ownerWaId, message, TRANSCRIPTION_DISABLED_REASON);
    }

    // T12 (image/PDF vision ingress gate): the earliest safe application
    // boundary, strictly before mediaResolver.resolveImage()/resolvePdf()
    // is ever reached, so a disabled owner triggers ZERO Meta media
    // lookup, ZERO Meta media download, ZERO media validation and ZERO
    // temporary media ingestion. Visual interpretation additionally
    // requires config.features.brain — interpretation.interpret() never
    // reaches Gemini without it (kadiV1ConversationOrchestrator.js's own
    // BRAIN_DISABLED short-circuit fires first, confirmed by code: input.media
    // is only ever read after that check passes) — so media would
    // otherwise be downloaded and stored only to hit that dead end.
    if (isVisualMessage(message)) {
      if (config.features.vision !== true) return recover(ownerWaId, message, VISION_DISABLED_REASON);
      if (config.features.brain !== true) return recover(ownerWaId, message, VISUAL_BRAIN_DISABLED_REASON);
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
  GENERATION_RETRY_TEXT,
  TRANSCRIPTION_DISABLED_REASON,
  TRANSCRIPTION_DISABLED_TEXT,
  VISION_DISABLED_REASON,
  VISUAL_BRAIN_DISABLED_REASON,
  VISUAL_DISABLED_TEXT,
  correlationFor,
  createKadiV1WebhookRuntime,
  idempotencyFor,
  isNfmReply,
  mapMetaMessageToConversationInput,
  parseNfmReply,
  safeInternalReason,
};
