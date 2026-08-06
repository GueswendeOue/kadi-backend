"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  CONVERSATIONAL_EVENTS,
  createConversationalObservabilityEmitter,
  latencyBucket,
} = require("../kadiV1ConversationalMultimodalObservability");

const FORBIDDEN_SUBSTRINGS = [
  "22670000000", "Moussa", "raw text", "transcript", "livraison",
  "35000", "prompt", "Bearer ", "flow_token", "media:m1",
];

function containsForbiddenContent(payload) {
  const serialized = JSON.stringify(payload);
  return FORBIDDEN_SUBSTRINGS.some((needle) => serialized.includes(needle));
}

test("only the five required event names are recognized", () => {
  assert.deepEqual([...CONVERSATIONAL_EVENTS].sort(), [
    "conversational_clarification_required",
    "conversational_draft_applied",
    "conversational_fallback_selected",
    "conversational_result_validated",
    "conversational_route_selected",
  ]);
});

test("unknown event names are silently dropped, never reach the sink", () => {
  const calls = [];
  const emit = createConversationalObservabilityEmitter((event, details) => calls.push({ event, details }));
  emit("some_other_event", { correlation_id: "c1" });
  assert.equal(calls.length, 0);
});

test("a real request payload full of sensitive fields is reduced to the safe allowlist only", () => {
  const calls = [];
  const emit = createConversationalObservabilityEmitter((event, details) => calls.push({ event, details }));
  emit("conversational_route_selected", {
    correlation_id: "corr:22670000000:1",
    source: "TEXT",
    intent: "CREATE_DOCUMENT",
    document_type: "FACTURE",
    operation: null,
    result_status: "OK",
    missing_field_count: 2,
    ambiguous_field_count: 0,
    provider_category: "BRAIN",
    duration_ms: 450,
    fallback_reason_code: null,
    // sensitive fields that must never reach the sink:
    ownerWaId: "22670000000",
    text: "Fais une facture pour Moussa, livraison 35000 FCFA",
    transcription: "raw text transcript",
    extracted_entities: { client: { value: { name: "Moussa" } } },
    media_id: "media:m1:full",
    flow_token: "flow_token_secret_value",
    prompt: "system prompt with instructions",
    authorization: "Bearer abc123",
  });
  assert.equal(calls.length, 1);
  const { event, details } = calls[0];
  assert.equal(event, "conversational_route_selected");
  assert.deepEqual(Object.keys(details).sort(), [
    "ambiguous_field_count", "correlation_ref", "document_type", "fallback_reason_code",
    "intent", "latency_bucket", "missing_field_count", "operation", "provider_category",
    "result_status", "source",
  ]);
  assert.equal(details.source, "TEXT");
  assert.equal(details.intent, "CREATE_DOCUMENT");
  assert.equal(details.document_type, "FACTURE");
  assert.equal(details.result_status, "OK");
  assert.equal(details.missing_field_count, 2);
  assert.equal(details.ambiguous_field_count, 0);
  assert.equal(details.provider_category, "BRAIN");
  assert.equal(details.latency_bucket, "LT_1S");
  assert.ok(!containsForbiddenContent(details), "no sensitive content must leak into the emitted payload");
});

test("correlation_id is one-way hashed and truncated, never passed through in clear", () => {
  const calls = [];
  const emit = createConversationalObservabilityEmitter((event, details) => calls.push(details));
  emit("conversational_result_validated", { correlation_id: "22670000000:corr:1" });
  const expectedHash = crypto.createHash("sha256").update("22670000000:corr:1").digest("hex").slice(0, 16);
  assert.equal(calls[0].correlation_ref, expectedHash);
  assert.notEqual(calls[0].correlation_ref, "22670000000:corr:1");
});

test("missing or non-string correlation_id yields a null correlation_ref, never crashes", () => {
  const calls = [];
  const emit = createConversationalObservabilityEmitter((event, details) => calls.push(details));
  emit("conversational_result_validated", {});
  emit("conversational_result_validated", { correlation_id: 12345 });
  assert.equal(calls[0].correlation_ref, null);
  assert.equal(calls[1].correlation_ref, null);
});

