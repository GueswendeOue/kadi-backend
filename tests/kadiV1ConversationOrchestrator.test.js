"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  WELCOME_TEXT,
  createKadiV1ConversationOrchestrator,
  detectNaturalIntent,
  firstTargetedQuestion,
  validateCanonicalText,
} = require("../kadiV1ConversationOrchestrator");

function result(value) { return { ok: true, value }; }

function makeHarness(overrides = {}) {
  const calls = [];
  const config = overrides.config || {
    enabled: true,
    features: {
      brain: true,
      vision: true,
      transcription: true,
      voice: true,
      private_storage: false,
      generation: false,
      recharge: true,
      history: true,
      webhook: false,
    },
  };
  const context = overrides.context || {
    profile: { onboarding_status: "COMPLETED", voice_response_mode: "VOICE_WHEN_HELPFUL" },
    is_new: false,
    active_document: null,
  };
  const ports = {
    config,
    legacyHandler: async (input) => ({ legacy: true, input }),
    userContextService: { getContext: async () => result(context) },
    onboardingRuntime: {
      start: async (command) => { calls.push(["onboarding", command]); return result({ welcome_credits_granted: true }); },
    },
    interpretationRuntime: {
      interpret: async (command) => { calls.push(["interpret", command]); return result(overrides.interpretation || { intent: "CONTINUE", brain_result: null }); },
    },
    documentRuntime: {
      start: async (command) => { calls.push(["start", command]); return result(overrides.startedDocument || { document_id: "document:1", document_type: command.documentType, status: "COLLECTING", version: 1, missing_fields: [], uncertainties: [] }); },
      apply: async (command) => { calls.push(["apply", command]); return result(overrides.appliedDocument || command.document); },
      cancel: async (command) => { calls.push(["cancel", command]); return result({ status: "CANCELLED" }); },
    },
    historyRuntime: {
      search: async (command) => { calls.push(["history", command]); return result(overrides.history || { documents: [] }); },
    },
    walletRuntime: {
      getBalance: async (command) => { calls.push(["balance", command]); return result({ credits: overrides.credits ?? 5 }); },
    },
    voicePolicy: {
      evaluate: async (command) => { calls.push(["voice", command]); return result(overrides.voice || { mode: "TEXT_ONLY", reason: "SHORT" }); },
    },
  };
  return {
    calls,
    orchestrator: createKadiV1ConversationOrchestrator(ports),
  };
}

function input(overrides = {}) {
  return {
    ownerWaId: "22670000000",
    inputType: "TEXT",
    text: "bonjour",
    correlationId: "corr:1",
    idempotencyKey: "conversation:1",
    ...overrides,
  };
}

test("natural language detects the four document types", () => {
  assert.deepEqual(detectNaturalIntent("Je veux une facture"), { intent: "PREPARE_DOCUMENT", document_type: "FACTURE" });
  assert.deepEqual(detectNaturalIntent("Prépare un devis"), { intent: "PREPARE_DOCUMENT", document_type: "DEVIS" });
  assert.deepEqual(detectNaturalIntent("Je cherche un reçu"), { intent: "PREPARE_DOCUMENT", document_type: "RECU" });
  assert.deepEqual(detectNaturalIntent("Fais une décharge"), { intent: "PREPARE_DOCUMENT", document_type: "DECHARGE" });
});

test("disabled V1 delegates without changing the historical path", async () => {
  const { orchestrator } = makeHarness({ config: { enabled: false, features: {} } });
  const response = await orchestrator.handle(input());
  assert.equal(response.legacy, true);
});

test("new user receives welcome only after confirmed credits", async () => {
  const { orchestrator, calls } = makeHarness({
    context: { profile: null, is_new: true, active_document: null },
  });
  const response = await orchestrator.handle(input());
  assert.equal(response.canonical_text, WELCOME_TEXT);
  assert.equal(response.business_action, "ONBOARDING_STARTED");
  assert.equal(response.flow_request.flow_key, "ONBOARDING");
  assert.equal(response.voice_request.mode, "TEXT_AND_VOICE");
  assert.equal(calls[0][0], "onboarding");
});

test("natural invoice request starts a draft without forcing a modality menu", async () => {
  const { orchestrator, calls } = makeHarness();
  const response = await orchestrator.handle(input({ text: "Je veux créer une facture" }));
  assert.equal(response.business_action, "DOCUMENT_STARTED");
  assert.match(response.canonical_text, /nom du client/i);
  assert.equal(calls.some(([name]) => name === "start"), true);
  assert.equal(calls.some(([name]) => name === "interpret"), false);
});

test("balance is read from the wallet authority", async () => {
  const { orchestrator, calls } = makeHarness({ credits: 7 });
  const response = await orchestrator.handle(input({ text: "Quel est mon solde ?" }));
  assert.equal(response.canonical_text, "Votre solde est de 7 crédits.");
  assert.equal(calls.some(([name]) => name === "balance"), true);
});

test("history results remain owner-scoped and open logical selection", async () => {
  const { orchestrator, calls } = makeHarness({
    history: { documents: [{ document_id: "doc:1" }, { document_id: "doc:2" }] },
  });
  const response = await orchestrator.handle(input({ text: "Retrouve ma facture de Moussa" }));
  assert.equal(response.business_action, "HISTORY_RESULTS");
  assert.equal(response.flow_request.flow_key, "HISTORY_SEARCH");
  const searchCall = calls.find(([name]) => name === "history")[1];
  assert.equal(searchCall.ownerWaId, "22670000000");
});

