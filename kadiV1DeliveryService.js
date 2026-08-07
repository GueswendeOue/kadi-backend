"use strict";

const crypto = require("node:crypto");
const { assertGenerationLifecycleRepository } = require("./kadiV1GenerationLifecycleRepository");

const ok = (value, extra = {}) => ({ ok: true, value, ...extra });
const fail = (error) => ({ ok: false, error });

// A claim is considered abandoned (crash, timeout, killed process) once it
// has sat in IN_PROGRESS this long without a finalize write landing. Chosen
// generously above any realistic WhatsApp Cloud API round trip. Backed by
// last_attempt_at, a real persisted timestamp claim() now stamps at claim
// time — not an in-memory timer, so it works correctly across instances and
// survives a process restart. See docs/KADI_ENGINEERING_MEMORY.md fiche R.
const STALE_IN_PROGRESS_MS = 2 * 60 * 1000;
// Bounded retries for the finalize write that follows a provider call —
// closes the window where the provider succeeded (or failed) but the DB
// write recording that outcome itself fails or the process crashes first.
const FINALIZE_MAX_ATTEMPTS = 3;
const FINALIZE_RETRY_DELAY_MS = 50;

function assertDeliveryProvider(provider) {
  for (const method of ["deliverDocument", "getDeliveryStatus"]) {
    if (typeof provider?.[method] !== "function") throw new TypeError(`DELIVERY_PROVIDER_METHOD_REQUIRED:${method}`);
  }
  return provider;
}

