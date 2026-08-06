"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyDeterministicIntent,
  detectDocumentTypeHint,
  detectLanguage,
  interpretConversationalInput,
  validateCanonicalResponseText,
} = require("../kadiV1ConversationalMultimodalPolicy");
const { validateConversationalResult } = require("../kadiV1ConversationalMultimodalContracts");
const { KadiBrainError } = require("../kadiV1Brain");
const { detectNaturalIntent } = require("../kadiV1ConversationOrchestrator");

function candidate(value, status = "CONFIRMED", confidence = 0.9) {
  return { value, status, confidence, source_reference: "text:0" };
}

function mockBrain(understand) {
  return { understand };
}

function assertValidEnvelope(result) {
  const checked = validateConversationalResult(result);
  assert.equal(checked.ok, true, `résultat invalide: ${checked.error}`);
  return checked.value;
}

// --- Deterministic fast path: no provider call needed ---

test("Annule tout -> CANCEL sans appel provider", () => {
  const result = classifyDeterministicIntent("Annule tout", "fr");
  assert.equal(result.intent, "CANCEL");
  assert.equal(result.needs_confirmation, true);
  assertValidEnvelope(result);
});

test("Je ne sais pas quel document utiliser -> UNKNOWN avec ambiguïté sur document_type", () => {
  const result = classifyDeterministicIntent("Je ne sais pas quel document utiliser.", "fr");
  assert.equal(result.intent, "UNKNOWN");
  assert.deepEqual(result.ambiguous_fields, ["document_type"]);
  assert.equal(result.needs_confirmation, true);
  assertValidEnvelope(result);
});

test("solde -> CHECK_BALANCE, recharge -> RECHARGE, aide -> HELP, retrouve -> SEARCH_HISTORY", () => {
  assert.equal(classifyDeterministicIntent("Quel est mon solde ?", "fr").intent, "CHECK_BALANCE");
  assert.equal(classifyDeterministicIntent("Je veux recharger mon compte.", "fr").intent, "RECHARGE");
  assert.equal(classifyDeterministicIntent("J'ai besoin d'aide", "fr").intent, "HELP");
  assert.equal(classifyDeterministicIntent("Retrouve mon dernier document", "fr").intent, "SEARCH_HISTORY");
});

test("detectLanguage distingue le français de l'anglais", () => {
  assert.equal(detectLanguage("Fais une facture pour Moussa"), "fr");
  assert.equal(detectLanguage("Please cancel the invoice"), "en");
});

// --- Brain-backed path (mocked provider, no real API calls) ---

test("Fais une facture pour Moussa -> CREATE_DOCUMENT via brain mocké", async () => {
  const brain = mockBrain(async () => ({
    intent: "CREATE_DOCUMENT",
    document_type: "FACTURE",
    extracted_fields: { client: candidate({ name: "Moussa" }) },
    missing_fields: ["items"],
    uncertainties: [],
    confidence: 0.85,
    suggested_next_action: "ASK_TARGETED_QUESTION",
    user_facing_message_draft: "Quel produit ou service faut-il ajouter ?",
    provider_metadata: { provider: "OPENAI" },
  }));
  const result = await interpretConversationalInput({
    requestId: "req-a", source: "TEXT", text: "Fais une facture pour Moussa.", brain,
  });
  assert.equal(result.intent, "CREATE_DOCUMENT");
  assert.equal(result.document_type, "FACTURE");
  assert.deepEqual(result.missing_fields, ["items"]);
  assertValidEnvelope(result);
});

test("Fais un devis pour trois tables à 45 000 -> document_type DEVIS", async () => {
  const brain = mockBrain(async () => ({
    intent: "CREATE_DOCUMENT",
    document_type: "DEVIS",
    extracted_fields: { items: candidate([{ description: "tables", quantity: 3, unit_price: 45000 }]) },
    missing_fields: [],
    uncertainties: [],
    confidence: 0.9,
    suggested_next_action: "REVIEW_EXTRACTED_DATA",
    user_facing_message_draft: null,
    provider_metadata: { provider: "OPENAI" },
  }));
  const result = await interpretConversationalInput({
    requestId: "req-b", source: "TEXT", text: "Fais un devis pour trois tables à 45 000.", brain,
  });
  assert.equal(result.document_type, "DEVIS");
  assertValidEnvelope(result);
});

