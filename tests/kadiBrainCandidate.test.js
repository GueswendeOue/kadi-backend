"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BRAIN_CANDIDATE_STATUSES,
  BRAIN_CANDIDATE_REASONS,
  buildBrainCandidateDecision,
} = require("../kadiBrainCandidate");
const { validResult } = require("./kadiBrainFixture");

function brainResult(intent = "create_document", documentType = "facture") {
  const result = validResult({ requestId: "candidate-test" }, intent);
  result.document.documentType = documentType;
  return result;
}

function validInput(overrides = {}) {
  return {
    mode: "candidate",
    text: "Fais une facture pour Awa",
    isLocalCommand: false,
    isAdminCommand: false,
    brainResult: brainResult(),
    ...overrides,
  };
}

test("exports exact immutable candidate constants", () => {
  assert.deepEqual(BRAIN_CANDIDATE_STATUSES, {
    CANDIDATE: "candidate",
    REJECTED: "rejected",
  });
  assert.deepEqual(Object.values(BRAIN_CANDIDATE_REASONS), [
    "candidate_ready", "invalid_input", "missing_brain_result",
    "invalid_brain_status", "brain_result_not_actionable", "policy_rejected",
    "unsupported_operation", "malformed_brain_result",
  ]);
  assert.equal(Object.isFrozen(BRAIN_CANDIDATE_STATUSES), true);
  assert.equal(Object.isFrozen(BRAIN_CANDIDATE_REASONS), true);
});

test("builds candidates for both actionable Brain statuses", () => {
  for (const status of ["understood", "needs_clarification"]) {
    const result = brainResult();
    result.status = status;
    const decision = buildBrainCandidateDecision(validInput({ brainResult: result }));
    assert.equal(decision.status, "candidate");
    assert.equal(decision.eligible, true);
    assert.equal(decision.reason, "candidate_ready");
    assert.equal(decision.policyReason, "eligible");
  }
});

test("candidateId is local, stable and content-sensitive", () => {
  const first = buildBrainCandidateDecision(validInput());
  const second = buildBrainCandidateDecision(validInput());
  const different = buildBrainCandidateDecision(validInput({ mode: "active" }));
  assert.match(first.candidateId, /^candidate_[a-f0-9]{24}$/);
  assert.equal(first.candidateId, second.candidateId);
  assert.notEqual(first.candidateId, different.candidateId);
});

test("rejects invalid input and missing Brain result with complete output", () => {
  const cases = [
    [null, "invalid_input"],
    [[], "invalid_input"],
    [{}, "missing_brain_result"],
    [{ brainResult: [] }, "missing_brain_result"],
  ];
  for (const [input, reason] of cases) {
    const decision = buildBrainCandidateDecision(input);
    assert.equal(decision.reason, reason);
    assert.equal(decision.status, "rejected");
    assert.equal(decision.eligible, false);
    assert.match(decision.candidateId, /^candidate_/);
    assert.deepEqual(decision.operations, []);
    assert.deepEqual(decision.missingFields, []);
    assert.deepEqual(decision.ambiguities, []);
    assert.deepEqual(decision.warnings, []);
    assert.deepEqual(Object.keys(decision.metadata), [
      "hasText", "isLocalCommand", "isAdminCommand", "operationCount",
      "missingFieldCount", "ambiguityCount", "warningCount",
    ]);
  }
});

test("rejects unknown or missing statuses as invalid", () => {
  for (const status of [undefined, null, "timeout", "invalid", "error"]) {
    const result = brainResult();
    result.status = status;
    assert.equal(
      buildBrainCandidateDecision(validInput({ brainResult: result })).reason,
      "invalid_brain_status",
    );
  }
});

test("rejects contractual non-actionable statuses and provider failure", () => {
  for (const status of ["unsupported", "unsafe", "failed"]) {
    const result = brainResult();
    result.status = status;
    assert.equal(
      buildBrainCandidateDecision(validInput({ brainResult: result })).reason,
      "brain_result_not_actionable",
    );
  }
  const failed = brainResult();
  failed.providerFailed = true;
  assert.equal(
    buildBrainCandidateDecision(validInput({ brainResult: failed })).reason,
    "brain_result_not_actionable",
  );
});

