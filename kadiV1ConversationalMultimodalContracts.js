"use strict";

// Unified envelope for KADI_CONVERSATIONAL_MULTIMODAL_V1. This sits ABOVE the
// existing kadiV1Brain contract (LLM/vision extraction) and the existing
// deterministic fast-path classifier in kadiV1ConversationOrchestrator.js
// (detectNaturalIntent) — it does not replace either. document_type reuses
// the existing canonical FACTURE/DEVIS/RECU/DECHARGE enum from
// kadiV1BrainContracts.js rather than introducing a second, English-named
// taxonomy alongside the locked domain model.

const {
  AUTHORITY_FIELDS,
  EXTRACTED_FIELD_KEYS,
  normalizeDocumentType,
  validateItems,
  validateSimpleValue,
} = require("./kadiV1BrainContracts");

const SCHEMA_VERSION = "1.0";

const SOURCES = Object.freeze(["TEXT", "AUDIO", "IMAGE", "DOCUMENT", "FLOW"]);
const INTENTS = Object.freeze([
  "CREATE_DOCUMENT",
  "UPDATE_DOCUMENT",
  "SEARCH_HISTORY",
  "CHECK_BALANCE",
  "RECHARGE",
  "CANCEL",
  "HELP",
  "UNKNOWN",
]);
const OPERATIONS = Object.freeze(["CORRECT_FIELD", "REMOVE_ITEM", "ADD_ITEM", "CHANGE_DOCUMENT_TYPE"]);
const LANGUAGES = Object.freeze(["fr", "en"]);

// AUTHORITY_FIELDS is imported from kadiV1BrainContracts.js rather than
// redefined here — a second hand-copied literal list would drift from the
// canonical one exactly the way it already had (this file's original
// version omitted nothing, but kadiV1GeminiVisionProvider.js's separate
// FORBIDDEN_AUTHORITY_KEYS list is missing "credit_debit" and "delivered"
// compared to the canonical set; see docs/KADI_CONVERSATIONAL_MULTIMODAL_V1.md
// for that pre-existing, out-of-scope finding).

const REQUEST_KEYS = new Set([
  "request_id", "source", "text", "transcription", "media", "flow_reply",
  "conversation_context", "document_type_hint", "collected_data", "language_hint",
]);
const RESULT_KEYS = new Set([
  "schema_version", "intent", "document_type", "operation", "language",
  "extracted_entities", "requested_corrections", "missing_fields", "ambiguous_fields",
  "needs_confirmation", "confidence", "user_facing_message_draft", "provider_metadata",
]);
const CORRECTION_KEYS = new Set(["field", "new_value_hint", "source_reference"]);
const PROVIDER_METADATA_KEYS = new Set(["provider", "model", "request_ref", "latency_ms", "classifier"]);
const FLOW_REPLY_KEYS = new Set(["flow_key", "action", "data"]);
const CANDIDATE_KEYS = new Set(["value", "status", "confidence", "source_reference"]);
const FIELD_STATUSES = Object.freeze(["CONFIRMED", "UNCERTAIN", "ABSENT", "CONTRADICTORY"]);