test("Change le montant à 35 000 sur un brouillon actif -> UPDATE_DOCUMENT / CORRECT_FIELD", async () => {
  const activeDocument = { document_type: "FACTURE", amount: 20000 };
  const brain = mockBrain(async () => ({
    intent: "UPDATE_DOCUMENT",
    document_type: "FACTURE",
    extracted_fields: { amount: candidate(35000) },
    missing_fields: [],
    uncertainties: [],
    confidence: 0.9,
    suggested_next_action: "REVIEW_EXTRACTED_DATA",
    user_facing_message_draft: null,
    provider_metadata: { provider: "OPENAI" },
  }));
  const result = await interpretConversationalInput({
    requestId: "req-c", source: "TEXT", text: "Change le montant à 35 000.", activeDocument, brain,
  });
  assert.equal(result.intent, "UPDATE_DOCUMENT");
  assert.equal(result.operation, "CORRECT_FIELD");
  assert.equal(result.requested_corrections.length, 1);
  assert.equal(result.requested_corrections[0].field, "amount");
  assertValidEnvelope(result);
});

test("Ce n'est pas Moussa, c'est Ousmane -> correction du champ client réutilisée, pas redemandée", async () => {
  const activeDocument = { document_type: "FACTURE", client: { name: "Moussa" } };
  const brain = mockBrain(async (request) => {
    assert.equal(request.collected_data.client.name, "Moussa", "les données déjà connues doivent être transmises au provider");
    return {
      intent: "UPDATE_DOCUMENT",
      document_type: "FACTURE",
      extracted_fields: { client: candidate({ name: "Ousmane" }) },
      missing_fields: [],
      uncertainties: [],
      confidence: 0.9,
      suggested_next_action: "REVIEW_EXTRACTED_DATA",
      user_facing_message_draft: null,
      provider_metadata: { provider: "OPENAI" },
    };
  });
  const result = await interpretConversationalInput({
    requestId: "req-d", source: "TEXT", text: "Ce n'est pas Moussa, c'est Ousmane.", activeDocument, brain,
  });
  assert.equal(result.operation, "CORRECT_FIELD");
  assert.equal(result.requested_corrections[0].field, "client");
});

test("Enlève la livraison -> operation REMOVE_ITEM détectée depuis le texte", async () => {
  const activeDocument = { document_type: "FACTURE" };
  const brain = mockBrain(async () => ({
    intent: "UPDATE_DOCUMENT",
    document_type: "FACTURE",
    extracted_fields: {},
    missing_fields: [],
    uncertainties: [],
    confidence: 0.9,
    suggested_next_action: "REVIEW_EXTRACTED_DATA",
    user_facing_message_draft: null,
    provider_metadata: { provider: "OPENAI" },
  }));
  const result = await interpretConversationalInput({
    requestId: "req-e", source: "TEXT", text: "Enlève la livraison.", activeDocument, brain,
  });
  assert.equal(result.operation, "REMOVE_ITEM");
});

test("Ajoute deux chaises à 12 500 -> operation ADD_ITEM détectée depuis le texte", async () => {
  const activeDocument = { document_type: "FACTURE" };
  const brain = mockBrain(async () => ({
    intent: "UPDATE_DOCUMENT",
    document_type: "FACTURE",
    extracted_fields: { items: candidate([{ description: "chaises", quantity: 2, unit_price: 12500 }]) },
    missing_fields: [],
    uncertainties: [],
    confidence: 0.9,
    suggested_next_action: "REVIEW_EXTRACTED_DATA",
    user_facing_message_draft: null,
    provider_metadata: { provider: "OPENAI" },
  }));
  const result = await interpretConversationalInput({
    requestId: "req-f", source: "TEXT", text: "Ajoute deux chaises à 12 500.", activeDocument, brain,
  });
  assert.equal(result.operation, "ADD_ITEM");
});

test("Fais plutôt un devis -> CHANGE_DOCUMENT_TYPE quand un document actif diffère", async () => {
  const activeDocument = { document_type: "FACTURE" };
  const brain = mockBrain(async () => ({
    intent: "UPDATE_DOCUMENT",
    document_type: "DEVIS",
    extracted_fields: {},
    missing_fields: [],
    uncertainties: [],
    confidence: 0.9,
    suggested_next_action: "REVIEW_EXTRACTED_DATA",
    user_facing_message_draft: null,
    provider_metadata: { provider: "OPENAI" },
  }));
  const result = await interpretConversationalInput({
    requestId: "req-g", source: "TEXT", text: "Fais plutôt un devis.", activeDocument, brain,
  });
  assert.equal(result.operation, "CHANGE_DOCUMENT_TYPE");
});

