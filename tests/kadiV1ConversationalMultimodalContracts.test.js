"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SCHEMA_VERSION,
  SOURCES,
  INTENTS,
  validateConversationalRequest,
  validateConversationalResult,
} = require("../kadiV1ConversationalMultimodalContracts");

function baseResult(overrides = {}) {
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
    provider_metadata: { provider: "KADI_CONVERSATIONAL_MULTIMODAL_V1", classifier: "DETERMINISTIC" },
    ...overrides,
  };
}

test("SOURCES et INTENTS couvrent exactement le vocabulaire de la mission", () => {
  assert.deepEqual([...SOURCES], ["TEXT", "AUDIO", "IMAGE", "DOCUMENT", "FLOW"]);
  assert.deepEqual([...INTENTS], [
    "CREATE_DOCUMENT", "UPDATE_DOCUMENT", "SEARCH_HISTORY", "CHECK_BALANCE", "RECHARGE", "CANCEL", "HELP", "UNKNOWN",
  ]);
});

test("une requête TEXT valide est acceptée", () => {
  const result = validateConversationalRequest({
    request_id: "req-1",
    source: "TEXT",
    text: "Fais une facture pour Moussa.",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.source, "TEXT");
});

test("une requête FLOW sans flow_reply est rejetée", () => {
  const result = validateConversationalRequest({ request_id: "req-2", source: "FLOW" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "CONVERSATIONAL_FLOW_REPLY_REQUIRED");
});

test("un champ inconnu dans la requête échoue fermé", () => {
  const result = validateConversationalRequest({ request_id: "req-3", source: "TEXT", text: "x", unknown_field: true });
  assert.equal(result.ok, false);
  assert.equal(result.error, "CONVERSATIONAL_REQUEST_INVALID");
});

test("un résultat valide passe la validation", () => {
  const result = validateConversationalResult(baseResult());
  assert.equal(result.ok, true);
  assert.equal(result.value.intent, "CREATE_DOCUMENT");
});

test("aucun champ d'autorité backend ne peut apparaître dans le résultat", () => {
  // These fields aren't in the allowed key set at all, so the outer
  // allowlist check rejects them first (CONVERSATIONAL_RESULT_INVALID);
  // the dedicated AUTHORITY_FORBIDDEN check is defense-in-depth for any
  // future key that might otherwise slip into RESULT_KEYS.
  for (const field of ["debit", "total", "issued_at", "document_number", "final_generation"]) {
    const result = validateConversationalResult(baseResult({ [field]: 1000 }));
    assert.equal(result.ok, false);
    assert.equal(result.error, "CONVERSATIONAL_RESULT_INVALID");
  }
});

test("un champ extrait qui est en réalité un champ d'autorité est rejeté", () => {
  const result = validateConversationalResult(baseResult({
    extracted_entities: { total: { value: 1000, status: "CONFIRMED" } },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "CONVERSATIONAL_EXTRACTED_FIELD_FORBIDDEN");
});

test("needs_confirmation doit être vrai si des champs sont ambigus", () => {
  const result = validateConversationalResult(baseResult({
    ambiguous_fields: ["amount"],
    needs_confirmation: false,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "CONVERSATIONAL_CONFIRMATION_REQUIRED");
});

test("needs_confirmation vrai exige un message utilisateur", () => {
  const result = validateConversationalResult(baseResult({
    ambiguous_fields: ["amount"],
    needs_confirmation: true,
    user_facing_message_draft: null,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "CONVERSATIONAL_CONFIRMATION_MESSAGE_REQUIRED");
});

test("operation n'est autorisé que pour UPDATE_DOCUMENT", () => {
  const result = validateConversationalResult(baseResult({ intent: "CREATE_DOCUMENT", operation: "CORRECT_FIELD" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "CONVERSATIONAL_OPERATION_REQUIRES_UPDATE_INTENT");
});

test("un schema_version incorrect échoue fermé", () => {
  const result = validateConversationalResult(baseResult({ schema_version: "2.0" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "CONVERSATIONAL_SCHEMA_VERSION_INVALID");
});

test("le provider_metadata ne peut jamais contenir de secret", () => {
  const result = validateConversationalResult(baseResult({
    provider_metadata: { provider: "X", model: "contains a bearer token" },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "CONVERSATIONAL_PROVENANCE_REQUIRED");
});

test("un type de document non supporté est rejeté", () => {
  const result = validateConversationalResult(baseResult({ document_type: "CONTRACT" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "CONVERSATIONAL_DOCUMENT_TYPE_INVALID");
});

// --- Authority-boundary attacks: aliases, nesting, casing ---

test("un champ d'autorité imbriqué dans la valeur d'un candidat est rejeté (pas seulement au premier niveau)", () => {
  const result = validateConversationalResult(baseResult({
    extracted_entities: {
      client: { value: { name: "Moussa", total: 999999999, debit: true }, status: "CONFIRMED", confidence: 0.9, source_reference: "text:0" },
    },
  }));
  assert.equal(result.ok, false, "une valeur imbriquée contenant des clés d'autorité doit être rejetée");
});

test("une clé d'autorité en casse différente n'est pas un contournement valide, elle est simplement inconnue et rejetée", () => {
  const result = validateConversationalResult(baseResult({ Total: 5000 }));
  assert.equal(result.ok, false);
});

test("un tableau d'articles avec une clé inconnue dans un item est rejeté", () => {
  const result = validateConversationalResult(baseResult({
    extracted_entities: {
      items: {
        value: [{ description: "Table", quantity: 1, unit_price: 10, total_line: 10, status: "CONFIRMED", confidence: 0.9, source_reference: "text:0" }],
        status: "CONFIRMED",
        confidence: 0.9,
        source_reference: "text:0",
      },
    },
  }));
  assert.equal(result.ok, false, "total_line n'est pas une clé d'article autorisée");
});

test("provider_metadata utilise une liste fermée : une clé inconnue est rejetée même sans motif de secret", () => {
  const result = validateConversationalResult(baseResult({
    provider_metadata: { provider: "X", access_token: "not-a-recognizable-secret-pattern-but-still-unknown" },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "CONVERSATIONAL_PROVENANCE_REQUIRED");
});

test("une valeur d'intent inconnue échoue fermé", () => {
  const result = validateConversationalResult(baseResult({ intent: "DELETE_EVERYTHING" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "CONVERSATIONAL_INTENT_INVALID");
});

test("une valeur de langue inconnue échoue fermé", () => {
  const result = validateConversationalResult(baseResult({ language: "de" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "CONVERSATIONAL_LANGUAGE_INVALID");
});

test("une valeur d'operation inconnue échoue fermé", () => {
  const result = validateConversationalResult(baseResult({ intent: "UPDATE_DOCUMENT", operation: "DELETE_DOCUMENT" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "CONVERSATIONAL_OPERATION_INVALID");
});

test("une valeur candidate profondément imbriquée au-delà de la profondeur autorisée est rejetée", () => {
  const result = validateConversationalResult(baseResult({
    extracted_entities: {
      client: { value: { name: { label: { value: { type: "trop profond" } } } }, status: "CONFIRMED", confidence: 0.9, source_reference: "text:0" },
    },
  }));
  assert.equal(result.ok, false);
});
