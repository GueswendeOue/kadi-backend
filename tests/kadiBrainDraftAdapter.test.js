"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BRAIN_DRAFT_ADAPTER_STATUSES,
  BRAIN_DRAFT_ADAPTER_REASONS,
  BRAIN_DRAFT_ALLOWED_FIELDS,
  BRAIN_DRAFT_ALLOWED_PATCH_PATHS,
  adaptBrainDecisionToDraft,
} = require("../kadiBrainDraftAdapter");

const ID = "candidate_0123456789abcdef01234567";

function decisions(intent = "create_document", type = "facture") {
  const candidate = {
    status: "candidate", eligible: true, reason: "candidate_ready",
    candidateId: ID, intent, documentType: type,
    operations: intent === "create_document" ? ["create"]
      : intent === "edit_document" ? ["edit"] : [],
    missingFields: [], warnings: [],
  };
  return {
    activationDecision: {
      status: "allowed", allowed: true, reason: "activation_allowed",
      candidateId: ID,
    },
    eligibilityDecision: {
      status: "eligible", eligible: true, reason: "conversation_eligible",
      candidateId: ID,
    },
    candidateDecision: candidate,
  };
}

function document(operation = "create", type = "facture") {
  return {
    operation, documentId: null, documentType: type,
    clientName: " Awa ", clientPhone: null, subject: "Vente", notes: "Habits",
    items: [{
      lineRef: null, label: "Chemise", quantity: 10, unit: "pièce",
      unitPrice: 7500, lineTotal: null,
    }],
    subtotal: null, grandTotal: null, amountPaid: null, paymentStatus: null,
    paymentMethod: "mobile money", paymentDate: null, currency: null,
  };
}

function input(intent = "create_document", type = "facture") {
  return {
    ...decisions(intent, type),
    brainResult: {
      intent: { name: intent },
      document: document(intent === "edit_document" ? "edit" :
        intent === "create_document" ? "create" : null, type),
      patches: [],
    },
    currentDraft: null,
  };
}

test("exports exact frozen constants", () => {
  assert.deepEqual(BRAIN_DRAFT_ADAPTER_STATUSES, {
    ADAPTED: "adapted", NO_CHANGE: "no_change", REJECTED: "rejected",
  });
  assert.deepEqual(Object.values(BRAIN_DRAFT_ADAPTER_REASONS), [
    "draft_adapted", "no_draft_change", "invalid_input",
    "activation_not_allowed", "eligibility_not_granted", "candidate_not_ready",
    "decision_chain_mismatch", "missing_brain_result", "malformed_brain_result",
    "brain_candidate_mismatch", "unsupported_intent", "unsupported_operation",
    "unsupported_document_type", "active_draft_required", "active_draft_conflict",
    "invalid_client", "invalid_items", "too_many_items", "invalid_item",
    "unsupported_field", "ambiguous_document_field", "unsupported_patch",
    "unsafe_patch_path", "unknown_line_reference", "engine_owned_field",
  ]);
  for (const value of [BRAIN_DRAFT_ADAPTER_STATUSES,
    BRAIN_DRAFT_ADAPTER_REASONS, BRAIN_DRAFT_ALLOWED_FIELDS,
    BRAIN_DRAFT_ALLOWED_PATCH_PATHS]) assert.equal(Object.isFrozen(value), true);
});

test("requires every ready decision and a matching candidate id", () => {
  assert.equal(adaptBrainDecisionToDraft(null).reason, "invalid_input");
  for (const key of ["activationDecision", "eligibilityDecision", "candidateDecision"]) {
    const value = input();
    value[key] = null;
    assert.equal(adaptBrainDecisionToDraft(value).reason, {
      activationDecision: "activation_not_allowed",
      eligibilityDecision: "eligibility_not_granted",
      candidateDecision: "candidate_not_ready",
    }[key]);
  }
  const mismatch = input();
  mismatch.activationDecision.candidateId = "candidate_other";
  assert.equal(adaptBrainDecisionToDraft(mismatch).reason, "decision_chain_mismatch");
});

test("rejects missing, malformed and incoherent Brain results", () => {
  const missing = input(); missing.brainResult = null;
  assert.equal(adaptBrainDecisionToDraft(missing).reason, "missing_brain_result");
  const malformed = input(); malformed.brainResult.document = null;
  assert.equal(adaptBrainDecisionToDraft(malformed).reason, "malformed_brain_result");
  const intentMismatch = input(); intentMismatch.brainResult.intent.name = "edit_document";
  assert.equal(adaptBrainDecisionToDraft(intentMismatch).reason, "brain_candidate_mismatch");
  const typeMismatch = input(); typeMismatch.brainResult.document.documentType = "devis";
  assert.equal(adaptBrainDecisionToDraft(typeMismatch).reason, "brain_candidate_mismatch");
  const operationMismatch = input(); operationMismatch.brainResult.document.operation = "edit";
  assert.equal(adaptBrainDecisionToDraft(operationMismatch).reason, "brain_candidate_mismatch");
});

