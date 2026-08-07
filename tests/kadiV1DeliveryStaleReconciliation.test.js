"use strict";

// Direct unit coverage of kadiV1DeliveryService.js's stale-claim
// reconciliation and bounded finalize-write retries — the crash/timeout
// matrix behind PR #14's final-review follow-up (fiche R). Higher-level
// integration coverage of the same behavior through the real generation
// lifecycle service lives in tests/kadiV1DeliveryRetryEligibility.test.js;
// this file isolates kadiV1DeliveryService.js itself so each case is fast
// and unambiguous about which layer is under test.

const assert = require("node:assert/strict");
const test = require("node:test");
const { createInMemoryGenerationLifecycleRepository } = require("../kadiV1GenerationLifecycleRepository");
const { createDeliveryService, STALE_IN_PROGRESS_MS, FINALIZE_MAX_ATTEMPTS } = require("../kadiV1DeliveryService");

function wrapRepository(repository, { failUpdatesWhenInProgress = 0 } = {}) {
  const wrapped = {};
  for (const key of Object.keys(repository)) wrapped[key] = repository[key];
  let remaining = failUpdatesWhenInProgress;
  wrapped.updateDeliveryAttempt = async (args) => {
    if (args.expectedStatus === "IN_PROGRESS" && remaining > 0) {
      remaining -= 1;
      return { ok: false, error: "SIMULATED_DB_FAILURE" };
    }
    return repository.updateDeliveryAttempt(args);
  };
  return wrapped;
}

// Models a real acknowledgment-loss race, not a genuine write failure: the
// underlying write actually commits (real repository state mutates), but
// the caller is told it failed anyway — e.g. the response never arrived
// after a network drop or client-side timeout that fired after the server
// had already applied the change.
function wrapRepositoryWithAckLoss(repository, { loseAckCount = 0 } = {}) {
  const wrapped = {};
  for (const key of Object.keys(repository)) wrapped[key] = repository[key];
  let remaining = loseAckCount;
  wrapped.updateDeliveryAttempt = async (args) => {
    const real = await repository.updateDeliveryAttempt(args);
    if (args.expectedStatus === "IN_PROGRESS" && remaining > 0) {
      remaining -= 1;
      return { ok: false, error: "SIMULATED_ACK_LOST" };
    }
    return real;
  };
  return wrapped;
}

async function seedPendingAttempt(repository, { deliveryAttemptId = "delivery:test", finalFileId = "final:test" } = {}) {
  await repository.promoteFinalFile({
    finalFile: {
      final_file_id: finalFileId, document_id: "document:test", document_version: 1, generation_attempt_id: "generation:test",
      storage_ref: "private-final:x", checksum: "a".repeat(64), page_count: 1, mime_type: "application/pdf", generated_at: "2026-08-06T12:00:00.000Z",
    },
    idempotencyKey: `${finalFileId}:promote`,
  });
  await repository.createDeliveryAttempt({
    delivery: { delivery_attempt_id: deliveryAttemptId, final_file_id: finalFileId, destination_ref: "owner:abc", status: "PENDING", attempt_count: 0 },
    idempotencyKey: `${deliveryAttemptId}:create`,
  });
  return deliveryAttemptId;
}

test("reconcileStaleClaim leaves a non-IN_PROGRESS attempt completely untouched", async () => {
  const repository = createInMemoryGenerationLifecycleRepository({});
  const deliveryAttemptId = await seedPendingAttempt(repository);
  const provider = { async deliverDocument() { return { ok: true, value: { reference: "x" } }; }, async getDeliveryStatus() { return { ok: true, value: { status: "UNKNOWN" } }; } };
  const delivery = createDeliveryService({ repository, provider, clock: () => "2026-08-06T12:00:00.000Z" });
  const reconciled = await delivery.reconcileStaleClaim({ deliveryAttemptId });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.reconciled, false);
  assert.equal(reconciled.value.status, "PENDING");
});

