"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createInMemoryV1DocumentRepository } = require("../kadiV1DocumentRepository");
const { createSharedDocumentPipeline } = require("../kadiV1SharedDocumentPipeline");
const { createDischargePipeline } = require("../kadiV1DischargePipeline");
const {
  createKadiV1DocumentRuntimeAdapter,
  createKadiV1GenerationRuntimeAdapter,
  createKadiV1HistoryRuntimeAdapter,
  createKadiV1InterpretationRuntimeAdapter,
  createKadiV1OnboardingRuntimeAdapter,
  createKadiV1PreviewRuntimeAdapter,
  createKadiV1VoicePolicyRuntimeAdapter,
  createKadiV1WalletRuntimeAdapter,
  runtimeKey,
} = require("../kadiV1RuntimeAdapters");

const OWNER = "22670000000";

function documentRuntime() {
  const repository = createInMemoryV1DocumentRepository();
  return {
    repository,
    runtime: createKadiV1DocumentRuntimeAdapter({
      sharedPipeline: createSharedDocumentPipeline({ repository }),
      dischargePipeline: createDischargePipeline({ repository }),
      documentRepository: repository,
      issuerResolver: { getIssuerProfileId: async () => ({ ok: true, value: { issuerProfileId: "issuer:1" } }), getIssuerProfileById: async () => ({ ok: true, value: { business_name: "Kadi Boutique", owner_name: "Awa Traoré" } }) },
    }),
  };
}

function confirmed(value) {
  return { value, status: "CONFIRMED", confidence: 0.99, source_reference: "user:text" };
}

function brainResult(type, fields) {
  return {
    intent: "CREATE_DOCUMENT",
    document_type: type,
    extracted_fields: fields,
    missing_fields: [],
    uncertainties: [],
    confidence: 0.99,
    suggested_next_action: "REVIEW_EXTRACTED_DATA",
    user_facing_message_draft: null,
    provider_metadata: { provider: "OPENAI", model: "test", request_ref: "req:1", latency_ms: 1 },
  };
}

test("runtime keys are deterministic, scoped and bounded", () => {
  const first = runtimeKey("preview:", "flow_command:reply:1", "one");
  const second = runtimeKey("preview:", "flow_command:reply:1", "one");
  assert.equal(first, second);
  assert.match(first, /^preview:[a-f0-9]{40}$/);
  assert.notEqual(first, runtimeKey("preview:", "flow_command:reply:1", "two"));
});

test("shared document adapter starts a real FACTURE draft with a pipeline-compatible key", async () => {
  const { runtime } = documentRuntime();
  const started = await runtime.start({ ownerWaId: OWNER, documentType: "FACTURE", idempotencyKey: "flow_command:start:1" });
  assert.equal(started.ok, true, started.error);
  assert.equal(started.value.document_type, "FACTURE");
  assert.equal(started.value.status, "COLLECTING");
});

test("startAddContent revalidates ownership and version without mutating the document", async () => {
  const { runtime } = documentRuntime();
  const started = await runtime.start({ ownerWaId: OWNER, documentType: "FACTURE", idempotencyKey: "flow_command:start:1b" });
  const opened = await runtime.startAddContent({
    ownerWaId: OWNER, documentId: started.value.document_id, expectedVersion: started.value.version,
    documentType: "FACTURE", idempotencyKey: "flow_command:start-add:1",
  });
  assert.equal(opened.ok, true, opened.error);
  assert.equal(opened.value.document_id, started.value.document_id);
  assert.equal(opened.value.version, started.value.version);
  assert.deepEqual(opened.value.items, started.value.items);
});

test("setInvoiceKind persists the chosen kind on a FACTURE document", async () => {
  const { runtime } = documentRuntime();
  const started = await runtime.start({ ownerWaId: OWNER, documentType: "FACTURE", idempotencyKey: "flow_command:start:invoice-kind" });
  const saved = await runtime.setInvoiceKind({
    ownerWaId: OWNER, documentId: started.value.document_id, expectedVersion: started.value.version,
    documentType: "FACTURE", invoiceKind: "PROFORMA", idempotencyKey: "flow_command:save-invoice-type:1",
  });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.value.options.invoice_kind, "PROFORMA");
});

