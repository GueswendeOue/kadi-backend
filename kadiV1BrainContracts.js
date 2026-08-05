"use strict";

const { validateMediaInput } = require("./kadiV1MediaContracts");

const BRAIN_MODALITIES = Object.freeze(["TEXT", "TRANSCRIPTION", "IMAGE", "DOCUMENT"]);
const BRAIN_DOCUMENT_TYPES = Object.freeze(["FACTURE", "DEVIS", "RECU", "DECHARGE"]);
const BRAIN_INTENTS = Object.freeze([
  "CREATE_DOCUMENT",
  "UPDATE_DOCUMENT",
  "SEARCH_DOCUMENT",
  "REQUEST_HELP",
  "UNKNOWN",
]);
const BRAIN_NEXT_ACTIONS = Object.freeze([
  "ASK_TARGETED_QUESTION",
  "REVIEW_EXTRACTED_DATA",
  "CONTINUE_COLLECTION",
  "REQUEST_RETRY",
  "NO_ACTION",
]);
const FIELD_STATUSES = Object.freeze(["CONFIRMED", "UNCERTAIN", "ABSENT", "CONTRADICTORY"]);

const REQUEST_KEYS = new Set([
  "request_id",
  "modality",
  "text",
  "transcription",
  "media",
  "conversation_context",
  "document_type_hint",
  "collected_data",
]);
const RESULT_KEYS = new Set([
  "intent",
  "document_type",
  "extracted_fields",
  "missing_fields",
  "uncertainties",
  "confidence",
  "suggested_next_action",
  "user_facing_message_draft",
  "provider_metadata",
]);
const EXTRACTED_FIELD_KEYS = new Set([
  "issuer",
  "client",
  "beneficiary",
  "payer",
  "receiver",
  "giver",
  "items",
  "subject",
  "amount",
  "reason",
  "options",
  "taxes",
  "discount",
  "notes",
  "payment_terms",
  "payment_method",
  "reference",
  "date_read",
  "document_number_read",
  "currency",
  "total_read",
  "document_type",
]);
const AUTHORITY_FIELDS = new Set([
  "debit",
  "credit_debit",
  "payment_confirmed",
  "final_generation",
  "generate_final",
  "generation_cost",
  "issued_at",
  "document_number",
  "subtotal",
  "total",
  "final_total",
  "delivery",
  "delivered",
]);
const CANDIDATE_KEYS = new Set(["value", "status", "confidence", "source_reference"]);
const UNCERTAINTY_KEYS = new Set(["field", "reason", "candidate_value", "confidence", "source_reference"]);
const PROVIDER_METADATA_KEYS = new Set(["provider", "model", "request_ref", "latency_ms"]);
const MEDIA_KEYS = new Set([
  "mime_type", "content", "content_ref", "media_id", "owner_ref", "source_type",
  "byte_size", "checksum", "page_count", "correlation_id", "storage_reference",
  "received_at", "expires_at",
]);
const ITEM_KEYS = new Set(["item_id", "description", "label", "quantity", "unit", "unit_price", "confidence", "status", "source_reference"]);
const SIMPLE_OBJECT_KEYS = new Set([
  "name", "phone", "address", "email", "ifu", "rccm", "label", "value", "rate", "type",
]);

function ok(value) {
  return { ok: true, value };
}

