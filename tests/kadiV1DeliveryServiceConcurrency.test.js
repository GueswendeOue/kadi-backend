"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createInMemoryGenerationLifecycleRepository } = require("../kadiV1GenerationLifecycleRepository");
const { createDeliveryService } = require("../kadiV1DeliveryService");

const clock = () => "2026-08-06T12:00:00.000Z";

async function setup({ providerDelayMs = 5 } = {}) {
  const repository = createInMemoryGenerationLifecycleRepository({});
  const finalFile = { final_file_id: "final:concurrency", document_id: "document:concurrency", document_version: 1, generation_attempt_id: "generation:concurrency", storage_ref: "private-final:x", checksum: "a".repeat(64), page_count: 1, mime_type: "application/pdf", generated_at: clock() };
  await repository.promoteFinalFile({ finalFile, idempotencyKey: "final:concurrency:promote" });
  const created = await repository.createDeliveryAttempt({
    delivery: { delivery_attempt_id: "delivery:concurrency", final_file_id: finalFile.final_file_id, destination_ref: "owner:abc", status: "PENDING", attempt_count: 0 },
    idempotencyKey: "delivery:concurrency:create",
  });
  assert.equal(created.ok, true);
  let providerCalls = 0;
  const provider = {
    async deliverDocument() {
      providerCalls += 1;
      // A deliberate delay widens the race window: without the atomic
      // claim, both concurrent callers would already be inside this
      // function before either finishes.
      await new Promise((resolve) => setTimeout(resolve, providerDelayMs));
      return { ok: true, value: { reference: `send-${providerCalls}` } };
    },
    async getDeliveryStatus() { return { ok: true, value: null }; },
  };
  // No lifecycle-level serialization is wired here at all — this proves
  // the protection lives in kadiV1DeliveryService.js itself (the atomic
  // DB-level claim), not in kadiV1GenerationLifecycleService.js's
  // in-memory serializeConfirmation queue, which would trivially mask a
  // real cross-instance race by fully serializing same-process callers
  // regardless of whether the underlying claim works at all.
  const delivery = createDeliveryService({ repository, provider, clock });
  return { repository, delivery, getProviderCalls: () => providerCalls };
}

test("two concurrent deliver() calls on the same PENDING attempt result in exactly one provider call", async () => {
  const { delivery, repository, getProviderCalls } = await setup();
  const [first, second] = await Promise.all([
    delivery.deliver({ deliveryAttemptId: "delivery:concurrency" }),
    delivery.deliver({ deliveryAttemptId: "delivery:concurrency" }),
  ]);
  assert.equal(getProviderCalls(), 1, "the provider must be called exactly once, never twice, under true concurrency");
  const outcomes = [first, second];
  assert.equal(outcomes.filter((entry) => entry.ok).length, 1, "exactly one caller succeeds");
  assert.equal(outcomes.filter((entry) => !entry.ok && entry.error === "DELIVERY_ALREADY_IN_PROGRESS").length, 1, "the loser learns this from the claim itself, never from a second provider call");
  const state = repository.inspect();
  assert.equal(state.deliveries.filter((entry) => entry.status === "DELIVERED").length, 1);
});

test("two concurrent retryDelivery() calls on the same RECOVERABLE_FAILURE attempt result in exactly one provider call", async () => {
  const { repository, provider: _unused, delivery, getProviderCalls } = await (async () => {
    const built = await setup();
    // Move the attempt to RECOVERABLE_FAILURE first (a prior failed send),
    // matching the real state retryDelivery is designed for.
    await built.repository.updateDeliveryAttempt({
      deliveryAttemptId: "delivery:concurrency", expectedStatus: "PENDING",
      changes: { status: "RECOVERABLE_FAILURE", attempt_count: 1, last_error_code: "CHANNEL_TEMPORARY" },
    });
    return built;
  })();
  const [first, second] = await Promise.all([
    delivery.retryDelivery({ deliveryAttemptId: "delivery:concurrency" }),
    delivery.retryDelivery({ deliveryAttemptId: "delivery:concurrency" }),
  ]);
  assert.equal(getProviderCalls(), 1, "the provider must be called exactly once, never twice, under true concurrency");
  const outcomes = [first, second];
  assert.equal(outcomes.filter((entry) => entry.ok).length, 1);
  const state = repository.inspect();
  assert.equal(state.deliveries.filter((entry) => entry.status === "DELIVERED").length, 1);
  assert.equal(state.deliveries[0].attempt_count, 2, "attempt_count increments by exactly one for the one execution that actually happened");
});

test("a delivery already DELIVERED is never re-sent by a concurrent retry attempt", async () => {
  const { repository, delivery, getProviderCalls } = await setup();
  const settled = await delivery.deliver({ deliveryAttemptId: "delivery:concurrency" });
  assert.equal(settled.ok, true);
  assert.equal(getProviderCalls(), 1);
  const replay = await delivery.retryDelivery({ deliveryAttemptId: "delivery:concurrency" });
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(getProviderCalls(), 1, "no second provider call for an already-delivered attempt");
  const state = repository.inspect();
  assert.equal(state.deliveries.filter((entry) => entry.status === "DELIVERED").length, 1);
});
