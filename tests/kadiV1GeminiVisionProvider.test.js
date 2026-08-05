"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createKadiBrain } = require("../kadiV1Brain");
const { validateBrainResult } = require("../kadiV1BrainContracts");
const { checksumBuffer } = require("../kadiV1MediaContracts");
const { createInMemoryTemporaryMediaStore } = require("../kadiV1TemporaryMediaStore");
const { GeminiVisionError, createGeminiVisionProvider, createGoogleGenerativeAIClientAdapter, normalizeStructuredExtraction } = require("../kadiV1GeminiVisionProvider");

const OWNER = "vision_owner";
const CONTRACT = Object.freeze({
  media_id: "media_vision",
  owner_ref: OWNER,
  source_type: "IMAGE",
  mime_type: "image/png",
  byte_size: 5,
  checksum: checksumBuffer(Buffer.from("image")),
  page_count: 1,
  correlation_id: "corr_vision",
  storage_reference: "temporary-private://vision/media_vision",
  received_at: "2026-08-02T12:00:00.000Z",
  expires_at: "2026-08-02T13:00:00.000Z",
});

function raw(type = "FACTURE", fields = {}) {
  return {
    document_type: type,
    fields: {
      client: { value: { name: "Client Exemple" }, confidence: 0.95, source_reference: "page:1:header" },
      items: { value: [{ description: "Ordinateur", quantity: 2, unit: "unité", unit_price: 250000, confidence: 0.92, status: "CONFIRMED", source_reference: "page:1:row1" }], confidence: 0.92, source_reference: "page:1:table" },
      currency: { value: "XOF", confidence: 0.99, source_reference: "page:1:footer" },
      ...fields,
    },
    missing_fields: [],
    uncertainties: [],
    confidence: 0.91,
  };
}

async function setup({ response = raw(), clientError = null, config = {}, logger = null, content = Buffer.from("image") } = {}) {
  const store = createInMemoryTemporaryMediaStore({ clock: () => "2026-08-02T12:10:00.000Z" });
  await store.storeTemporaryMedia({ contract: { ...CONTRACT, byte_size: content.length, checksum: checksumBuffer(content) }, content });
  const calls = [];
  const client = { generateStructured: async (request) => { calls.push(request); if (clientError) throw clientError; return structuredClone(response); } };
  const provider = createGeminiVisionProvider({
    client,
    temporaryMediaStore: store,
    config: { enabled: true, model: "configured-vision-model", timeoutMs: 100, maxRetries: 0, temperature: 0, minimumConfidence: 0.7, policy: "GEMINI_PRIMARY_ONLY", maxImageBytes: 1000, maxPdfBytes: 2000, maxPages: 5, ...config },
    logger,
  });
  const request = { request_id: "brain_visual", modality: "IMAGE", media: { ...CONTRACT, byte_size: content.length, checksum: checksumBuffer(content) }, conversation_context: {}, collected_data: {} };
  return { store, calls, client, provider, request };
}

test("normalizes photographed invoice fields with page provenance", async () => {
  const { provider, request } = await setup();
  const result = await provider.analyzeImage(request);
  assert.equal(validateBrainResult(result).ok, true);
  assert.equal(result.document_type, "FACTURE");
  assert.equal(result.extracted_fields.items.value.length, 1);
  assert.equal(result.extracted_fields.client.source_reference, "page:1:header");
  assert.equal(result.extracted_fields.currency.value, "XOF");
  assert.equal(result.extracted_fields.items.value[0].source_reference, "page:1:row1");
});

test("empty extraction reports missing fields without inventing values", () => {
  const result = normalizeStructuredExtraction({ document_type: "FACTURE", fields: {}, confidence: 0.8 }, { model: "configured-model" });
  assert.deepEqual(result.extracted_fields, {});
  assert.deepEqual(result.missing_fields, ["client", "items"]);
  assert.equal(result.suggested_next_action, "ASK_TARGETED_QUESTION");
});

test("unknown document type remains missing and requires confirmation", () => {
  const result = normalizeStructuredExtraction({ document_type: null, fields: {}, confidence: 0.9 }, { model: "configured-model" });
  assert.ok(result.missing_fields.includes("document_type"));
  assert.ok(result.uncertainties.some(({ reason }) => reason === "DOCUMENT_TYPE_UNKNOWN"));
});

