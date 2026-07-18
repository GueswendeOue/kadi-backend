"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BRAIN_ELIGIBILITY_STATUSES,
  BRAIN_ELIGIBILITY_REASONS,
  evaluateBrainConversationEligibility,
} = require("../kadiBrainEligibility");

function candidate(overrides = {}) {
  return {
    candidateId: "candidate_0123456789abcdef01234567",
    status: "candidate",
    eligible: true,
    reason: "candidate_ready",
    intent: "create_document",
    documentType: "facture",
    operations: ["create"],
    missingFields: [],
    ambiguities: [],
    warnings: [],
    metadata: {},
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    hasActiveDocument: false,
    activeDocumentType: null,
    activeDocumentId: null,
    currentFlow: null,
    deterministicRouteMatched: false,
    awaitingDeterministicInput: false,
    hasPendingDeterministicConfirmation: false,
    conversationLocked: false,
    userMessageType: "text",
    ...overrides,
  };
}

function input(candidateOverrides = {}, contextOverrides = {}) {
  return {
    candidateDecision: candidate(candidateOverrides),
    conversationContext: context(contextOverrides),
  };
}

test("exports exact immutable eligibility constants", () => {
  assert.deepEqual(BRAIN_ELIGIBILITY_STATUSES, {
    ELIGIBLE: "eligible",
    REJECTED: "rejected",
  });
  assert.deepEqual(Object.values(BRAIN_ELIGIBILITY_REASONS), [
    "conversation_eligible",
    "invalid_input",
    "missing_candidate_decision",
    "candidate_not_ready",
    "invalid_conversation_context",
    "unsupported_message_type",
    "deterministic_route_has_priority",
    "conversation_locked",
    "confirmation_pending",
    "deterministic_input_pending",
    "active_document_required",
    "active_document_conflict",
    "document_context_required",
    "incompatible_conversation_state",
  ]);
  assert.equal(Object.isFrozen(BRAIN_ELIGIBILITY_STATUSES), true);
  assert.equal(Object.isFrozen(BRAIN_ELIGIBILITY_REASONS), true);
});

test("rejects non-object input and missing Candidate", () => {
  for (const value of [null, [], "candidate", 1]) {
    assert.equal(
      evaluateBrainConversationEligibility(value).reason,
      "invalid_input",
    );
  }
  for (const value of [undefined, null, [], "candidate"]) {
    assert.equal(
      evaluateBrainConversationEligibility({ candidateDecision: value }).reason,
      "missing_candidate_decision",
    );
  }
});

test("fails closed when the Candidate is not ready", () => {
  const cases = [
    { candidateId: null },
    { candidateId: "  " },
    { status: "rejected" },
    { eligible: false },
    { reason: "policy_rejected" },
    { intent: "generate_pdf" },
    { documentType: "invoice" },
  ];
  for (const overrides of cases) {
    assert.equal(
      evaluateBrainConversationEligibility({
        candidateDecision: candidate(overrides),
        conversationContext: context(),
      }).reason,
      "candidate_not_ready",
    );
  }
});

test("always returns the complete output shape", () => {
  const decision = evaluateBrainConversationEligibility(null);
  assert.deepEqual(Object.keys(decision), [
    "status", "eligible", "reason", "candidateId", "intent",
    "documentType", "activeDocumentType", "metadata",
  ]);
  assert.deepEqual(Object.keys(decision.metadata), [
    "hasActiveDocument", "deterministicRouteMatched",
    "awaitingDeterministicInput", "hasPendingDeterministicConfirmation",
    "conversationLocked", "currentFlow", "userMessageType",
  ]);
});

test("rejects absent, incomplete and contradictory conversation contexts", () => {
  const invalidContexts = [
    undefined,
    null,
    [],
    {},
    context({ hasActiveDocument: "true" }),
    context({ deterministicRouteMatched: 1 }),
    context({ awaitingDeterministicInput: null }),
    context({ hasPendingDeterministicConfirmation: undefined }),
    context({ conversationLocked: "false" }),
    context({ hasActiveDocument: true, activeDocumentType: null }),
    context({ activeDocumentType: "facture" }),
    context({ activeDocumentId: "doc-1" }),
    context({ activeDocumentId: " " }),
    context({ activeDocumentType: "invoice", hasActiveDocument: true }),
    context({ currentFlow: "unknown" }),
    context({ userMessageType: null }),
  ];
  for (const conversationContext of invalidContexts) {
    assert.equal(
      evaluateBrainConversationEligibility({
        candidateDecision: candidate(),
        conversationContext,
      }).reason,
      "invalid_conversation_context",
    );
  }
});

test("accepts only text and transcribed voice message types", () => {
  for (const userMessageType of ["text", "voice"]) {
    const decision = evaluateBrainConversationEligibility(
      input({}, { userMessageType }),
    );
    assert.equal(decision.status, "eligible");
  }
  for (const userMessageType of ["interactive", "button", "image", "audio", "unknown", ""]) {
    assert.equal(
      evaluateBrainConversationEligibility(
        input({}, { userMessageType }),
      ).reason,
      "unsupported_message_type",
    );
  }
});

test("preserves deterministic route priority over every other protection", () => {
  const decision = evaluateBrainConversationEligibility(input({}, {
    deterministicRouteMatched: true,
    conversationLocked: true,
    hasPendingDeterministicConfirmation: true,
    awaitingDeterministicInput: true,
  }));
  assert.equal(decision.reason, "deterministic_route_has_priority");
});

