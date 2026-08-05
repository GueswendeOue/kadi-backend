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
    setInvoiceKind: noop,
    setClientOrPayer: noop,
    addContent: noop,
    updateContent: noop,
    removeContent: noop,
    setOptions: noop,
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