test("supports devis, reçu and décharge through the same provider", async () => {
  const cases = [
    ["DEVIS", { client: { value: { name: "Client" }, confidence: 1, source_reference: "page:1" }, items: { value: [{ description: "Table", quantity: 1, unit_price: 10, confidence: 1, status: "CONFIRMED", source_reference: "page:1" }], confidence: 1, source_reference: "page:1" } }],
    ["RECU", { payer: { value: "Payeur", confidence: 1, source_reference: "page:1" }, amount: { value: 1000, confidence: 1, source_reference: "page:1" } }],
    ["DECHARGE", { giver: { value: "Remettant", confidence: 1, source_reference: "page:1" }, receiver: { value: "Receveur", confidence: 1, source_reference: "page:1" }, subject: { value: "Document", confidence: 1, source_reference: "page:1" }, reason: { value: "Remise", confidence: 1, source_reference: "page:1" } }],
  ];
  for (const [type, fields] of cases) {
    const result = normalizeStructuredExtraction({ document_type: type, fields, confidence: 0.95 }, { model: "configured-model" });
    assert.equal(result.document_type, type);
    assert.equal(validateBrainResult(result).ok, true);
  }
});

test("deduplicates exact repeated items across pages", async () => {
  const repeated = { description: "Cahier", quantity: 2, unit: "pièce", unit_price: 500, confidence: 0.9, status: "CONFIRMED", source_reference: "page:1:row1" };
  const result = normalizeStructuredExtraction(raw("FACTURE", { items: { value: [repeated, repeated], confidence: 0.9, source_reference: "page:1" } }), { model: "configured-model" });
  assert.equal(result.extracted_fields.items.value.length, 1);
});

test("keeps handwritten or masked prices uncertain and asks one targeted question", () => {
  const result = normalizeStructuredExtraction(raw("FACTURE", {
    items: { value: [{ description: "Ordinateur", quantity: 1, unit_price: 15000, confidence: 0.35, status: "UNCERTAIN", source_reference: "page:1:row2" }], confidence: 0.35, status: "UNCERTAIN", uncertainty_reason: "HANDWRITING_DIFFICULT_TO_READ", source_reference: "page:1:row2" },
  }), { model: "configured-model" });
  assert.equal(result.extracted_fields.items.status, "UNCERTAIN");
  assert.ok(result.uncertainties.some(({ reason }) => reason === "HANDWRITING_DIFFICULT_TO_READ"));
  assert.equal(result.suggested_next_action, "ASK_TARGETED_QUESTION");
});

test("marks page contradictions and multiple documents without merging silently", () => {
  const result = normalizeStructuredExtraction({ ...raw(), multiple_documents: true, uncertainties: [{ field: "client", reason: "CONTRADICTORY_VALUES_BETWEEN_PAGES", confidence: 0.2, source_reference: "page:2" }] }, { model: "configured-model" });
  assert.ok(result.uncertainties.some(({ reason }) => reason === "CONTRADICTORY_VALUES_BETWEEN_PAGES"));
  assert.ok(result.uncertainties.some(({ reason }) => reason === "MULTIPLE_DOCUMENTS_DETECTED"));
  assert.equal(result.suggested_next_action, "ASK_TARGETED_QUESTION");
});

test("read total is always uncertain and never becomes backend authority", () => {
  const result = normalizeStructuredExtraction(raw("FACTURE", { total_read: { value: 500000, confidence: 1, source_reference: "page:1:total" } }), { model: "configured-model" });
  assert.equal(result.extracted_fields.total_read.status, "UNCERTAIN");
  assert.ok(result.uncertainties.some(({ reason }) => reason === "SERVER_RECALCULATION_REQUIRED"));
  assert.equal("total" in result, false);
});

test("rejects reserved authority fields, unknown fields and invalid items", () => {
  assert.throws(() => normalizeStructuredExtraction({ ...raw(), total: 500000 }, { model: "m" }), (error) => error.code === "VISION_AUTHORITY_FIELD_FORBIDDEN");
  assert.throws(() => normalizeStructuredExtraction(raw("FACTURE", { invented: { value: "x", confidence: 1 } }), { model: "m" }), /VISION_FIELD_FORBIDDEN/);
  assert.throws(() => normalizeStructuredExtraction({ ...raw(), private_ocr_dump: "forbidden" }, { model: "m" }), /VISION_RESULT_FIELD_FORBIDDEN/);
  assert.throws(() => normalizeStructuredExtraction(raw("FACTURE", { items: { value: [{ description: "X", quantity: -1, unit_price: 1, confidence: 1, status: "CONFIRMED", source_reference: "page:1" }], confidence: 1 } }), { model: "m" }), /VISION_ITEMS_INVALID/);
});

test("specialized analysis methods enforce media source type", async () => {
  const { provider, request } = await setup();
  await assert.rejects(provider.analyzePdf(request), (error) => error.code === "MEDIA_SOURCE_TYPE_INVALID");
  await assert.rejects(provider.analyzeDocument(request), (error) => error.code === "MEDIA_SOURCE_TYPE_INVALID");
});