function createDeliveryService({
  repository, provider, clock = () => new Date().toISOString(), idFactory,
  staleInProgressMs = STALE_IN_PROGRESS_MS,
  finalizeMaxAttempts = FINALIZE_MAX_ATTEMPTS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const store = assertGenerationLifecycleRepository(repository);
  const deliveryProvider = assertDeliveryProvider(provider);
  const makeId = idFactory || ((key) => `delivery:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}`);

  // Retries the finalize write (the DB update that records what the
  // provider call already did) a bounded number of times before giving up.
  // Every attempt in this loop shares the same expectedStatus ("IN_PROGRESS"),
  // so if an earlier attempt actually committed on the server but this
  // process never saw the acknowledgment (a real network/timeout race, not
  // merely hypothetical — the write itself is not idempotent-looking from
  // the caller's side once the row has moved off IN_PROGRESS), every
  // subsequent attempt in the SAME loop would otherwise fail on the now-
  // stale expectedStatus and the true, already-settled outcome would be
  // misreported as unresolved. Re-reading the authoritative row after
  // exhausting the budget closes that gap: if it has already moved past
  // IN_PROGRESS, that IS the real outcome, not a guess — only a row still
  // genuinely at IN_PROGRESS after this re-read is left unresolved for
  // later stale-claim reconciliation (which only ever settles it as
  // DELIVERY_OUTCOME_UNKNOWN, never a confirmed outcome on a guess).
  async function finalizeWithRetries(args) {
    let last;
    for (let attemptIndex = 0; attemptIndex < finalizeMaxAttempts; attemptIndex += 1) {
      last = await store.updateDeliveryAttempt(args);
      if (last.ok) return last;
      if (attemptIndex < finalizeMaxAttempts - 1) await sleep(FINALIZE_RETRY_DELAY_MS);
    }
    const current = await store.getDeliveryAttempt({ deliveryAttemptId: args.deliveryAttemptId });
    if (current.ok && current.value.status !== "IN_PROGRESS") return current;
    return fail("DELIVERY_FINALIZE_UNRESOLVED");
  }

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

  // Claims the attempt (PENDING/RECOVERABLE_FAILURE -> IN_PROGRESS) via a
  // conditional, expected-status-checked update *before* ever calling the
  // provider. This is the one property an in-memory queue alone cannot
  // give: two concurrent calls both reading the same RECOVERABLE_FAILURE
  // row would, without this claim, both pass straight through to
  // deliverDocument() — a real double-send risk. Only the caller whose
  // conditional update actually lands may proceed; the loser learns this
  // from the update's own result, never from a second provider call.
  async function claim(attempt) {
    return store.updateDeliveryAttempt({
      deliveryAttemptId: attempt.delivery_attempt_id,
      expectedStatus: attempt.status,
      // last_attempt_at is stamped here, at claim time — not only on
      // finalize as before — so it becomes a real "claimed at" timestamp
      // stale-claim reconciliation can trust, without inventing any
      // in-memory timer.
      changes: { status: "IN_PROGRESS", attempt_count: attempt.attempt_count, last_attempt_at: new Date(clock()).toISOString() },
    });
  }

  async function execute(attempt) {
    const claimed = await claim(attempt);
    if (!claimed.ok) return fail("DELIVERY_ALREADY_IN_PROGRESS");
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
      const updated = await finalizeWithRetries({
        deliveryAttemptId: attempt.delivery_attempt_id, expectedStatus: "IN_PROGRESS",
        changes: { status: "RECOVERABLE_FAILURE", attempt_count: claimed.value.attempt_count + 1, last_error_code: code, last_attempt_at: now },
      });
      return updated.ok ? fail("DELIVERY_RECOVERABLE_FAILURE") : updated;
    }
    const updated = await finalizeWithRetries({
      deliveryAttemptId: attempt.delivery_attempt_id, expectedStatus: "IN_PROGRESS",
      changes: { status: "DELIVERED", attempt_count: claimed.value.attempt_count + 1, last_error_code: null, delivered_at: now, provider_reference: result.value?.reference || null },
    });
    return updated;
  }

  // Reconciles a delivery attempt stuck at IN_PROGRESS because the process
  // crashed or the finalize write exhausted its retries after the provider
  // call already happened (or was about to). Only ever acts once the claim
  // is provably stale (last_attempt_at older than staleInProgressMs) — a
  // still-fresh IN_PROGRESS attempt is left completely untouched, since it
  // may genuinely still be in flight. Never resolves to a confirmed outcome
  // without real provider evidence: today's WhatsApp provider exposes no
  // supported request-level status/idempotency lookup (getDeliveryStatus is
  // an honest UNKNOWN stub — see kadiV1ProductionInfrastructure.js and
  // docs/KADI_ENGINEERING_MEMORY.md fiche R), so in practice this always
  // resolves to DELIVERY_OUTCOME_UNKNOWN, requiring an explicit user
  // confirmation before any resend — never a silent, uncontrolled duplicate
  // send.
  async function reconcileStaleClaim({ deliveryAttemptId }) {
    const attempt = await store.getDeliveryAttempt({ deliveryAttemptId });
    if (!attempt.ok) return attempt;
    if (attempt.value.status !== "IN_PROGRESS") return ok(attempt.value, { reconciled: false });
    const claimedAtMs = Date.parse(attempt.value.last_attempt_at || "");
    const nowMs = Date.parse(new Date(clock()).toISOString());
    if (!Number.isFinite(claimedAtMs) || nowMs - claimedAtMs < staleInProgressMs) {
      return ok(attempt.value, { reconciled: false });
    }
    let providerConfirmedDelivered = false;
    try {
      const checked = await deliveryProvider.getDeliveryStatus({
        deliveryAttemptId, providerReference: attempt.value.provider_reference || null,
      });
      providerConfirmedDelivered = checked.ok && checked.value?.status === "DELIVERED";
    } catch {
      providerConfirmedDelivered = false;
    }
    if (providerConfirmedDelivered) {
      const updated = await store.updateDeliveryAttempt({
        deliveryAttemptId, expectedStatus: "IN_PROGRESS",
        changes: { status: "DELIVERED", last_error_code: null, delivered_at: new Date(clock()).toISOString() },
      });
      return updated.ok ? ok(updated.value, { reconciled: true, outcome: "CONFIRMED_SUCCESS" }) : updated;
    }
    const updated = await store.updateDeliveryAttempt({
      deliveryAttemptId, expectedStatus: "IN_PROGRESS",
      changes: { status: "RECOVERABLE_FAILURE", last_error_code: "DELIVERY_OUTCOME_UNKNOWN", last_attempt_at: new Date(clock()).toISOString() },
    });
    return updated.ok ? ok(updated.value, { reconciled: true, outcome: "OUTCOME_UNKNOWN" }) : updated;
  }

  async function deliver({ deliveryAttemptId }) {
    const attempt = await store.getDeliveryAttempt({ deliveryAttemptId });
    if (!attempt.ok) return attempt;
    if (attempt.value.status === "DELIVERED") return ok(attempt.value, { duplicate: true });
    if (attempt.value.status === "IN_PROGRESS") return fail("DELIVERY_ALREADY_IN_PROGRESS");
    return execute(attempt.value);
  }

  async function retryDelivery({ deliveryAttemptId }) {
    const attempt = await store.getDeliveryAttempt({ deliveryAttemptId });
    if (!attempt.ok) return attempt;
    if (attempt.value.status === "DELIVERED") return ok(attempt.value, { duplicate: true });
    if (attempt.value.status === "IN_PROGRESS") return fail("DELIVERY_ALREADY_IN_PROGRESS");
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

  return Object.freeze({ createDeliveryAttempt, deliver, retryDelivery, reconcileStaleClaim, markDelivered, markRecoverableFailure });
}

module.exports = {
  assertDeliveryProvider, createDeliveryService,
  STALE_IN_PROGRESS_MS, FINALIZE_MAX_ATTEMPTS, FINALIZE_RETRY_DELAY_MS,
};