function ok(value) { return { ok: true, value }; }
function fail(error) { return { ok: false, error }; }

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Buffer.isBuffer(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasOnlyKeys(value, allowed) {
  try {
    return Object.keys(value).every((key) => allowed.has(key));
  } catch {
    return false;
  }
}

function validBoundedString(value, max = 500) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function validateFlowReply(value) {
  if (value == null) return true;
  if (!isPlainRecord(value) || !hasOnlyKeys(value, FLOW_REPLY_KEYS)) return false;
  if (!validBoundedString(value.flow_key, 100) || !validBoundedString(value.action, 100)) return false;
  return value.data == null || isPlainRecord(value.data);
}

function validateConversationalRequest(rawRequest) {
  if (!isPlainRecord(rawRequest) || !hasOnlyKeys(rawRequest, REQUEST_KEYS)) {
    return fail("CONVERSATIONAL_REQUEST_INVALID");
  }
  if (!validBoundedString(rawRequest.request_id, 200)) return fail("CONVERSATIONAL_REQUEST_ID_INVALID");
  if (!SOURCES.includes(rawRequest.source)) return fail("CONVERSATIONAL_SOURCE_INVALID");
  const hint = rawRequest.document_type_hint == null ? null : normalizeDocumentType(rawRequest.document_type_hint);
  if (rawRequest.document_type_hint != null && !hint) return fail("CONVERSATIONAL_DOCUMENT_TYPE_INVALID");
  if (rawRequest.conversation_context != null && !isPlainRecord(rawRequest.conversation_context)) {
    return fail("CONVERSATIONAL_CONTEXT_INVALID");
  }
  if (rawRequest.collected_data != null && !isPlainRecord(rawRequest.collected_data)) {
    return fail("CONVERSATIONAL_COLLECTED_DATA_INVALID");
  }
  if (rawRequest.language_hint != null && !LANGUAGES.includes(rawRequest.language_hint)) {
    return fail("CONVERSATIONAL_LANGUAGE_HINT_INVALID");
  }
  if (!validateFlowReply(rawRequest.flow_reply)) return fail("CONVERSATIONAL_FLOW_REPLY_INVALID");
  if (rawRequest.source === "TEXT" && !validBoundedString(rawRequest.text, 20_000)) {
    return fail("CONVERSATIONAL_TEXT_REQUIRED");
  }
  if (rawRequest.source === "AUDIO" && rawRequest.transcription != null && !validBoundedString(rawRequest.transcription, 20_000)) {
    return fail("CONVERSATIONAL_TRANSCRIPTION_INVALID");
  }
  if (["IMAGE", "DOCUMENT"].includes(rawRequest.source) && !isPlainRecord(rawRequest.media)) {
    return fail("CONVERSATIONAL_MEDIA_REQUIRED");
  }
  if (rawRequest.source === "FLOW" && !rawRequest.flow_reply) {
    return fail("CONVERSATIONAL_FLOW_REPLY_REQUIRED");
  }
  return ok(Object.freeze({ ...rawRequest, document_type_hint: hint }));
}

function validateCandidate(field, candidate) {
  if (!isPlainRecord(candidate) || !hasOnlyKeys(candidate, CANDIDATE_KEYS)) return false;
  if (!FIELD_STATUSES.includes(candidate.status)) return false;
  if (candidate.confidence != null && (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1)) return false;
  if (candidate.source_reference != null && !validBoundedString(candidate.source_reference, 300)) return false;
  if (candidate.status === "ABSENT") return candidate.value == null;
  if (candidate.value == null) return false;
  // Reuses kadiV1BrainContracts.js's own recursive, depth-limited, closed-key
  // shape validation instead of a shallow "!= null" check — a candidate's
  // value is itself untrusted provider output and must not be able to smuggle
  // an authority-shaped key (e.g. extracted_entities.client.value.total)
  // one level below the top-level AUTHORITY_FIELDS check.
  return field === "items" ? validateItems(candidate.value) : validateSimpleValue(candidate.value);
}

function validateCorrection(entry) {
  if (!isPlainRecord(entry) || !hasOnlyKeys(entry, CORRECTION_KEYS)) return false;
  if (!EXTRACTED_FIELD_KEYS.has(entry.field)) return false;
  if (!validBoundedString(entry.new_value_hint, 500)) return false;
  return entry.source_reference == null || validBoundedString(entry.source_reference, 300);
}

function validateProviderMetadata(value) {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, PROVIDER_METADATA_KEYS)) return false;
  if (!validBoundedString(value.provider, 80)) return false;
  if (value.classifier != null && !["DETERMINISTIC", "BRAIN"].includes(value.classifier)) return false;
  if (value.model != null && (!validBoundedString(value.model, 120) || /authorization|bearer|api[_-]?key|token/i.test(value.model))) {
    return false;
  }
  return value.latency_ms == null || (Number.isFinite(value.latency_ms) && value.latency_ms >= 0);
}