test("creates all four canonical drafts without calculations", () => {
  for (const type of ["devis", "facture", "recu", "decharge"]) {
    const value = input("create_document", type);
    if (type === "decharge") value.brainResult.document.items = [];
    const result = adaptBrainDecisionToDraft(value);
    assert.equal(result.reason, "draft_adapted", type);
    assert.equal(result.draft.type, type);
    assert.equal(result.draft.factureKind, type === "facture" ? "definitive" : null);
    assert.equal(result.draft.docNumber, null);
    assert.equal(result.draft.date, null);
    assert.equal(result.draft.finance, null);
    assert.equal(result.draft.source, "brain");
    assert.equal(result.metadata.requiresDeterministicNormalization, true);
    assert.equal(result.metadata.requiresDeterministicFinance, true);
  }
});

test("maps flat client, notes and items without amount or lineTotal", () => {
  const result = adaptBrainDecisionToDraft(input());
  assert.equal(result.draft.client, "Awa");
  assert.equal(result.draft.clientPhone, null);
  assert.equal(result.draft.motif, "Habits");
  assert.deepEqual(result.draft.items, [{
    label: "Chemise", qty: 10, unit: "pièce", unitPrice: 7500,
  }]);
  assert.equal(Object.hasOwn(result.draft.items[0], "amount"), false);
  assert.equal(Object.hasOwn(result.draft.items[0], "lineTotal"), false);
});

test("rejects aliases, invalid facture kind and receipt format", () => {
  const alias = input(); alias.candidateDecision.documentType = "invoice";
  assert.equal(adaptBrainDecisionToDraft(alias).reason, "candidate_not_ready");
  const kind = input(); kind.brainResult.document.factureKind = "final";
  assert.equal(adaptBrainDecisionToDraft(kind).reason, "unsupported_field");
  const format = input("create_document", "recu");
  format.brainResult.document.receiptFormat = "ticket";
  assert.equal(adaptBrainDecisionToDraft(format).reason, "unsupported_field");
});

test("accepts approved optional fields and detects motif ambiguity", () => {
  const value = input();
  Object.assign(value.brainResult.document, {
    factureKind: "proforma", receiptFormat: "compact", paid: true,
    motif: "Habits",
  });
  const result = adaptBrainDecisionToDraft(value);
  assert.equal(result.draft.factureKind, "proforma");
  assert.equal(result.draft.receiptFormat, "compact");
  assert.equal(result.draft.paid, true);
  const conflict = input(); conflict.brainResult.document.motif = "Autre";
  assert.equal(adaptBrainDecisionToDraft(conflict).reason, "ambiguous_document_field");
});

test("fails closed on unknown and engine-owned document fields", () => {
  const unknown = input(); unknown.brainResult.document.secret = "x";
  assert.equal(adaptBrainDecisionToDraft(unknown).reason, "unsupported_field");
  const engine = input(); engine.brainResult.document.finance = { total: 1 };
  const result = adaptBrainDecisionToDraft(engine);
  assert.equal(result.reason, "engine_owned_field");
  assert.deepEqual(result.ignoredEngineFields, ["finance"]);
  for (const field of ["subtotal", "grandTotal", "amountPaid"]) {
    const attempted = input(); attempted.brainResult.document[field] = 1;
    assert.equal(adaptBrainDecisionToDraft(attempted).reason, "engine_owned_field", field);
  }
  const knownButIgnored = input();
  Object.assign(knownButIgnored.brainResult.document, {
    paymentStatus: "paid", paymentDate: "2026-07-18", currency: "XOF",
  });
  const ignoredResult = adaptBrainDecisionToDraft(knownButIgnored);
  assert.equal(ignoredResult.reason, "draft_adapted");
  assert.equal(Object.hasOwn(ignoredResult.draft, "currency"), false);
  assert.equal(Object.hasOwn(ignoredResult.draft, "paymentStatus"), false);
});

test("validates every item primitive and the fifty-item limit", () => {
  for (const [field, invalid] of [["label", ""], ["quantity", 0],
    ["quantity", "1"], ["unit", 3], ["unitPrice", -1], ["unitPrice", NaN]]) {
    const value = input(); value.brainResult.document.items[0][field] = invalid;
    assert.equal(adaptBrainDecisionToDraft(value).reason, "invalid_item", field);
  }
  const tooMany = input();
  tooMany.brainResult.document.items = Array.from({ length: 51 }, () => ({
    lineRef: null, label: "x", quantity: 1, unit: null,
    unitPrice: 1, lineTotal: null,
  }));
  assert.equal(adaptBrainDecisionToDraft(tooMany).reason, "too_many_items");
  const total = input(); total.brainResult.document.items[0].lineTotal = 75000;
  assert.equal(adaptBrainDecisionToDraft(total).reason, "engine_owned_field");
});

