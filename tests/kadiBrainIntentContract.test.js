"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const contract = require("../kadiBrainIntentContract");

const { KADI_INTENTS, KADI_INTENT_SCHEMA_VERSION, KADI_ACTIONABLE_CONFIDENCE_THRESHOLD,
  createEmptyIntentResolution, normalizeIntentResolution, validateIntentResolution,
  isActionableIntentResolution } = contract;

function invoice(overrides = {}) {
  return normalizeIntentResolution({
    intent: "CREATE_INVOICE", confidence: 0.9, language: "fr",
    entities: { documentType: "invoice", items: [{ description: "Ciment", quantity: 10, unit: "sac", unitPrice: 6500 }] },
    requestedAction: { type: "CREATE_DOCUMENT", target: "invoice" }, ...overrides,
  });
}

test("creates the exact empty deterministic resolution", () => {
  const first = createEmptyIntentResolution();
  const second = createEmptyIntentResolution();
  assert.equal(first.schemaVersion, "kadi.intent.v1");
  assert.equal(first.intent, "UNKNOWN");
  assert.equal(first.explanation, null);
  assert.deepEqual(first, second);
  first.entities.clientName = "changed";
  assert.equal(second.entities.clientName, null);
});

test("exports the stable version, threshold and protected intent catalog", () => {
  assert.equal(KADI_INTENT_SCHEMA_VERSION, "kadi.intent.v1");
  assert.equal(KADI_ACTIONABLE_CONFIDENCE_THRESHOLD, 0.75);
  assert.equal(Object.isFrozen(KADI_INTENTS), true);
  for (const intent of ["CREATE_QUOTE", "CREATE_INVOICE", "CREATE_RECEIPT", "CREATE_DISCHARGE", "CONVERT_QUOTE_TO_INVOICE", "SEARCH_DOCUMENT", "LIST_RECENT_DOCUMENTS", "DOWNLOAD_DOCUMENT", "MODIFY_DOCUMENT", "CANCEL_DOCUMENT_OPERATION", "CHECK_CREDITS", "BUY_CREDITS", "SUBMIT_PAYMENT_PROOF", "CHECK_PAYMENT_STATUS", "UPDATE_BUSINESS_PROFILE", "ADD_LOGO", "ADD_STAMP", "ENABLE_STAMP", "DISABLE_STAMP", "ASK_HELP", "ASK_PRODUCT_QUESTION", "CONTACT_SUPPORT", "GREETING", "THANKS", "GOODBYE", "CONFIRM", "REJECT", "PROVIDE_MISSING_INFORMATION", "CORRECT_PREVIOUS_INFORMATION", "CONTINUE_CURRENT_FLOW", "SENSITIVE_DATA_WARNING", "UNSUPPORTED_REQUEST", "UNKNOWN"]) assert.equal(KADI_INTENTS[intent], intent);
});

test("normalizes partial and ordinary invalid inputs to a complete shape", () => {
  for (const value of [null, undefined, [], "text", 1]) assert.deepEqual(normalizeIntentResolution(value), createEmptyIntentResolution());
  const result = normalizeIntentResolution({ intent: "CHECK_CREDITS", language: " fr " });
  assert.equal(result.intent, "CHECK_CREDITS");
  assert.equal(result.language, "fr");
  assert.deepEqual(Object.keys(result), Object.keys(createEmptyIntentResolution()));
});

test("normalization never mutates frozen input", () => {
  const input = Object.freeze({ intent: "CREATE_INVOICE", entities: Object.freeze({ documentType: "invoice" }) });
  assert.doesNotThrow(() => normalizeIntentResolution(input));
  assert.equal(input.entities.documentType, "invoice");
});

test("unknown intentions fail closed to UNKNOWN", () => assert.equal(normalizeIntentResolution({ intent: "MAKE_MAGIC" }).intent, "UNKNOWN"));