test("setInvoiceKind is forbidden for a non-FACTURE document", async () => {
  const { runtime } = documentRuntime();
  const started = await runtime.start({ ownerWaId: OWNER, documentType: "DEVIS", idempotencyKey: "flow_command:start:invoice-kind-devis" });
  const saved = await runtime.setInvoiceKind({
    ownerWaId: OWNER, documentId: started.value.document_id, expectedVersion: started.value.version,
    documentType: "DEVIS", invoiceKind: "FINAL", idempotencyKey: "flow_command:save-invoice-type:2",
  });
  assert.deepEqual(saved, { ok: false, error: "KADI_V1_INVOICE_KIND_FLOW_FORBIDDEN" });
});

test("startAddContent is forbidden for DECHARGE", async () => {
  const { runtime } = documentRuntime();
  const started = await runtime.start({ ownerWaId: OWNER, documentType: "DECHARGE", idempotencyKey: "flow_command:start:1c" });
  const opened = await runtime.startAddContent({
    ownerWaId: OWNER, documentId: started.value.document_id, expectedVersion: started.value.version,
    documentType: "DECHARGE", idempotencyKey: "flow_command:start-add:2",
  });
  assert.deepEqual(opened, { ok: false, error: "KADI_V1_DISCHARGE_CONTENT_FLOW_REQUIRED" });
});

test("changeDocumentType converts a FACTURE draft to DEVIS through the document runtime adapter", async () => {
  const { runtime } = documentRuntime();
  const started = await runtime.start({ ownerWaId: OWNER, documentType: "FACTURE", idempotencyKey: "flow_command:start:type-1" });
  const changed = await runtime.changeDocumentType({
    ownerWaId: OWNER, documentId: started.value.document_id, expectedVersion: started.value.version,
    documentType: "FACTURE", targetDocumentType: "DEVIS", idempotencyKey: "flow_command:change-type:1",
  });
  assert.equal(changed.ok, true, changed.error);
  assert.equal(changed.value.document_type, "DEVIS");
  assert.equal(changed.value.document_id, started.value.document_id);
});

test("changeDocumentType is forbidden for DECHARGE at the adapter level", async () => {
  const { runtime } = documentRuntime();
  const started = await runtime.start({ ownerWaId: OWNER, documentType: "DECHARGE", idempotencyKey: "flow_command:start:type-2" });
  const changed = await runtime.changeDocumentType({
    ownerWaId: OWNER, documentId: started.value.document_id, expectedVersion: started.value.version,
    documentType: "DECHARGE", targetDocumentType: "FACTURE", idempotencyKey: "flow_command:change-type:2",
  });
  assert.deepEqual(changed, { ok: false, error: "KADI_V1_DISCHARGE_TYPE_CONVERSION_UNSUPPORTED" });
});

test("brain extraction advances a complete FACTURE to READY_FOR_REVIEW", async () => {
  const { runtime } = documentRuntime();
  const started = await runtime.start({ ownerWaId: OWNER, documentType: "FACTURE", idempotencyKey: "flow_command:start:2" });
  const applied = await runtime.apply({
    ownerWaId: OWNER,
    document: started.value,
    idempotencyKey: "conversation:apply:2",
    brainResult: brainResult("FACTURE", {
      client: confirmed({ name: "Awa Test" }),
      items: confirmed([{ description: "Ciment", quantity: 2, unit: "sac", unit_price: 6500 }]),
    }),
  });
  assert.equal(applied.ok, true, applied.error);
  assert.equal(applied.value.status, "READY_FOR_REVIEW");
  assert.equal(applied.value.items.length, 1);
  assert.equal(applied.value.total, 13000);
});

test("apply() reports duplicate:true on a replayed idempotencyKey, duplicate:false on the first call, even when advanceIfComplete runs", async () => {
  const { runtime } = documentRuntime();
  const started = await runtime.start({ ownerWaId: OWNER, documentType: "FACTURE", idempotencyKey: "flow_command:start:dup-1" });
  const applyCommand = {
    ownerWaId: OWNER,
    document: started.value,
    idempotencyKey: "conversation:apply:dup-1",
    brainResult: brainResult("FACTURE", { client: confirmed({ name: "Awa Test" }) }),
  };
  const first = await runtime.apply(applyCommand);
  assert.equal(first.ok, true, first.error);
  assert.equal(first.duplicate, false, "a fresh application must not be reported as a duplicate");

  const replay = await runtime.apply(applyCommand);
  assert.equal(replay.ok, true, replay.error);
  assert.equal(replay.duplicate, true, "replaying the exact same idempotencyKey must be reported as a duplicate");
  assert.equal(replay.value.version, first.value.version, "a replay must not create a new version");
});

