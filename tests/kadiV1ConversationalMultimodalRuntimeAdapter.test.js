"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateBrainResult } = require("../kadiV1BrainContracts");
const { KadiBrainError } = require("../kadiV1Brain");
const {
  createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter,
} = require("../kadiV1ConversationalMultimodalRuntimeAdapter");

function candidate(value, status = "CONFIRMED", confidence = 0.9) {
  return { value, status, confidence, source_reference: "text:0" };
}

function makeFallback(calls) {
  return {
    interpret: async (command) => {
      calls.push(command);
      return { ok: true, value: { intent: "CONTINUE", document_type: null, brain_result: null } };
    },
  };
}

function makeBrain(understand) {
  return { understand };
}

test("propriétaire non éligible -> délégation exacte au fallback, aucun appel brain", async () => {
  const fallbackCalls = [];
  const fallback = makeFallback(fallbackCalls);
  const brain = makeBrain(async () => { throw new Error("ne doit jamais être appelé"); });
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => false,
  });
  const command = { ownerWaId: "22670000000", inputType: "TEXT", text: "Fais une facture pour Moussa.", correlationId: "c1" };
  const result = await adapter.interpret(command);
  assert.equal(result.ok, true);
  assert.equal(result.value.intent, "CONTINUE");
  assert.equal(fallbackCalls.length, 1);
  assert.equal(fallbackCalls[0], command);
});

test("FLOW_REPLY délègue toujours au fallback, même pour un propriétaire éligible", async () => {
  const fallbackCalls = [];
  const fallback = makeFallback(fallbackCalls);
  const brain = makeBrain(async () => { throw new Error("ne doit jamais être appelé"); });
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
  });
  const result = await adapter.interpret({ ownerWaId: "22670000000", inputType: "FLOW_REPLY", flowReply: { flow_key: "X" }, correlationId: "c2" });
  assert.equal(result.ok, true);
  assert.equal(fallbackCalls.length, 1);
});

test("propriétaire éligible, CREATE_DOCUMENT -> intent PREPARE_DOCUMENT avec le brainResult original valide", async () => {
  const fallback = makeFallback([]);
  const rawBrainResult = {
    intent: "CREATE_DOCUMENT", document_type: "FACTURE",
    extracted_fields: { client: candidate({ name: "Moussa" }) },
    missing_fields: ["items"], uncertainties: [], confidence: 0.85,
    suggested_next_action: "ASK_TARGETED_QUESTION", user_facing_message_draft: "Quel produit ?",
    provider_metadata: { provider: "OPENAI" },
  };
  const brain = makeBrain(async () => rawBrainResult);
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
  });
  const result = await adapter.interpret({ ownerWaId: "22670000000", inputType: "TEXT", text: "Fais une facture pour Moussa.", correlationId: "c3" });
  assert.equal(result.ok, true);
  assert.equal(result.value.intent, "PREPARE_DOCUMENT");
  assert.equal(result.value.document_type, "FACTURE");
  assert.equal(result.value.brain_result.extracted_fields.client.value.name, "Moussa");
  assert.equal(validateBrainResult(result.value.brain_result).ok, true, "le brainResult transmis à documents.apply(...) doit être indépendamment valide");
});

test("propriétaire éligible, UPDATE_DOCUMENT sur un brouillon actif -> intent CONTINUE avec brainResult, réutilise l'application existante", async () => {
  const fallback = makeFallback([]);
  const rawBrainResult = {
    intent: "UPDATE_DOCUMENT", document_type: "FACTURE",
    extracted_fields: { amount: candidate(35000) },
    missing_fields: [], uncertainties: [], confidence: 0.9,
    suggested_next_action: "REVIEW_EXTRACTED_DATA", user_facing_message_draft: null,
    provider_metadata: { provider: "OPENAI" },
  };
  const brain = makeBrain(async () => rawBrainResult);
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
  });
  const activeDocument = { document_type: "FACTURE", amount: 20000 };
  const result = await adapter.interpret({
    ownerWaId: "22670000000", inputType: "TEXT", text: "Change le montant à 35 000.", activeDocument, correlationId: "c4",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.intent, "CONTINUE");
  assert.equal(result.value.brain_result.extracted_fields.amount.value, 35000);
  assert.equal(validateBrainResult(result.value.brain_result).ok, true);
});

