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
      issuerResolver: { getIssuerProfileId: async () => ({ ok: true, value: { issuerProfileId: "issuer:1" } }) },
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

test("generation adapter confirms only with immutable document version and quote", async () => {
  let received;
  const adapter = createKadiV1GenerationRuntimeAdapter({ generationLifecycleService: { confirmGeneration: async (command) => { received = command; return { ok: true, value: { delivered: true } }; } } });
  const result = await adapter.confirm({ ownerWaId: OWNER, documentId: "document:1", expectedVersion: 4, documentType: "FACTURE", quoteId: "quote:1", idempotencyKey: "flow_command:generation:1" });
  assert.equal(result.ok, true);
  assert.equal(received.documentVersion, 4);
  assert.equal(received.quoteId, "quote:1");
  assert.match(received.idempotencyKey, /^generation_confirm:/);
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

test("wallet adapter accepts only a non-negative integer credit balance", async () => {
  const valid = createKadiV1WalletRuntimeAdapter({ balanceReader: { getBalance: async () => ({ ok: true, value: { credits: 7 } }) } });
  assert.deepEqual(await valid.getBalance({ ownerWaId: OWNER }), { ok: true, value: { credits: 7 } });
  const invalid = createKadiV1WalletRuntimeAdapter({ balanceReader: { getBalance: async () => ({ ok: true, value: { credits: 1.5 } }) } });
  assert.deepEqual(await invalid.getBalance({ ownerWaId: OWNER }), { ok: false, error: "KADI_V1_BALANCE_INVALID" });
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
