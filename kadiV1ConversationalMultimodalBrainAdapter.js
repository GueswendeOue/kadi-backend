"use strict";

// Canonical, single mapping from a validated KADI_CONVERSATIONAL_MULTIMODAL_V1
// envelope to the exact shape kadiV1BrainContracts.validateBrainResult (and
// therefore kadiV1SharedDocumentPipeline.js / kadiV1DischargePipeline.js's
// applyBrainExtraction) already requires. This is the ONLY place a
// conversational result is turned into something documents.apply(...) can
// consume — there is no second document-mutation implementation anywhere in
// this feature.
//
// Required chain (enforced by this function, not just documented):
//   envelope -> validateConversationalResult -> this mapping ->
//   validateBrainResult -> (caller) documents.apply -> existing domain
//   validation -> draft mutation.
//
// Strict closed mapping: only EXTRACTED_FIELD_KEYS entries that are not
// AUTHORITY_FIELDS are ever copied, one key at a time — never a spread of
// the input object. Unknown/unexpected fields are silently dropped, not
// forwarded. This function never invents total/subtotal/debit/issued_at/
// document_number/final_generation/delivery/payment_confirmed/etc. — those
// remain exclusively backend-calculated, downstream of documents.apply.

const {
  AUTHORITY_FIELDS,
  EXTRACTED_FIELD_KEYS,
  validateBrainResult,
} = require("./kadiV1BrainContracts");
const { validateConversationalResult } = require("./kadiV1ConversationalMultimodalContracts");

const MUTATING_INTENTS = new Set(["CREATE_DOCUMENT", "UPDATE_DOCUMENT"]);
// Expressible today through a single documents.apply(...) call because the
// existing pipeline merges extracted_fields values into the draft.
// REMOVE_ITEM and CHANGE_DOCUMENT_TYPE are NOT: removing an item has no
// equivalent in applyBrainExtraction (only add/replace via extracted_fields
// exists), and document_type is immutable within a draft
// (applyBrainExtraction itself rejects a mismatched document_type). Neither
// is faked here — both fail closed until a dedicated pipeline capability
// exists, tracked as a known limitation rather than worked around with a
// second mutation path.
const SUPPORTED_OPERATIONS = new Set([null, "CORRECT_FIELD", "ADD_ITEM"]);
const BRAIN_PROVIDER_METADATA_KEYS = new Set(["provider", "model", "request_ref", "latency_ms"]);
const BRAIN_MIN_CONFIDENCE = 0.6;

function ok(value) { return { ok: true, value }; }
function fail(error) { return { ok: false, error }; }

function mapProviderMetadata(source) {
  const mapped = {};
  for (const key of BRAIN_PROVIDER_METADATA_KEYS) {
    if (source[key] != null) mapped[key] = source[key];
  }
  if (!mapped.provider) mapped.provider = "KADI_CONVERSATIONAL_MULTIMODAL_V1";
  return mapped;
}

function conversationalResultToBrainResult(rawEnvelope) {
  const checkedEnvelope = validateConversationalResult(rawEnvelope);
  if (!checkedEnvelope.ok) return fail(checkedEnvelope.error);
  const envelope = checkedEnvelope.value;

  if (!MUTATING_INTENTS.has(envelope.intent)) {
    return fail("CONVERSATIONAL_TO_BRAIN_INTENT_NOT_MUTATING");
  }
  if (!SUPPORTED_OPERATIONS.has(envelope.operation)) {
    return fail("CONVERSATIONAL_OPERATION_NOT_SUPPORTED_BY_DRAFT_APPLICATION");
  }

  const extractedFields = {};
  for (const [field, candidate] of Object.entries(envelope.extracted_entities)) {
    if (!EXTRACTED_FIELD_KEYS.has(field) || AUTHORITY_FIELDS.has(field)) continue;
    extractedFields[field] = candidate;
  }

  const missingFields = [...new Set([...envelope.missing_fields, ...envelope.ambiguous_fields])];
  const uncertainties = envelope.ambiguous_fields.map((field) => ({
    field,
    reason: "CONVERSATIONAL_AMBIGUITY",
    confidence: envelope.confidence,
    source_reference: extractedFields[field]?.source_reference || "conversation:0",
  }));

  const needsQuestion = envelope.needs_confirmation === true
    || missingFields.length > 0
    || envelope.confidence < BRAIN_MIN_CONFIDENCE;
  // validateBrainResult requires missing_fields non-empty whenever a
  // question is needed — fold in a generic marker rather than let a
  // low-confidence-but-otherwise-complete envelope produce an
  // inconsistent shape that would only fail later, opaquely.
  if (needsQuestion && missingFields.length === 0) missingFields.push("subject");

  const brainResult = {
    intent: envelope.intent,
    document_type: envelope.document_type,
    extracted_fields: extractedFields,
    missing_fields: missingFields,
    uncertainties,
    confidence: envelope.confidence,
    suggested_next_action: needsQuestion ? "ASK_TARGETED_QUESTION" : "REVIEW_EXTRACTED_DATA",
    user_facing_message_draft: needsQuestion
      ? (envelope.user_facing_message_draft || "Pouvez-vous préciser l’information manquante ?")
      : null,
    provider_metadata: mapProviderMetadata(envelope.provider_metadata),
  };

  const checkedBrainResult = validateBrainResult(brainResult, { minimumConfidence: BRAIN_MIN_CONFIDENCE });
  if (!checkedBrainResult.ok) return fail(checkedBrainResult.error);
  return ok(checkedBrainResult.value);
}

module.exports = {
  MUTATING_INTENTS,
  SUPPORTED_OPERATIONS,
  conversationalResultToBrainResult,
};
