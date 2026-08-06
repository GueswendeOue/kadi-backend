"use strict";

// End-to-end proof for the "PREPARE_DOCUMENT contradiction" fix in
// kadiV1ConversationOrchestrator.js: the deterministic PREPARE_DOCUMENT
// short-circuit (detectNaturalIntent matching "facture"/"devis"/...) must
// preserve the exact historical behavior for owners who are not eligible
// for conversational interpretation, while eligible owners get exactly one
// conversational interpretation pass that retains same-message data
// (client, items, quantity, unit price), applied through the existing
// canonical adapter chain and the existing document port — never a second
// draft, never a second paid provider call on failure.
//
// This wires the REAL orchestrator, the REAL conversational-multimodal
// runtime adapter, the REAL plain interpretation adapter, and the REAL
// document pipeline/repository (in-memory) — only the AI provider
// (`brain.understand`) and the outer ports (user context, onboarding,
// history, wallet) are test doubles. Provider-call and draft-count
// assertions are real counters on real calls, not inferred from response
// shape alone.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createKadiV1ConversationOrchestrator } = require("../kadiV1ConversationOrchestrator");
const {
  createKadiV1DocumentRuntimeAdapter,
  createKadiV1InterpretationRuntimeAdapter,
} = require("../kadiV1RuntimeAdapters");
const {
  createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter,
} = require("../kadiV1ConversationalMultimodalRuntimeAdapter");
const { createSharedDocumentPipeline } = require("../kadiV1SharedDocumentPipeline");
const { createDischargePipeline } = require("../kadiV1DischargePipeline");
const { createInMemoryV1DocumentRepository } = require("../kadiV1DocumentRepository");
const { KadiBrainError } = require("../kadiV1Brain");

const OWNER_ELIGIBLE = "22670000001";
const OWNER_INELIGIBLE = "22670000002";

function ok(value) { return { ok: true, value }; }
function fail(error) { return { ok: false, error }; }

function candidate(value, status = "CONFIRMED", confidence = 0.9) {
  return { value, status, confidence, source_reference: "text:0" };
}

function countingDocumentRuntime(real) {
  const calls = { start: 0, apply: 0 };
  const documentIds = new Set();
  return {
    calls,
    documentIds,
    runtime: {
      async start(command) {
        calls.start += 1;
        const result = await real.start(command);
        if (result.ok) documentIds.add(result.value.document_id);
        return result;
      },
      async apply(command) {
        calls.apply += 1;
        return real.apply(command);
      },
      cancel: (command) => real.cancel(command),
      removeContent: (command) => real.removeContent(command),
      changeDocumentType: (command) => real.changeDocumentType(command),
    },
  };
}

function makeFixture({ understand, captureObservability = false }) {
  const repository = createInMemoryV1DocumentRepository();
  const sharedPipeline = createSharedDocumentPipeline({ repository });
  const dischargePipeline = createDischargePipeline({ repository });
  const issuerResolver = {
    getIssuerProfileId: async () => ok({ issuerProfileId: "issuer:1" }),
    getIssuerProfileById: async () => ok({ issuerProfileId: "issuer:1" }),
  };
  const realDocumentRuntime = createKadiV1DocumentRuntimeAdapter({
    sharedPipeline, dischargePipeline, documentRepository: repository, issuerResolver,
  });
  const { runtime: documentRuntime, calls: documentCalls, documentIds } = countingDocumentRuntime(realDocumentRuntime);

  let understandCalls = 0;
  const brain = {
    understand: async (request) => {
      understandCalls += 1;
      return understand(request);
    },
  };
  const plainInterpretationRuntime = createKadiV1InterpretationRuntimeAdapter({ brain });
  const gate = (ownerWaId) => ownerWaId === OWNER_ELIGIBLE;
  const interpretationRuntime = createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
    brain, fallback: plainInterpretationRuntime, gate,
  });

  const context = { profile: { onboarding_status: "COMPLETED" }, is_new: false, active_document: null };
  const userContextService = { getContext: async () => ok(context) };
  const onboardingRuntime = { start: async () => ok({ welcome_credits_granted: true }) };
  const historyRuntime = { search: async () => ok({ documents: [] }) };
  const walletRuntime = { getBalance: async () => ok({ credits: 5 }) };

  const config = {
    enabled: true,
    features: { brain: true, vision: true, transcription: true, voice: false, recharge: true, history: true },
  };

  const observabilityEvents = [];
  const orchestrator = createKadiV1ConversationOrchestrator({
    config,
    legacyHandler: async () => ({ legacy: true }),
    userContextService,
    onboardingRuntime,
    interpretationRuntime,
    documentRuntime,
    historyRuntime,
    walletRuntime,
    conversationalEligibilityGate: gate,
    conversationalObservabilityEmit: captureObservability
      ? (event, details) => observabilityEvents.push({ event, details })
      : null,
  });

  return {
    orchestrator,
    repository,
    documentCalls,
    documentIds,
    observabilityEvents,
    understandCallCount: () => understandCalls,
  };
}

