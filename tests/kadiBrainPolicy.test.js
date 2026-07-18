"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MVP_DOCUMENT_TYPES,
  MVP_INTENTS,
  BRAIN_POLICY_REASONS,
  evaluateBrainMvpPolicy,
} = require("../kadiBrainPolicy");

function validInput(overrides = {}) {
  return {
    mode: "candidate",
    text: "Fais une facture pour Awa",
    intent: "create_document",
    documentType: "facture",
    isLocalCommand: false,
    isAdminCommand: false,
    ...overrides,
  };
}

function assertCompleteDecision(decision) {
  assert.equal(typeof decision.eligible, "boolean");
  assert.equal(typeof decision.reason, "string");
  assert.ok(Object.hasOwn(decision, "documentType"));
  assert.ok(Object.hasOwn(decision, "intent"));
  assert.ok(Object.hasOwn(decision, "mode"));
  assert.deepEqual(Object.keys(decision.metadata), [
    "hasText",
    "isLocalCommand",
    "isAdminCommand",
  ]);
  assert.equal(typeof decision.metadata.hasText, "boolean");
  assert.equal(typeof decision.metadata.isLocalCommand, "boolean");
  assert.equal(typeof decision.metadata.isAdminCommand, "boolean");
}

test("exports exact immutable MVP constants", () => {
  assert.deepEqual(MVP_DOCUMENT_TYPES, ["devis", "facture", "recu", "decharge"]);
  assert.deepEqual(MVP_INTENTS, [
    "create_document",
    "edit_document",
    "clarify",
    "confirm_document",
  ]);
  assert.deepEqual(Object.values(BRAIN_POLICY_REASONS), [
    "eligible",
    "invalid_input",
    "mode_not_candidate_capable",
    "missing_text",
    "local_command",
    "admin_command",
    "unsupported_intent",
    "unsupported_document_type",
  ]);
  assert.equal(Object.isFrozen(MVP_DOCUMENT_TYPES), true);
  assert.equal(Object.isFrozen(MVP_INTENTS), true);
  assert.equal(Object.isFrozen(BRAIN_POLICY_REASONS), true);
});

test("candidate-capable modes are conceptually eligible", () => {
  for (const mode of ["candidate", "active_allowlist", "active"]) {
    const decision = evaluateBrainMvpPolicy(validInput({ mode }));
    assert.equal(decision.eligible, true, mode);
    assert.equal(decision.reason, "eligible", mode);
    assert.equal(decision.mode, mode);
  }
});

test("off, shadow, absent and invalid modes are rejected", () => {
  for (const mode of ["off", "shadow", undefined, "invalid"]) {
    const decision = evaluateBrainMvpPolicy(validInput({ mode }));
    assert.equal(decision.eligible, false, String(mode));
    assert.equal(decision.reason, "mode_not_candidate_capable", String(mode));
  }
});

test("mode normalization accepts surrounding spaces and uppercase", () => {
  const decision = evaluateBrainMvpPolicy(validInput({ mode: " ACTIVE_ALLOWLIST " }));
  assert.equal(decision.eligible, true);
  assert.equal(decision.mode, "active_allowlist");
});

test("accepts all four canonical MVP document types", () => {
  for (const documentType of MVP_DOCUMENT_TYPES) {
    const decision = evaluateBrainMvpPolicy(validInput({ documentType }));
    assert.equal(decision.eligible, true, documentType);
    assert.equal(decision.documentType, documentType);
  }
});

test("normalizes only the controlled accented document forms", () => {
  const cases = [
    [" Reçu ", "recu"],
    [" DÉCHARGE ", "decharge"],
  ];
  for (const [documentType, expected] of cases) {
    const decision = evaluateBrainMvpPolicy(validInput({ documentType }));
    assert.equal(decision.eligible, true, documentType);
    assert.equal(decision.documentType, expected);
  }
});