test("reconcileStaleClaim leaves a fresh IN_PROGRESS claim untouched (below the staleness window)", async () => {
  const repository = createInMemoryGenerationLifecycleRepository({});
  const deliveryAttemptId = await seedPendingAttempt(repository);
  await repository.updateDeliveryAttempt({ deliveryAttemptId, expectedStatus: "PENDING", changes: { status: "IN_PROGRESS", last_attempt_at: "2026-08-06T11:59:00.000Z" } });
  const provider = { async deliverDocument() { throw new Error("must never be called"); }, async getDeliveryStatus() { throw new Error("must never be called"); } };
  const delivery = createDeliveryService({ repository, provider, clock: () => "2026-08-06T12:00:00.000Z", staleInProgressMs: STALE_IN_PROGRESS_MS });
  const reconciled = await delivery.reconcileStaleClaim({ deliveryAttemptId });
  assert.equal(reconciled.reconciled, false);
  assert.equal(reconciled.value.status, "IN_PROGRESS");
});

test("reconcileStaleClaim resolves a stale claim to OUTCOME_UNKNOWN when the provider offers no confirming evidence (today's honest default)", async () => {
  const repository = createInMemoryGenerationLifecycleRepository({});
  const deliveryAttemptId = await seedPendingAttempt(repository);
  await repository.updateDeliveryAttempt({ deliveryAttemptId, expectedStatus: "PENDING", changes: { status: "IN_PROGRESS", last_attempt_at: "2020-01-01T00:00:00.000Z" } });
  let statusCalls = 0;
  const provider = {
    async deliverDocument() { throw new Error("must never be called"); },
    async getDeliveryStatus() { statusCalls += 1; return { ok: true, value: { status: "UNKNOWN" } }; },
  };
  const delivery = createDeliveryService({ repository, provider, clock: () => "2026-08-06T12:00:00.000Z" });
  const reconciled = await delivery.reconcileStaleClaim({ deliveryAttemptId });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.outcome, "OUTCOME_UNKNOWN");
  assert.equal(reconciled.value.status, "RECOVERABLE_FAILURE");
  assert.equal(reconciled.value.last_error_code, "DELIVERY_OUTCOME_UNKNOWN");
  assert.equal(statusCalls, 1, "provider evidence is consulted before ever declaring the outcome unknown");
});

test("reconcileStaleClaim resolves to CONFIRMED_SUCCESS, never re-sending, when the provider positively confirms delivery", async () => {
  const repository = createInMemoryGenerationLifecycleRepository({});
  const deliveryAttemptId = await seedPendingAttempt(repository);
  await repository.updateDeliveryAttempt({ deliveryAttemptId, expectedStatus: "PENDING", changes: { status: "IN_PROGRESS", last_attempt_at: "2020-01-01T00:00:00.000Z" } });
  const provider = {
    async deliverDocument() { throw new Error("must never be called"); },
    async getDeliveryStatus() { return { ok: true, value: { status: "DELIVERED" } }; },
  };
  const delivery = createDeliveryService({ repository, provider, clock: () => "2026-08-06T12:00:00.000Z" });
  const reconciled = await delivery.reconcileStaleClaim({ deliveryAttemptId });
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.outcome, "CONFIRMED_SUCCESS");
  assert.equal(reconciled.value.status, "DELIVERED");
});

test("a transient finalize-write failure that recovers within the retry budget still records the true outcome (no data loss on a merely flaky write)", async () => {
  const repository = wrapRepository(createInMemoryGenerationLifecycleRepository({}), { failUpdatesWhenInProgress: FINALIZE_MAX_ATTEMPTS - 1 });
  const deliveryAttemptId = await seedPendingAttempt(repository);
  const provider = { async deliverDocument() { return { ok: true, value: { reference: "ref-1" } }; }, async getDeliveryStatus() { return { ok: true, value: { status: "UNKNOWN" } }; } };
  const delivery = createDeliveryService({ repository, provider, clock: () => "2026-08-06T12:00:00.000Z", sleep: async () => {} });
  const attempt = await repository.getDeliveryAttempt({ deliveryAttemptId });
  const result = await delivery.deliver({ deliveryAttemptId: attempt.value.delivery_attempt_id });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.status, "DELIVERED");
});

