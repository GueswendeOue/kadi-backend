"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createKadiBrain, KadiBrainError } = require("../kadiV1Brain");
const {
  validateBrainRequest,
  validateBrainResult,
} = require("../kadiV1BrainContracts");
const {
  createBrainProvider,
  createGeminiBrainProvider,
  createOpenAIBrainProvider,
} = require("../kadiV1BrainProviders");

function request(modality = "TEXT", overrides = {}) {
  const inputs = {
    TEXT: { text: "Facture pour Moussa, une porte à 25000" },
    TRANSCRIPTION: { transcription: "Devis pour Awa, deux tables à 15000" },
    IMAGE: { media: { mime_type: "image/jpeg", content: Buffer.from("synthetic-image") } },
    DOCUMENT: { media: { mime_type: "application/pdf", content_ref: "document-ref-1" } },
  };
  return {
    request_id: `request-${modality.toLowerCase()}`,
    modality,
    conversation_context: { step: "collection" },
    document_type_hint: null,
    collected_data: {},
    ...inputs[modality],
    ...overrides,
  };
}

function validResult(provider = "OPENAI", overrides = {}) {
  return {
    intent: "CREATE_DOCUMENT",
    document_type: "FACTURE",
    extracted_fields: {
      client: {
        value: { name: "Client fictif" },
        status: "CONFIRMED",
        confidence: 0.95,
        source_reference: "text:client",
      },
      items: {
        value: [{ description: "Service", quantity: 1, unit: "unité", unit_price: 25000 }],
        status: "CONFIRMED",
        confidence: 0.92,
        source_reference: "text:items",
      },
    },
    missing_fields: [],
    uncertainties: [],
    confidence: 0.9,
    suggested_next_action: "REVIEW_EXTRACTED_DATA",
    user_facing_message_draft: null,
    provider_metadata: { provider },
    ...overrides,
  };
}

function providers({ openai, gemini }) {
  return {
    openai: createBrainProvider({ name: "OPENAI", understand: openai || (async () => validResult("OPENAI")) }),
    gemini: createBrainProvider({ name: "GEMINI", understand: gemini || (async () => validResult("GEMINI")) }),
  };
}

function allRoutes(provider = "OPENAI") {
  return { TEXT: provider, TRANSCRIPTION: provider, IMAGE: provider, DOCUMENT: provider };
}

test("BrainRequest represents text, transcription, image and document without provider coupling", () => {
  for (const modality of ["TEXT", "TRANSCRIPTION", "IMAGE", "DOCUMENT"]) {
    const result = validateBrainRequest(request(modality));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.value.modality, modality);
  }
});

test("selects the configured primary provider for each modality", async () => {
  const calls = [];
  const brain = createKadiBrain({
    providers: providers({
      openai: async (value) => { calls.push(["OPENAI", value.modality]); return validResult("OPENAI"); },
      gemini: async (value) => { calls.push(["GEMINI", value.modality]); return validResult("GEMINI"); },
    }),
    primaryByModality: { TEXT: "OPENAI", TRANSCRIPTION: "GEMINI", IMAGE: "GEMINI", DOCUMENT: "OPENAI" },
  });
  for (const modality of ["TEXT", "TRANSCRIPTION", "IMAGE", "DOCUMENT"]) await brain.understand(request(modality));
  assert.deepEqual(calls, [
    ["OPENAI", "TEXT"], ["GEMINI", "TRANSCRIPTION"], ["GEMINI", "IMAGE"], ["OPENAI", "DOCUMENT"],
  ]);
});

test("normalizes an existing OpenAI-shaped result into the strict brain contract", async () => {
  const provider = createOpenAIBrainProvider({
    understand: async () => ({
      kind: "items",
      docType: "facture",
      client: "Moussa",
      items: [{ label: "Porte", qty: 2, unit: "unité", unitPrice: 25000 }],
      confidence: 0.91,
    }),
  });
  const result = await provider.understand(request("TEXT"));
  assert.equal(validateBrainResult(result).ok, true);
  assert.equal(result.document_type, "FACTURE");
  assert.equal(result.extracted_fields.client.value.name, "Moussa");
  assert.equal(result.extracted_fields.items.value[0].quantity, 2);
  assert.equal(result.provider_metadata.provider, "OPENAI");
});

test("normalizes a Gemini-shaped visual extraction and keeps read totals uncertain", async () => {
  const provider = createGeminiBrainProvider({
    understand: async () => ({
      documentType: "devis",
      client: "Awa",
      items: [{ label: "Table", quantity: 1, unitPrice: 30000 }],
      detectedTotal: 30000,
      confidence: 0.88,
    }),
  });
  const result = await provider.understand(request("IMAGE"));
  assert.equal(validateBrainResult(result).ok, true);
  assert.equal(result.document_type, "DEVIS");
  assert.equal(result.extracted_fields.total_read.status, "UNCERTAIN");
  assert.ok(result.missing_fields.includes("total_read"));
  assert.ok(result.uncertainties.some(({ field }) => field === "total_read"));
  assert.equal(result.provider_metadata.provider, "GEMINI");
});

