"use strict";

const crypto = require("node:crypto");
const { assertGenerationLifecycleRepository } = require("./kadiV1GenerationLifecycleRepository");

const ok = (value, extra = {}) => ({ ok: true, value, ...extra });
const fail = (error) => ({ ok: false, error });
const valid = (value) => typeof value === "string" && /^[A-Za-z0-9:_.-]{1,200}$/.test(value);

function createWalletReservationService({ repository, clock = () => new Date().toISOString(), idFactory } = {}) {
  const store = assertGenerationLifecycleRepository(repository);
  const makeId = idFactory || ((key) => `reservation:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}`);

  async function reserveCredits({ ownerWaId, quoteId, amount, idempotencyKey }) {
    if (!valid(ownerWaId) || !valid(quoteId) || !valid(idempotencyKey) || !Number.isSafeInteger(amount) || amount < 1) {
      return fail("CREDIT_RESERVATION_COMMAND_INVALID");
    }
    const at = clock();
    if (!Number.isFinite(Date.parse(at))) return fail("CREDIT_RESERVATION_CLOCK_INVALID");
    return store.reserveCredits({
      reservation: { reservation_id: makeId(idempotencyKey), owner_wa_id: ownerWaId, quote_id: quoteId, amount, status: "RESERVED", reserved_at: new Date(at).toISOString() },
      idempotencyKey,
    });
  }

  async function captureReservation({ reservationId, idempotencyKey }) {
    if (!valid(reservationId) || !valid(idempotencyKey)) return fail("CREDIT_CAPTURE_COMMAND_INVALID");
    return store.captureReservation({ reservationId, idempotencyKey, capturedAt: new Date(clock()).toISOString() });
  }

  async function releaseReservation({ reservationId, idempotencyKey }) {
    if (!valid(reservationId) || !valid(idempotencyKey)) return fail("CREDIT_RELEASE_COMMAND_INVALID");
    return store.releaseReservation({ reservationId, idempotencyKey, releasedAt: new Date(clock()).toISOString() });
  }

  async function getReservation({ reservationId, ownerWaId }) {
    const result = await store.getReservation({ reservationId });
    return result.ok && result.value.owner_wa_id === ownerWaId ? result : fail("CREDIT_RESERVATION_NOT_FOUND");
  }

  return Object.freeze({ reserveCredits, captureReservation, releaseReservation, getReservation });
}

module.exports = { createWalletReservationService };