test("rejects document aliases and non-text document values", () => {
  for (const documentType of [
    "invoice",
    "quote",
    "proforma",
    "document",
    "FEC",
    null,
    42,
    {},
  ]) {
    const decision = evaluateBrainMvpPolicy(validInput({ documentType }));
    assert.equal(decision.eligible, false, String(documentType));
    assert.equal(decision.reason, "unsupported_document_type", String(documentType));
  }
});

test("accepts all four contract-compatible MVP intents", () => {
  for (const intent of MVP_INTENTS) {
    const decision = evaluateBrainMvpPolicy(validInput({ intent: ` ${intent.toUpperCase()} ` }));
    assert.equal(decision.eligible, true, intent);
    assert.equal(decision.intent, intent);
  }
});

test("rejects payment, PDF, history, deletion and unknown intents", () => {
  for (const intent of [
    "mark_paid",
    "generate_pdf",
    "list_documents",
    "remove_document_item",
    "unknown",
    "unsupported_new_intent",
    null,
    7,
  ]) {
    const decision = evaluateBrainMvpPolicy(validInput({ intent }));
    assert.equal(decision.eligible, false, String(intent));
    assert.equal(decision.reason, "unsupported_intent", String(intent));
  }
});

test("rejects empty, missing and non-text input text", () => {
  for (const text of ["", "   ", null, 123, {}]) {
    const decision = evaluateBrainMvpPolicy(validInput({ text }));
    assert.equal(decision.eligible, false, String(text));
    assert.equal(decision.reason, "missing_text", String(text));
    assert.equal(decision.metadata.hasText, false);
  }
});

test("rejects admin commands before local commands", () => {
  const admin = evaluateBrainMvpPolicy(validInput({ isAdminCommand: true }));
  assert.equal(admin.reason, "admin_command");

  const local = evaluateBrainMvpPolicy(validInput({ isLocalCommand: true }));
  assert.equal(local.reason, "local_command");

  const both = evaluateBrainMvpPolicy(
    validInput({ isAdminCommand: true, isLocalCommand: true })
  );
  assert.equal(both.reason, "admin_command");
});

test("does not infer command flags from text", () => {
  const decision = evaluateBrainMvpPolicy(validInput({ text: "MENU" }));
  assert.equal(decision.eligible, true);
  assert.equal(decision.metadata.isLocalCommand, false);
  assert.equal(decision.metadata.isAdminCommand, false);
});

test("rejects non-plain inputs with the required structure", () => {
  for (const input of [null, undefined, [], "text", 42, new Date()]) {
    const decision = evaluateBrainMvpPolicy(input);
    assertCompleteDecision(decision);
    assert.deepEqual(decision, {
      eligible: false,
      reason: "invalid_input",
      documentType: null,
      intent: null,
      mode: null,
      metadata: {
        hasText: false,
        isLocalCommand: false,
        isAdminCommand: false,
      },
    });
  }
});

test("returns a complete structure for every rejection reason", () => {
  const cases = [
    validInput({ mode: "shadow" }),
    validInput({ text: "" }),
    validInput({ isAdminCommand: true }),
    validInput({ isLocalCommand: true }),
    validInput({ intent: "generate_pdf" }),
    validInput({ documentType: "invoice" }),
  ];

  for (const input of cases) {
    const decision = evaluateBrainMvpPolicy(input);
    assertCompleteDecision(decision);
    assert.equal(decision.eligible, false);
  }
});

test("accepts frozen input without mutation and is deterministic", () => {
  const input = Object.freeze(validInput({
    mode: " CANDIDATE ",
    intent: " CREATE_DOCUMENT ",
    documentType: " Reçu ",
  }));
  const snapshot = { ...input };

  const first = evaluateBrainMvpPolicy(input);
  const second = evaluateBrainMvpPolicy(input);

  assert.deepEqual(input, snapshot);
  assert.deepEqual(first, second);
  assert.equal(first.eligible, true);
  assert.equal(first.documentType, "recu");
  assert.equal(first.intent, "create_document");
});

test("requires no environment configuration", () => {
  const decision = evaluateBrainMvpPolicy(validInput());
  assert.equal(decision.eligible, true);
  assert.equal(decision.mode, "candidate");
});