test("clamps numeric confidence and rejects non-numeric confidence", () => {
  assert.equal(normalizeIntentResolution({ confidence: 4 }).confidence, 1);
  assert.equal(normalizeIntentResolution({ confidence: -2 }).confidence, 0);
  assert.equal(normalizeIntentResolution({ confidence: "0.9" }).confidence, 0);
});

test("normalizes invalid arrays and canonical items without calculating totals", () => {
  const invalid = normalizeIntentResolution({ missingFields: {}, ambiguities: "x", entities: { items: {} } });
  assert.deepEqual(invalid.missingFields, []); assert.deepEqual(invalid.ambiguities, []); assert.deepEqual(invalid.entities.items, []);
  const item = normalizeIntentResolution({ entities: { items: [{ description: " Ciment ", quantity: 10, unit: " sac ", unitPrice: 6500, total: "65000", secret: true }] } }).entities.items[0];
  assert.deepEqual(item, { description: "Ciment", quantity: 10, unit: "sac", unitPrice: 6500, total: null });
});

test("drops unknown and raw WhatsApp identity properties", () => {
  const result = normalizeIntentResolution({ waId: "raw", bsuid: "raw", unknown: true, entities: { unknown: true } });
  assert.equal(Object.hasOwn(result, "waId"), false); assert.equal(Object.hasOwn(result, "bsuid"), false);
  assert.equal(Object.hasOwn(result, "unknown"), false); assert.equal(Object.hasOwn(result.entities, "unknown"), false);
});

test("validates correct resolutions and reports invalid intent, version and identity", () => {
  assert.deepEqual(validateIntentResolution(invoice()), { valid: true, errors: [] });
  const invalidIntent = { ...invoice(), intent: "INVALID" };
  assert.equal(validateIntentResolution(invalidIntent).errors.some((error) => error.code === "INVALID_INTENT"), true);
  const invalidVersion = { ...invoice(), schemaVersion: "v2" };
  assert.equal(validateIntentResolution(invalidVersion).errors.some((error) => error.code === "INVALID_SCHEMA_VERSION"), true);
  const rawIdentity = { ...invoice(), waId: "raw" };
  assert.equal(validateIntentResolution(rawIdentity).errors.some((error) => error.code === "RAW_WHATSAPP_IDENTITY_FORBIDDEN"), true);
});

test("makes a complete CREATE_INVOICE actionable", () => assert.equal(isActionableIntentResolution(invoice()), true));

test("blocks invoice creation with missing or determining fields absent", () => {
  assert.equal(isActionableIntentResolution(invoice({ missingFields: ["items"] })), false);
  assert.equal(isActionableIntentResolution(invoice({ entities: { documentType: "invoice", items: [] } })), false);
});

test("UNKNOWN, unsupported and conversational intentions are not executable", () => {
  for (const intent of ["UNKNOWN", "UNSUPPORTED_REQUEST", "GREETING", "CONFIRM"]) {
    assert.equal(isActionableIntentResolution(normalizeIntentResolution({ intent, confidence: 1 })), false);
  }
});

test("human review, sensitive data, blocking ambiguity and low confidence block execution", () => {
  assert.equal(isActionableIntentResolution(invoice({ safety: { requiresHumanReview: true } })), false);
  assert.equal(isActionableIntentResolution(invoice({ safety: { containsSensitiveData: true, reason: "otp" } })), false);
  assert.equal(isActionableIntentResolution(invoice({ ambiguities: [{ field: "documentType", options: ["invoice", "receipt"], message: "Type unclear", blocking: true }] })), false);
  assert.equal(isActionableIntentResolution(invoice({ confidence: 0.74 })), false);
});

test("SEARCH_DOCUMENT requires a search query", () => {
  const valid = normalizeIntentResolution({ intent: "SEARCH_DOCUMENT", confidence: 0.9, entities: { searchQuery: " reçu Salif " } });
  assert.equal(isActionableIntentResolution(valid), true);
  assert.equal(isActionableIntentResolution(normalizeIntentResolution({ intent: "SEARCH_DOCUMENT", confidence: 0.9 })), false);
});

