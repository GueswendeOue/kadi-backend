"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createKadiV1ProductionOrchestratorComposition,
} = require("../kadiV1ProductionOrchestratorComposition");

const OWNER = "22670626055";

function config() {
  return {
    enabled: true,
    features: {
      brain: true,
      vision: true,
      transcription: true,
      voice: true,
      private_storage: true,
      generation: true,
      recharge: true,
      history: true,
      webhook: true,
    },
  };
}

function sharedPipeline() {
  const noop = async () => ({ ok: true, value: {} });
  return {
    createDraft: noop,
    applyBrainExtraction: noop,
    setInvoiceKind: noop, setReceiptFormat: noop,
    setClientOrPayer: noop,
    addContent: noop,
    updateContent: noop,
    removeContent: noop,
    setOptions: noop,
    changeDocumentType: noop,
    markReadyForReview: noop,
    verifyDocument: noop,
    reopenForCorrection: noop,
    cancelDocument: noop,
  };
}

function dischargePipeline() {
  const noop = async () => ({ ok: true, value: {} });
  return {
    createDischargeDraft: noop,
    applyBrainExtraction: noop,
    setIssuerOrGiver: noop,
    setRecipient: noop,
    setTransferredContent: noop,
    setReason: noop,
    setOptions: noop,
    markReadyForReview: noop,
    verifyDischarge: noop,
    reopenForCorrection: noop,
    cancelDischarge: noop,
  };
}

function baseDependencies(overrides = {}) {
  return {
    config: config(),
    supabase: {
      from() {
        throw new Error("BOOT_QUERY_FORBIDDEN");
      },
      rpc() {
        throw new Error("BOOT_RPC_FORBIDDEN");
      },
    },
    legacyHandler: async () => ({ handled: false }),
    brain: {
      async understand() {
        throw new Error("BOOT_BRAIN_FORBIDDEN");
      },
    },
    sharedPipeline: sharedPipeline(),
    dischargePipeline: dischargePipeline(),
    issuerResolver: {
      async getIssuerProfileId() {
        throw new Error("BOOT_ISSUER_FORBIDDEN");
      },
      async getIssuerProfileById() {
        throw new Error("BOOT_ISSUER_FORBIDDEN");
      },
    },
    historyService: {
      async searchDocuments() {
        throw new Error("BOOT_HISTORY_FORBIDDEN");
      },
      async getDocumentDetails() {
        throw new Error("BOOT_HISTORY_FORBIDDEN");
      },
    },
    balanceReader: {
      async getBalance() {
        throw new Error("BOOT_BALANCE_FORBIDDEN");
      },
    },
    providerAvailability: async () => false,
    ...overrides,
  };
}

test("production orchestrator composition performs no external call at boot", () => {
  const composition =
    createKadiV1ProductionOrchestratorComposition(
      baseDependencies()
    );

  assert.equal(composition.readiness.ready, true);
  assert.equal(
    composition.readiness.boot_external_calls,
    0
  );
  assert.equal(
    typeof composition.orchestrator.handle,
    "function"
  );
  assert.equal(
    typeof composition.userContextService.getContext,
    "function"
  );
  assert.equal(
    typeof composition.interpretationRuntime.interpret,
    "function"
  );
});

test("the composed orchestrator reads profile and wallet only when handling a request", async () => {
  const calls = [];
  const profile = {
    wa_id: OWNER,
    onboarding_status: "COMPLETED",
    welcome_credits_granted: true,
    welcome_credits_eligibility: "GRANTED",
    voice_response_mode: "TEXT_ONLY",
    locale: "fr-BF",
    created_at: "2026-08-03T20:00:00.000Z",
    updated_at: "2026-08-03T20:00:00.000Z",
  };

  function queryFor(table) {
    const query = {
      select() {
        return query;
      },
      eq() {
        return query;
      },
      in() {
        return query;
      },
      order() {
        return query;
      },
      limit() {
        return query;
      },
      async maybeSingle() {
        calls.push(["query", table]);
        if (table === "business_profiles") {
          return {
            data: {
              ...profile,
              phone_normalized: null,
              v1_created_at: profile.created_at,
              v1_updated_at: profile.updated_at,
            },
            error: null,
          };
        }
        if (table === "kadi_v1_documents") {
          return { data: null, error: null };
        }
        throw new Error(`UNEXPECTED_TABLE:${table}`);
      },
    };
    return query;
  }

  const composition =
    createKadiV1ProductionOrchestratorComposition(
      baseDependencies({
        supabase: {
          from(table) {
            return queryFor(table);
          },
          async rpc() {
            throw new Error("RPC_NOT_EXPECTED");
          },
        },
        balanceReader: {
          async getBalance(command) {
            calls.push(["balance", command]);
            return {
              ok: true,
              value: { credits: 7 },
            };
          },
        },
      })
    );

  assert.deepEqual(calls, []);

  const response = await composition.orchestrator.handle({
    ownerWaId: OWNER,
    inputType: "TEXT",
    text: "Quel est mon solde ?",
    correlationId: "corr:production:1",
    idempotencyKey: "conversation:production:1",
  });

  assert.equal(
    response.canonical_text,
    "Votre solde est de 7 crédits."
  );
  assert.equal(response.business_action, "SHOW_BALANCE");
  assert.deepEqual(
    calls.map((entry) => entry[0]),
    ["query", "query", "balance"]
  );
});