test("propriétaire éligible, RECHARGE -> intent RECHARGE sans mutation de document", async () => {
  const fallback = makeFallback([]);
  const brain = makeBrain(async () => { throw new Error("ne doit pas être appelé pour RECHARGE (voie déterministe)"); });
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
  });
  const result = await adapter.interpret({ ownerWaId: "22670000000", inputType: "TEXT", text: "Je veux recharger mon compte.", correlationId: "c5" });
  assert.equal(result.ok, true);
  assert.equal(result.value.intent, "RECHARGE");
  assert.equal(result.value.brain_result, null);
});

test("un intent déjà couvert par le chemin déterministe de l'orchestrateur (CANCEL) ne produit jamais de mutation ici", async () => {
  const fallback = makeFallback([]);
  const brain = makeBrain(async () => { throw new Error("ne doit pas être appelé"); });
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
  });
  const result = await adapter.interpret({ ownerWaId: "22670000000", inputType: "TEXT", text: "Annule tout", correlationId: "c6" });
  assert.equal(result.ok, true);
  assert.equal(result.value.intent, "CONTINUE");
  assert.equal(result.value.brain_result, null);
});

test("une ambiguïté (quel document) renvoie une clarification sans inventer de document_type", async () => {
  const fallback = makeFallback([]);
  const brain = makeBrain(async () => { throw new Error("ne doit pas être appelé (voie déterministe)"); });
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
  });
  const result = await adapter.interpret({ ownerWaId: "22670000000", inputType: "TEXT", text: "Je ne sais pas quel document utiliser.", correlationId: "c7" });
  assert.equal(result.ok, true);
  assert.equal(result.value.intent, "CONTINUE");
  assert.equal(result.value.document_type, null);
  assert.ok(typeof result.value.clarification === "string" && result.value.clarification.length > 0);
});

test("un timeout/refus du brain échoue proprement (ok:false), sans halluciner de résultat", async () => {
  const fallback = makeFallback([]);
  const brain = makeBrain(async () => { throw new KadiBrainError("BRAIN_PROVIDER_TIMEOUT"); });
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
  });
  const result = await adapter.interpret({ ownerWaId: "22670000000", inputType: "TEXT", text: "Fais une facture.", correlationId: "c8" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "BRAIN_PROVIDER_TIMEOUT");
});

test("une sortie provider malformée échoue proprement (ok:false)", async () => {
  const fallback = makeFallback([]);
  const brain = makeBrain(async () => ({ not_a_valid_shape: true }));
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
  });
  const result = await adapter.interpret({ ownerWaId: "22670000000", inputType: "TEXT", text: "Fais une facture.", correlationId: "c9" });
  assert.equal(result.ok, false);
});

test("les constructeurs exigent un brain, un fallback et une porte valides", () => {
  assert.throws(() => createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({}), /KADI_V1_BRAIN_REQUIRED/);
  assert.throws(
    () => createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({ brain: makeBrain(async () => ({})) }),
    /KADI_V1_INTERPRETATION_RUNTIME_REQUIRED/
  );
  assert.throws(
    () => createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
      brain: makeBrain(async () => ({})), fallback: makeFallback([]),
    }),
    /KADI_V1_CONVERSATIONAL_MULTIMODAL_GATE_REQUIRED/
  );
});

test("TRANSCRIPTION (sortie OPENAI_STT existante) entre dans le pipeline conversationnel, jamais Gemini Audio", async () => {
  const fallback = makeFallback([]);
  let receivedRequest = null;
  const rawBrainResult = {
    intent: "CREATE_DOCUMENT", document_type: "RECU",
    extracted_fields: { payer: candidate({ name: "Adama" }) },
    missing_fields: ["amount"], uncertainties: [], confidence: 0.8,
    suggested_next_action: "ASK_TARGETED_QUESTION", user_facing_message_draft: "Quel est le montant exact ?",
    provider_metadata: { provider: "OPENAI" },
  };
  const brain = makeBrain(async (request) => { receivedRequest = request; return rawBrainResult; });
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
  });
  const result = await adapter.interpret({
    ownerWaId: "22670000000", inputType: "TRANSCRIPTION",
    text: "Reçu de 50 000 reçu de Adama pour acompte peinture.", correlationId: "c10",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.intent, "PREPARE_DOCUMENT");
  assert.equal(receivedRequest.modality, "TRANSCRIPTION", "le texte déjà transcrit par OPENAI_STT entre tel quel, aucun second passage audio");
  assert.equal(receivedRequest.transcription, "Reçu de 50 000 reçu de Adama pour acompte peinture.");
  assert.ok(!("KADI_GEMINI_AUDIO" in receivedRequest) && JSON.stringify(receivedRequest).toLowerCase().includes("gemini") === false);
});

