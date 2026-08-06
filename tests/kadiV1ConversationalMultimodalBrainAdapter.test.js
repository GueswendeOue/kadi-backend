"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateBrainResult } = require("../kadiV1BrainContracts");
const { SCHEMA_VERSION } = require("../kadiV1ConversationalMultimodalContracts");
const { conversationalResultToBrainResult } = require("../kadiV1ConversationalMultimodalBrainAdapter");

function candidate(value, status = "CONFIRMED", confidence = 0.9) {
  return { value, status, confidence, source_reference: "text:0" };
}

function envelope(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    intent: "CREATE_DOCUMENT",
    document_type: "FACTURE",
    operation: null,
    language: "fr",
    extracted_entities: {},
    requested_corrections: [],
    missing_fields: [],
    ambiguous_fields: [],
    needs_confirmation: false,
    confidence: 0.9,
    user_facing_message_draft: null,
    provider_metadata: { provider: "KADI_CONVERSATIONAL_MULTIMODAL_V1", classifier: "BRAIN", model: "OPENAI" },
    ...overrides,
  };
}

test("un résultat conversationnel valide devient un résultat Brain valide, accepté indépendamment par validateBrainResult", () => {
  const result = conversationalResultToBrainResult(envelope({
    extracted_entities: { client: candidate({ name: "Moussa" }) },
    missing_fields: ["items"],
    needs_confirmation: true,
    user_facing_message_draft: "Quel produit ou service faut-il ajouter ?",
  }));
  assert.equal(result.ok, true);
  assert.equal(validateBrainResult(result.value).ok, true, "la sortie doit être indépendamment acceptée par validateBrainResult");
  assert.equal(result.value.intent, "CREATE_DOCUMENT");
  assert.equal(result.value.document_type, "FACTURE");
  assert.equal(result.value.extracted_fields.client.value.name, "Moussa");
});

test("un champ inconnu ou d'autorité n'est jamais transmis silencieusement", () => {
  // extracted_entities cannot literally contain an authority field (the
  // envelope contract itself already rejects that upstream) — this proves
  // the adapter's own mapping is also a closed allowlist, not a blind
  // spread, as defense-in-depth independent of that upstream check.
  const dirty = envelope({ extracted_entities: { client: candidate({ name: "Moussa" }) } });
  Object.prototype.polluted = candidate("x"); // simulate prototype pollution from elsewhere
  try {
    const result = conversationalResultToBrainResult(dirty);
    assert.equal(result.ok, true);
    assert.equal(Object.hasOwn(result.value.extracted_fields, "polluted"), false, "un champ hérité du prototype ne doit jamais devenir une propriété propre transmise");
  } finally {
    delete Object.prototype.polluted;
  }
});

test("operation CORRECT_FIELD et ADD_ITEM sont acceptés ; REMOVE_ITEM et CHANGE_DOCUMENT_TYPE sont rejetés fermé (non supportés par documents.apply en un seul appel)", () => {
  const correct = conversationalResultToBrainResult(envelope({
    intent: "UPDATE_DOCUMENT", operation: "CORRECT_FIELD",
    extracted_entities: { amount: candidate(35000) },
  }));
  assert.equal(correct.ok, true);

  const add = conversationalResultToBrainResult(envelope({
    intent: "UPDATE_DOCUMENT", operation: "ADD_ITEM",
    extracted_entities: { items: candidate([{ description: "chaises", quantity: 2, unit_price: 12500 }]) },
  }));
  assert.equal(add.ok, true);

  const remove = conversationalResultToBrainResult(envelope({ intent: "UPDATE_DOCUMENT", operation: "REMOVE_ITEM" }));
  assert.equal(remove.ok, false);
  assert.equal(remove.error, "CONVERSATIONAL_OPERATION_NOT_SUPPORTED_BY_DRAFT_APPLICATION");

  const changeType = conversationalResultToBrainResult(envelope({ intent: "UPDATE_DOCUMENT", operation: "CHANGE_DOCUMENT_TYPE", document_type: "DEVIS" }));
  assert.equal(changeType.ok, false);
  assert.equal(changeType.error, "CONVERSATIONAL_OPERATION_NOT_SUPPORTED_BY_DRAFT_APPLICATION");
});

test("un intent non mutant (CHECK_BALANCE, RECHARGE, CANCEL, HELP, SEARCH_HISTORY, UNKNOWN) est rejeté : cet adaptateur ne sert qu'à CREATE/UPDATE_DOCUMENT", () => {
  for (const intent of ["CHECK_BALANCE", "RECHARGE", "CANCEL", "HELP", "SEARCH_HISTORY", "UNKNOWN"]) {
    const result = conversationalResultToBrainResult(envelope({ intent, document_type: null }));
    assert.equal(result.ok, false, `${intent} ne doit jamais atteindre documents.apply`);
    assert.equal(result.error, "CONVERSATIONAL_TO_BRAIN_INTENT_NOT_MUTATING");
  }
});

test("aucun champ d'autorité (total, debit, issued_at, document_number, final_generation...) ne peut être produit", () => {
  const result = conversationalResultToBrainResult(envelope({
    extracted_entities: { client: candidate({ name: "Moussa" }) },
  }));
  assert.equal(result.ok, true);
  for (const field of ["debit", "credit_debit", "payment_confirmed", "final_generation", "generate_final", "issued_at", "document_number", "subtotal", "total", "final_total", "delivery", "delivered"]) {
    assert.ok(!(field in result.value), `${field} ne doit jamais apparaître`);
    assert.ok(!(field in result.value.extracted_fields), `${field} ne doit jamais apparaître dans extracted_fields`);
  }
});

test("un envelope invalide (échoue validateConversationalResult) n'atteint jamais documents.apply", () => {
  const result = conversationalResultToBrainResult({ intent: "NOT_A_REAL_INTENT" });
  assert.equal(result.ok, false);
});

test("les champs ambigus deviennent des uncertainties Brain, et sont inclus dans missing_fields (contrainte exigée par validateBrainResult)", () => {
  const result = conversationalResultToBrainResult(envelope({
    extracted_entities: { amount: candidate(35000, "UNCERTAIN", 0.4) },
    ambiguous_fields: ["amount"],
    missing_fields: [],
    needs_confirmation: true,
    confidence: 0.4,
    user_facing_message_draft: "Le montant est-il bien 35 000 ?",
  }));
  assert.equal(result.ok, true);
  assert.ok(result.value.missing_fields.includes("amount"));
  assert.ok(result.value.uncertainties.some((u) => u.field === "amount"));
});

test("provider_metadata est réécrit dans la forme fermée attendue par Brain (sans 'classifier')", () => {
  const result = conversationalResultToBrainResult(envelope({
    extracted_entities: { client: candidate({ name: "Moussa" }) },
    provider_metadata: { provider: "KADI_CONVERSATIONAL_MULTIMODAL_V1", classifier: "BRAIN", model: "OPENAI" },
  }));
  assert.equal(result.ok, true);
  assert.equal("classifier" in result.value.provider_metadata, false);
  assert.equal(result.value.provider_metadata.model, "OPENAI");
});