function onboardedOwnerSupabase() {
  const profile = {
    wa_id: OWNER,
    onboarding_status: "COMPLETED",
    welcome_credits_granted: true,
    welcome_credits_eligibility: "GRANTED",
    voice_response_mode: "TEXT_ONLY",
    locale: "fr-BF",
    created_at: "2026-08-03T20:00:00.000Z",
    updated_at: "2026-08-03T20:00:00.000Z",
  };
  function queryFor(table) {
    const query = {
      select() { return query; },
      eq() { return query; },
      in() { return query; },
      order() { return query; },
      limit() { return query; },
      async maybeSingle() {
        if (table === "business_profiles") {
          return { data: { ...profile, phone_normalized: null, v1_created_at: profile.created_at, v1_updated_at: profile.updated_at }, error: null };
        }
        return { data: null, error: null };
      },
    };
    return query;
  }
  return {
    from(table) { return queryFor(table); },
    async rpc() { throw new Error("RPC_NOT_EXPECTED"); },
  };
}

test("sans conversationalMultimodalCanaryConfig, un texte de recharge suit exactement le chemin existant (brain appelé, pas de flow recharge)", async () => {
  const requests = [];
  const composition = createKadiV1ProductionOrchestratorComposition(
    baseDependencies({
      supabase: onboardedOwnerSupabase(),
      brain: {
        async understand(request) {
          requests.push(request);
          return { intent: "UNKNOWN", document_type: null, extracted_fields: {}, missing_fields: [], uncertainties: [], confidence: 0.9, suggested_next_action: "NO_ACTION", user_facing_message_draft: null, provider_metadata: { provider: "OPENAI" } };
        },
      },
    })
  );
  const response = await composition.orchestrator.handle({
    ownerWaId: OWNER, inputType: "TEXT", text: "Je veux recharger mon compte.",
    correlationId: "corr:recharge:1", idempotencyKey: "conversation:recharge:1",
  });
  assert.notEqual(response.business_action, "RECHARGE_REQUESTED");
  assert.equal(requests.length, 1, "sans la config conversationnelle, le brain existant reste sollicité comme avant");
});

test("avec conversationalMultimodalCanaryConfig et le propriétaire éligible, un texte de recharge ouvre le flow existant sans appeler le brain", async () => {
  const { createKadiV1ConversationalMultimodalCanaryConfig } = require("../kadiV1CanaryIngress");
  const conversationalMultimodalCanaryConfig = createKadiV1ConversationalMultimodalCanaryConfig({
    KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS: OWNER,
  });
  const requests = [];
  const composition = createKadiV1ProductionOrchestratorComposition(
    baseDependencies({
      supabase: onboardedOwnerSupabase(),
      brain: { async understand(request) { requests.push(request); throw new Error("RECHARGE ne doit jamais appeler le brain"); } },
      conversationalMultimodalCanaryConfig,
    })
  );
  const response = await composition.orchestrator.handle({
    ownerWaId: OWNER, inputType: "TEXT", text: "Je veux recharger mon compte.",
    correlationId: "corr:recharge:2", idempotencyKey: "conversation:recharge:2",
  });
  assert.equal(response.business_action, "RECHARGE_REQUESTED");
  assert.equal(response.flow_request.flow_key, "RECHARGE");
  assert.equal(requests.length, 0);
});