test("acknowledgment-loss on the finalize write: the row genuinely reaches DELIVERED on the server even though every retry attempt in this process reports failure — the true, already-settled outcome is recovered, never misreported as unresolved", async () => {
  // The first write actually commits to DELIVERED on the "server" (the
  // real repository), but this process never sees a successful response;
  // every retry after that keeps hitting expectedStatus:"IN_PROGRESS",
  // which by then no longer matches the real (already DELIVERED) row —
  // exactly the ambiguity a naive retry loop would misreport as
  // DELIVERY_FINALIZE_UNRESOLVED.
  const repository = wrapRepositoryWithAckLoss(createInMemoryGenerationLifecycleRepository({}), { loseAckCount: FINALIZE_MAX_ATTEMPTS });
  const deliveryAttemptId = await seedPendingAttempt(repository);
  const provider = { async deliverDocument() { return { ok: true, value: { reference: "ref-1" } }; }, async getDeliveryStatus() { return { ok: true, value: { status: "UNKNOWN" } }; } };
  const delivery = createDeliveryService({ repository, provider, clock: () => "2026-08-06T12:00:00.000Z", sleep: async () => {} });
  const result = await delivery.deliver({ deliveryAttemptId });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.status, "DELIVERED");
  const real = repository.inspect().deliveries.find((entry) => entry.delivery_attempt_id === deliveryAttemptId);
  assert.equal(real.status, "DELIVERED");
});

test("acknowledgment-loss also applies to the failure branch: a genuinely recorded RECOVERABLE_FAILURE is recovered, never re-reported as unresolved", async () => {
  const repository = wrapRepositoryWithAckLoss(createInMemoryGenerationLifecycleRepository({}), { loseAckCount: FINALIZE_MAX_ATTEMPTS });
  const deliveryAttemptId = await seedPendingAttempt(repository);
  const provider = { async deliverDocument() { return { ok: false, error: "CHANNEL_TEMPORARY" }; }, async getDeliveryStatus() { return { ok: true, value: { status: "UNKNOWN" } }; } };
  const delivery = createDeliveryService({ repository, provider, clock: () => "2026-08-06T12:00:00.000Z", sleep: async () => {} });
  const result = await delivery.deliver({ deliveryAttemptId });
  assert.equal(result.ok, false);
  assert.equal(result.error, "DELIVERY_RECOVERABLE_FAILURE");
  const real = repository.inspect().deliveries.find((entry) => entry.delivery_attempt_id === deliveryAttemptId);
  assert.equal(real.status, "RECOVERABLE_FAILURE");
  assert.equal(real.last_error_code, "CHANNEL_TEMPORARY");
});

test("finalize-write exhaustion (every retry fails) leaves the row IN_PROGRESS and reports DELIVERY_FINALIZE_UNRESOLVED — never a guessed confirmed outcome", async () => {
  const repository = wrapRepository(createInMemoryGenerationLifecycleRepository({}), { failUpdatesWhenInProgress: FINALIZE_MAX_ATTEMPTS });
  const deliveryAttemptId = await seedPendingAttempt(repository);
  const provider = { async deliverDocument() { return { ok: true, value: { reference: "ref-1" } }; }, async getDeliveryStatus() { return { ok: true, value: { status: "UNKNOWN" } }; } };
  const delivery = createDeliveryService({ repository, provider, clock: () => "2026-08-06T12:00:00.000Z", sleep: async () => {} });
  const result = await delivery.deliver({ deliveryAttemptId });
  assert.equal(result.ok, false);
  assert.equal(result.error, "DELIVERY_FINALIZE_UNRESOLVED");
  const stuck = repository.inspect().deliveries.find((entry) => entry.delivery_attempt_id === deliveryAttemptId);
  assert.equal(stuck.status, "IN_PROGRESS");
});

test("claim() stamps last_attempt_at at claim time, giving stale-claim reconciliation a real persisted timestamp to trust — never an in-memory timer", async () => {
  const repository = createInMemoryGenerationLifecycleRepository({});
  const deliveryAttemptId = await seedPendingAttempt(repository);
  const provider = { async deliverDocument() { return new Promise(() => {}); }, async getDeliveryStatus() { return { ok: true, value: { status: "UNKNOWN" } }; } };
  const delivery = createDeliveryService({ repository, provider, clock: () => "2026-08-06T12:00:00.000Z" });
  delivery.deliver({ deliveryAttemptId }); // never awaited — deliverDocument hangs forever, mirroring a crash mid-flight
  await new Promise((resolve) => setTimeout(resolve, 20));
  const claimed = repository.inspect().deliveries.find((entry) => entry.delivery_attempt_id === deliveryAttemptId);
  assert.equal(claimed.status, "IN_PROGRESS");
  assert.equal(claimed.last_attempt_at, "2026-08-06T12:00:00.000Z");
});
