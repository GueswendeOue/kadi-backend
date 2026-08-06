"use strict";

// Proves the fix for the review finding "conversational_draft_applied is
// emitted before the orchestrator knows whether the backend mutation
// actually succeeded": kadiV1ConversationOrchestrator.js is now the ONLY
// place that event is emitted, and only once the corresponding backend
// port (documents.apply / removeContent / changeDocumentType) has itself
// returned ok:true with duplicate !== true.
//
// Uses the real orchestrator with a deterministically controllable
// documentRuntime double (so ok:false / duplicate:true can be forced
// precisely, independent of real version-conflict plumbing) and an
// interpretationRuntime double shaped exactly like
// kadiV1ConversationalMultimodalRuntimeAdapter.js's real return values
// (including observabilityFields), so this test exercises the orchestrator's
// real emission-gating logic, not a re-implementation of it.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createKadiV1ConversationOrchestrator } = require("../kadiV1ConversationOrchestrator");

const OWNER = "22670000000";

function ok(value, extra = {}) { return { ok: true, value, ...extra }; }
function fail(error) { return { ok: false, error }; }

function observabilityFields(overrides = {}) {
  return Object.freeze({
    correlation_ref: null, source: "TEXT", intent: "PREPARE_DOCUMENT", document_type: "FACTURE",
    operation: null, result_status: "OK", missing_field_count: 0, ambiguous_field_count: 0,
    provider_category: "BRAIN", latency_bucket: "LT_1S", fallback_reason_code: null,
    ...overrides,
  });
}

function makeFixture({ interpretation, documentRuntimeOverrides = {} } = {}) {
  const calls = [];
  const events = [];
  const config = {
    enabled: true,
    features: { brain: true, vision: true, transcription: true, voice: false, recharge: true, history: true },
  };
  const activeDocument = { document_id: "doc:1", document_type: "FACTURE", status: "COLLECTING", version: 3, items: [{ item_id: "item-9", description: "Livraison" }] };
  const context = { profile: { onboarding_status: "COMPLETED" }, is_new: false, active_document: activeDocument };
  const documentRuntime = {
    start: async (command) => { calls.push(["start", command]); return ok({ document_id: "doc:new", document_type: command.documentType, status: "COLLECTING", version: 1, missing_fields: [], uncertainties: [] }); },
    apply: async (command) => { calls.push(["apply", command]); return documentRuntimeOverrides.apply ? documentRuntimeOverrides.apply(command) : ok(command.document); },
    cancel: async () => ok({ status: "CANCELLED" }),
    removeContent: async (command) => { calls.push(["removeContent", command]); return documentRuntimeOverrides.removeContent ? documentRuntimeOverrides.removeContent(command) : ok({ ...activeDocument, version: activeDocument.version + 1, items: [] }); },
    changeDocumentType: async (command) => { calls.push(["changeDocumentType", command]); return documentRuntimeOverrides.changeDocumentType ? documentRuntimeOverrides.changeDocumentType(command) : ok({ ...activeDocument, document_type: command.targetDocumentType, version: activeDocument.version + 1 }); },
  };
  const orchestrator = createKadiV1ConversationOrchestrator({
    config,
    legacyHandler: async () => ({ legacy: true }),
    userContextService: { getContext: async () => ok(context) },
    onboardingRuntime: { start: async () => ok({ welcome_credits_granted: true }) },
    interpretationRuntime: { interpret: async () => ok(interpretation) },
    documentRuntime,
    historyRuntime: { search: async () => ok({ documents: [] }) },
    walletRuntime: { getBalance: async () => ok({ credits: 5 }) },
    conversationalObservabilityEmit: (event, details) => events.push({ event, details }),
  });
  return { orchestrator, calls, events, activeDocument };
}

function input(overrides = {}) {
  return {
    ownerWaId: OWNER, inputType: "TEXT", text: "Enlève la livraison.",
    correlationId: "corr:1", idempotencyKey: "conversation:1",
    ...overrides,
  };
}

test("1. documents.apply échoue -> zéro événement conversational_draft_applied", async () => {
  const f = makeFixture({
    interpretation: {
      intent: "PREPARE_DOCUMENT", document_type: "FACTURE",
      brain_result: { intent: "CREATE_DOCUMENT", document_type: "FACTURE", extracted_fields: {}, missing_fields: [], uncertainties: [], confidence: 0.9, suggested_next_action: "REVIEW_EXTRACTED_DATA", user_facing_message_draft: null, provider_metadata: { provider: "OPENAI" } },
      observabilityFields: observabilityFields(),
    },
    documentRuntimeOverrides: { apply: async () => fail("DOCUMENT_VERSION_CONFLICT") },
  });
  const response = await f.orchestrator.handle(input({ ownerWaId: OWNER, activeDocument: undefined }));
  assert.equal(response.ok, false);
  assert.equal(f.events.filter((e) => e.event === "conversational_draft_applied").length, 0);
});

test("2. documents.removeContent échoue -> zéro événement conversational_draft_applied", async () => {
  const f = makeFixture({
    interpretation: {
      intent: "REMOVE_ITEM", document_type: "FACTURE", remove_item_id: "item-9", brain_result: null,
      observabilityFields: observabilityFields({ intent: "REMOVE_ITEM", operation: "REMOVE_ITEM" }),
    },
    documentRuntimeOverrides: { removeContent: async () => fail("DOCUMENT_VERSION_CONFLICT") },
  });
  const response = await f.orchestrator.handle(input());
  assert.equal(response.ok, false);
  assert.equal(f.events.filter((e) => e.event === "conversational_draft_applied").length, 0);
});

