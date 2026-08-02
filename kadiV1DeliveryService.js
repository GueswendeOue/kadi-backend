"use strict";

const crypto = require("node:crypto");
const { assertGenerationLifecycleRepository } = require("./kadiV1GenerationLifecycleRepository");

const ok = (value, extra = {}) => ({ ok: true, value, ...extra });
const fail = (error) => ({ ok: false, error });

function assertDeliveryProvider(provider) {
  for (const method of ["deliverDocument", "getDeliveryStatus"]) {
    if (typeof provider?.[method] !== "function") throw new TypeError(`DELIVERY_PROVIDER_METHOD_REQUIRED:${method}`);
  }
  return provider;
}

function createDeliveryService({ repository, provider, clock = () => new Date().toISOString(), idFactory } = {}) {
  const store = assertGenerationLifecycleRepository(repository);
  const deliveryProvider = assertDeliveryProvider(provider);
  const makeId = idFactory || ((key) => `delivery:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}`);

  async function createDeliveryAttempt({ finalFileId, ownerRef, idempotencyKey }) {
    const finalFile = await store.getFinalFile({ finalFileId });
    if (!finalFile.ok) return finalFile;
    return store.createDeliveryAttempt({
      delivery: {
        delivery_attempt_id: makeId(idempotencyKey), final_file_id: finalFileId,
        destination_ref: `owner:${crypto.createHash("sha256").update(ownerRef).digest("hex").slice(0, 12)}`,
        status: "PENDING", attempt_count: 0, last_error_code: null, created_at: new Date(clock()).toISOString(),
      },
      idempotencyKey,
    });
  }

  async function execute(attempt) {
    const file = await store.getFinalFile({ finalFileId: attempt.final_file_id });
    if (!file.ok) return file;
    let result;
    try {
      result = await deliveryProvider.deliverDocument({ finalFile: file.value, destinationRef: attempt.destination_ref, deliveryAttemptId: attempt.delivery_attempt_id });
    } catch {
      result = fail("DELIVERY_PROVIDER_EXCEPTION");
    }
    const now = new Date(clock()).toISOString();
    if (!result.ok) {
      const code = typeof result.error === "string" && /^[A-Z0-9_:-]{1,100}$/.test(result.error) ? result.error : "DELIVERY_PROVIDER_FAILED";
      const updated = await store.updateDeliveryAttempt({ deliveryAttemptId: attempt.delivery_attempt_id, changes: { status: "RECOVERABLE_FAILURE", attempt_count: attempt.attempt_count + 1, last_error_code: code, last_attempt_at: now } });
      return updated.ok ? fail("DELIVERY_RECOVERABLE_FAILURE") : updated;
    }
    return store.updateDeliveryAttempt({ deliveryAttemptId: attempt.delivery_attempt_id, changes: { status: "DELIVERED", attempt_count: attempt.attempt_count + 1, last_error_code: null, delivered_at: now, provider_reference: result.value?.reference || null } });
  }

  async function deliver({ deliveryAttemptId }) {
    const attempt = await store.getDeliveryAttempt({ deliveryAttemptId });
    if (!attempt.ok) return attempt;
    if (attempt.value.status === "DELIVERED") return ok(attempt.value, { duplicate: true });
    return execute(attempt.value);
  }

  async function retryDelivery({ deliveryAttemptId }) {
    const attempt = await store.getDeliveryAttempt({ deliveryAttemptId });
    if (!attempt.ok) return attempt;
    if (attempt.value.status === "DELIVERED") return ok(attempt.value, { duplicate: true });
    if (attempt.value.status !== "RECOVERABLE_FAILURE") return fail("DELIVERY_NOT_RETRYABLE");
    return execute(attempt.value);
  }

  async function markDelivered({ deliveryAttemptId }) {
    const attempt = await store.getDeliveryAttempt({ deliveryAttemptId });
    return attempt.ok && attempt.value.status === "DELIVERED" ? attempt : fail("DELIVERY_NOT_CONFIRMED");
  }

  async function markRecoverableFailure({ deliveryAttemptId, errorCode = "DELIVERY_FAILED" }) {
    return store.updateDeliveryAttempt({ deliveryAttemptId, changes: { status: "RECOVERABLE_FAILURE", last_error_code: errorCode, last_attempt_at: new Date(clock()).toISOString() } });
  }

  return Object.freeze({ createDeliveryAttempt, deliver, retryDelivery, markDelivered, markRecoverableFailure });
}

module.exports = { assertDeliveryProvider, createDeliveryService };