function input(overrides = {}) {
  return {
    ownerWaId: OWNER_ELIGIBLE,
    inputType: "TEXT",
    text: "Fais une facture.",
    correlationId: "corr:1",
    idempotencyKey: "conversation:1",
    ...overrides,
  };
}

function brainResult(overrides = {}) {
  return {
    intent: "CREATE_DOCUMENT",
    document_type: "FACTURE",
    extracted_fields: {},
    missing_fields: ["client", "items"],
    uncertainties: [],
    confidence: 0.85,
    suggested_next_action: "ASK_TARGETED_QUESTION",
    user_facing_message_draft: "Quel est le nom du client ?",
    provider_metadata: { provider: "OPENAI", request_ref: "req:1", latency_ms: 5 },
    ...overrides,
  };
}

test("1. propriétaire éligible, 'Fais une facture' simple -> un appel provider, un seul brouillon, question ciblée", async () => {
  const f = makeFixture({ understand: async () => brainResult() });
  const response = await f.orchestrator.handle(input());
  assert.equal(response.business_action, "ASK_MISSING_INFORMATION");
  assert.equal(f.understandCallCount(), 1, "un seul appel provider pour ce message");
  assert.equal(f.documentIds.size, 1, "un seul brouillon doit exister");
});

test("2. propriétaire éligible, facture avec client -> le client du même message est conservé", async () => {
  const f = makeFixture({
    understand: async () => brainResult({
      extracted_fields: { client: candidate({ name: "Moussa" }) },
      missing_fields: ["items"],
    }),
  });
  const response = await f.orchestrator.handle(input({ text: "Fais une facture pour Moussa." }));
  assert.equal(response.business_action, "ASK_MISSING_INFORMATION");
  assert.equal(f.understandCallCount(), 1);
  assert.equal(f.documentIds.size, 1);
  const documentId = [...f.documentIds][0];
  const reloaded = await f.repository.getDocumentById({ documentId, ownerWaId: OWNER_ELIGIBLE });
  assert.equal(reloaded.value.client.name, "Moussa", "le client fourni dans le même message ne doit pas être perdu");
});

test("3. propriétaire éligible, facture avec client et articles -> client, description, quantité et prix unitaire sont tous conservés", async () => {
  const f = makeFixture({
    understand: async () => brainResult({
      extracted_fields: {
        client: candidate({ name: "Moussa" }),
        items: candidate([{ description: "Table", quantity: 3, unit_price: 45000 }]),
      },
      missing_fields: [],
    }),
  });
  const response = await f.orchestrator.handle(input({ text: "Fais une facture pour Moussa avec trois tables à 45 000." }));
  assert.equal(f.understandCallCount(), 1, "un seul appel provider pour ce message");
  assert.equal(f.documentIds.size, 1, "un seul brouillon créé ou mis à jour, jamais deux");
  const documentId = [...f.documentIds][0];
  const reloaded = await f.repository.getDocumentById({ documentId, ownerWaId: OWNER_ELIGIBLE });
  assert.equal(reloaded.value.client.name, "Moussa");
  assert.equal(reloaded.value.items.length, 1);
  assert.equal(reloaded.value.items[0].description, "Table");
  assert.equal(reloaded.value.items[0].quantity_millis, 3000, "la quantité du même message doit être conservée");
  assert.equal(reloaded.value.items[0].unit_price, 45000, "le prix unitaire du même message doit être conservé");
  assert.equal(response.business_action, "DOCUMENT_DATA_APPLIED");
});

test("4. propriétaire non éligible -> chemin historique exact, zéro appel provider", async () => {
  const f = makeFixture({ understand: async () => { throw new Error("le provider ne doit jamais être appelé pour un propriétaire non éligible"); } });
  const response = await f.orchestrator.handle(input({ ownerWaId: OWNER_INELIGIBLE, text: "Fais une facture." }));
  assert.equal(response.business_action, "DOCUMENT_STARTED");
  assert.equal(f.understandCallCount(), 0, "zéro appel provider pour un propriétaire non éligible");
  assert.equal(f.documentIds.size, 1, "le brouillon vide historique doit tout de même être créé");
});

