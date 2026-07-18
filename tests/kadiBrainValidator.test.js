"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateBrainResult } = require("../kadiBrainValidator");
const { validResult } = require("./kadiBrainFixture");

const request = {
  requestId: "req-1",
  context: { allowedIntents: ["create_document"], currentDraft: null },
};

test("invalid or unknown JSON properties are rejected", () => {
  const result = validResult(request);
  result.unexpected = true;
  assert.equal(validateBrainResult(result, request).verdict, "invalid_schema");
  assert.equal(validateBrainResult({ broken: true }, request).verdict, "invalid_schema");
});

test("intent not allowed by current state is rejected", () => {
  const result = validResult(request);
  result.intent.name = "mark_paid";
  assert.equal(validateBrainResult(result, request).verdict, "disallowed_intent");
});

test("financial value without exact evidence is rejected", () => {
  const result = validResult(request);
  result.evidence = result.evidence.filter((entry) => entry.field !== "document.items[0].unitPrice");
  assert.equal(validateBrainResult(result, request).verdict, "insufficient_evidence");
});

test("negative prices and invalid dates are rejected locally", () => {
  const result = validResult(request);
  result.document.items[0].unitPrice = -1;
  result.document.paymentDate = "17/07/2026";
  assert.equal(validateBrainResult(result, request).verdict, "invalid_business");
});