test("3. documents.changeDocumentType échoue -> zéro événement conversational_draft_applied", async () => {
  const f = makeFixture({
    interpretation: {
      intent: "CHANGE_DOCUMENT_TYPE", document_type: "DEVIS", target_document_type: "DEVIS", brain_result: null,
      observabilityFields: observabilityFields({ intent: "CHANGE_DOCUMENT_TYPE", operation: "CHANGE_DOCUMENT_TYPE", document_type: "DEVIS" }),
    },
    documentRuntimeOverrides: { changeDocumentType: async () => fail("DOCUMENT_VERSION_CONFLICT") },
  });
  const response = await f.orchestrator.handle(input());
  assert.equal(response.ok, false);
  assert.equal(f.events.filter((e) => e.event === "conversational_draft_applied").length, 0);
});

test("4. apply réussi -> exactement un événement conversational_draft_applied, après le succès", async () => {
  const f = makeFixture({
    interpretation: {
      intent: "PREPARE_DOCUMENT", document_type: "FACTURE",
      brain_result: { intent: "CREATE_DOCUMENT", document_type: "FACTURE", extracted_fields: {}, missing_fields: [], uncertainties: [], confidence: 0.9, suggested_next_action: "REVIEW_EXTRACTED_DATA", user_facing_message_draft: null, provider_metadata: { provider: "OPENAI" } },
      observabilityFields: observabilityFields(),
    },
  });
  const response = await f.orchestrator.handle(input({ ownerWaId: OWNER, activeDocument: undefined }));
  assert.equal(response.handled, true);
  const applyIndex = f.calls.findIndex(([name]) => name === "apply");
  assert.ok(applyIndex >= 0, "documents.apply doit avoir été appelé");
  assert.equal(f.events.filter((e) => e.event === "conversational_draft_applied").length, 1);
  assert.equal(f.events[f.events.length - 1].event, "conversational_draft_applied");
});

test("5. REMOVE_ITEM réussi -> exactement un événement conversational_draft_applied", async () => {
  const f = makeFixture({
    interpretation: {
      intent: "REMOVE_ITEM", document_type: "FACTURE", remove_item_id: "item-9", brain_result: null,
      observabilityFields: observabilityFields({ intent: "REMOVE_ITEM", operation: "REMOVE_ITEM" }),
    },
  });
  const response = await f.orchestrator.handle(input());
  assert.equal(response.handled, true);
  assert.equal(f.events.filter((e) => e.event === "conversational_draft_applied").length, 1);
  assert.equal(f.events[f.events.length - 1].details.intent, "REMOVE_ITEM");
});

test("6. CHANGE_DOCUMENT_TYPE réussi -> exactement un événement conversational_draft_applied", async () => {
  const f = makeFixture({
    interpretation: {
      intent: "CHANGE_DOCUMENT_TYPE", document_type: "DEVIS", target_document_type: "DEVIS", brain_result: null,
      observabilityFields: observabilityFields({ intent: "CHANGE_DOCUMENT_TYPE", operation: "CHANGE_DOCUMENT_TYPE", document_type: "DEVIS" }),
    },
  });
  const response = await f.orchestrator.handle(input());
  assert.equal(response.handled, true);
  assert.equal(f.events.filter((e) => e.event === "conversational_draft_applied").length, 1);
  assert.equal(f.events[f.events.length - 1].details.intent, "CHANGE_DOCUMENT_TYPE");
});

test("7. rejeu du même webhook -> une seule mutation et un seul événement de succès au total", async () => {
  let applyCalls = 0;
  const document = { document_id: "doc:new", document_type: "FACTURE", status: "COLLECTING", version: 1, missing_fields: [], uncertainties: [] };
  const f = makeFixture({
    interpretation: {
      intent: "PREPARE_DOCUMENT", document_type: "FACTURE",
      brain_result: { intent: "CREATE_DOCUMENT", document_type: "FACTURE", extracted_fields: {}, missing_fields: [], uncertainties: [], confidence: 0.9, suggested_next_action: "REVIEW_EXTRACTED_DATA", user_facing_message_draft: null, provider_metadata: { provider: "OPENAI" } },
      observabilityFields: observabilityFields(),
    },
    documentRuntimeOverrides: {
      apply: async () => {
        applyCalls += 1;
        // First call is a fresh mutation; the replay of the identical
        // webhook (same idempotencyKey) is exactly what
        // kadiV1SharedDocumentPipeline.js's own replayFor(...) reports as
        // duplicate:true, with zero additional mutation performed.
        return applyCalls === 1 ? ok(document, { duplicate: false }) : ok(document, { duplicate: true });
      },
    },
  });
  const request = input({ ownerWaId: OWNER, activeDocument: undefined });
  const first = await f.orchestrator.handle(request);
  const second = await f.orchestrator.handle(request);
  assert.equal(first.handled, true);
  assert.equal(second.handled, true);
  assert.equal(applyCalls, 2, "l'interprétation/l'appel applicatif est retenté (non dédupliqué à ce niveau) mais...");
  assert.equal(f.events.filter((e) => e.event === "conversational_draft_applied").length, 1, "...un seul événement de succès doit être émis au total, car le second appel est un doublon");
});

test("le fallback (échec) est enregistré comme un échec, jamais comme une application réussie", async () => {
  const f = makeFixture({
    interpretation: {
      intent: "CONTINUE", document_type: null, brain_result: null,
      clarification: "Plusieurs articles du document correspondent à cette description.",
      // A clarification/fallback outcome never carries observabilityFields —
      // there is nothing for the orchestrator to apply, so there must be
      // nothing it could possibly report as applied.
    },
  });
  const response = await f.orchestrator.handle(input());
  assert.equal(response.handled, true);
  assert.equal(f.calls.some(([name]) => ["apply", "removeContent", "changeDocumentType"].includes(name)), false);
  assert.equal(f.events.filter((e) => e.event === "conversational_draft_applied").length, 0);
});
