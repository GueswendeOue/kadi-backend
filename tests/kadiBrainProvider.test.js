"use strict";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-openai-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const { makeKadiBrainProvider } = require("../kadiBrainProvider");
const { KADI_BRAIN_OUTPUT_SCHEMA } = require("../kadiBrainContract");
const { validResult } = require("./kadiBrainFixture");

test("provider performs one strict structured-output call", async () => {
  const calls = [];
  const request = { requestId: "req-1", context: { allowedIntents: ["create_document"] } };
  const provider = makeKadiBrainProvider({
    model: "test-model",
    timeoutMs: 1234,
    createCompletion: async (options) => {
      calls.push(options);
      return {
        model: "test-model",
        choices: [{ message: { content: JSON.stringify(validResult(request)) } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      };
    },
  });
  const response = await provider.understand(request);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeoutMs, 1234);
  assert.equal(calls[0].schema, KADI_BRAIN_OUTPUT_SCHEMA);
  assert.equal(response.result.schemaVersion, "kadi.brain.v1");
  assert.equal(response.telemetry.totalTokens, 30);
});

test("invalid provider JSON is classified without retry", async () => {
  let calls = 0;
  const provider = makeKadiBrainProvider({
    createCompletion: async () => {
      calls += 1;
      return { choices: [{ message: { content: "not-json" } }] };
    },
  });
  const response = await provider.understand({ requestId: "bad" });
  assert.equal(calls, 1);
  assert.equal(response.result.providerFailed, true);
  assert.equal(response.result.errorType, "invalid_output");
});
