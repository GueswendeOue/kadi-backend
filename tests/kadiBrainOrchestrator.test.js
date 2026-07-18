"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const orchestrator = require("../kadiBrainOrchestrator");

const {
  BRAIN_ORCHESTRATOR_STATUSES: STATUSES,
  BRAIN_ORCHESTRATOR_STAGES: STAGES,
  BRAIN_ORCHESTRATOR_REASONS: REASONS,
  BRAIN_ORCHESTRATOR_NEXT_ACTIONS: ACTIONS,
  BRAIN_ORCHESTRATOR_FUTURE_STEPS: FUTURE,
  orchestrateBrainDocumentPipeline: run,
} = orchestrator;

function brain(intent = "create_document", type = "facture") {
  return {
    status: "understood",
    intent: { name: intent },
    document: {
      operation: intent === "create_document" ? "create"
        : intent === "edit_document" ? "edit" : null,
      documentId: null, documentType: type, clientName: "Awa",
      clientPhone: null, subject: "Vente", notes: null,
      items: type === "decharge" ? [] : [{
        lineRef: null, label: "Chemise", quantity: 2, unit: null,
        unitPrice: 7500, lineTotal: null,
      }],
      subtotal: null, grandTotal: null, amountPaid: null,
      paymentStatus: null, paymentMethod: null, paymentDate: null,
      currency: null,
    },
    patches: [], missingFields: [], ambiguities: [], warnings: [],
  };
}

function input(intent = "create_document", type = "facture") {
  const active = intent !== "create_document";
  return {
    brainResult: brain(intent, type),
    mode: "active_allowlist",
    text: "Document pour Awa",
    isLocalCommand: false,
    isAdminCommand: false,
    conversationContext: {
      hasActiveDocument: active,
      activeDocumentType: active ? type : null,
      activeDocumentId: null,
      currentFlow: active ? "document" : null,
      deterministicRouteMatched: false,
      awaitingDeterministicInput: false,
      hasPendingDeterministicConfirmation: false,
      conversationLocked: false,
      userMessageType: "text",
    },
    activationContext: {
      userId: "user-1", userPhone: null, mode: "active_allowlist",
      allowlistedUserIds: ["user-1"], allowlistedPhones: [],
      emergencyDisabled: false,
    },
    currentDraft: active
      ? { type, client: "Awa", items: [], finance: null }
      : null,
  };
}

test("exports exact immutable constants", () => {
  assert.deepEqual(STATUSES, {
    ADAPTED: "adapted", NO_CHANGE: "no_change", REJECTED: "rejected",
    INVALID: "invalid",
  });
  assert.deepEqual(STAGES, {
    INPUT: "input", POLICY: "policy", CANDIDATE: "candidate",
    ELIGIBILITY: "eligibility", ACTIVATION: "activation",
    DRAFT_ADAPTER: "draft_adapter", COMPLETE: "complete",
  });
  assert.deepEqual(Object.values(REASONS), [
    "pipeline_adapted", "pipeline_no_change", "invalid_input", "invalid_mode",
    "mode_context_mismatch", "policy_rejected", "policy_brain_mismatch",
    "candidate_rejected", "eligibility_rejected", "activation_rejected",
    "draft_adapter_rejected", "policy_candidate_mismatch",
    "decision_chain_mismatch", "invalid_terminal_result",
  ]);
  assert.deepEqual(ACTIONS, {
    NONE: "none", ASK_MISSING_FIELDS: "ask_missing_fields",
    DETERMINISTIC_NORMALIZATION: "deterministic_normalization",
    DETERMINISTIC_CONFIRMATION: "deterministic_confirmation",
  });
  assert.deepEqual(FUTURE, {
    NONE: "NONE", STEP_8_MISSING_FIELDS: "STEP_8_MISSING_FIELDS",
    STEP_9_NORMALIZATION: "STEP_9_NORMALIZATION",
    STEP_10_CONFIRMATION: "STEP_10_CONFIRMATION",
  });
  for (const value of [STATUSES, STAGES, REASONS, ACTIONS, FUTURE]) {
    assert.equal(Object.isFrozen(value), true);
  }
});