test("IMAGE réutilise l'extraction Gemini existante via le même brain, sans second appel Gemini", async () => {
  const fallback = makeFallback([]);
  let calls = 0;
  const media = { media_id: "m1", owner_ref: "o1" };
  const brain = makeBrain(async (request) => {
    calls += 1;
    assert.equal(request.modality, "IMAGE");
    assert.equal(request.media, media, "le même objet média doit être transmis, pas re-résolu");
    return {
      intent: "CREATE_DOCUMENT", document_type: "FACTURE", extracted_fields: {},
      missing_fields: ["client"], uncertainties: [], confidence: 0.7,
      suggested_next_action: "ASK_TARGETED_QUESTION", user_facing_message_draft: "Quel est le nom du client ?",
      provider_metadata: { provider: "GEMINI" },
    };
  });
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
  });
  const result = await adapter.interpret({ ownerWaId: "22670000000", inputType: "IMAGE", media, correlationId: "c11" });
  assert.equal(result.ok, true);
  assert.equal(calls, 1, "un seul appel au brain/Gemini pour cette image");
});

test("REMOVE_ITEM (non supporté par documents.apply en un seul appel) retombe sur CONTINUE sans mutation, jamais une erreur non gérée", async () => {
  const fallback = makeFallback([]);
  const rawBrainResult = {
    intent: "UPDATE_DOCUMENT", document_type: "FACTURE", extracted_fields: {},
    missing_fields: [], uncertainties: [], confidence: 0.9,
    suggested_next_action: "REVIEW_EXTRACTED_DATA", user_facing_message_draft: null,
    provider_metadata: { provider: "OPENAI" },
  };
  const brain = makeBrain(async () => rawBrainResult);
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
  });
  const activeDocument = { document_type: "FACTURE" };
  const result = await adapter.interpret({
    ownerWaId: "22670000000", inputType: "TEXT", text: "Enlève la livraison.", activeDocument, correlationId: "c12",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.intent, "CONTINUE");
  assert.equal(result.value.brain_result, null, "aucune mutation ne doit être tentée pour une opération non supportée par le port existant");
});

test("CHANGE_DOCUMENT_TYPE (FACTURE -> DEVIS) produit l'intent CHANGE_DOCUMENT_TYPE avec la cible exacte, jamais de brain_result", async () => {
  const fallback = makeFallback([]);
  const rawBrainResult = {
    intent: "UPDATE_DOCUMENT", document_type: "DEVIS", extracted_fields: {},
    missing_fields: [], uncertainties: [], confidence: 0.95,
    suggested_next_action: "REVIEW_EXTRACTED_DATA", user_facing_message_draft: null,
    provider_metadata: { provider: "OPENAI" },
  };
  const brain = makeBrain(async () => rawBrainResult);
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
  });
  const activeDocument = { document_type: "FACTURE" };
  const result = await adapter.interpret({
    ownerWaId: "22670000000", inputType: "TEXT", text: "En fait transforme ça en devis.", activeDocument, correlationId: "c17",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.intent, "CHANGE_DOCUMENT_TYPE");
  assert.equal(result.value.target_document_type, "DEVIS");
  assert.equal(result.value.brain_result, null, "aucune extraction non validée ne doit être appliquée au brouillon");
});

test("CHANGE_DOCUMENT_TYPE (DEVIS -> FACTURE) produit aussi l'intent CHANGE_DOCUMENT_TYPE", async () => {
  const fallback = makeFallback([]);
  const rawBrainResult = {
    intent: "UPDATE_DOCUMENT", document_type: "FACTURE", extracted_fields: {},
    missing_fields: [], uncertainties: [], confidence: 0.95,
    suggested_next_action: "REVIEW_EXTRACTED_DATA", user_facing_message_draft: null,
    provider_metadata: { provider: "OPENAI" },
  };
  const brain = makeBrain(async () => rawBrainResult);
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
  });
  const activeDocument = { document_type: "DEVIS" };
  const result = await adapter.interpret({
    ownerWaId: "22670000000", inputType: "TEXT", text: "Fais plutôt une facture.", activeDocument, correlationId: "c17b",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.intent, "CHANGE_DOCUMENT_TYPE");
  assert.equal(result.value.target_document_type, "FACTURE");
});

