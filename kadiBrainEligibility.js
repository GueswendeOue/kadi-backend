"use strict";

const BRAIN_ELIGIBILITY_STATUSES = Object.freeze({
  ELIGIBLE: "eligible",
  REJECTED: "rejected",
});

const BRAIN_ELIGIBILITY_REASONS = Object.freeze({
  CONVERSATION_ELIGIBLE: "conversation_eligible",
  INVALID_INPUT: "invalid_input",
  MISSING_CANDIDATE_DECISION: "missing_candidate_decision",
  CANDIDATE_NOT_READY: "candidate_not_ready",
  INVALID_CONVERSATION_CONTEXT: "invalid_conversation_context",
  UNSUPPORTED_MESSAGE_TYPE: "unsupported_message_type",
  DETERMINISTIC_ROUTE_HAS_PRIORITY: "deterministic_route_has_priority",
  CONVERSATION_LOCKED: "conversation_locked",
  CONFIRMATION_PENDING: "confirmation_pending",
  DETERMINISTIC_INPUT_PENDING: "deterministic_input_pending",
  ACTIVE_DOCUMENT_REQUIRED: "active_document_required",
  ACTIVE_DOCUMENT_CONFLICT: "active_document_conflict",
  DOCUMENT_CONTEXT_REQUIRED: "document_context_required",
  INCOMPATIBLE_CONVERSATION_STATE: "incompatible_conversation_state",
});