test("preserves detailed policy rejection reasons", () => {
  const cases = [
    [{ mode: "shadow" }, "mode_not_candidate_capable"],
    [{ text: "   " }, "missing_text"],
    [{ isAdminCommand: true, isLocalCommand: true }, "admin_command"],
    [{ isLocalCommand: true }, "local_command"],
    [{ brainResult: brainResult("generate_pdf") }, "unsupported_intent"],
    [{ brainResult: brainResult("create_document", "proforma") }, "unsupported_document_type"],
  ];
  for (const [overrides, policyReason] of cases) {
    const decision = buildBrainCandidateDecision(validInput(overrides));
    assert.equal(decision.reason, "policy_rejected");
    assert.equal(decision.policyReason, policyReason);
  }
});

test("copies known operations in contract order without executing them", () => {
  const result = brainResult();
  result.patches = [
    { op: "add", path: "document.items", valueText: "x", valueNumber: null },
    { op: "replace", path: "document.notes", valueText: "y", valueNumber: null },
    { op: "remove", path: "document.subject", valueText: null, valueNumber: null },
    { op: "add", path: "document.items", valueText: "z", valueNumber: null },
  ];
  const decision = buildBrainCandidateDecision(validInput({ brainResult: result }));
  assert.deepEqual(decision.operations, ["create", "add", "replace", "remove", "add"]);
  assert.notStrictEqual(decision.operations, result.patches);
  assert.equal(decision.metadata.operationCount, 5);
});

test("allows a candidate with no operation for clarification", () => {
  const result = brainResult("clarify");
  result.document.operation = null;
  result.patches = [];
  assert.deepEqual(
    buildBrainCandidateDecision(validInput({ brainResult: result })).operations,
    [],
  );
});

test("rejects unknown document and patch operations", () => {
  const unknownDocument = brainResult();
  unknownDocument.document.operation = "delete";
  const unknownPatch = brainResult();
  unknownPatch.patches = [{ op: "move", path: "x", valueText: null, valueNumber: null }];
  for (const result of [unknownDocument, unknownPatch]) {
    assert.equal(
      buildBrainCandidateDecision(validInput({ brainResult: result })).reason,
      "unsupported_operation",
    );
  }
});

test("copies and normalizes diagnostic string arrays", () => {
  const result = brainResult();
  result.missingFields = [" clientName ", "", "clientPhone"];
  result.ambiguities = [" quantité "];
  result.warnings = [" prix ", "prix"];
  const decision = buildBrainCandidateDecision(validInput({ brainResult: result }));
  assert.deepEqual(decision.missingFields, ["clientName", "clientPhone"]);
  assert.deepEqual(decision.ambiguities, ["quantité"]);
  assert.deepEqual(decision.warnings, ["prix", "prix"]);
  assert.notStrictEqual(decision.missingFields, result.missingFields);
  assert.deepEqual(
    [decision.metadata.missingFieldCount, decision.metadata.ambiguityCount, decision.metadata.warningCount],
    [2, 1, 2],
  );
});

test("fails closed on malformed Brain shapes and diagnostic arrays", () => {
  const mutations = [
    (result) => { result.intent = null; },
    (result) => { result.intent.name = 3; },
    (result) => { result.document = []; },
    (result) => { result.patches = null; },
    (result) => { result.missingFields = [3]; },
    (result) => { result.ambiguities = null; },
    (result) => { result.warnings = Array(51).fill("x"); },
  ];
  for (const mutate of mutations) {
    const result = brainResult();
    mutate(result);
    assert.equal(
      buildBrainCandidateDecision(validInput({ brainResult: result })).reason,
      "malformed_brain_result",
    );
  }
});

test("accepts frozen input without mutation and returns independent decisions", () => {
  const result = brainResult();
  Object.freeze(result.missingFields);
  Object.freeze(result.ambiguities);
  Object.freeze(result.warnings);
  Object.freeze(result.patches);
  Object.freeze(result.intent);
  Object.freeze(result.document);
  Object.freeze(result);
  const input = Object.freeze(validInput({ brainResult: result }));
  const first = buildBrainCandidateDecision(input);
  const second = buildBrainCandidateDecision(input);
  assert.deepEqual(first, second);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.operations, second.operations);
  assert.notStrictEqual(first.metadata, second.metadata);
});

test("normalizes policy fields in the final decision", () => {
  const decision = buildBrainCandidateDecision(validInput({
    mode: " ACTIVE_ALLOWLIST ",
    brainResult: brainResult(" CREATE_DOCUMENT ", "décharge"),
  }));
  assert.equal(decision.mode, "active_allowlist");
  assert.equal(decision.intent, "create_document");
  assert.equal(decision.documentType, "decharge");
});