test("5. timeout du provider -> chemin PREPARE_DOCUMENT historique exécuté une seule fois, aucun second appel provider", async () => {
  const f = makeFixture({ understand: async () => { throw new KadiBrainError("BRAIN_PROVIDER_TIMEOUT"); } });
  const response = await f.orchestrator.handle(input({ text: "Fais une facture." }));
  assert.equal(response.business_action, "DOCUMENT_STARTED", "le repli doit démarrer le brouillon vide historique, pas un message d'erreur générique");
  assert.equal(f.understandCallCount(), 1, "un seul essai provider, jamais de retry automatique");
  assert.equal(f.documentIds.size, 1, "au plus un brouillon, jamais deux");
  assert.equal(f.documentCalls.apply, 0, "aucune mutation conversationnelle ne doit être tentée après un échec provider");
});

test("6. sortie provider malformée -> chemin PREPARE_DOCUMENT historique exécuté une seule fois, aucun second appel provider", async () => {
  const f = makeFixture({ understand: async () => ({ not_a_valid_shape: true }) });
  const response = await f.orchestrator.handle(input({ text: "Fais une facture." }));
  assert.equal(response.business_action, "DOCUMENT_STARTED");
  assert.equal(f.understandCallCount(), 1, "un seul essai provider malgré la sortie malformée");
  assert.equal(f.documentIds.size, 1);
  assert.equal(f.documentCalls.apply, 0);
});

test("7. rejeu du même webhook (idempotencyKey identique) -> le brouillon n'est appliqué qu'une seule fois", async () => {
  const f = makeFixture({
    understand: async () => brainResult({
      extracted_fields: {
        client: candidate({ name: "Moussa" }),
        items: candidate([{ description: "Table", quantity: 3, unit_price: 45000 }]),
      },
      missing_fields: [],
    }),
  });
  const request = input({ text: "Fais une facture pour Moussa avec trois tables à 45 000." });
  const first = await f.orchestrator.handle(request);
  const documentId = [...f.documentIds][0];
  const afterFirst = await f.repository.getDocumentById({ documentId, ownerWaId: OWNER_ELIGIBLE });

  // A replayed webhook still re-runs conversational interpretation (the
  // provider call itself is not deduplicated at this layer — only the
  // document MUTATION is, via the existing idempotencyKey-based replay in
  // kadiV1SharedDocumentPipeline.js). What must never happen is a second
  // draft or a second applied version.
  const second = await f.orchestrator.handle(request);
  const afterSecond = await f.repository.getDocumentById({ documentId, ownerWaId: OWNER_ELIGIBLE });

  assert.equal(f.documentIds.size, 1, "toujours un seul brouillon après le rejeu");
  assert.equal(afterSecond.value.version, afterFirst.value.version, "le rejeu ne doit pas créer une nouvelle version");
  assert.equal(afterSecond.value.items.length, 1, "le rejeu ne doit pas dupliquer les articles");
  assert.equal(second.business_action, first.business_action);
});

test("8. bout-en-bout (pipeline réel) : conversational_draft_applied n'est émis qu'après le succès réel de documents.apply, un seul événement même après rejeu", async () => {
  const f = makeFixture({
    captureObservability: true,
    understand: async () => brainResult({
      extracted_fields: {
        client: candidate({ name: "Moussa" }),
        items: candidate([{ description: "Table", quantity: 3, unit_price: 45000 }]),
      },
      missing_fields: [],
    }),
  });
  const request = input({ text: "Fais une facture pour Moussa avec trois tables à 45 000." });
  const first = await f.orchestrator.handle(request);
  assert.equal(first.handled, true);
  const draftAppliedAfterFirst = f.observabilityEvents.filter((e) => e.event === "conversational_draft_applied");
  assert.equal(draftAppliedAfterFirst.length, 1, "un seul événement de succès pour la première application réelle");
  assert.equal(draftAppliedAfterFirst[0].details.intent, "PREPARE_DOCUMENT");
  assert.equal(draftAppliedAfterFirst[0].details.document_type, "FACTURE");

  const second = await f.orchestrator.handle(request);
  assert.equal(second.handled, true);
  const draftAppliedAfterReplay = f.observabilityEvents.filter((e) => e.event === "conversational_draft_applied");
  assert.equal(draftAppliedAfterReplay.length, 1, "le rejeu du même webhook (kadiV1SharedDocumentPipeline.js le reconnaît comme duplicate:true) ne doit jamais produire un second événement de succès");
});
