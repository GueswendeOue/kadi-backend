"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createKadiV1DeliveryRetryRuntime } = require("../kadiV1DeliveryRetryRuntime");

test("handle forwards ownerWaId/documentId/idempotencyKey to generationRuntime.retryDelivery and returns its result unchanged", async () => {
  let received;
  const runtime = createKadiV1DeliveryRetryRuntime({
    generationRuntime: {
      async retryDelivery(command) {
        received = command;
        return { ok: true, value: { document: { status: "DELIVERED" } } };
      },
    },
  });
  const result = await runtime.handle({ ownerWaId: "22670000000", documentId: "document:1", idempotencyKey: "webhook:1" });
  assert.equal(result.ok, true);
  assert.deepEqual(received, { ownerWaId: "22670000000", documentId: "document:1", idempotencyKey: "webhook:1" });
});

test("construction requires a generationRuntime exposing retryDelivery", () => {
  assert.throws(() => createKadiV1DeliveryRetryRuntime({ generationRuntime: {} }), TypeError);
  assert.throws(() => createKadiV1DeliveryRetryRuntime({}), TypeError);
});