test("CHANGE_DOCUMENT_TYPE impliquant RECU échoue toujours fermé avec une clarification, jamais de mutation", async () => {
  const fallback = makeFallback([]);
  const rawBrainResult = {
    intent: "UPDATE_DOCUMENT", document_type: "RECU", extracted_fields: {},
    missing_fields: [], uncertainties: [], confidence: 0.95,
    suggested_next_action: "REVIEW_EXTRACTED_DATA", user_facing_message_draft: null,
    provider_metadata: { provider: "OPENAI" },
  };
  const brain = makeBrain(async () => rawBrainResult);
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
  });
  const activeDocument = { document_type: "FACTURE" };
  const result = await adapter.interpret({
    ownerWaId: "22670000000", inputType: "TEXT", text: "Fais plutôt un reçu.", activeDocument, correlationId: "c17c",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.intent, "CONTINUE");
  assert.equal(result.value.document_type, null);
  assert.equal(result.value.brain_result, null);
  assert.ok(typeof result.value.clarification === "string" && result.value.clarification.length > 0);
});

test("CHANGE_DOCUMENT_TYPE impliquant DECHARGE échoue toujours fermé avec une clarification, jamais de mutation", async () => {
  const fallback = makeFallback([]);
  const rawBrainResult = {
    intent: "UPDATE_DOCUMENT", document_type: "DECHARGE", extracted_fields: {},
    missing_fields: [], uncertainties: [], confidence: 0.95,
    suggested_next_action: "REVIEW_EXTRACTED_DATA", user_facing_message_draft: null,
    provider_metadata: { provider: "OPENAI" },
  };
  const brain = makeBrain(async () => rawBrainResult);
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
  });
  const activeDocument = { document_type: "DEVIS" };
  const result = await adapter.interpret({
    ownerWaId: "22670000000", inputType: "TEXT", text: "Fais plutôt une décharge.", activeDocument, correlationId: "c17d",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.intent, "CONTINUE");
  assert.ok(typeof result.value.clarification === "string" && result.value.clarification.length > 0);
});

test("REMOVE_ITEM avec correspondance unique -> intent REMOVE_ITEM avec le item_id existant, aucun appel à documents.apply", async () => {
  const fallback = makeFallback([]);
  const rawBrainResult = {
    intent: "UPDATE_DOCUMENT", document_type: "FACTURE", extracted_fields: {},
    missing_fields: [], uncertainties: [], confidence: 0.9,
    suggested_next_action: "REVIEW_EXTRACTED_DATA", user_facing_message_draft: null,
    provider_metadata: { provider: "OPENAI" },
  };
  const brain = makeBrain(async () => rawBrainResult);
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
  });
  const activeDocument = {
    document_type: "FACTURE",
    items: [
      { item_id: "item-1", description: "Livraison express" },
      { item_id: "item-2", description: "Table en bois" },
    ],
  };
  const result = await adapter.interpret({
    ownerWaId: "22670000000", inputType: "TEXT", text: "Enlève la livraison.", activeDocument, correlationId: "c13",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.intent, "REMOVE_ITEM");
  assert.equal(result.value.document_type, "FACTURE");
  assert.equal(result.value.remove_item_id, "item-1");
  assert.equal(result.value.brain_result, null);
});

test("CREATE_DOCUMENT dont le mapping vers Brain échoue retombe sur PREPARE_DOCUMENT (brouillon vide), jamais une simple clarification générique", async () => {
  const fallback = makeFallback([]);
  const rawBrainResult = {
    intent: "CREATE_DOCUMENT", document_type: "FACTURE",
    extracted_fields: { client: candidate({ name: "Moussa" }) },
    missing_fields: ["items"], uncertainties: [], confidence: 0.85,
    suggested_next_action: "ASK_TARGETED_QUESTION", user_facing_message_draft: "Quel produit ?",
    provider_metadata: { provider: "OPENAI" },
  };
  const brain = makeBrain(async () => rawBrainResult);
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
    conversationalResultToBrainResult: () => ({ ok: false, error: "CONVERSATIONAL_TO_BRAIN_MAPPING_TEST_FAILURE" }),
  });
  const result = await adapter.interpret({ ownerWaId: "22670000000", inputType: "TEXT", text: "Fais une facture pour Moussa.", correlationId: "c15" });
  assert.equal(result.ok, true);
  assert.equal(result.value.intent, "PREPARE_DOCUMENT", "un document_type connu et validé doit toujours démarrer le brouillon exact existant, pas une clarification générique");
  assert.equal(result.value.document_type, "FACTURE");
  assert.equal(result.value.brain_result, null, "aucune donnée extraite non validée ne doit être appliquée au brouillon");
});