function fail(error) {
  return { ok: false, error };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

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

function normalizeDocumentType(value) {
  if (value == null || value === "") return null;
  const normalized = String(value).trim().toUpperCase();
  return BRAIN_DOCUMENT_TYPES.includes(normalized) ? normalized : null;
}

function validateBrainRequest(rawRequest) {
  if (!isPlainRecord(rawRequest) || !hasOnlyKeys(rawRequest, REQUEST_KEYS)) {
    return fail("BRAIN_REQUEST_INVALID");
  }
  if (!validBoundedString(rawRequest.request_id, 200)) return fail("BRAIN_REQUEST_ID_INVALID");
  if (!BRAIN_MODALITIES.includes(rawRequest.modality)) return fail("BRAIN_MODALITY_INVALID");
  const hint = normalizeDocumentType(rawRequest.document_type_hint);
  if (rawRequest.document_type_hint != null && !hint) return fail("BRAIN_DOCUMENT_TYPE_INVALID");
  if (rawRequest.conversation_context != null && !isPlainRecord(rawRequest.conversation_context)) {
    return fail("BRAIN_CONTEXT_INVALID");
  }
  if (rawRequest.collected_data != null && !isPlainRecord(rawRequest.collected_data)) {
    return fail("BRAIN_COLLECTED_DATA_INVALID");
  }
  if (rawRequest.modality === "TEXT" && !validBoundedString(rawRequest.text, 20_000)) {
    return fail("BRAIN_TEXT_REQUIRED");
  }
  if (rawRequest.modality === "TRANSCRIPTION" && !validBoundedString(rawRequest.transcription, 20_000)) {
    return fail("BRAIN_TRANSCRIPTION_REQUIRED");
  }
  if (["IMAGE", "DOCUMENT"].includes(rawRequest.modality)) {
    const media = rawRequest.media;
    if (!isPlainRecord(media) || !hasOnlyKeys(media, MEDIA_KEYS) || !validBoundedString(media.mime_type, 100)) {
      return fail("BRAIN_MEDIA_INVALID");
    }
    const hasContent = Buffer.isBuffer(media.content) && media.content.length > 0;
    const hasReference = validBoundedString(media.content_ref, 300) || (
      validBoundedString(media.media_id, 200) && validBoundedString(media.owner_ref, 200)
    );
    if (!hasContent && !hasReference) return fail("BRAIN_MEDIA_CONTENT_REQUIRED");
    if (media.media_id != null) {
      const contract = validateMediaInput(media);
      if (!contract.ok) return fail(contract.error);
    }
  }
  return ok(Object.freeze({
    ...rawRequest,
    document_type_hint: hint,
  }));
}

function validateSimpleValue(value, depth = 0) {
  if (depth > 3) return false;
  if (value == null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.trim().length > 0 && value.length <= 2_000;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0;
  if (Array.isArray(value)) return value.length <= 100 && value.every((entry) => validateSimpleValue(entry, depth + 1));
  if (!isPlainRecord(value) || !hasOnlyKeys(value, SIMPLE_OBJECT_KEYS)) return false;
  return Object.values(value).every((entry) => validateSimpleValue(entry, depth + 1));
}

function validateItems(value) {
  if (!Array.isArray(value) || value.length > 100) return false;
  return value.every((item) => {
    if (!isPlainRecord(item) || !hasOnlyKeys(item, ITEM_KEYS)) return false;
    const label = item.description ?? item.label;
    if (!validBoundedString(label, 300)) return false;
    if (item.quantity != null && (!Number.isFinite(item.quantity) || item.quantity <= 0)) return false;
    if (item.unit_price != null && (!Number.isFinite(item.unit_price) || item.unit_price < 0)) return false;
    if (item.unit != null && !validBoundedString(item.unit, 50)) return false;
    if (item.item_id != null && !validBoundedString(item.item_id, 200)) return false;
    if (item.confidence != null && (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1)) return false;
    if (item.status != null && !FIELD_STATUSES.includes(item.status)) return false;
    if (item.source_reference != null && !validBoundedString(item.source_reference, 300)) return false;
    return true;
  });
}

function validateCandidate(field, candidate) {
  if (!isPlainRecord(candidate) || !hasOnlyKeys(candidate, CANDIDATE_KEYS)) return false;
  if (!FIELD_STATUSES.includes(candidate.status)) return false;
  if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) return false;
  if (!validBoundedString(candidate.source_reference, 300)) return false;
  if (candidate.status === "ABSENT" && candidate.value != null) return false;
  if (candidate.status !== "ABSENT" && candidate.value == null) return false;
  if (field === "items") return candidate.status === "ABSENT" || validateItems(candidate.value);
  return candidate.status === "ABSENT" || validateSimpleValue(candidate.value);
}

function validateUncertainty(value) {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, UNCERTAINTY_KEYS)) return false;
  if (!EXTRACTED_FIELD_KEYS.has(value.field) || !validBoundedString(value.reason, 300)) return false;
  if (value.confidence != null && (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1)) {
    return false;
  }
  if (value.source_reference != null && !validBoundedString(value.source_reference, 300)) return false;
  return value.candidate_value == null || validateSimpleValue(value.candidate_value) || validateItems(value.candidate_value);
}

function validateProviderMetadata(value) {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, PROVIDER_METADATA_KEYS)) return false;
  if (!validBoundedString(value.provider, 80)) return false;
  if (value.model != null && (!validBoundedString(value.model, 120) || /authorization|bearer|api[_-]?key|token/i.test(value.model))) {
    return false;
  }
  if (value.request_ref != null && (
    !validBoundedString(value.request_ref, 200) ||
    /authorization|bearer|api[_-]?key|access[_-]?token|secret/i.test(value.request_ref) ||
    /[A-Za-z0-9+/_=-]{80,}/.test(value.request_ref)
  )) return false;
  return value.latency_ms == null || (Number.isFinite(value.latency_ms) && value.latency_ms >= 0);
}