test("returns a complete depth-zero result for invalid input", () => {
  const result = run(null);
  assert.deepEqual(Object.keys(result), [
    "status", "completed", "reason", "stoppedAt", "candidateId",
    "decisions", "draft", "nextAction", "futureStep", "metadata",
  ]);
  assert.deepEqual(result.decisions, {
    policy: null, candidate: null, eligibility: null, activation: null,
    draftAdapter: null,
  });
  assert.deepEqual(result.metadata, {
    reachedPolicy: false, reachedCandidate: false, reachedEligibility: false,
    reachedActivation: false, reachedDraftAdapter: false, pipelineDepth: 0,
    requiresDeterministicNormalization: false,
    requiresDeterministicFinance: false,
  });
  assert.equal(result.status, "invalid");
  assert.equal(result.completed, false);
  assert.equal(result.nextAction, "none");
  assert.equal(result.futureStep, "NONE");
});

test("validates exact initial input and mode before Policy", () => {
  const cases = [];
  const missing = input(); delete missing.text; cases.push(missing);
  for (const mode of ["ACTIVE_ALLOWLIST", " active_allowlist ", "unknown", 1, null]) {
    const value = input(); value.mode = mode; cases.push(value);
  }
  const local = input(); local.isLocalCommand = 1; cases.push(local);
  const admin = input(); admin.isAdminCommand = null; cases.push(admin);
  const conversation = input(); conversation.conversationContext = []; cases.push(conversation);
  const activation = input(); activation.activationContext = null; cases.push(activation);
  const draft = input(); draft.currentDraft = []; cases.push(draft);
  for (const value of cases) {
    const result = run(value);
    assert.equal(result.status, "invalid");
    assert.equal(result.metadata.pipelineDepth, 0);
    assert.equal(result.decisions.policy, null);
  }
  const mismatch = input(); mismatch.activationContext.mode = "candidate";
  assert.equal(run(mismatch).reason, "mode_context_mismatch");
});

test("stops at Policy without consulting conversation state", () => {
  const value = input(); value.text = "   ";
  Object.defineProperty(value.conversationContext, "hasActiveDocument", {
    get() { throw new Error("later stage consulted"); },
  });
  const result = run(value);
  assert.equal(result.reason, "policy_rejected");
  assert.equal(result.stoppedAt, "policy");
  assert.equal(result.metadata.pipelineDepth, 1);
  assert.equal(result.decisions.candidate, null);
});

test("rejects a Policy canonicalization mismatch before Candidate", () => {
  const value = input("create_document", "recu");
  value.brainResult.document.documentType = "reçu";
  const result = run(value);
  assert.equal(result.status, "invalid");
  assert.equal(result.reason, "policy_brain_mismatch");
  assert.equal(result.decisions.candidate, null);
});

test("stops at Candidate for a non-actionable Brain result", () => {
  const value = input(); value.brainResult.status = "failed";
  const first = run(value); const second = run(value);
  assert.equal(first.reason, "candidate_rejected");
  assert.equal(first.metadata.pipelineDepth, 2);
  assert.equal(first.decisions.eligibility, null);
  assert.match(first.candidateId, /^candidate_[a-f0-9]{24}$/);
  assert.equal(first.candidateId, second.candidateId);
});

test("stops at Eligibility without consulting allowlist members", () => {
  const value = input();
  value.conversationContext.deterministicRouteMatched = true;
  Object.defineProperty(value.activationContext, "allowlistedUserIds", {
    get() { throw new Error("later stage consulted"); },
  });
  const result = run(value);
  assert.equal(result.reason, "eligibility_rejected");
  assert.equal(result.metadata.pipelineDepth, 3);
  assert.equal(result.decisions.activation, null);
});

test("stops at Activation without consulting currentDraft", () => {
  const value = input(); value.activationContext.allowlistedUserIds = [];
  const trappedDraft = {};
  Object.defineProperty(trappedDraft, "type", {
    get() { throw new Error("later stage consulted"); },
  });
  value.currentDraft = trappedDraft;
  const result = run(value);
  assert.equal(result.reason, "activation_rejected");
  assert.equal(result.metadata.pipelineDepth, 4);
  assert.equal(result.decisions.draftAdapter, null);
  assert.equal(JSON.stringify(result).includes("allowlistedUserIds"), false);
});