test("un montant absent n'est jamais inventé : uncertainty absente -> champ manquant, pas de valeur", async () => {
  const brain = mockBrain(async () => ({
    intent: "CREATE_DOCUMENT",
    document_type: "RECU",
    extracted_fields: { payer: candidate({ name: "Adama" }) },
    missing_fields: ["amount"],
    uncertainties: [],
    confidence: 0.8,
    suggested_next_action: "ASK_TARGETED_QUESTION",
    user_facing_message_draft: "Quel est le montant exact ?",
    provider_metadata: { provider: "OPENAI" },
  }));
  const result = await interpretConversationalInput({
    requestId: "req-h", source: "TEXT", text: "Reçu de Adama pour acompte peinture.", brain,
  });
  assert.ok(!("amount" in result.extracted_entities), "un montant non fourni ne doit jamais être inventé");
  assert.deepEqual(result.missing_fields, ["amount"]);
});

test("une information ambiguë exige confirmation, jamais une décision silencieuse", async () => {
  const brain = mockBrain(async () => ({
    intent: "UPDATE_DOCUMENT",
    document_type: "FACTURE",
    extracted_fields: { amount: candidate(35000, "UNCERTAIN", 0.4) },
    missing_fields: ["amount"],
    uncertainties: [{ field: "amount", reason: "LOW_CONFIDENCE", confidence: 0.4, source_reference: "text:0" }],
    confidence: 0.4,
    suggested_next_action: "ASK_TARGETED_QUESTION",
    user_facing_message_draft: "Le montant est-il bien 35 000 ?",
    provider_metadata: { provider: "OPENAI" },
  }));
  const result = await interpretConversationalInput({ requestId: "req-i", source: "TEXT", text: "Peut-être 35 000.", brain });
  assert.equal(result.needs_confirmation, true);
  assert.deepEqual(result.ambiguous_fields, ["amount"]);
  assertValidEnvelope(result);
});

test("un document_type non supporté renvoyé par le provider échoue proprement", async () => {
  const brain = mockBrain(async () => {
    throw new KadiBrainError("BRAIN_DOCUMENT_TYPE_INVALID");
  });
  await assert.rejects(
    interpretConversationalInput({ requestId: "req-j", source: "TEXT", text: "Fais un contrat pour Awa.", brain }),
    (error) => error.code === "BRAIN_DOCUMENT_TYPE_INVALID"
  );
});

test("une sortie provider malformée est rejetée plutôt que propagée telle quelle", async () => {
  const brain = mockBrain(async () => ({ not_a_valid_shape: true }));
  await assert.rejects(interpretConversationalInput({ requestId: "req-k", source: "TEXT", text: "Fais une facture.", brain }));
});

test("un timeout provider se propage comme une erreur récupérable, sans halluciner de résultat", async () => {
  const brain = mockBrain(async () => { throw new KadiBrainError("PROVIDER_TIMEOUT"); });
  await assert.rejects(
    interpretConversationalInput({ requestId: "req-l", source: "TEXT", text: "Fais une facture.", brain }),
    (error) => error.code === "PROVIDER_TIMEOUT"
  );
});

test("un refus/erreur provider se propage sans texte de succès fabriqué", async () => {
  const brain = mockBrain(async () => { throw new KadiBrainError("BRAIN_PROVIDER_FAILED"); });
  await assert.rejects(
    interpretConversationalInput({ requestId: "req-m", source: "TEXT", text: "Fais une facture.", brain }),
    (error) => error.code === "BRAIN_PROVIDER_FAILED"
  );
});

test("aucun champ d'autorité (débit, total, finalisation) n'est jamais produit par ce module", async () => {
  const brain = mockBrain(async () => ({
    intent: "CREATE_DOCUMENT",
    document_type: "FACTURE",
    extracted_fields: { client: candidate({ name: "Moussa" }) },
    missing_fields: [],
    uncertainties: [],
    confidence: 0.9,
    suggested_next_action: "REVIEW_EXTRACTED_DATA",
    user_facing_message_draft: null,
    provider_metadata: { provider: "OPENAI" },
  }));
  const result = await interpretConversationalInput({ requestId: "req-n", source: "TEXT", text: "Fais une facture pour Moussa.", brain });
  for (const field of ["debit", "total", "issued_at", "document_number", "final_generation", "generate_final"]) {
    assert.ok(!(field in result), `le champ d'autorité ${field} ne doit jamais apparaître ici`);
  }
});