test("CHECK_CREDITS needs no document entity", () => {
  const result = normalizeIntentResolution({ intent: "CHECK_CREDITS", confidence: 0.9, requestedAction: { type: "CHECK_BALANCE", target: "credits" } });
  assert.equal(isActionableIntentResolution(result), true);
  assert.equal(result.entities.documentType, null);
});

test("normalization is deterministic and outputs are independent", () => {
  const input = { intent: "CREATE_INVOICE", confidence: 0.9, entities: { documentType: "invoice", items: [{ description: "A", quantity: 1 }] } };
  const first = normalizeIntentResolution(input); const second = normalizeIntentResolution(input);
  assert.deepEqual(first, second); first.entities.items[0].description = "changed";
  assert.deepEqual(normalizeIntentResolution(input), second);
});

test("module has no external integration surface", () => {
  assert.deepEqual(Object.keys(contract).sort(), ["KADI_ACTIONABLE_CONFIDENCE_THRESHOLD", "KADI_INTENTS", "KADI_INTENT_SCHEMA_VERSION", "createEmptyIntentResolution", "isActionableIntentResolution", "normalizeIntentResolution", "validateIntentResolution"].sort());
  const result = createEmptyIntentResolution();
  assert.equal(Object.hasOwn(result, "candidateId"), false);
  assert.equal(Object.hasOwn(result, "waId"), false);
  assert.equal(Object.hasOwn(result, "bsuid"), false);
});

test("rejects malformed nested structures without throwing", () => {
  const valid = invoice();
  const malformed = [
    { ...valid, entities: {} },
    { ...valid, entities: { ...valid.entities, items: null } },
    { ...valid, entities: { ...valid.entities, items: "item" } },
    { ...valid, entities: { ...valid.entities, items: {} } },
    { ...valid, entities: null },
    { ...valid, entities: [] },
    { ...valid, safety: undefined },
    { ...valid, conversation: { isReplyToCurrentFlow: "false", requiresContext: false, contextReference: null } },
    { ...valid, requestedAction: [] },
    { ...valid, ambiguities: ["ambiguous"] },
    { ...valid, missingFields: [1] },
  ];

  for (const input of malformed) {
    assert.doesNotThrow(() => validateIntentResolution(input));
    assert.equal(validateIntentResolution(input).valid, false);
    assert.doesNotThrow(() => isActionableIntentResolution(input));
    assert.equal(isActionableIntentResolution(input), false);
  }
});

test("rejects the audited invoice shape without entities items", () => {
  const input = {
    schemaVersion: "kadi.intent.v1",
    intent: "CREATE_INVOICE",
    confidence: 0.95,
    entities: {},
    missingFields: [],
    ambiguities: [],
    requestedAction: { type: "CREATE_DOCUMENT", target: "invoice" },
    conversation: { isReplyToCurrentFlow: false, requiresContext: false, contextReference: null },
    safety: { containsSensitiveData: false, requiresHumanReview: false, reason: null },
    explanation: null,
  };
  assert.doesNotThrow(() => isActionableIntentResolution(input));
  assert.equal(validateIntentResolution(input).valid, false);
  assert.equal(isActionableIntentResolution(input), false);
});

test("keeps a canonical complete invoice actionable after validation hardening", () => {
  const input = invoice();
  assert.deepEqual(validateIntentResolution(input), { valid: true, errors: [] });
  assert.equal(isActionableIntentResolution(input), true);
});

test("source has no network or external dependency", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "kadiBrainIntentContract.js"), "utf8");
  for (const forbidden of [
    /\brequire\s*\(/,
    /\bimport\s+/,
    /\bfetch\s*\(/,
    /\baxios\b/i,
    /\bhttps?\b/i,
    /\bnet\b/i,
    /\btls\b/i,
    /\bchild_process\b/i,
    /\bsupabase\b/i,
    /\bopenai\b/i,
  ]) assert.doesNotMatch(source, forbidden);
});