test("reports missing fields and a targeted question instead of inventing data", async () => {
  const provider = createOpenAIBrainProvider({
    understand: async () => ({ kind: "intent_only", docType: "facture", confidence: 0.8 }),
  });
  const result = await provider.understand(request("TEXT"));
  assert.deepEqual(result.missing_fields, ["client", "items"]);
  assert.equal(result.suggested_next_action, "ASK_TARGETED_QUESTION");
  assert.match(result.user_facing_message_draft, /nom du client/i);
  assert.equal(validateBrainResult(result).ok, true);
});

test("rejects unknown result fields and effective business authority decisions", () => {
  const unknown = validateBrainResult({ ...validResult(), payload: "forbidden" });
  const authority = validateBrainResult({ ...validResult(), total: 25000 });
  assert.equal(unknown.ok, false);
  assert.equal(authority.ok, false);
});

test("rejects provider metadata that could carry credentials", () => {
  const result = validResult("OPENAI", {
    provider_metadata: { provider: "OPENAI", request_ref: "Bearer synthetic-secret" },
  });
  assert.equal(validateBrainResult(result).error, "BRAIN_PROVENANCE_REQUIRED");
});

test("rejects unknown document types and mismatched provider provenance", async () => {
  const adapter = createGeminiBrainProvider({
    understand: async () => ({ documentType: "PROFORMA_UNKNOWN", confidence: 0.9 }),
  });
  await assert.rejects(adapter.understand(request("IMAGE")), (error) => error.code === "BRAIN_DOCUMENT_TYPE_INVALID");

  const brain = createKadiBrain({
    providers: providers({ openai: async () => validResult("GEMINI") }),
    primaryByModality: allRoutes("OPENAI"),
  });
  await assert.rejects(brain.understand(request()), /BRAIN_PROVIDER_PROVENANCE_MISMATCH/);
});

test("rejects negative quantities and incoherent numeric candidates", () => {
  const result = validResult();
  result.extracted_fields.items.value[0].quantity = -1;
  assert.equal(validateBrainResult(result).error, "BRAIN_EXTRACTED_VALUE_INVALID");
  assert.equal(validateBrainResult({ ...validResult(), confidence: Number.NaN }).error, "BRAIN_CONFIDENCE_INVALID");
});

test("legacy adapters explicitly mark invalid numeric extraction as uncertain", async () => {
  const provider = createOpenAIBrainProvider({
    understand: async () => ({
      kind: "items",
      docType: "facture",
      client: "Moussa",
      items: [{ label: "Porte", qty: -2, unitPrice: 25000 }],
      confidence: 0.9,
    }),
  });
  const result = await provider.understand(request());
  assert.equal(validateBrainResult(result).ok, true);
  assert.ok(result.missing_fields.includes("items"));
  assert.ok(result.uncertainties.some(({ field, reason }) => field === "items" && reason === "INVALID_ITEM_VALUE"));
});

test("rejects an uncertain field without missing-field and targeted-question safeguards", () => {
  const result = validResult();
  result.extracted_fields.client.status = "UNCERTAIN";
  result.uncertainties = [{
    field: "client",
    reason: "AMBIGUOUS_NAME",
    confidence: 0.4,
    source_reference: "text:client",
  }];
  assert.equal(validateBrainResult(result).error, "BRAIN_MISSING_FIELD_REQUIRED");
});

test("PRIMARY_ONLY propagates a controlled primary failure without fallback", async () => {
  let geminiCalls = 0;
  const brain = createKadiBrain({
    providers: providers({
      openai: async () => { throw Object.assign(new Error("secret details"), { code: "PROVIDER_TIMEOUT" }); },
      gemini: async () => { geminiCalls += 1; return validResult("GEMINI"); },
    }),
    primaryByModality: allRoutes("OPENAI"),
  });
  await assert.rejects(brain.understand(request()), (error) => error instanceof KadiBrainError && error.code === "PROVIDER_TIMEOUT");
  assert.equal(geminiCalls, 0);
});

test("CONTROLLED_FALLBACK uses only the explicitly configured secondary after failure", async () => {
  const calls = [];
  const brain = createKadiBrain({
    providers: providers({
      openai: async () => { calls.push("OPENAI"); throw new Error("unavailable"); },
      gemini: async () => { calls.push("GEMINI"); return validResult("GEMINI"); },
    }),
    primaryByModality: allRoutes("OPENAI"),
    fallbackByModality: allRoutes("GEMINI"),
    policy: "CONTROLLED_FALLBACK",
  });
  const result = await brain.understand(request());
  assert.deepEqual(calls, ["OPENAI", "GEMINI"]);
  assert.equal(result.provider_metadata.provider, "GEMINI");
});