test("one uncertainty produces one targeted question", async () => {
  const { orchestrator } = makeHarness({
    context: {
      profile: { onboarding_status: "COMPLETED", voice_response_mode: "VOICE_WHEN_HELPFUL" },
      active_document: { document_id: "doc:1", document_type: "FACTURE", status: "COLLECTING", version: 2 },
    },
    interpretation: { intent: "CONTINUE", brain_result: { safe: true } },
    appliedDocument: {
      document_id: "doc:1",
      document_type: "FACTURE",
      status: "INCOMPLETE",
      version: 3,
      missing_fields: ["client", "items"],
      uncertainties: [{ field: "client", recommended_question: "Le client s’appelle Moussa ou Issa ?" }],
    },
  });
  const response = await orchestrator.handle(input({ text: "Ajoute Moussa" }));
  assert.equal(response.canonical_text, "Le client s’appelle Moussa ou Issa ?");
  assert.equal(response.business_action, "ASK_MISSING_INFORMATION");
  assert.equal(response.flow_request, null);
});

test("ready document opens review by logical key only", async () => {
  const { orchestrator } = makeHarness({
    context: {
      profile: { onboarding_status: "COMPLETED", voice_response_mode: "TEXT_ONLY" },
      active_document: { document_id: "doc:1", document_type: "DEVIS", status: "COLLECTING", version: 1 },
    },
    interpretation: { intent: "CONTINUE", brain_result: { safe: true } },
    appliedDocument: {
      document_id: "doc:1",
      document_type: "DEVIS",
      status: "READY_FOR_REVIEW",
      version: 2,
      missing_fields: [],
      uncertainties: [],
    },
  });
  const response = await orchestrator.handle(input({ text: "C’est tout" }));
  assert.equal(response.flow_request.flow_key, "DOCUMENT_REVIEW");
  assert.equal(Object.hasOwn(response.flow_request, "flow_id"), false);
});

test("visual input is rejected cleanly when the feature is disabled", async () => {
  const { orchestrator, calls } = makeHarness({
    config: { enabled: true, features: { brain: true, vision: false, transcription: true, voice: false, history: true } },
  });
  const response = await orchestrator.handle(input({ inputType: "IMAGE", text: undefined, media: { media_id: "m:1" } }));
  assert.equal(response.business_action, "VISION_UNAVAILABLE");
  assert.equal(calls.some(([name]) => name === "interpret"), false);
});

test("recoverable provider failure preserves the user's information", async () => {
  const { orchestrator } = makeHarness({
    context: {
      profile: { onboarding_status: "COMPLETED", voice_response_mode: "VOICE_WHEN_HELPFUL" },
      active_document: { document_id: "doc:1", document_type: "FACTURE", status: "COLLECTING", version: 1 },
    },
  });
  const broken = createKadiV1ConversationOrchestrator({
    config: { enabled: true, features: { brain: true, vision: true, transcription: true, voice: false, history: true } },
    legacyHandler: async () => ({}),
    userContextService: { getContext: async () => result({ profile: { onboarding_status: "COMPLETED" }, active_document: { document_id: "doc:1", document_type: "FACTURE", status: "COLLECTING", version: 1 } }) },
    onboardingRuntime: { start: async () => result({ welcome_credits_granted: true }) },
    interpretationRuntime: { interpret: async () => ({ ok: false, error: "PROVIDER_DOWN" }) },
    documentRuntime: { start: async () => result({}), apply: async () => result({}), cancel: async () => result({}) },
    historyRuntime: { search: async () => result({ documents: [] }) },
    walletRuntime: { getBalance: async () => result({ credits: 0 }) },
  });
  const response = await broken.handle(input({ text: "Ajoute le ciment" }));
  assert.equal(response.business_action, "INTERPRETATION_RECOVERABLE_FAILURE");
  assert.match(response.canonical_text, /informations sont conservées/i);
  assert.equal(orchestrator != null, true);
});

test("canonical text rejects technical boundaries", () => {
  assert.equal(validateCanonicalText("Votre document est prêt."), true);
  assert.equal(validateCanonicalText("Le payload est invalide."), false);
  assert.equal(validateCanonicalText("Une erreur interne est survenue."), false);
});

test("targeted question prefers uncertainty over missing fields", () => {
  assert.equal(firstTargetedQuestion({
    missing_fields: ["client", "items"],
    uncertainties: [{ recommended_question: "Quel client dois-je retenir ?" }],
  }), "Quel client dois-je retenir ?");
});

test("cancel applies to the active document only", async () => {
  const { orchestrator, calls } = makeHarness({
    context: {
      profile: { onboarding_status: "COMPLETED", voice_response_mode: "TEXT_ONLY" },
      active_document: { document_id: "doc:9", document_type: "RECU", status: "COLLECTING", version: 4 },
    },
  });
  const response = await orchestrator.handle(input({ text: "Annule" }));
  assert.equal(response.business_action, "DOCUMENT_CANCELLED");
  const cancelCall = calls.find(([name]) => name === "cancel")[1];
  assert.equal(cancelCall.documentId, "doc:9");
  assert.equal(cancelCall.expectedVersion, 4);
});