const MVP_INTENTS = new Set([
  "create_document",
  "edit_document",
  "clarify",
  "confirm_document",
]);
const MVP_DOCUMENT_TYPES = new Set(["devis", "facture", "recu", "decharge"]);
const CONVERSATION_FLOWS = new Set([
  "document",
  "history",
  "profile",
  "stamp",
  "recharge",
  "image",
  "structured",
]);
const SUPPORTED_MESSAGE_TYPES = new Set(["text", "voice"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function emptyMetadata() {
  return {
    hasActiveDocument: false,
    deterministicRouteMatched: false,
    awaitingDeterministicInput: false,
    hasPendingDeterministicConfirmation: false,
    conversationLocked: false,
    currentFlow: null,
    userMessageType: null,
  };
}

function makeDecision({
  status = BRAIN_ELIGIBILITY_STATUSES.REJECTED,
  reason,
  candidateId = null,
  intent = null,
  documentType = null,
  activeDocumentType = null,
  metadata = emptyMetadata(),
}) {
  return {
    status,
    eligible: status === BRAIN_ELIGIBILITY_STATUSES.ELIGIBLE,
    reason,
    candidateId,
    intent,
    documentType,
    activeDocumentType,
    metadata: { ...metadata },
  };
}

function isReadyCandidate(candidate) {
  return (
    typeof candidate.candidateId === "string"
    && Boolean(candidate.candidateId.trim())
    && candidate.status === "candidate"
    && candidate.eligible === true
    && candidate.reason === "candidate_ready"
    && MVP_INTENTS.has(candidate.intent)
    && MVP_DOCUMENT_TYPES.has(candidate.documentType)
  );
}

function isValidConversationContext(context) {
  const booleanFields = [
    "hasActiveDocument",
    "deterministicRouteMatched",
    "awaitingDeterministicInput",
    "hasPendingDeterministicConfirmation",
    "conversationLocked",
  ];
  if (booleanFields.some((field) => typeof context[field] !== "boolean")) {
    return false;
  }

  const validDocumentType = context.activeDocumentType === null
    || MVP_DOCUMENT_TYPES.has(context.activeDocumentType);
  const validDocumentId = context.activeDocumentId === null
    || (typeof context.activeDocumentId === "string"
      && Boolean(context.activeDocumentId.trim()));
  const validFlow = context.currentFlow === null
    || CONVERSATION_FLOWS.has(context.currentFlow);
  if (!validDocumentType || !validDocumentId || !validFlow) return false;

  if (context.hasActiveDocument && context.activeDocumentType === null) return false;
  if (
    !context.hasActiveDocument
    && (context.activeDocumentType !== null || context.activeDocumentId !== null)
  ) {
    return false;
  }

  return typeof context.userMessageType === "string";
}

function evaluateBrainConversationEligibility(input) {
  if (!isPlainObject(input)) {
    return makeDecision({ reason: BRAIN_ELIGIBILITY_REASONS.INVALID_INPUT });
  }

  const candidate = input.candidateDecision;
  if (!isPlainObject(candidate)) {
    return makeDecision({
      reason: BRAIN_ELIGIBILITY_REASONS.MISSING_CANDIDATE_DECISION,
    });
  }
  if (!isReadyCandidate(candidate)) {
    return makeDecision({ reason: BRAIN_ELIGIBILITY_REASONS.CANDIDATE_NOT_READY });
  }

  const candidateFields = {
    candidateId: candidate.candidateId,
    intent: candidate.intent,
    documentType: candidate.documentType,
  };
  const context = input.conversationContext;
  const reject = (reason, fields = {}) => makeDecision({
    reason,
    ...candidateFields,
    ...fields,
  });

  if (!isPlainObject(context) || !isValidConversationContext(context)) {
    return reject(BRAIN_ELIGIBILITY_REASONS.INVALID_CONVERSATION_CONTEXT);
  }

  const metadata = {
    hasActiveDocument: context.hasActiveDocument,
    deterministicRouteMatched: context.deterministicRouteMatched,
    awaitingDeterministicInput: context.awaitingDeterministicInput,
    hasPendingDeterministicConfirmation:
      context.hasPendingDeterministicConfirmation,
    conversationLocked: context.conversationLocked,
    currentFlow: context.currentFlow,
    userMessageType: context.userMessageType,
  };
  const contextFields = {
    activeDocumentType: context.activeDocumentType,
    metadata,
  };
  const rejectContext = (reason) => reject(reason, contextFields);

  if (!SUPPORTED_MESSAGE_TYPES.has(context.userMessageType)) {
    return rejectContext(BRAIN_ELIGIBILITY_REASONS.UNSUPPORTED_MESSAGE_TYPE);
  }
  if (context.deterministicRouteMatched) {
    return rejectContext(
      BRAIN_ELIGIBILITY_REASONS.DETERMINISTIC_ROUTE_HAS_PRIORITY,
    );
  }
  if (context.conversationLocked) {
    return rejectContext(BRAIN_ELIGIBILITY_REASONS.CONVERSATION_LOCKED);
  }
  if (context.hasPendingDeterministicConfirmation) {
    return rejectContext(BRAIN_ELIGIBILITY_REASONS.CONFIRMATION_PENDING);
  }
  if (context.awaitingDeterministicInput) {
    return rejectContext(BRAIN_ELIGIBILITY_REASONS.DETERMINISTIC_INPUT_PENDING);
  }
  if (context.currentFlow !== null && context.currentFlow !== "document") {
    return rejectContext(
      BRAIN_ELIGIBILITY_REASONS.INCOMPATIBLE_CONVERSATION_STATE,
    );
  }
  if (
    context.hasActiveDocument
    && candidate.documentType !== context.activeDocumentType
  ) {
    return rejectContext(BRAIN_ELIGIBILITY_REASONS.ACTIVE_DOCUMENT_CONFLICT);
  }

  if (candidate.intent === "create_document") {
    if (context.hasActiveDocument || context.currentFlow !== null) {
      return rejectContext(
        BRAIN_ELIGIBILITY_REASONS.INCOMPATIBLE_CONVERSATION_STATE,
      );
    }
  } else if (candidate.intent === "edit_document") {
    if (!context.hasActiveDocument) {
      return rejectContext(BRAIN_ELIGIBILITY_REASONS.ACTIVE_DOCUMENT_REQUIRED);
    }
  } else if (candidate.intent === "clarify") {
    if (!context.hasActiveDocument) {
      return rejectContext(BRAIN_ELIGIBILITY_REASONS.DOCUMENT_CONTEXT_REQUIRED);
    }
  } else if (candidate.intent === "confirm_document") {
    if (!context.hasActiveDocument) {
      return rejectContext(BRAIN_ELIGIBILITY_REASONS.ACTIVE_DOCUMENT_REQUIRED);
    }
  }

  return makeDecision({
    status: BRAIN_ELIGIBILITY_STATUSES.ELIGIBLE,
    reason: BRAIN_ELIGIBILITY_REASONS.CONVERSATION_ELIGIBLE,
    ...candidateFields,
    ...contextFields,
  });
}

module.exports = {
  BRAIN_ELIGIBILITY_STATUSES,
  BRAIN_ELIGIBILITY_REASONS,
  evaluateBrainConversationEligibility,
};