test("aucun secret ou payload brut n'apparaît dans provider_metadata", async () => {
  const brain = mockBrain(async () => ({
    intent: "CREATE_DOCUMENT",
    document_type: "FACTURE",
    extracted_fields: {},
    missing_fields: ["client"],
    uncertainties: [],
    confidence: 0.7,
    suggested_next_action: "ASK_TARGETED_QUESTION",
    user_facing_message_draft: "Quel est le nom du client ?",
    provider_metadata: { provider: "OPENAI" },
  }));
  const result = await interpretConversationalInput({ requestId: "req-o", source: "TEXT", text: "Fais une facture.", brain });
  const serialized = JSON.stringify(result.provider_metadata);
  assert.ok(!/sk-|bearer|authorization/i.test(serialized));
});

test("English input is accepted and detected as such", async () => {
  const brain = mockBrain(async () => ({
    intent: "CREATE_DOCUMENT",
    document_type: "FACTURE",
    extracted_fields: {},
    missing_fields: ["client"],
    uncertainties: [],
    confidence: 0.7,
    suggested_next_action: "ASK_TARGETED_QUESTION",
    user_facing_message_draft: "What is the client's name?",
    provider_metadata: { provider: "OPENAI" },
  }));
  const result = await interpretConversationalInput({ requestId: "req-p", source: "TEXT", text: "Please make an invoice.", brain });
  assert.equal(result.language, "en");
  assertValidEnvelope(result);
});

test("interpretConversationalInput valide sa propre sortie et ne fait pas confiance aveuglément à un brain non conforme (Phase 2 : \"validated before it is allowed to affect a document draft\")", async () => {
  const misbehavingBrain = { understand: async () => ({
    intent: "CREATE_DOCUMENT",
    document_type: "facture", // minuscule : invalide face à l'énumération canonique
    extracted_fields: {},
    missing_fields: [], uncertainties: [], confidence: 0.9,
    suggested_next_action: "REVIEW_EXTRACTED_DATA", user_facing_message_draft: null,
    provider_metadata: { provider: "OPENAI" },
  })};
  const result = await interpretConversationalInput({ requestId: "req-r2", source: "TEXT", text: "Fais une facture.", brain: misbehavingBrain });
  assert.equal(result.document_type, "FACTURE", "la sortie doit être normalisée par le contrat, jamais renvoyée telle quelle depuis un brain non conforme");
});

test("interpretConversationalInput échoue fermé si un brain renvoie quelque chose que le contrat rejette réellement", async () => {
  const brokenBrain = { understand: async () => ({
    intent: "CREATE_DOCUMENT",
    document_type: "CONTRACT", // n'existe pas dans l'énumération canonique
    extracted_fields: {},
    missing_fields: [], uncertainties: [], confidence: 0.9,
    suggested_next_action: "REVIEW_EXTRACTED_DATA", user_facing_message_draft: null,
    provider_metadata: { provider: "OPENAI" },
  })};
  await assert.rejects(
    interpretConversationalInput({ requestId: "req-r3", source: "TEXT", text: "Fais une facture.", brain: brokenBrain }),
    (error) => /CONVERSATIONAL_DOCUMENT_TYPE_INVALID/.test(error.message || error.code || "")
  );
});

test("une entrée FLOW ne fabrique pas une opération non vérifiée et ne débloque jamais needs_confirmation à tort", async () => {
  const brain = mockBrain(async () => { throw new Error("le cerveau ne doit jamais être appelé pour une entrée FLOW"); });
  const result = await interpretConversationalInput({
    requestId: "req-r",
    source: "FLOW",
    flowReply: { flow_key: "EDIT_CLIENT", action: "SAVE_CLIENT", data: { client_name: "Moussa" } },
    brain,
  });
  assert.equal(result.intent, "UPDATE_DOCUMENT");
  assert.equal(result.operation, null, "l'opération réelle n'est pas déterminée ici ; ne pas inventer CORRECT_FIELD sans preuve");
  assertValidEnvelope(result);
});

test("interpret exige un brain valide", async () => {
  await assert.rejects(
    interpretConversationalInput({ requestId: "req-q", source: "TEXT", text: "x", brain: null }),
    /KADI_CONVERSATIONAL_MULTIMODAL_BRAIN_REQUIRED/
  );
});

// --- Phase 7: conversation policy ---

test("un texte court et naturel passe la politique de conversation", () => {
  const result = validateCanonicalResponseText("Bien sûr. Quel est le nom du client ?");
  assert.equal(result.ok, true);
});

