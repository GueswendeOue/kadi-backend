"use strict";

const KADI_INTENT_SCHEMA_VERSION = "kadi.intent.v1";
const KADI_ACTIONABLE_CONFIDENCE_THRESHOLD = 0.75;

const KADI_INTENTS = Object.freeze({
  CREATE_QUOTE: "CREATE_QUOTE",
  CREATE_INVOICE: "CREATE_INVOICE",
  CREATE_RECEIPT: "CREATE_RECEIPT",
  CREATE_DISCHARGE: "CREATE_DISCHARGE",
  CONVERT_QUOTE_TO_INVOICE: "CONVERT_QUOTE_TO_INVOICE",
  SEARCH_DOCUMENT: "SEARCH_DOCUMENT",
  LIST_RECENT_DOCUMENTS: "LIST_RECENT_DOCUMENTS",
  DOWNLOAD_DOCUMENT: "DOWNLOAD_DOCUMENT",
  MODIFY_DOCUMENT: "MODIFY_DOCUMENT",
  CANCEL_DOCUMENT_OPERATION: "CANCEL_DOCUMENT_OPERATION",
  CHECK_CREDITS: "CHECK_CREDITS",
  BUY_CREDITS: "BUY_CREDITS",
  SUBMIT_PAYMENT_PROOF: "SUBMIT_PAYMENT_PROOF",
  CHECK_PAYMENT_STATUS: "CHECK_PAYMENT_STATUS",
  UPDATE_BUSINESS_PROFILE: "UPDATE_BUSINESS_PROFILE",
  ADD_LOGO: "ADD_LOGO",
  ADD_STAMP: "ADD_STAMP",
  ENABLE_STAMP: "ENABLE_STAMP",
  DISABLE_STAMP: "DISABLE_STAMP",
  ASK_HELP: "ASK_HELP",
  ASK_PRODUCT_QUESTION: "ASK_PRODUCT_QUESTION",
  CONTACT_SUPPORT: "CONTACT_SUPPORT",
  GREETING: "GREETING",
  THANKS: "THANKS",
  GOODBYE: "GOODBYE",
  CONFIRM: "CONFIRM",
  REJECT: "REJECT",
  PROVIDE_MISSING_INFORMATION: "PROVIDE_MISSING_INFORMATION",
  CORRECT_PREVIOUS_INFORMATION: "CORRECT_PREVIOUS_INFORMATION",
  CONTINUE_CURRENT_FLOW: "CONTINUE_CURRENT_FLOW",
  SENSITIVE_DATA_WARNING: "SENSITIVE_DATA_WARNING",
  UNSUPPORTED_REQUEST: "UNSUPPORTED_REQUEST",
  UNKNOWN: "UNKNOWN",
});

const KNOWN_INTENTS = new Set(Object.values(KADI_INTENTS));
const FORBIDDEN_IDENTITY_KEYS = new Set(["waId", "wa_id", "bsuid", "parentBsuid", "parent_bsuid"]);
const BUSINESS_ACTIONS = new Set([
  "CREATE_QUOTE", "CREATE_INVOICE", "CREATE_RECEIPT", "CREATE_DISCHARGE",
  "CONVERT_QUOTE_TO_INVOICE", "SEARCH_DOCUMENT", "LIST_RECENT_DOCUMENTS",
  "DOWNLOAD_DOCUMENT", "MODIFY_DOCUMENT", "CANCEL_DOCUMENT_OPERATION",
  "CHECK_CREDITS", "BUY_CREDITS", "SUBMIT_PAYMENT_PROOF", "CHECK_PAYMENT_STATUS",
  "UPDATE_BUSINESS_PROFILE", "ADD_LOGO", "ADD_STAMP", "ENABLE_STAMP", "DISABLE_STAMP",
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function textOrNull(value) {
  if (typeof value !== "string") return null;
  const valueTrimmed = value.trim();
  return valueTrimmed || null;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(textOrNull).filter(Boolean);
}

function normalizeItem(value) {
  const source = isPlainObject(value) ? value : {};
  return {
    description: textOrNull(source.description),
    quantity: numberOrNull(source.quantity),
    unit: textOrNull(source.unit),
    unitPrice: numberOrNull(source.unitPrice),
    total: numberOrNull(source.total),
  };
}

function emptyEntities() {
  return {
    documentType: null, documentId: null, documentNumber: null,
    clientName: null, clientPhone: null, clientAddress: null, businessName: null,
    date: null, dueDate: null, currency: null, amount: null, subtotal: null,
    tax: null, discount: null, items: [], paymentMethod: null, reason: null,
    description: null, searchQuery: null, requestedFormat: null,
    sourceDocumentId: null, sourceDocumentNumber: null,
  };
}

function normalizeEntities(value) {
  const source = isPlainObject(value) ? value : {};
  const result = emptyEntities();
  for (const key of Object.keys(result)) {
    if (key === "items") result.items = Array.isArray(source.items) ? source.items.map(normalizeItem) : [];
    else if (["amount", "subtotal", "tax", "discount"].includes(key)) result[key] = numberOrNull(source[key]);
    else result[key] = textOrNull(source[key]);
  }
  return result;
}

function normalizeAmbiguity(value) {
  const source = isPlainObject(value) ? value : {};
  return {
    field: textOrNull(source.field),
    options: normalizeStringList(source.options),
    message: textOrNull(source.message),
    blocking: source.blocking === true,
  };
}

function createEmptyIntentResolution() {
  return {
    schemaVersion: KADI_INTENT_SCHEMA_VERSION,
    intent: KADI_INTENTS.UNKNOWN,
    confidence: 0,
    language: null,
    entities: emptyEntities(),
    missingFields: [],
    ambiguities: [],
    requestedAction: null,
    conversation: { isReplyToCurrentFlow: false, requiresContext: false, contextReference: null },
    safety: { containsSensitiveData: false, requiresHumanReview: false, reason: null },
    explanation: null,
  };
}

function normalizeIntentResolution(input) {
  const source = isPlainObject(input) ? input : {};
  const confidence = numberOrNull(source.confidence);
  const action = isPlainObject(source.requestedAction) ? source.requestedAction : null;
  const conversation = isPlainObject(source.conversation) ? source.conversation : {};
  const safety = isPlainObject(source.safety) ? source.safety : {};
  return {
    schemaVersion: KADI_INTENT_SCHEMA_VERSION,
    intent: KNOWN_INTENTS.has(source.intent) ? source.intent : KADI_INTENTS.UNKNOWN,
    confidence: confidence === null ? 0 : Math.min(1, Math.max(0, confidence)),
    language: textOrNull(source.language),
    entities: normalizeEntities(source.entities),
    missingFields: normalizeStringList(source.missingFields),
    ambiguities: Array.isArray(source.ambiguities) ? source.ambiguities.map(normalizeAmbiguity) : [],
    requestedAction: action ? { type: textOrNull(action.type), target: textOrNull(action.target) } : null,
    conversation: {
      isReplyToCurrentFlow: conversation.isReplyToCurrentFlow === true,
      requiresContext: conversation.requiresContext === true,
      contextReference: textOrNull(conversation.contextReference),
    },
    safety: {
      containsSensitiveData: safety.containsSensitiveData === true,
      requiresHumanReview: safety.requiresHumanReview === true,
      reason: textOrNull(safety.reason),
    },
    explanation: textOrNull(source.explanation),
  };
}

function hasForbiddenIdentity(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_IDENTITY_KEYS.has(key)) return true;
    if (hasForbiddenIdentity(child, seen)) return true;
  }
  return false;
}