test("UPDATE_DOCUMENT dont le mapping vers Brain échoue retombe sur une clarification, jamais sur PREPARE_DOCUMENT (pas de second brouillon)", async () => {
  const fallback = makeFallback([]);
  const rawBrainResult = {
    intent: "UPDATE_DOCUMENT", document_type: "FACTURE",
    extracted_fields: { amount: candidate(35000) },
    missing_fields: [], uncertainties: [], confidence: 0.9,
    suggested_next_action: "REVIEW_EXTRACTED_DATA", user_facing_message_draft: null,
    provider_metadata: { provider: "OPENAI" },
  };
  const brain = makeBrain(async () => rawBrainResult);
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
    conversationalResultToBrainResult: () => ({ ok: false, error: "CONVERSATIONAL_TO_BRAIN_MAPPING_TEST_FAILURE" }),
  });
  const activeDocument = { document_type: "FACTURE", amount: 20000 };
  const result = await adapter.interpret({
    ownerWaId: "22670000000", inputType: "TEXT", text: "Change le montant à 35 000.", activeDocument, correlationId: "c16",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.intent, "CONTINUE");
  assert.equal(result.value.brain_result, null);
});

test("observabilité : CREATE_DOCUMENT réussi émet result_validated et route_selected mais JAMAIS draft_applied depuis l'adaptateur, sans exposer le texte ou le wa_id", async () => {
  const fallback = makeFallback([]);
  const rawBrainResult = {
    intent: "CREATE_DOCUMENT", document_type: "FACTURE",
    extracted_fields: { client: candidate({ name: "Moussa" }) },
    missing_fields: ["items"], uncertainties: [], confidence: 0.85,
    suggested_next_action: "ASK_TARGETED_QUESTION", user_facing_message_draft: "Quel produit ?",
    provider_metadata: { provider: "OPENAI" },
  };
  const brain = makeBrain(async () => rawBrainResult);
  const events = [];
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
    logger: (event, details) => events.push({ event, details }),
  });
  const result = await adapter.interpret({
    ownerWaId: "22670000000", inputType: "TEXT", text: "Fais une facture pour Moussa, livraison 35000 FCFA.", correlationId: "c-obs-1",
  });
  assert.equal(result.ok, true);
  const names = events.map((entry) => entry.event);
  assert.deepEqual(names, ["conversational_result_validated", "conversational_route_selected"], "l'adaptateur n'a encore appelé aucun port de mutation : il ne doit jamais prétendre qu'un brouillon a été appliqué");
  for (const { details } of events) {
    const serialized = JSON.stringify(details);
    assert.ok(!serialized.includes("Moussa"), "le nom du client ne doit jamais apparaître dans un événement");
    assert.ok(!serialized.includes("22670000000"), "le numéro complet ne doit jamais apparaître dans un événement");
    assert.ok(!serialized.includes("35000"), "un montant ne doit jamais apparaître dans un événement");
    assert.notEqual(details.correlation_ref, "c-obs-1", "la référence de corrélation doit être hachée, jamais en clair");
  }
  assert.equal(events[1].details.intent, "PREPARE_DOCUMENT");
  // La mutation n'a pas encore eu lieu : le résultat renvoyé porte un sac de
  // champs sûrs déjà filtrés (observabilityFields), que seul l'orchestrateur
  // utilisera pour émettre conversational_draft_applied, et seulement après
  // le succès réel de documents.apply(...).
  assert.equal(result.value.observabilityFields.intent, "PREPARE_DOCUMENT");
  assert.equal(result.value.observabilityFields.document_type, "FACTURE");
  assert.equal(result.value.observabilityFields.result_status, "OK");
  assert.ok(Object.isFrozen(result.value.observabilityFields));
  const serializedObservabilityFields = JSON.stringify(result.value.observabilityFields);
  assert.ok(!serializedObservabilityFields.includes("Moussa"));
  assert.ok(!serializedObservabilityFields.includes("22670000000"));
  assert.ok(!serializedObservabilityFields.includes("35000"));
});