test("adapts create_document for every canonical type", () => {
  for (const type of ["devis", "facture", "recu", "decharge"]) {
    const result = run(input("create_document", type));
    assert.equal(result.status, "adapted", type);
    assert.equal(result.completed, true);
    assert.equal(result.stoppedAt, "complete");
    assert.equal(result.metadata.pipelineDepth, 5);
    assert.equal(result.metadata.requiresDeterministicNormalization, true);
    assert.equal(result.metadata.requiresDeterministicFinance, true);
    assert.equal(result.draft.type, type);
    assert.equal(result.nextAction, "deterministic_normalization");
    assert.equal(result.futureStep, "STEP_9_NORMALIZATION");
    assert.equal(result.decisions.candidate.candidateId, result.candidateId);
    assert.equal(result.decisions.eligibility.candidateId, result.candidateId);
    assert.equal(result.decisions.activation.candidateId, result.candidateId);
    assert.equal(result.decisions.draftAdapter.candidateId, result.candidateId);
  }
});

test("adapts edit_document without mutation or recalculation", () => {
  const value = input("edit_document");
  value.currentDraft.items = [{ lineRef: "line-a", label: "Chemise", qty: 2,
    unit: null, unitPrice: 7500, amount: 15000 }];
  value.currentDraft.finance = { total: 15000 };
  value.brainResult.document.items = [];
  value.brainResult.patches = [{ op: "replace", path: "items.line-a.qty",
    valueText: null, valueNumber: 3 }];
  const before = JSON.stringify(value.currentDraft);
  const result = run(value);
  assert.equal(result.status, "adapted");
  assert.equal(result.draft.items[0].qty, 3);
  assert.equal(result.draft.items[0].amount, 15000);
  assert.equal(result.draft.finance.total, 15000);
  assert.equal(JSON.stringify(value.currentDraft), before);
  assert.notStrictEqual(result.draft, value.currentDraft);
});

test("maps clarify and confirm_document to no_change actions", () => {
  const clarify = run(input("clarify"));
  assert.equal(clarify.status, "no_change");
  assert.equal(clarify.completed, true);
  assert.equal(clarify.draft, null);
  assert.equal(clarify.nextAction, "ask_missing_fields");
  assert.equal(clarify.futureStep, "STEP_8_MISSING_FIELDS");

  const confirm = run(input("confirm_document"));
  assert.equal(confirm.status, "no_change");
  assert.equal(confirm.nextAction, "deterministic_confirmation");
  assert.equal(confirm.futureStep, "STEP_10_CONFIRMATION");
});

test("missingFields has priority over adapted normalization", () => {
  const value = input(); value.brainResult.missingFields = ["clientPhone"];
  const result = run(value);
  assert.equal(result.status, "adapted");
  assert.equal(result.nextAction, "ask_missing_fields");
  assert.equal(result.futureStep, "STEP_8_MISSING_FIELDS");
});

test("reports Draft Adapter rejection at depth five", () => {
  const value = input(); value.brainResult.document.items[0].lineTotal = 15000;
  const result = run(value);
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "draft_adapter_rejected");
  assert.equal(result.stoppedAt, "draft_adapter");
  assert.equal(result.metadata.pipelineDepth, 5);
  assert.equal(result.nextAction, "none");
  assert.equal(result.futureStep, "NONE");
});

test("accepts frozen inputs and returns deterministic independent outputs", () => {
  const value = input();
  Object.freeze(value.conversationContext);
  Object.freeze(value.activationContext.allowlistedUserIds);
  Object.freeze(value.activationContext.allowlistedPhones);
  Object.freeze(value.activationContext);
  Object.freeze(value.brainResult.document.items[0]);
  Object.freeze(value.brainResult.document.items);
  Object.freeze(value.brainResult.document);
  Object.freeze(value.brainResult);
  Object.freeze(value);
  const first = run(value); const second = run(value);
  assert.deepEqual(first, second);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.draft, second.draft);
  first.draft.items[0].label = "Modifié";
  assert.equal(second.draft.items[0].label, "Chemise");
});