test("analyzeDocument preserves ordered multi-image pages sent to Gemini", async () => {
  const first = Buffer.from("page-one");
  const second = Buffer.from("page-two");
  const combined = Buffer.concat([first, second]);
  const contract = {
    ...CONTRACT,
    media_id: "media_multi",
    source_type: "MULTI_IMAGE",
    byte_size: combined.length,
    checksum: checksumBuffer(combined),
    page_count: 2,
    storage_reference: "temporary-private://vision/media_multi",
  };
  const store = createInMemoryTemporaryMediaStore({ clock: () => "2026-08-02T12:10:00.000Z" });
  await store.storeTemporaryMedia({ contract, content: [first, second] });
  const calls = [];
  const provider = createGeminiVisionProvider({
    client: { generateStructured: async ({ media }) => { calls.push(media); return raw(); } },
    temporaryMediaStore: store,
    config: { enabled: true, model: "configured-model", timeoutMs: 100, maxRetries: 0, temperature: 0, policy: "GEMINI_PRIMARY_ONLY", minimumConfidence: 0.7, maxImageBytes: 1000, maxPdfBytes: 2000, maxPages: 5 },
  });
  await provider.analyzeDocument({ request_id: "multi", modality: "DOCUMENT", media: contract });
  assert.equal(calls[0][0].buffer.equals(first), true);
  assert.equal(calls[0][1].buffer.equals(second), true);
});

test("integrates as the configured IMAGE provider in Kadi Brain", async () => {
  const { provider, request } = await setup();
  const brain = createKadiBrain({ providers: { gemini: provider }, primaryByModality: { TEXT: "GEMINI", TRANSCRIPTION: "GEMINI", IMAGE: "GEMINI", DOCUMENT: "GEMINI" } });
  const result = await brain.understand(request);
  assert.equal(result.provider_metadata.provider, "GEMINI");
  assert.equal(result.document_type, "FACTURE");
});

test("feature flag, ownership and provider failure return recoverable errors", async () => {
  const disabled = await setup({ config: { enabled: false } });
  await assert.rejects(disabled.provider.understand(disabled.request), (error) => error instanceof GeminiVisionError && error.recoverable && error.code === "VISION_FEATURE_DISABLED");
  const wrongOwner = await setup();
  await assert.rejects(wrongOwner.provider.understand({ ...wrongOwner.request, media: { ...wrongOwner.request.media, owner_ref: "other_owner" } }), (error) => error.code === "MEDIA_NOT_FOUND");
  const failed = await setup({ clientError: new Error("private provider details") });
  await assert.rejects(failed.provider.understand(failed.request), (error) => error.recoverable && error.code === "VISION_PROVIDER_FAILED" && /photo plus nette/i.test(error.user_message));
});

test("configuration controls model, deterministic temperature and retry count", async () => {
  let attempts = 0;
  const base = await setup({ config: { maxRetries: 2, temperature: 0.1 } });
  base.client.generateStructured = async (request) => { attempts += 1; if (attempts < 3) throw new Error("retry"); base.calls.push(request); return raw(); };
  const result = await base.provider.understand(base.request);
  assert.equal(result.document_type, "FACTURE");
  assert.equal(attempts, 3);
  assert.equal(base.calls[0].model, "configured-vision-model");
  assert.equal(base.calls[0].temperature, 0.1);
});

test("provider timeout does not start an overlapping retry", async () => {
  let attempts = 0;
  const pending = new Promise(() => {});
  const base = await setup({ config: { maxRetries: 3, timeoutMs: 10 } });
  base.client.generateStructured = async () => { attempts += 1; return pending; };
  await assert.rejects(base.provider.understand(base.request), (error) => error.code === "VISION_PROVIDER_TIMEOUT");
  assert.equal(attempts, 1);
});

test("Google SDK adapter uses configured model and structured JSON mode", async () => {
  const calls = [];
  const adapter = createGoogleGenerativeAIClientAdapter({ client: {
    getGenerativeModel: ({ model }) => ({ generateContent: async (request) => { calls.push({ model, request }); return { response: { text: () => '{"document_type":"FACTURE","fields":{},"confidence":0.8}' } }; } }),
  } });
  const result = await adapter.generateStructured({ model: "runtime-model", prompt: "safe prompt", media: [{ mime_type: "image/png", buffer: Buffer.from("x") }], temperature: 0 });
  assert.equal(result.document_type, "FACTURE");
  assert.equal(calls[0].model, "runtime-model");
  assert.equal(calls[0].request.generationConfig.responseMimeType, "application/json");
});