test("observabilité : un logger qui échoue ne change jamais le résultat renvoyé à l'appelant", async () => {
  const fallback = makeFallback([]);
  const rawBrainResult = {
    intent: "CREATE_DOCUMENT", document_type: "FACTURE",
    extracted_fields: { client: candidate({ name: "Moussa" }) },
    missing_fields: ["items"], uncertainties: [], confidence: 0.85,
    suggested_next_action: "ASK_TARGETED_QUESTION", user_facing_message_draft: "Quel produit ?",
    provider_metadata: { provider: "OPENAI" },
  };
  const brain = makeBrain(async () => rawBrainResult);
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
    logger: () => { throw new Error("sink down"); },
  });
  const result = await adapter.interpret({ ownerWaId: "22670000000", inputType: "TEXT", text: "Fais une facture pour Moussa.", correlationId: "c-obs-2" });
  assert.equal(result.ok, true);
  assert.equal(result.value.intent, "PREPARE_DOCUMENT");
});

test("observabilité : un timeout du brain émet un fallback_selected avec un code fermé, sans détail brut de l'erreur", async () => {
  const fallback = makeFallback([]);
  const brain = makeBrain(async () => { const e = new Error("connection reset by peer at 10.0.0.5"); e.code = "BRAIN_PROVIDER_TIMEOUT"; throw e; });
  const events = [];
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
    logger: (event, details) => events.push({ event, details }),
  });
  const result = await adapter.interpret({ ownerWaId: "22670000000", inputType: "TEXT", text: "Fais une facture.", correlationId: "c-obs-3" });
  assert.equal(result.ok, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "conversational_fallback_selected");
  assert.equal(events[0].details.fallback_reason_code, "BRAIN_PROVIDER_TIMEOUT");
  assert.equal(events[0].details.result_status, "ERROR");
});

test("observabilité : REMOVE_ITEM ambigu émet fallback_selected et clarification_required, jamais draft_applied", async () => {
  const fallback = makeFallback([]);
  const rawBrainResult = {
    intent: "UPDATE_DOCUMENT", document_type: "FACTURE", extracted_fields: {},
    missing_fields: [], uncertainties: [], confidence: 0.9,
    suggested_next_action: "REVIEW_EXTRACTED_DATA", user_facing_message_draft: null,
    provider_metadata: { provider: "OPENAI" },
  };
  const brain = makeBrain(async () => rawBrainResult);
  const events = [];
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
    logger: (event, details) => events.push({ event, details }),
  });
  const activeDocument = {
    document_type: "FACTURE",
    items: [{ item_id: "item-1", description: "Chaise en bois" }, { item_id: "item-2", description: "Table en bois" }],
  };
  const result = await adapter.interpret({
    ownerWaId: "22670000000", inputType: "TEXT", text: "Enlève le bois.", activeDocument, correlationId: "c-obs-4",
  });
  assert.equal(result.ok, true);
  const names = events.map((entry) => entry.event);
  assert.ok(names.includes("conversational_fallback_selected"));
  assert.ok(names.includes("conversational_clarification_required"));
  assert.ok(!names.includes("conversational_draft_applied"), "aucune mutation n'a eu lieu, draft_applied ne doit jamais être émis");
  const fallbackEvent = events.find((entry) => entry.event === "conversational_fallback_selected");
  assert.equal(fallbackEvent.details.fallback_reason_code, "REMOVE_ITEM_AMBIGUOUS");
});

test("REMOVE_ITEM avec plusieurs correspondances -> clarification, aucun item_id choisi", async () => {
  const fallback = makeFallback([]);
  const rawBrainResult = {
    intent: "UPDATE_DOCUMENT", document_type: "FACTURE", extracted_fields: {},
    missing_fields: [], uncertainties: [], confidence: 0.9,
    suggested_next_action: "REVIEW_EXTRACTED_DATA", user_facing_message_draft: null,
    provider_metadata: { provider: "OPENAI" },
  };
  const brain = makeBrain(async () => rawBrainResult);
  const adapter = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback, gate: () => true,
  });
  const activeDocument = {
    document_type: "FACTURE",
    items: [
      { item_id: "item-1", description: "Chaise en bois" },
      { item_id: "item-2", description: "Table en bois" },
    ],
  };
  const result = await adapter.interpret({
    ownerWaId: "22670000000", inputType: "TEXT", text: "Enlève le bois.", activeDocument, correlationId: "c14",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.intent, "CONTINUE");
  assert.equal(result.value.brain_result, null);
  assert.ok(typeof result.value.clarification === "string" && result.value.clarification.length > 0);
});