test("manual shared flow keeps collecting until options completion then advances", async () => {
  const { runtime } = documentRuntime();
  let document = (await runtime.start({ ownerWaId: OWNER, documentType: "DEVIS", idempotencyKey: "flow_command:start:3" })).value;
  document = (await runtime.setClient({ ownerWaId: OWNER, documentId: document.document_id, expectedVersion: document.version, documentType: "DEVIS", client: { name: "Issa" }, idempotencyKey: "flow_command:client:3" })).value;
  assert.equal(document.status, "COLLECTING");
  document = (await runtime.addContent({ ownerWaId: OWNER, documentId: document.document_id, expectedVersion: document.version, documentType: "DEVIS", content: { description: "Pose", quantity: 1, unit: "service", unit_price: 25000 }, idempotencyKey: "flow_command:item:3" })).value;
  assert.equal(document.status, "COLLECTING");
  document = (await runtime.setOptions({ ownerWaId: OWNER, documentId: document.document_id, expectedVersion: document.version, documentType: "DEVIS", options: {}, idempotencyKey: "flow_command:options:3" })).value;
  assert.equal(document.status, "READY_FOR_REVIEW");
});

test("discharge details use the dedicated pipeline and become reviewable", async () => {
  const { runtime } = documentRuntime();
  const started = await runtime.start({ ownerWaId: OWNER, documentType: "DECHARGE", idempotencyKey: "flow_command:start:4" });
  const saved = await runtime.saveDischargeDetails({
    ownerWaId: OWNER,
    documentId: started.value.document_id,
    expectedVersion: started.value.version,
    documentType: "DECHARGE",
    idempotencyKey: "flow_command:details:4",
    details: {
      giver: "Awa",
      recipient: "Issa",
      transferred_content_type: "ARGENT",
      amount: 50000,
      currency: "XOF",
      reason: "Remboursement",
    },
  });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.value.status, "READY_FOR_REVIEW");
  assert.equal(saved.value.total, 50000);
  assert.equal(saved.value.discharge.subject.type, "MONEY");
});

test("item correction requires the server item id and preserves one item", async () => {
  const { runtime } = documentRuntime();
  let document = (await runtime.start({ ownerWaId: OWNER, documentType: "FACTURE", idempotencyKey: "flow_command:start:5" })).value;
  document = (await runtime.setClient({ ownerWaId: OWNER, documentId: document.document_id, expectedVersion: document.version, documentType: "FACTURE", client: { name: "Client" }, idempotencyKey: "flow_command:client:5" })).value;
  document = (await runtime.addContent({ ownerWaId: OWNER, documentId: document.document_id, expectedVersion: document.version, documentType: "FACTURE", content: { description: "Article", quantity: 1, unit_price: 1000 }, idempotencyKey: "flow_command:item:5" })).value;
  const itemId = document.items[0].item_id;
  const updated = await runtime.updateContent({ ownerWaId: OWNER, documentId: document.document_id, expectedVersion: document.version, documentType: "FACTURE", itemId, content: { quantity: 3 }, idempotencyKey: "flow_command:update:5" });
  assert.equal(updated.ok, true, updated.error);
  assert.equal(updated.value.items.length, 1);
  assert.equal(updated.value.items[0].item_id, itemId);
  assert.equal(updated.value.total, 3000);
});

