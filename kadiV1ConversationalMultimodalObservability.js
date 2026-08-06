"use strict";

// Privacy-safe event emission for KADI_CONVERSATIONAL_MULTIMODAL_V1,
// following the same safeEmitter(logger) pattern already used by
// kadiV1GeminiVisionProvider.js / kadiV1GeminiAudioProvider.js /
// kadiV1VoiceProviders.js: a closed event-name allowlist, a closed
// safe-field allowlist (hashed/bucketed/enum values only, never raw
// content), wrapped in try/catch so a missing or failing logger never
// changes the document path's outcome.
//
// A future KADI_ADMIN_AI_OBSERVABILITY_V1 mission is expected to consume
// these events (aggregated, read-only) for an admin dashboard. This module
// only emits them — it does not persist, aggregate, or expose them itself,
// and it is never read back inside this mission's own request path.

const crypto = require("node:crypto");
const { INTENTS, OPERATIONS } = require("./kadiV1ConversationalMultimodalContracts");

const CONVERSATIONAL_EVENTS = Object.freeze([
  "conversational_route_selected",
  "conversational_result_validated",
  "conversational_fallback_selected",
  "conversational_draft_applied",
  "conversational_clarification_required",
]);
const CONVERSATIONAL_EVENTS_SET = new Set(CONVERSATIONAL_EVENTS);

// Matches kadiV1ConversationalMultimodalRuntimeAdapter.js's own
// sourceForInputType() output range exactly (TEXT/AUDIO/IMAGE/PDF) — not
// kadiV1ConversationalMultimodalContracts.js's SOURCES (which uses
// "DOCUMENT" instead of "PDF" for the Brain-facing request contract, a
// different, wider enum this module does not reuse).
const SOURCES_SET = new Set(["TEXT", "AUDIO", "IMAGE", "PDF"]);
// The runtime adapter's own outcome intents (kadiV1ConversationalMultimodalRuntimeAdapter.js),
// a superset of the envelope's INTENTS: PREPARE_DOCUMENT/CONTINUE/REMOVE_ITEM/
// CHANGE_DOCUMENT_TYPE are adapter-level outcomes, not envelope intents.
const INTENT_SET = new Set([...INTENTS, "PREPARE_DOCUMENT", "CONTINUE", "REMOVE_ITEM", "CHANGE_DOCUMENT_TYPE"]);
const OPERATION_SET = new Set(OPERATIONS);
const DOCUMENT_TYPE_SET = new Set(["FACTURE", "DEVIS", "RECU", "DECHARGE"]);
const PROVIDER_CATEGORY_SET = new Set(["DETERMINISTIC", "BRAIN"]);
const RESULT_STATUS_SET = new Set(["OK", "ERROR"]);
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,79}$/;

function hashCorrelationRef(value) {
  return typeof value === "string" && value
    ? crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)
    : null;
}

// Coarse buckets only — never the raw millisecond value, which combined
// with other logs could help correlate a specific request.
function latencyBucket(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1000) return "LT_1S";
  if (durationMs < 3000) return "LT_3S";
  if (durationMs < 10000) return "LT_10S";
  return "GTE_10S";
}

function safeEnum(value, allowed) {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeCode(value) {
  return typeof value === "string" && CODE_PATTERN.test(value) ? value : null;
}

// createConversationalObservabilityEmitter(logger) -> (event, details) => void
//
// `logger` is injected (never constructed here) and may be omitted — a
// missing logger silently no-ops, exactly like the Gemini providers' own
// safeEmitter. `details` may contain arbitrary caller-side data (including
// full text, wa_id, etc.); only the fields explicitly read below ever leave
// this function, and only after being hashed, bucketed, or checked against a
// closed enum. Everything else in `details` is discarded, not passed
// through.
function createConversationalObservabilityEmitter(logger) {
  const sink = typeof logger === "function" ? logger : () => {};
  return function emit(event, details = {}) {
    if (!CONVERSATIONAL_EVENTS_SET.has(event)) return;
    const safe = Object.freeze({
      correlation_ref: hashCorrelationRef(details.correlation_id),
      source: safeEnum(details.source, SOURCES_SET),
      intent: safeEnum(details.intent, INTENT_SET),
      document_type: safeEnum(details.document_type, DOCUMENT_TYPE_SET),
      operation: safeEnum(details.operation, OPERATION_SET),
      result_status: safeEnum(details.result_status, RESULT_STATUS_SET),
      missing_field_count: safeCount(details.missing_field_count),
      ambiguous_field_count: safeCount(details.ambiguous_field_count),
      provider_category: safeEnum(details.provider_category, PROVIDER_CATEGORY_SET),
      latency_bucket: latencyBucket(details.duration_ms),
      fallback_reason_code: safeCode(details.fallback_reason_code),
    });
    try { sink(event, safe); } catch { /* observability is non-authoritative */ }
  };
}

module.exports = {
  CONVERSATIONAL_EVENTS,
  createConversationalObservabilityEmitter,
  latencyBucket,
};