function validateBrainResult(rawResult, { minimumConfidence = 0.6 } = {}) {
  if (!isPlainRecord(rawResult) || !hasOnlyKeys(rawResult, RESULT_KEYS)) return fail("BRAIN_RESULT_INVALID");
  for (const key of Object.keys(rawResult)) {
    if (AUTHORITY_FIELDS.has(key)) return fail("BRAIN_RESULT_AUTHORITY_FORBIDDEN");
  }
  if (!BRAIN_INTENTS.includes(rawResult.intent)) return fail("BRAIN_INTENT_INVALID");
  const documentType = normalizeDocumentType(rawResult.document_type);
  if (rawResult.document_type != null && !documentType) return fail("BRAIN_DOCUMENT_TYPE_INVALID");
  if (!isPlainRecord(rawResult.extracted_fields)) return fail("BRAIN_EXTRACTED_FIELDS_INVALID");
  const extractedEntries = Object.entries(rawResult.extracted_fields);
  if (extractedEntries.some(([field]) => !EXTRACTED_FIELD_KEYS.has(field) || AUTHORITY_FIELDS.has(field))) {
    return fail("BRAIN_EXTRACTED_FIELD_FORBIDDEN");
  }
  if (extractedEntries.some(([field, candidate]) => !validateCandidate(field, candidate))) {
    return fail("BRAIN_EXTRACTED_VALUE_INVALID");
  }
  if (!Array.isArray(rawResult.missing_fields) || rawResult.missing_fields.some((field) => !EXTRACTED_FIELD_KEYS.has(field))) {
    return fail("BRAIN_MISSING_FIELDS_INVALID");
  }
  if (!Array.isArray(rawResult.uncertainties) || !rawResult.uncertainties.every(validateUncertainty)) {
    return fail("BRAIN_UNCERTAINTIES_INVALID");
  }
  if (!Number.isFinite(rawResult.confidence) || rawResult.confidence < 0 || rawResult.confidence > 1) {
    return fail("BRAIN_CONFIDENCE_INVALID");
  }
  if (!BRAIN_NEXT_ACTIONS.includes(rawResult.suggested_next_action)) return fail("BRAIN_NEXT_ACTION_INVALID");
  if (rawResult.user_facing_message_draft != null && !validBoundedString(rawResult.user_facing_message_draft, 1_000)) {
    return fail("BRAIN_MESSAGE_DRAFT_INVALID");
  }
  if (!validateProviderMetadata(rawResult.provider_metadata)) return fail("BRAIN_PROVENANCE_REQUIRED");

  const uncertainFields = new Set(rawResult.uncertainties.map(({ field }) => field));
  for (const [field, candidate] of extractedEntries) {
    if (["UNCERTAIN", "CONTRADICTORY"].includes(candidate.status) && !uncertainFields.has(field)) {
      return fail("BRAIN_UNCERTAINTY_REQUIRED");
    }
    if (["UNCERTAIN", "CONTRADICTORY", "ABSENT"].includes(candidate.status) && !rawResult.missing_fields.includes(field)) {
      return fail("BRAIN_MISSING_FIELD_REQUIRED");
    }
  }
  if ((rawResult.confidence < minimumConfidence || rawResult.uncertainties.length > 0) && (
    rawResult.missing_fields.length === 0 ||
    rawResult.suggested_next_action !== "ASK_TARGETED_QUESTION" ||
    !validBoundedString(rawResult.user_facing_message_draft, 1_000)
  )) {
    return fail("BRAIN_CONFIRMATION_REQUIRED");
  }
  try {
    return ok(deepFreeze(structuredClone({ ...rawResult, document_type: documentType })));
  } catch {
    return fail("BRAIN_RESULT_INVALID");
  }
}

module.exports = {
  AUTHORITY_FIELDS,
  BRAIN_DOCUMENT_TYPES,
  BRAIN_INTENTS,
  BRAIN_MODALITIES,
  BRAIN_NEXT_ACTIONS,
  EXTRACTED_FIELD_KEYS,
  FIELD_STATUSES,
  normalizeDocumentType,
  validateBrainRequest,
  validateBrainResult,
  validateItems,
  validateSimpleValue,
};