test("preview adapter persists, renders, counts and quotes in the required order", async () => {
  const calls = [];
  const adapter = createKadiV1PreviewRuntimeAdapter({
    previewService: { persistPreview: async (command) => { calls.push(["preview", command]); return { ok: true, value: { preview_id: "preview:1", document_version: 3 }, document: { status: "PREVIEW_READY" } }; } },
    temporaryRenderService: {
      createTemporaryRender: async (command) => { calls.push(["render", command]); return { ok: true, value: { render_id: "render:1" } }; },
      inspectTemporaryRender: async (command) => { calls.push(["inspect", command]); return { ok: true, value: { render_id: "render:1", page_count: 2 } }; },
    },
    generationQuoteService: { createGenerationQuote: async (command) => { calls.push(["quote", command]); return { ok: true, value: { quote_id: "quote:1", total_credits: 5 }, document: { status: "AWAITING_GENERATION_CONFIRMATION" } }; } },
  });
  const result = await adapter.prepare({ ownerWaId: OWNER, documentId: "document:1", expectedVersion: 3, documentType: "FACTURE", idempotencyKey: "flow_command:preview:1" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(([name]) => name), ["preview", "render", "inspect", "quote"]);
  assert.equal(result.value.temporary_render.page_count, 2);
  assert.equal(result.value.quote.total_credits, 5);
  assert.equal(calls.some(([, command]) => Object.hasOwn(command, "debit")), false);
});

test("generation adapter confirms only with immutable document version and quote — routed through confirmOrRetryGeneration, the single production entrypoint for both normal confirmation and render-failure recovery", async () => {
  let received;
  const adapter = createKadiV1GenerationRuntimeAdapter({
    generationLifecycleService: {
      confirmOrRetryGeneration: async (command) => { received = command; return { ok: true, value: { delivered: true } }; },
      retryDelivery: async () => ({ ok: true, value: { delivered: true } }),
    },
  });
  const result = await adapter.confirm({ ownerWaId: OWNER, documentId: "document:1", expectedVersion: 4, documentType: "FACTURE", quoteId: "quote:1", idempotencyKey: "flow_command:generation:1" });
  assert.equal(result.ok, true);
  assert.equal(received.documentVersion, 4);
  assert.equal(received.quoteId, "quote:1");
  assert.match(received.idempotencyKey, /^generation_confirm:/);
});

test("generation adapter's retryDelivery only forwards ownerWaId/documentId — never trusts any other client-supplied field", async () => {
  let received;
  const adapter = createKadiV1GenerationRuntimeAdapter({
    generationLifecycleService: {
      confirmOrRetryGeneration: async () => ({ ok: true, value: {} }),
      retryDelivery: async (command) => { received = command; return { ok: true, value: { document: { status: "DELIVERED" } } }; },
    },
  });
  const result = await adapter.retryDelivery({
    ownerWaId: OWNER, documentId: "document:1", idempotencyKey: "webhook:delivery:1",
    quoteId: "quote:attacker-supplied", deliveryAttemptId: "delivery:attacker-supplied", amount: 0,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(received).sort(), ["confirmed", "documentId", "idempotencyKey", "ownerWaId"]);
  assert.equal(received.confirmed, false);
  assert.equal(received.ownerWaId, OWNER);
  assert.equal(received.documentId, "document:1");
  assert.match(received.idempotencyKey, /^delivery_retry:/);
});

test("generation adapter's retryDelivery rejects malformed owner/document input before ever reaching the lifecycle service", async () => {
  let called = false;
  const adapter = createKadiV1GenerationRuntimeAdapter({
    generationLifecycleService: {
      confirmOrRetryGeneration: async () => ({ ok: true, value: {} }),
      retryDelivery: async () => { called = true; return { ok: true, value: {} }; },
    },
  });
  const badOwner = await adapter.retryDelivery({ ownerWaId: "not-a-number", documentId: "document:1", idempotencyKey: "k" });
  const badDocument = await adapter.retryDelivery({ ownerWaId: OWNER, documentId: "", idempotencyKey: "k" });
  assert.equal(badOwner.ok, false);
  assert.equal(badDocument.ok, false);
  assert.equal(called, false);
});

// R2 independent review (MEDIUM/P1): the R1 fix classified BOTH
// GENERATION_CONFIRMATION_STATE_INVALID and DOCUMENT_VERSION_CONFLICT as
// "safe replay" signals whenever a re-read of the document showed
// RECHARGE_REQUIRED, without also requiring the re-read document's
// version/type to still match the ORIGINAL command's expectedVersion/
// documentType. A stale command for version N, replayed after the SAME
// document later independently reached version N+1/RECHARGE_REQUIRED
// through a DIFFERENT confirmation, would be wrongly classified as a
// safe, duplicate replay of the ORIGINAL (now-stale) confirmation
// attempt — even though it was never actually about that later state.
// Fixed: DOCUMENT_VERSION_CONFLICT always fails closed, never translated
// into a handled RECHARGE_REQUIRED success. GENERATION_CONFIRMATION_STATE_INVALID
// is only ever translated when BOTH the trusted exactReplay signal
// (threaded from kadiV1FlowReplyRuntime.js's own consumed.duplicate —
// never the payload) is true AND the re-read document's version/type
// still exactly match the original command's expectedVersion/
// documentType. INSUFFICIENT_CREDITS (the genuine first-time path) is
// unaffected — it never needs exactReplay, only the re-read's RECHARGE_REQUIRED
// status.

test("R2-MEDIUM-repro-fixed: a stale command for version N is never classified as a safe replay merely because the document is now RECHARGE_REQUIRED at version N+1", async () => {
  const adapter = createKadiV1GenerationRuntimeAdapter({
    generationLifecycleService: {
      confirmOrRetryGeneration: async () => ({ ok: false, error: "DOCUMENT_VERSION_CONFLICT" }),
      retryDelivery: async () => ({ ok: true, value: {} }),
    },
    documentRepository: {
      getDocumentById: async () => ({ ok: true, value: { document_id: "document:1", version: 9, document_type: "FACTURE", status: "RECHARGE_REQUIRED" } }),
    },
  });
  const result = await adapter.confirm({ ownerWaId: OWNER, documentId: "document:1", expectedVersion: 8, documentType: "FACTURE", quoteId: "quote:old", idempotencyKey: "flow_command:generation:stale" });
  assert.equal(result.ok, false, "DOCUMENT_VERSION_CONFLICT must always fail closed — never converted into a handled RECHARGE_REQUIRED success merely because the document happens to be RECHARGE_REQUIRED now");
  assert.equal(result.error, "DOCUMENT_VERSION_CONFLICT");
});

test("R2-MEDIUM: GENERATION_CONFIRMATION_STATE_INVALID is translated as a safe replay only when exactReplay is true AND the re-read version/type still match the original command", async () => {
  const baseLifecycle = { confirmOrRetryGeneration: async () => ({ ok: false, error: "GENERATION_CONFIRMATION_STATE_INVALID" }), retryDelivery: async () => ({ ok: true, value: {} }) };
  const matchingDocument = { getDocumentById: async () => ({ ok: true, value: { document_id: "document:1", version: 8, document_type: "FACTURE", status: "RECHARGE_REQUIRED" } }) };
  const mismatchedVersionDocument = { getDocumentById: async () => ({ ok: true, value: { document_id: "document:1", version: 9, document_type: "FACTURE", status: "RECHARGE_REQUIRED" } }) };
  const mismatchedTypeDocument = { getDocumentById: async () => ({ ok: true, value: { document_id: "document:1", version: 8, document_type: "DEVIS", status: "RECHARGE_REQUIRED" } }) };

  // Not an exact replay (exactReplay: false/absent) — must fail closed
  // even though the document is genuinely RECHARGE_REQUIRED at the exact
  // matching version: this is a first-time stale submission, not a proven
  // replay of the same original transition.
  const notReplay = await createKadiV1GenerationRuntimeAdapter({ generationLifecycleService: baseLifecycle, documentRepository: matchingDocument })
    .confirm({ ownerWaId: OWNER, documentId: "document:1", expectedVersion: 8, documentType: "FACTURE", quoteId: "quote:1", idempotencyKey: "flow_command:generation:1" });
  assert.equal(notReplay.ok, false, "GENERATION_CONFIRMATION_STATE_INVALID must fail closed when exactReplay is not proven true");

  // Exact replay proven, but the re-read version no longer matches the
  // original command's expectedVersion — the document moved on for a
  // DIFFERENT reason since this stale context was captured; must fail
  // closed, never treated as a safe replay of THIS command.
  const versionMismatch = await createKadiV1GenerationRuntimeAdapter({ generationLifecycleService: baseLifecycle, documentRepository: mismatchedVersionDocument })
    .confirm({ ownerWaId: OWNER, documentId: "document:1", expectedVersion: 8, documentType: "FACTURE", quoteId: "quote:1", idempotencyKey: "flow_command:generation:1", exactReplay: true });
  assert.equal(versionMismatch.ok, false, "a version mismatch must fail closed even when exactReplay is true");

  // Exact replay proven, but the re-read document_type no longer matches
  // — an impossible identity mismatch; must fail closed.
  const typeMismatch = await createKadiV1GenerationRuntimeAdapter({ generationLifecycleService: baseLifecycle, documentRepository: mismatchedTypeDocument })
    .confirm({ ownerWaId: OWNER, documentId: "document:1", expectedVersion: 8, documentType: "FACTURE", quoteId: "quote:1", idempotencyKey: "flow_command:generation:1", exactReplay: true });
  assert.equal(typeMismatch.ok, false, "a document_type mismatch must fail closed even when exactReplay is true");

  // Exact replay proven AND the re-read version/type exactly match the
  // original command — this is genuinely the same already-applied
  // transition being safely re-observed.
  const genuineReplay = await createKadiV1GenerationRuntimeAdapter({ generationLifecycleService: baseLifecycle, documentRepository: matchingDocument })
    .confirm({ ownerWaId: OWNER, documentId: "document:1", expectedVersion: 8, documentType: "FACTURE", quoteId: "quote:1", idempotencyKey: "flow_command:generation:1", exactReplay: true });
  assert.equal(genuineReplay.ok, true, genuineReplay.error);
  assert.equal(genuineReplay.value.recharge_required, true);
  assert.equal(genuineReplay.value.next_flow_key, "RECHARGE");
  assert.equal(genuineReplay.duplicate, true);
});

test("R2-MEDIUM: INSUFFICIENT_CREDITS (genuine first time) needs no exactReplay signal — only the re-read RECHARGE_REQUIRED status", async () => {
  const adapter = createKadiV1GenerationRuntimeAdapter({
    generationLifecycleService: { confirmOrRetryGeneration: async () => ({ ok: false, error: "INSUFFICIENT_CREDITS" }), retryDelivery: async () => ({ ok: true, value: {} }) },
    documentRepository: { getDocumentById: async () => ({ ok: true, value: { document_id: "document:1", version: 8, document_type: "FACTURE", status: "RECHARGE_REQUIRED" } }) },
  });
  const result = await adapter.confirm({ ownerWaId: OWNER, documentId: "document:1", expectedVersion: 8, documentType: "FACTURE", quoteId: "quote:1", idempotencyKey: "flow_command:generation:1" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.recharge_required, true);
  assert.equal(result.value.next_flow_key, "RECHARGE");
  assert.notEqual(result.duplicate, true, "the genuine first-time INSUFFICIENT_CREDITS path is not itself a replay");
});

test("R2-MEDIUM: an owner mismatch fails closed — getDocumentById itself is owner-scoped, so a replay/insufficient-credits translation can never leak across owners", async () => {
  const documents = { getDocumentById: async ({ ownerWaId }) => (ownerWaId === OWNER ? { ok: true, value: { document_id: "document:1", version: 8, document_type: "FACTURE", status: "RECHARGE_REQUIRED" } } : { ok: false, error: "DOCUMENT_OWNER_MISMATCH" }) };
  const insufficient = await createKadiV1GenerationRuntimeAdapter({
    generationLifecycleService: { confirmOrRetryGeneration: async () => ({ ok: false, error: "INSUFFICIENT_CREDITS" }), retryDelivery: async () => ({ ok: true, value: {} }) },
    documentRepository: documents,
  }).confirm({ ownerWaId: "22679999999", documentId: "document:1", expectedVersion: 8, documentType: "FACTURE", quoteId: "quote:1", idempotencyKey: "flow_command:generation:1" });
  assert.equal(insufficient.ok, false, "a mismatched owner must never receive a translated RECHARGE_REQUIRED success");

  const replay = await createKadiV1GenerationRuntimeAdapter({
    generationLifecycleService: { confirmOrRetryGeneration: async () => ({ ok: false, error: "GENERATION_CONFIRMATION_STATE_INVALID" }), retryDelivery: async () => ({ ok: true, value: {} }) },
    documentRepository: documents,
  }).confirm({ ownerWaId: "22679999999", documentId: "document:1", expectedVersion: 8, documentType: "FACTURE", quoteId: "quote:1", idempotencyKey: "flow_command:generation:1", exactReplay: true });
  assert.equal(replay.ok, false, "a mismatched owner must never receive a translated replay success either");
});

test("interpretation adapter maps the real brain contract without exposing providers", async () => {
  let request;
  const resultValue = brainResult("RECU", { amount: confirmed(10000) });
  const adapter = createKadiV1InterpretationRuntimeAdapter({ brain: { understand: async (value) => { request = value; return resultValue; } } });
  const interpreted = await adapter.interpret({ inputType: "TEXT", text: "Fais un reçu de 10000", correlationId: "corr:1", activeDocument: null });
  assert.equal(interpreted.ok, true);
  assert.equal(interpreted.value.intent, "PREPARE_DOCUMENT");
  assert.equal(interpreted.value.document_type, "RECU");
  assert.equal(request.modality, "TEXT");
  assert.equal(Object.hasOwn(interpreted.value, "provider"), false);
});

test("interpretation adapter converts PDF to the DOCUMENT modality", async () => {
  let request;
  const adapter = createKadiV1InterpretationRuntimeAdapter({ brain: { understand: async (value) => { request = value; return brainResult("FACTURE", {}); } } });
  await adapter.interpret({ inputType: "PDF", media: { mime_type: "application/pdf", media_id: "media:1", owner_ref: OWNER }, correlationId: "corr:pdf", activeDocument: null });
  assert.equal(request.modality, "DOCUMENT");
});

test("onboarding adapter distinguishes a first welcome from a safe resume", async () => {
  const first = createKadiV1OnboardingRuntimeAdapter({ onboardingService: {
    onboardNewUser: async () => ({ ok: true, credits_granted_now: true, profile: { onboarding_status: "IN_PROGRESS" }, welcome: { text: "Bienvenue" } }),
    getOnboardingState: async () => ({ ok: true, value: { welcome_credits_granted: true } }),
    completeOnboarding: async () => ({ ok: true, value: { onboarding_status: "COMPLETED" } }),
  } });
  assert.equal((await first.start({ ownerWaId: OWNER })).value.welcome_should_send, true);
  assert.equal((await first.continueOnboarding({ ownerWaId: OWNER })).ok, true);

  const resume = createKadiV1OnboardingRuntimeAdapter({ onboardingService: {
    onboardNewUser: async () => ({ ok: true, credits_granted_now: false, duplicate: true, profile: { onboarding_status: "IN_PROGRESS" } }),
    getOnboardingState: async () => ({ ok: true, value: { welcome_credits_granted: true } }),
    completeOnboarding: async () => ({ ok: true, value: {} }),
  } });
  assert.equal((await resume.start({ ownerWaId: OWNER })).value.welcome_should_send, false);
});

test("history adapter maps natural search to the existing text filter", async () => {
  let received;
  const adapter = createKadiV1HistoryRuntimeAdapter({ historyService: {
    searchDocuments: async (command) => { received = command; return { ok: true, value: { documents: [] } }; },
    getDocumentDetails: async () => ({ ok: true, value: {} }),
  } });
  await adapter.search({ ownerWaId: OWNER, query: "facture Moussa", limit: 5, correlationId: "corr:history" });
  assert.deepEqual(received.filters, { text: "facture Moussa" });
  assert.equal(received.ownerWaId, OWNER);
});

// HISTORY-CONTRACT-001: the real HISTORY_SEARCH Flow's combined form
// submits query/document_type/date_from/date_to/document_id together on
// every SEARCH submission, blank fields included. kadiV1HistoryService.js's
// normalizeFilters only recognizes the canonical text/from/to — never
// query/date_from/date_to, which it previously received unchanged and
// rejected outright as HISTORY_FILTER_UNKNOWN (or, for document_type, would
// have silently persisted an empty-string filter matching nothing).
test("history adapter maps the real Flow's query/date_from/date_to to the canonical text/from/to filters", async () => {
  let received;
  const adapter = createKadiV1HistoryRuntimeAdapter({ historyService: {
    searchDocuments: async (command) => { received = command; return { ok: true, value: { documents: [] } }; },
    getDocumentDetails: async () => ({ ok: true, value: {} }),
  } });
  await adapter.search({
    ownerWaId: OWNER,
    criteria: { query: "Moussa", document_type: "FACTURE", date_from: "2026-01-01", date_to: "2026-08-01", document_id: "" },
  });
  assert.deepEqual(received.filters, { text: "Moussa", document_type: "FACTURE", from: "2026-01-01", to: "2026-08-01" });
});

test("history adapter treats every blank real-Flow field as not provided, never a literal empty-string filter", async () => {
  let received;
  const adapter = createKadiV1HistoryRuntimeAdapter({ historyService: {
    searchDocuments: async (command) => { received = command; return { ok: true, value: { documents: [] } }; },
    getDocumentDetails: async () => ({ ok: true, value: {} }),
  } });
  await adapter.search({
    ownerWaId: OWNER,
    criteria: { query: "", document_type: "", date_from: "", date_to: "", document_id: "" },
  });
  assert.deepEqual(received.filters, {}, "an all-blank real SEARCH submission must become an unconstrained search, never a filter that matches nothing");
});

test("history adapter drops document_id from SEARCH filters — it must never influence which documents are returned", async () => {
  let received;
  const adapter = createKadiV1HistoryRuntimeAdapter({ historyService: {
    searchDocuments: async (command) => { received = command; return { ok: true, value: { documents: [] } }; },
    getDocumentDetails: async () => ({ ok: true, value: {} }),
  } });
  await adapter.search({ ownerWaId: OWNER, criteria: { query: "", document_type: "", date_from: "", date_to: "", document_id: "doc:leftover-from-a-previous-search" } });
  assert.equal(Object.hasOwn(received.filters, "document_id"), false);
});

// T6/BALANCE-001: the canonical shape is
// {total_credits, reserved_credits, available_credits}, with the
// available = total - reserved invariant re-validated at this layer too.
test("wallet adapter accepts only a consistent, non-negative integer available-balance snapshot", async () => {
  const valid = createKadiV1WalletRuntimeAdapter({ balanceReader: { getBalance: async () => ({ ok: true, value: { total_credits: 10, reserved_credits: 3, available_credits: 7 } }) } });
  assert.deepEqual(await valid.getBalance({ ownerWaId: OWNER }), { ok: true, value: { total_credits: 10, reserved_credits: 3, available_credits: 7 } });

  const nonInteger = createKadiV1WalletRuntimeAdapter({ balanceReader: { getBalance: async () => ({ ok: true, value: { total_credits: 1.5, reserved_credits: 0, available_credits: 1.5 } }) } });
  assert.deepEqual(await nonInteger.getBalance({ ownerWaId: OWNER }), { ok: false, error: "KADI_V1_BALANCE_INVALID" });

  const negative = createKadiV1WalletRuntimeAdapter({ balanceReader: { getBalance: async () => ({ ok: true, value: { total_credits: 5, reserved_credits: -1, available_credits: 6 } }) } });
  assert.deepEqual(await negative.getBalance({ ownerWaId: OWNER }), { ok: false, error: "KADI_V1_BALANCE_INVALID" });

  const inconsistent = createKadiV1WalletRuntimeAdapter({ balanceReader: { getBalance: async () => ({ ok: true, value: { total_credits: 10, reserved_credits: 3, available_credits: 8 } }) } });
  assert.deepEqual(await inconsistent.getBalance({ ownerWaId: OWNER }), { ok: false, error: "KADI_V1_BALANCE_INVALID" });
});

test("voice adapter translates the deterministic engine contract and never debits", async () => {
  let received;
  const adapter = createKadiV1VoicePolicyRuntimeAdapter({
    voicePolicyEngine: { evaluate: (command) => { received = command; return { decision: "TEXT_AND_VOICE", reason: "VOICE_CONTINUITY" }; } },
    providerAvailability: async () => true,
  });
  const evaluated = await adapter.evaluate({ voice_response_mode: "VOICE_WHEN_HELPFUL", canonical_text: "Expliquez-moi la suite.", input_type: "TRANSCRIPTION", step: "HELP" });
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.value.mode, "TEXT_AND_VOICE");
  assert.equal(evaluated.value.wallet_debit, false);
  assert.equal(received.last_input_modality, "VOICE");
});