test("create rejects an active draft and never synthesizes receipt items", () => {
  const active = input(); active.currentDraft = { type: "facture" };
  assert.equal(adaptBrainDecisionToDraft(active).reason, "active_draft_conflict");
  const receipt = input("create_document", "recu");
  receipt.brainResult.document.items = [];
  assert.equal(adaptBrainDecisionToDraft(receipt).reason, "invalid_items");
});

function editInput() {
  const value = input("edit_document", "facture");
  value.currentDraft = {
    type: "facture", factureKind: "definitive", client: "Awa",
    items: [{ lineRef: "line-a", label: "Chemise", qty: 2, unit: null,
      unitPrice: 1000, amount: 2000 }],
    finance: { total: 2000 }, docNumber: "FAC-1", savedDocumentId: "doc-1",
  };
  return value;
}

test("edit requires a compatible explicit draft", () => {
  const missing = input("edit_document", "facture");
  assert.equal(adaptBrainDecisionToDraft(missing).reason, "active_draft_required");
  const conflict = editInput(); conflict.currentDraft.type = "devis";
  assert.equal(adaptBrainDecisionToDraft(conflict).reason, "active_draft_conflict");
});

test("applies exact top-level patches to a copy and preserves engine fields", () => {
  const value = editInput();
  value.brainResult.document.items = [];
  value.brainResult.patches = [
    { op: "replace", path: "client", valueText: "Binta", valueNumber: null },
  ];
  const result = adaptBrainDecisionToDraft(value);
  assert.equal(result.reason, "draft_adapted");
  assert.equal(result.draft.client, "Binta");
  assert.equal(value.currentDraft.client, "Awa");
  assert.equal(result.draft.docNumber, "FAC-1");
  assert.equal(result.draft.savedDocumentId, "doc-1");
  assert.notStrictEqual(result.draft.items, value.currentDraft.items);
});

test("applies only exact item lineRef patches", () => {
  const value = editInput();
  value.brainResult.patches = [
    { op: "replace", path: "items.line-a.qty", valueText: null, valueNumber: 3 },
  ];
  const result = adaptBrainDecisionToDraft(value);
  assert.equal(result.draft.items[0].qty, 3);
  assert.equal(result.draft.items[0].amount, 2000);

  const unknown = editInput();
  unknown.brainResult.patches = [
    { op: "replace", path: "items.missing.qty", valueText: null, valueNumber: 3 },
  ];
  assert.equal(adaptBrainDecisionToDraft(unknown).reason, "unknown_line_reference");
  const index = editInput();
  index.brainResult.patches = [
    { op: "replace", path: "items.0.qty", valueText: null, valueNumber: 3 },
  ];
  assert.equal(adaptBrainDecisionToDraft(index).reason, "unknown_line_reference");
});

test("rejects financial, prototype and partial patch paths", () => {
  for (const [path, reason] of [["finance.total", "unsafe_patch_path"],
    ["__proto__.polluted", "unsafe_patch_path"],
    ["items.line-a", "unsupported_patch"], ["client.name", "unsupported_patch"]]) {
    const value = editInput();
    value.brainResult.patches = [
      { op: "replace", path, valueText: "x", valueNumber: 1 },
    ];
    assert.equal(adaptBrainDecisionToDraft(value).reason, reason, path);
  }
});

test("clarify and confirm return no_change without a draft", () => {
  for (const intent of ["clarify", "confirm_document"]) {
    const value = input(intent, "facture");
    value.currentDraft = { type: "facture" };
    const result = adaptBrainDecisionToDraft(value);
    assert.equal(result.status, "no_change");
    assert.equal(result.adapted, false);
    assert.equal(result.reason, "no_draft_change");
    assert.equal(result.draft, null);
    assert.equal(result.metadata.requiresDeterministicFinance, false);
  }
});

test("accepts frozen input, returns independent output and is deterministic", () => {
  const value = input();
  Object.freeze(value.brainResult.document.items[0]);
  Object.freeze(value.brainResult.document.items);
  Object.freeze(value.brainResult.document);
  const first = adaptBrainDecisionToDraft(value);
  const second = adaptBrainDecisionToDraft(value);
  assert.deepEqual(first, second);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.draft, second.draft);
  first.draft.items[0].label = "changed";
  assert.equal(second.draft.items[0].label, "Chemise");
});