test("provider sends only media bytes, MIME, prompt and configured generation settings", async () => {
  const { provider, request, calls } = await setup();
  await provider.understand(request);
  const serializedKeys = JSON.stringify(Object.keys(calls[0]).sort());
  assert.equal(serializedKeys, JSON.stringify(["media", "model", "prompt", "temperature"]));
  assert.doesNotMatch(JSON.stringify(calls[0], (_key, value) => Buffer.isBuffer(value) ? "<buffer>" : value), /vision_owner|temporary-private|token|phone|ifu|rccm/i);
});

test("safe logs never include OCR text, names, private references or provider errors", async () => {
  const logs = [];
  const { provider, request } = await setup({ logger: (event, details) => logs.push({ event, details }) });
  await provider.understand(request);
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /Client Exemple|Ordinateur|temporary-private|vision_owner|250000|image$/i);
  assert.ok(logs.some(({ event }) => event === "structured_extraction_validated"));
});

test("visual provider has no document persistence, wallet, PDF generation or webhook dependency", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "kadiV1GeminiVisionProvider.js"), "utf8");
  assert.doesNotMatch(source, /require\([^\n]*(supabase|whatsapp|wallet|payment|pdfkit|kadiV1DocumentRepository)/i);
  assert.doesNotMatch(source, /\.debit\(|persistDocument\(|generatePdf\(|sendMessage\(/i);
});

// --- Authority-boundary hardening: canonical AUTHORITY_FIELDS reuse ---
// These lock in that no authority-shaped value can pass through Gemini
// Vision structured extraction, regardless of which layer (top-level key
// allowlist, per-field key allowlist, item key allowlist, or the final
// validateBrainResult pass) is what actually blocks it.

test("a top-level credit_debit key is rejected", () => {
  assert.throws(
    () => normalizeStructuredExtraction({ document_type: "FACTURE", fields: {}, confidence: 0.9, credit_debit: 500 }, { model: "m" }),
    (error) => error instanceof GeminiVisionError
  );
});

test("a top-level delivered key is rejected", () => {
  assert.throws(
    () => normalizeStructuredExtraction({ document_type: "FACTURE", fields: {}, confidence: 0.9, delivered: true }, { model: "m" }),
    (error) => error instanceof GeminiVisionError
  );
});

test("a field literally named credit_debit is rejected", () => {
  assert.throws(
    () => normalizeStructuredExtraction({
      document_type: "FACTURE",
      fields: { credit_debit: { value: 500, confidence: 0.9, source_reference: "page:1" } },
      confidence: 0.9,
    }, { model: "m" }),
    (error) => error instanceof GeminiVisionError
  );
});

test("a field name in a different casing (Delivered) is still rejected, not bypassed by case", () => {
  assert.throws(
    () => normalizeStructuredExtraction({
      document_type: "FACTURE",
      fields: { Delivered: { value: true, confidence: 0.9, source_reference: "page:1" } },
      confidence: 0.9,
    }, { model: "m" }),
    (error) => error instanceof GeminiVisionError
  );
});

test("an authority-shaped key nested inside an allowed field's value is rejected", () => {
  assert.throws(
    () => normalizeStructuredExtraction({
      document_type: "FACTURE",
      fields: { client: { value: { name: "Moussa", total: 999999999, credit_debit: true }, confidence: 0.95, source_reference: "page:1" } },
      confidence: 0.9,
    }, { model: "m" }),
    (error) => error instanceof GeminiVisionError
  );
});

test("an authority-shaped key inside an item in the items array is rejected", () => {
  assert.throws(
    () => normalizeStructuredExtraction({
      document_type: "FACTURE",
      fields: {
        items: {
          value: [{ description: "x", quantity: 1, unit_price: 1, total: 999999, confidence: 1, status: "CONFIRMED", source_reference: "page:1" }],
          confidence: 0.9,
          source_reference: "page:1",
        },
      },
      confidence: 0.9,
    }, { model: "m" }),
    (error) => error instanceof GeminiVisionError
  );
});

test("FORBIDDEN_AUTHORITY_KEYS is not a second independent list: every canonical AUTHORITY_FIELDS entry is covered", () => {
  const { AUTHORITY_FIELDS } = require("../kadiV1BrainContracts");
  const source = fs.readFileSync(path.join(__dirname, "..", "kadiV1GeminiVisionProvider.js"), "utf8");
  assert.doesNotMatch(source, /const FORBIDDEN_AUTHORITY_KEYS = new Set/, "must import the canonical list, not redefine it");
  for (const field of AUTHORITY_FIELDS) {
    assert.throws(
      () => normalizeStructuredExtraction({ document_type: "FACTURE", fields: {}, confidence: 0.9, [field]: "x" }, { model: "m" }),
      (error) => error instanceof GeminiVisionError,
      `${field} should be forbidden`
    );
  }
});