test("rejects locked conversations before pending confirmation and input", () => {
  const decision = evaluateBrainConversationEligibility(input({}, {
    conversationLocked: true,
    hasPendingDeterministicConfirmation: true,
    awaitingDeterministicInput: true,
  }));
  assert.equal(decision.reason, "conversation_locked");
});

test("protects pending deterministic confirmation before expected input", () => {
  const decision = evaluateBrainConversationEligibility(input({}, {
    hasPendingDeterministicConfirmation: true,
    awaitingDeterministicInput: true,
  }));
  assert.equal(decision.reason, "confirmation_pending");
});

test("protects pending deterministic text input", () => {
  assert.equal(
    evaluateBrainConversationEligibility(input({}, {
      awaitingDeterministicInput: true,
    })).reason,
    "deterministic_input_pending",
  );
});

test("rejects every active non-document flow", () => {
  for (const currentFlow of [
    "history", "profile", "stamp", "recharge", "image", "structured",
  ]) {
    assert.equal(
      evaluateBrainConversationEligibility(input({}, { currentFlow })).reason,
      "incompatible_conversation_state",
    );
  }
});

test("allows document creation only without a document or active flow", () => {
  const eligible = evaluateBrainConversationEligibility(input());
  assert.equal(eligible.status, "eligible");
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.reason, "conversation_eligible");

  const sameDocument = evaluateBrainConversationEligibility(input({}, {
    hasActiveDocument: true,
    activeDocumentType: "facture",
    activeDocumentId: null,
    currentFlow: "document",
  }));
  assert.equal(sameDocument.reason, "incompatible_conversation_state");

  const documentFlowOnly = evaluateBrainConversationEligibility(input({}, {
    currentFlow: "document",
  }));
  assert.equal(documentFlowOnly.reason, "incompatible_conversation_state");
});

test("rejects a document type conflict before intention-specific rules", () => {
  const decision = evaluateBrainConversationEligibility(input({}, {
    hasActiveDocument: true,
    activeDocumentType: "devis",
    activeDocumentId: null,
    currentFlow: "document",
  }));
  assert.equal(decision.reason, "active_document_conflict");
  assert.equal(decision.activeDocumentType, "devis");
});

test("requires a compatible active document for edit", () => {
  assert.equal(
    evaluateBrainConversationEligibility(input({ intent: "edit_document" })).reason,
    "active_document_required",
  );
  const decision = evaluateBrainConversationEligibility(input(
    { intent: "edit_document" },
    {
      hasActiveDocument: true,
      activeDocumentType: "facture",
      activeDocumentId: null,
      currentFlow: "document",
    },
  ));
  assert.equal(decision.reason, "conversation_eligible");
});

test("requires identifiable document context for clarification", () => {
  assert.equal(
    evaluateBrainConversationEligibility(input({ intent: "clarify" })).reason,
    "document_context_required",
  );
  assert.equal(
    evaluateBrainConversationEligibility(input(
      { intent: "clarify" },
      {
        hasActiveDocument: true,
        activeDocumentType: "facture",
        activeDocumentId: null,
        currentFlow: "document",
      },
    )).reason,
    "conversation_eligible",
  );
});

test("requires an active document for confirmation and protects legacy confirmation", () => {
  assert.equal(
    evaluateBrainConversationEligibility(input({ intent: "confirm_document" })).reason,
    "active_document_required",
  );
  const activeContext = {
    hasActiveDocument: true,
    activeDocumentType: "facture",
    activeDocumentId: "document-1",
    currentFlow: "document",
  };
  assert.equal(
    evaluateBrainConversationEligibility(input(
      { intent: "confirm_document" },
      activeContext,
    )).reason,
    "conversation_eligible",
  );
  assert.equal(
    evaluateBrainConversationEligibility(input(
      { intent: "confirm_document" },
      { ...activeContext, hasPendingDeterministicConfirmation: true },
    )).reason,
    "confirmation_pending",
  );
});

test("accepts an unsaved active draft without a document id", () => {
  const decision = evaluateBrainConversationEligibility(input(
    { intent: "edit_document", documentType: "devis" },
    {
      hasActiveDocument: true,
      activeDocumentType: "devis",
      activeDocumentId: null,
      currentFlow: "document",
    },
  ));
  assert.equal(decision.reason, "conversation_eligible");
});

test("does not mutate frozen input and is deterministic", () => {
  const frozenCandidate = candidate({ intent: "edit_document" });
  Object.freeze(frozenCandidate.operations);
  Object.freeze(frozenCandidate.missingFields);
  Object.freeze(frozenCandidate.ambiguities);
  Object.freeze(frozenCandidate.warnings);
  Object.freeze(frozenCandidate.metadata);
  Object.freeze(frozenCandidate);
  const frozenContext = Object.freeze(context({
    hasActiveDocument: true,
    activeDocumentType: "facture",
    activeDocumentId: null,
    currentFlow: "document",
  }));
  const frozenInput = Object.freeze({
    candidateDecision: frozenCandidate,
    conversationContext: frozenContext,
  });
  const first = evaluateBrainConversationEligibility(frozenInput);
  const second = evaluateBrainConversationEligibility(frozenInput);
  assert.deepEqual(first, second);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.metadata, second.metadata);
  assert.deepEqual(frozenCandidate.operations, ["create"]);
});