function validateIntentResolution(input) {
  const errors = [];
  const add = (path, code) => errors.push({ path, code });
  if (!isPlainObject(input)) return { valid: false, errors: [{ path: "$", code: "INVALID_INPUT" }] };
  if (input.schemaVersion !== KADI_INTENT_SCHEMA_VERSION) add("schemaVersion", "INVALID_SCHEMA_VERSION");
  if (!KNOWN_INTENTS.has(input.intent)) add("intent", "INVALID_INTENT");
  if (typeof input.confidence !== "number" || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) add("confidence", "INVALID_CONFIDENCE");
  if (input.language !== null && typeof input.language !== "string") add("language", "INVALID_LANGUAGE");
  if (!isPlainObject(input.entities)) add("entities", "INVALID_ENTITIES");
  if (!Array.isArray(input.missingFields) || input.missingFields.some((item) => typeof item !== "string")) add("missingFields", "INVALID_MISSING_FIELDS");
  if (!Array.isArray(input.ambiguities) || input.ambiguities.some((item) => !isPlainObject(item))) add("ambiguities", "INVALID_AMBIGUITIES");
  if (input.requestedAction !== null && !isPlainObject(input.requestedAction)) add("requestedAction", "INVALID_REQUESTED_ACTION");
  if (!isPlainObject(input.conversation)) add("conversation", "INVALID_CONVERSATION");
  if (!isPlainObject(input.safety)) add("safety", "INVALID_SAFETY");
  if (hasForbiddenIdentity(input)) add("$", "RAW_WHATSAPP_IDENTITY_FORBIDDEN");
  return { valid: errors.length === 0, errors };
}

function hasDeterminingFields(value) {
  const entities = value.entities;
  switch (value.intent) {
    case "CREATE_QUOTE": return entities.documentType === "quote" && entities.items.length > 0;
    case "CREATE_INVOICE": return entities.documentType === "invoice" && entities.items.length > 0;
    case "CREATE_RECEIPT": return entities.documentType === "receipt" && entities.amount !== null;
    case "CREATE_DISCHARGE": return entities.documentType === "discharge" && !!(entities.description || entities.reason || entities.items.length);
    case "CONVERT_QUOTE_TO_INVOICE": return !!(entities.sourceDocumentId || entities.sourceDocumentNumber);
    case "SEARCH_DOCUMENT": return !!entities.searchQuery;
    case "DOWNLOAD_DOCUMENT": return !!(entities.documentId || entities.documentNumber);
    case "MODIFY_DOCUMENT": return !!(entities.documentId || entities.documentNumber || value.conversation.contextReference);
    default: return true;
  }
}

function isActionableIntentResolution(input) {
  if (!validateIntentResolution(input).valid) return false;
  if (!BUSINESS_ACTIONS.has(input.intent)) return false;
  if (input.confidence < KADI_ACTIONABLE_CONFIDENCE_THRESHOLD) return false;
  if (input.safety.requiresHumanReview || input.safety.containsSensitiveData) return false;
  if (input.missingFields.length > 0) return false;
  if (input.ambiguities.some((ambiguity) => ambiguity.blocking === true)) return false;
  return hasDeterminingFields(input);
}

module.exports = {
  KADI_INTENTS,
  KADI_INTENT_SCHEMA_VERSION,
  KADI_ACTIONABLE_CONFIDENCE_THRESHOLD,
  createEmptyIntentResolution,
  normalizeIntentResolution,
  validateIntentResolution,
  isActionableIntentResolution,
};