function validateConversationalResult(rawResult) {
  if (!isPlainRecord(rawResult) || !hasOnlyKeys(rawResult, RESULT_KEYS)) return fail("CONVERSATIONAL_RESULT_INVALID");
  for (const key of Object.keys(rawResult)) {
    if (AUTHORITY_FIELDS.has(key)) return fail("CONVERSATIONAL_RESULT_AUTHORITY_FORBIDDEN");
  }
  if (rawResult.schema_version !== SCHEMA_VERSION) return fail("CONVERSATIONAL_SCHEMA_VERSION_INVALID");
  if (!INTENTS.includes(rawResult.intent)) return fail("CONVERSATIONAL_INTENT_INVALID");
  const documentType = rawResult.document_type == null ? null : normalizeDocumentType(rawResult.document_type);
  if (rawResult.document_type != null && !documentType) return fail("CONVERSATIONAL_DOCUMENT_TYPE_INVALID");
  if (rawResult.operation != null && !OPERATIONS.includes(rawResult.operation)) return fail("CONVERSATIONAL_OPERATION_INVALID");
  if (rawResult.operation != null && rawResult.intent !== "UPDATE_DOCUMENT") return fail("CONVERSATIONAL_OPERATION_REQUIRES_UPDATE_INTENT");
  if (!LANGUAGES.includes(rawResult.language)) return fail("CONVERSATIONAL_LANGUAGE_INVALID");
  if (!isPlainRecord(rawResult.extracted_entities)) return fail("CONVERSATIONAL_EXTRACTED_ENTITIES_INVALID");
  for (const [field, candidate] of Object.entries(rawResult.extracted_entities)) {
    if (!EXTRACTED_FIELD_KEYS.has(field) || AUTHORITY_FIELDS.has(field)) return fail("CONVERSATIONAL_EXTRACTED_FIELD_FORBIDDEN");
    if (!validateCandidate(field, candidate)) return fail("CONVERSATIONAL_EXTRACTED_VALUE_INVALID");
  }
  if (!Array.isArray(rawResult.requested_corrections) || rawResult.requested_corrections.length > 20 ||
      !rawResult.requested_corrections.every(validateCorrection)) {
    return fail("CONVERSATIONAL_CORRECTIONS_INVALID");
  }
  if (!Array.isArray(rawResult.missing_fields) || rawResult.missing_fields.some((field) => !EXTRACTED_FIELD_KEYS.has(field))) {
    return fail("CONVERSATIONAL_MISSING_FIELDS_INVALID");
  }
  if (!Array.isArray(rawResult.ambiguous_fields) || rawResult.ambiguous_fields.some((field) => !EXTRACTED_FIELD_KEYS.has(field))) {
    return fail("CONVERSATIONAL_AMBIGUOUS_FIELDS_INVALID");
  }
  if (typeof rawResult.needs_confirmation !== "boolean") return fail("CONVERSATIONAL_NEEDS_CONFIRMATION_INVALID");
  if (!Number.isFinite(rawResult.confidence) || rawResult.confidence < 0 || rawResult.confidence > 1) {
    return fail("CONVERSATIONAL_CONFIDENCE_INVALID");
  }
  if (rawResult.user_facing_message_draft != null && !validBoundedString(rawResult.user_facing_message_draft, 1_000)) {
    return fail("CONVERSATIONAL_MESSAGE_DRAFT_INVALID");
  }
  if (rawResult.ambiguous_fields.length > 0 && !rawResult.needs_confirmation) {
    return fail("CONVERSATIONAL_CONFIRMATION_REQUIRED");
  }
  if (rawResult.needs_confirmation && !validBoundedString(rawResult.user_facing_message_draft, 1_000)) {
    return fail("CONVERSATIONAL_CONFIRMATION_MESSAGE_REQUIRED");
  }
  if (!validateProviderMetadata(rawResult.provider_metadata)) return fail("CONVERSATIONAL_PROVENANCE_REQUIRED");
  try {
    return ok(Object.freeze(structuredClone({ ...rawResult, document_type: documentType })));
  } catch {
    return fail("CONVERSATIONAL_RESULT_INVALID");
  }
}

module.exports = {
  SCHEMA_VERSION,
  SOURCES,
  INTENTS,
  OPERATIONS,
  LANGUAGES,
  AUTHORITY_FIELDS,
  validateConversationalRequest,
  validateConversationalResult,
};