test("invalid enum values are dropped to null rather than passed through unchecked", () => {
  const calls = [];
  const emit = createConversationalObservabilityEmitter((event, details) => calls.push(details));
  emit("conversational_fallback_selected", {
    source: "SMS", intent: "DELETE_EVERYTHING", document_type: "INVOICE",
    operation: "DROP_TABLE", result_status: "MAYBE", provider_category: "CLAUDE",
    fallback_reason_code: "not a valid code!",
  });
  const details = calls[0];
  assert.equal(details.source, null);
  assert.equal(details.intent, null);
  assert.equal(details.document_type, null);
  assert.equal(details.operation, null);
  assert.equal(details.result_status, null);
  assert.equal(details.provider_category, null);
  assert.equal(details.fallback_reason_code, null);
});

test("CHANGE_DOCUMENT_TYPE is a valid intent and survives emission unchanged", () => {
  const calls = [];
  const emit = createConversationalObservabilityEmitter((event, details) => calls.push(details));
  emit("conversational_route_selected", {
    intent: "CHANGE_DOCUMENT_TYPE", operation: "CHANGE_DOCUMENT_TYPE", document_type: "DEVIS",
    result_status: "OK", source: "TEXT", correlation_id: "corr:1",
  });
  emit("conversational_draft_applied", {
    intent: "CHANGE_DOCUMENT_TYPE", operation: "CHANGE_DOCUMENT_TYPE", document_type: "FACTURE",
    result_status: "OK", source: "TEXT", correlation_id: "corr:1",
  });
  assert.equal(calls.length, 2);
  for (const details of calls) {
    assert.equal(details.intent, "CHANGE_DOCUMENT_TYPE");
    assert.equal(details.operation, "CHANGE_DOCUMENT_TYPE");
  }
  assert.equal(calls[0].document_type, "DEVIS");
  assert.equal(calls[1].document_type, "FACTURE");
});

test("an unknown/unmapped intent still becomes null under the same closed-enum policy used for every other field", () => {
  const calls = [];
  const emit = createConversationalObservabilityEmitter((event, details) => calls.push(details));
  emit("conversational_route_selected", { intent: "SOME_FUTURE_INTENT_NOT_YET_ALLOWLISTED" });
  assert.equal(calls[0].intent, null);
});

test("CHANGE_DOCUMENT_TYPE events still contain no personal data", () => {
  const calls = [];
  const emit = createConversationalObservabilityEmitter((event, details) => calls.push(details));
  emit("conversational_draft_applied", {
    intent: "CHANGE_DOCUMENT_TYPE", operation: "CHANGE_DOCUMENT_TYPE", document_type: "FACTURE",
    result_status: "OK", source: "TEXT", correlation_id: "22670000000:corr:5",
    ownerWaId: "22670000000", text: "Fais plutôt une facture pour Moussa", client_name: "Moussa",
  });
  const serialized = JSON.stringify(calls[0]);
  assert.ok(!serialized.includes("22670000000"));
  assert.ok(!serialized.includes("Moussa"));
  assert.deepEqual(Object.keys(calls[0]).sort(), [
    "ambiguous_field_count", "correlation_ref", "document_type", "fallback_reason_code",
    "intent", "latency_bucket", "missing_field_count", "operation", "provider_category",
    "result_status", "source",
  ]);
});

test("latencyBucket buckets coarsely and never leaks the raw millisecond value", () => {
  assert.equal(latencyBucket(200), "LT_1S");
  assert.equal(latencyBucket(999), "LT_1S");
  assert.equal(latencyBucket(1000), "LT_3S");
  assert.equal(latencyBucket(2999), "LT_3S");
  assert.equal(latencyBucket(3000), "LT_10S");
  assert.equal(latencyBucket(9999), "LT_10S");
  assert.equal(latencyBucket(10000), "GTE_10S");
  assert.equal(latencyBucket(-5), null);
  assert.equal(latencyBucket(NaN), null);
  assert.equal(latencyBucket(undefined), null);
});

test("a throwing logger never propagates and never blocks the caller", () => {
  const emit = createConversationalObservabilityEmitter(() => { throw new Error("sink is down"); });
  assert.doesNotThrow(() => emit("conversational_draft_applied", { correlation_id: "c1" }));
});

test("an omitted logger is a safe no-op", () => {
  const emit = createConversationalObservabilityEmitter();
  assert.doesNotThrow(() => emit("conversational_draft_applied", { correlation_id: "c1" }));
});

test("missing_field_count and ambiguous_field_count reject negative or non-integer values", () => {
  const calls = [];
  const emit = createConversationalObservabilityEmitter((event, details) => calls.push(details));
  emit("conversational_route_selected", { missing_field_count: -1, ambiguous_field_count: 1.5 });
  assert.equal(calls[0].missing_field_count, null);
  assert.equal(calls[0].ambiguous_field_count, null);
});