test("avec conversationalMultimodalCanaryConfig mais un propriétaire non listé, le comportement reste identique au chemin existant", async () => {
  const { createKadiV1ConversationalMultimodalCanaryConfig } = require("../kadiV1CanaryIngress");
  const conversationalMultimodalCanaryConfig = createKadiV1ConversationalMultimodalCanaryConfig({
    KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS: "22679999999",
  });
  const requests = [];
  const composition = createKadiV1ProductionOrchestratorComposition(
    baseDependencies({
      supabase: onboardedOwnerSupabase(),
      brain: {
        async understand(request) {
          requests.push(request);
          return { intent: "UNKNOWN", document_type: null, extracted_fields: {}, missing_fields: [], uncertainties: [], confidence: 0.9, suggested_next_action: "NO_ACTION", user_facing_message_draft: null, provider_metadata: { provider: "OPENAI" } };
        },
      },
      conversationalMultimodalCanaryConfig,
    })
  );
  const response = await composition.orchestrator.handle({
    ownerWaId: OWNER, inputType: "TEXT", text: "Je veux recharger mon compte.",
    correlationId: "corr:recharge:3", idempotencyKey: "conversation:recharge:3",
  });
  assert.notEqual(response.business_action, "RECHARGE_REQUESTED");
  assert.equal(requests.length, 1, "propriétaire non éligible: le chemin plain existant doit s'exécuter, brain compris");
});

test("les 4 conditions d'activation sont toutes requises : KADI_V1_BRAIN_ENABLED=false bloque tout, même propriétaire éligible et allowlist configurée", async () => {
  const { createKadiV1ConversationalMultimodalCanaryConfig } = require("../kadiV1CanaryIngress");
  const conversationalMultimodalCanaryConfig = createKadiV1ConversationalMultimodalCanaryConfig({
    KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS: OWNER,
  });
  const requests = [];
  const interpretCalls = [];
  const composition = createKadiV1ProductionOrchestratorComposition(
    baseDependencies({
      config: { ...config(), features: { ...config().features, brain: false } },
      supabase: onboardedOwnerSupabase(),
      brain: { async understand(request) { requests.push(request); throw new Error("le brain ne doit jamais être appelé quand features.brain est faux"); } },
      conversationalMultimodalCanaryConfig,
    })
  );
  const response = await composition.orchestrator.handle({
    ownerWaId: OWNER, inputType: "TEXT", text: "Je veux recharger mon compte.",
    correlationId: "corr:gate:1", idempotencyKey: "conversation:gate:1",
  });
  assert.equal(response.business_action, "BRAIN_DISABLED");
  assert.notEqual(response.business_action, "RECHARGE_REQUESTED");
  assert.equal(requests.length, 0, "l'orchestrateur retourne avant même d'appeler l'interpretationRuntime quand features.brain est faux");
});

function workingSharedPipeline() {
  const noop = async () => ({ ok: true, value: {} });
  return {
    createDraft: async ({ ownerWaId, documentType }) => ({
      ok: true,
      value: { document_id: "doc:obs:1", document_type: documentType, owner_wa_id: ownerWaId, version: 1, status: "COLLECTING", missing_fields: [], uncertainties: [] },
    }),
    applyBrainExtraction: async ({ ownerWaId, documentId, expectedVersion }) => ({
      ok: true,
      value: { document_id: documentId, document_type: "FACTURE", owner_wa_id: ownerWaId, version: expectedVersion + 1, status: "COLLECTING", missing_fields: ["client"], uncertainties: [] },
    }),
    setInvoiceKind: noop, setReceiptFormat: noop, setClientOrPayer: noop,
    addContent: noop, updateContent: noop, removeContent: noop,
    setOptions: noop, changeDocumentType: noop, markReadyForReview: noop, verifyDocument: noop,
    reopenForCorrection: noop, cancelDocument: noop,
  };
}

test("conversationalObservabilityLogger, quand fourni, reçoit les événements de la voie conversationnelle sans jamais changer la réponse", async () => {
  const { createKadiV1ConversationalMultimodalCanaryConfig } = require("../kadiV1CanaryIngress");
  const conversationalMultimodalCanaryConfig = createKadiV1ConversationalMultimodalCanaryConfig({
    KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS: OWNER,
  });
  const events = [];
  const composition = createKadiV1ProductionOrchestratorComposition(
    baseDependencies({
      supabase: onboardedOwnerSupabase(),
      brain: {
        async understand() {
          return {
            intent: "CREATE_DOCUMENT", document_type: "FACTURE", extracted_fields: {},
            missing_fields: ["client"], uncertainties: [], confidence: 0.8,
            suggested_next_action: "ASK_TARGETED_QUESTION", user_facing_message_draft: "Quel est le nom du client ?",
            provider_metadata: { provider: "OPENAI" },
          };
        },
      },
      sharedPipeline: workingSharedPipeline(),
      conversationalMultimodalCanaryConfig,
      conversationalObservabilityLogger: (event, details) => events.push({ event, details }),
      issuerResolver: {
        async getIssuerProfileId() { return { ok: true, value: { issuerProfileId: "issuer:1" } }; },
        async getIssuerProfileById() { return { ok: true, value: { issuerProfileId: "issuer:1" } }; },
      },
    })
  );
  const response = await composition.orchestrator.handle({
    ownerWaId: OWNER, inputType: "TEXT", text: "Je vends du riz à des clients au marché.",
    correlationId: "corr:obs:1", idempotencyKey: "conversation:obs:1",
  });
  assert.equal(response.business_action, "ASK_MISSING_INFORMATION");
  assert.ok(events.length > 0, "le logger injecté doit recevoir au moins un événement");
  assert.ok(events.every(({ event }) => event.startsWith("conversational_")));
  for (const { details } of events) {
    assert.ok(!JSON.stringify(details).includes(OWNER), "le wa_id complet ne doit jamais apparaître dans un événement");
  }
});