test("un nom de fournisseur exposé à l'utilisateur est rejeté (via kadiV1ConversationOrchestrator.validateCanonicalText réutilisé)", () => {
  const result = validateCanonicalResponseText("OpenAI a compris votre demande.");
  assert.equal(result.ok, false);
  assert.equal(result.error, "CONVERSATION_POLICY_INTERNAL_TERM_EXPOSED");
});

test("un terme technique interne exposé à l'utilisateur est rejeté", () => {
  const result = validateCanonicalResponseText("Votre payload a été reçu.");
  assert.equal(result.ok, false);
  assert.equal(result.error, "CONVERSATION_POLICY_INTERNAL_TERM_EXPOSED");
});

test("plus d'une question dans un même message est rejeté", () => {
  const result = validateCanonicalResponseText("Quel est le client ? Quel est le montant ?");
  assert.equal(result.ok, false);
  assert.equal(result.error, "CONVERSATION_POLICY_MULTIPLE_QUESTIONS");
});

test("un texte trop long est rejeté", () => {
  const result = validateCanonicalResponseText("a".repeat(800));
  assert.equal(result.ok, false);
  assert.equal(result.error, "CONVERSATION_POLICY_TEXT_TOO_LONG");
});

// --- Intent-classifier parity with the live orchestrator's detectNaturalIntent ---
// These prove the fast path genuinely reuses the live classifier rather than
// a second, independently-tuned copy that could silently diverge from what
// actually serves CANARY traffic.

test("parité CANCEL : le même texte produit le même verdict des deux côtés", () => {
  const text = "Annule tout";
  assert.equal(detectNaturalIntent(text).intent, "CANCEL");
  assert.equal(classifyDeterministicIntent(text, "fr").intent, "CANCEL");
});

test("parité HELP : le même texte produit le même verdict des deux côtés", () => {
  const text = "J'ai besoin d'aide";
  assert.equal(detectNaturalIntent(text).intent, "HELP");
  assert.equal(classifyDeterministicIntent(text, "fr").intent, "HELP");
});

test("parité CHECK_BALANCE (BALANCE côté orchestrateur) : le même texte produit le même verdict des deux côtés", () => {
  const text = "Quel est mon solde ?";
  assert.equal(detectNaturalIntent(text).intent, "BALANCE");
  assert.equal(classifyDeterministicIntent(text, "fr").intent, "CHECK_BALANCE");
});

test("parité SEARCH_HISTORY (HISTORY_SEARCH côté orchestrateur) : le même texte produit le même verdict des deux côtés", () => {
  const text = "Retrouve mon dernier document";
  assert.equal(detectNaturalIntent(text).intent, "HISTORY_SEARCH");
  assert.equal(classifyDeterministicIntent(text, "fr").intent, "SEARCH_HISTORY");
});

test("parité CREATE_DOCUMENT : le type de document détecté par l'orchestrateur est repris comme indice, sans court-circuiter l'extraction", () => {
  const text = "Fais une facture pour Moussa.";
  assert.equal(detectNaturalIntent(text).intent, "PREPARE_DOCUMENT");
  assert.equal(detectNaturalIntent(text).document_type, "FACTURE");
  // Le classificateur déterministe ne court-circuite pas CREATE_DOCUMENT :
  // il retourne null pour laisser passer au cerveau, qui extraira "Moussa".
  assert.equal(classifyDeterministicIntent(text, "fr"), null);
  assert.equal(detectDocumentTypeHint(text), "FACTURE");
});

test("parité UPDATE_DOCUMENT : aucun texte ne déclenche PREPARE_DOCUMENT côté orchestrateur sans mot-clé de document, donc aucun des deux ne classe en dur", () => {
  const text = "Change le montant à 35 000.";
  assert.equal(detectNaturalIntent(text).intent, "CONTINUE");
  assert.equal(classifyDeterministicIntent(text, "fr"), null);
});

test("MENU côté orchestrateur ne correspond à aucun intent de cette mission et retombe sur le cerveau plutôt que d'être deviné", () => {
  const text = "menu";
  assert.equal(detectNaturalIntent(text).intent, "MENU");
  assert.equal(classifyDeterministicIntent(text, "fr"), null);
});

// interpretForDraftApplication was removed: the orchestrator integration now
// goes through interpretConversationalInput's envelope +
// kadiV1ConversationalMultimodalBrainAdapter.js's
// conversationalResultToBrainResult (see
// tests/kadiV1ConversationalMultimodalBrainAdapter.test.js and
// tests/kadiV1ConversationalMultimodalRuntimeAdapter.test.js), not a second
// return shape from this module.