test("CONTROLLED_FALLBACK remains fail-closed when no route is explicitly enabled", async () => {
  let secondaryCalls = 0;
  const brain = createKadiBrain({
    providers: providers({
      openai: async () => { throw new Error("unavailable"); },
      gemini: async () => { secondaryCalls += 1; return validResult("GEMINI"); },
    }),
    primaryByModality: allRoutes("OPENAI"),
    policy: "CONTROLLED_FALLBACK",
  });
  await assert.rejects(brain.understand(request()), /BRAIN_PROVIDER_FAILED/);
  assert.equal(secondaryCalls, 0);
});

test("SHADOW_COMPARE returns only the primary result and runs the shadow sequentially", async () => {
  const order = [];
  const brain = createKadiBrain({
    providers: providers({
      openai: async () => { order.push("primary"); return validResult("OPENAI", { document_type: "FACTURE" }); },
      gemini: async () => { order.push("shadow"); return validResult("GEMINI", { document_type: "DEVIS" }); },
    }),
    primaryByModality: allRoutes("OPENAI"),
    shadowByModality: allRoutes("GEMINI"),
    policy: "SHADOW_COMPARE",
  });
  const result = await brain.understand(request());
  assert.deepEqual(order, ["primary", "shadow"]);
  assert.equal(result.document_type, "FACTURE");
  assert.equal(result.provider_metadata.provider, "OPENAI");
});

test("a shadow failure never blocks or changes the primary user result", async () => {
  const brain = createKadiBrain({
    providers: providers({
      openai: async () => validResult("OPENAI"),
      gemini: async () => { throw new Error("shadow failed"); },
    }),
    primaryByModality: allRoutes("OPENAI"),
    shadowByModality: allRoutes("GEMINI"),
    policy: "SHADOW_COMPARE",
  });
  assert.equal((await brain.understand(request())).provider_metadata.provider, "OPENAI");
});

test("observability uses stable safe events without request content, media or provider errors", async () => {
  const logs = [];
  const secretText = "Bearer synthetic-secret client IFU 123456789";
  const brain = createKadiBrain({
    providers: providers({ openai: async () => validResult("OPENAI") }),
    primaryByModality: allRoutes("OPENAI"),
    logger: (event, details) => logs.push({ event, details }),
  });
  await brain.understand(request("TEXT", { text: secretText }));
  const serialized = JSON.stringify(logs);
  assert.ok(logs.some(({ event }) => event === "brain_request_started"));
  assert.ok(logs.some(({ event }) => event === "brain_result_validated"));
  assert.doesNotMatch(serialized, /synthetic-secret|123456789|Bearer|Client fictif|25000/);
  assert.match(logs[0].details.correlation_id, /^[a-f0-9]{16}$/);
  assert.notEqual(logs[0].details.correlation_id, "request-text");
});

test("logger failures never alter result validation or propagation", async () => {
  const brain = createKadiBrain({
    providers: providers({}),
    primaryByModality: allRoutes("OPENAI"),
    logger: () => { throw new Error("logger unavailable"); },
  });
  assert.equal((await brain.understand(request())).intent, "CREATE_DOCUMENT");
});

test("validated results are deeply immutable", () => {
  const checked = validateBrainResult(validResult());
  assert.equal(checked.ok, true);
  assert.equal(Object.isFrozen(checked.value), true);
  assert.equal(Object.isFrozen(checked.value.extracted_fields.client), true);
  assert.throws(() => { checked.value.extracted_fields.client.value.name = "Changed"; }, TypeError);
});

test("providers are modality-independent and receive dependencies only by injection", async () => {
  const modalities = [];
  const provider = createGeminiBrainProvider({
    understand: async (value) => {
      modalities.push(value.modality);
      return { kind: "intent_only", documentType: "recu", confidence: 0.9 };
    },
  });
  for (const modality of ["TEXT", "TRANSCRIPTION", "IMAGE", "DOCUMENT"]) await provider.understand(request(modality));
  assert.deepEqual(modalities, ["TEXT", "TRANSCRIPTION", "IMAGE", "DOCUMENT"]);
});

test("the isolated brain core has no Meta, wallet, PDF, Supabase or provider SDK dependency", () => {
  for (const filename of ["kadiV1Brain.js", "kadiV1BrainContracts.js", "kadiV1BrainProviders.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", filename), "utf8");
    assert.doesNotMatch(source, /require\(["'](?:openai|@google\/generative-ai|@supabase\/supabase-js|\.\/whatsappApi|\.\/kadiPdf|\.\/kadiCreditsRepo)/i);
    assert.doesNotMatch(source, /flow_id|phone_number_id|wallet|decrement_credit|generatePdf/i);
  }
});