test("sans conversationalObservabilityLogger, le comportement reste identique (paramètre optionnel)", async () => {
  const { createKadiV1ConversationalMultimodalCanaryConfig } = require("../kadiV1CanaryIngress");
  const conversationalMultimodalCanaryConfig = createKadiV1ConversationalMultimodalCanaryConfig({
    KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS: OWNER,
  });
  const composition = createKadiV1ProductionOrchestratorComposition(
    baseDependencies({
      supabase: onboardedOwnerSupabase(),
      brain: {
        async understand() {
          return {
            intent: "CREATE_DOCUMENT", document_type: "FACTURE", extracted_fields: {},
            missing_fields: ["client"], uncertainties: [], confidence: 0.8,
            suggested_next_action: "ASK_TARGETED_QUESTION", user_facing_message_draft: "Quel est le nom du client ?",
            provider_metadata: { provider: "OPENAI" },
          };
        },
      },
      sharedPipeline: workingSharedPipeline(),
      conversationalMultimodalCanaryConfig,
      issuerResolver: {
        async getIssuerProfileId() { return { ok: true, value: { issuerProfileId: "issuer:1" } }; },
        async getIssuerProfileById() { return { ok: true, value: { issuerProfileId: "issuer:1" } }; },
      },
    })
  );
  const response = await composition.orchestrator.handle({
    ownerWaId: OWNER, inputType: "TEXT", text: "Je vends du riz à des clients au marché.",
    correlationId: "corr:obs:2", idempotencyKey: "conversation:obs:2",
  });
  assert.equal(response.business_action, "ASK_MISSING_INFORMATION");
});

test("the production composition keeps the brain behind the interpretation adapter", async () => {
  const requests = [];
  const profile = {
    wa_id: OWNER,
    onboarding_status: "COMPLETED",
    welcome_credits_granted: true,
    welcome_credits_eligibility: "GRANTED",
    voice_response_mode: "TEXT_ONLY",
    locale: "fr-BF",
    created_at: "2026-08-03T20:00:00.000Z",
    updated_at: "2026-08-03T20:00:00.000Z",
  };

  function queryFor(table) {
    const query = {
      select() {
        return query;
      },
      eq() {
        return query;
      },
      in() {
        return query;
      },
      order() {
        return query;
      },
      limit() {
        return query;
      },
      async maybeSingle() {
        if (table === "business_profiles") {
          return {
            data: {
              ...profile,
              phone_normalized: null,
              v1_created_at: profile.created_at,
              v1_updated_at: profile.updated_at,
            },
            error: null,
          };
        }
        return { data: null, error: null };
      },
    };
    return query;
  }

  const composition =
    createKadiV1ProductionOrchestratorComposition(
      baseDependencies({
        supabase: {
          from(table) {
            return queryFor(table);
          },
          async rpc() {
            throw new Error("RPC_NOT_EXPECTED");
          },
        },
        brain: {
          async understand(request) {
            requests.push(request);
            return {
              schema_version: "kadi.brain.v1",
              request_id: request.request_id,
              intent: "UNKNOWN",
              document_type: null,
              extracted_data: {},
              missing_fields: [],
              uncertainties: [],
              confidence: 0.9,
              safe_to_execute: false,
            };
          },
        },
      })
    );

  const response = await composition.orchestrator.handle({
    ownerWaId: OWNER,
    inputType: "TEXT",
    text: "Ajoute les informations",
    correlationId: "corr:production:2",
    idempotencyKey: "conversation:production:2",
  });

  assert.equal(response.business_action, "SHOW_MENU");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].modality, "TEXT");
  assert.equal(requests[0].text, "Ajoute les informations");
  assert.equal(
    JSON.stringify(requests[0]).includes("OPENAI"),
    false
  );
  assert.equal(
    JSON.stringify(requests[0]).includes("GEMINI"),
    false
  );
});
