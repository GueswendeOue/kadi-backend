"use strict";

const RESERVATION_STATUSES = Object.freeze(["RESERVED", "CAPTURED", "RELEASED", "EXPIRED"]);
const ATTEMPT_STATUSES = Object.freeze(["STARTED", "PDF_VALIDATED", "CAPTURED", "PROMOTED", "RECOVERABLE_FAILURE", "CANCELLED"]);
const DELIVERY_STATUSES = Object.freeze(["PENDING", "DELIVERED", "RECOVERABLE_FAILURE"]);

const METHODS = Object.freeze([
  "reserveCredits", "captureReservation", "releaseReservation", "getReservation",
  "createGenerationAttempt", "getGenerationAttempt", "updateGenerationAttempt",
  "promoteFinalFile", "getFinalFile", "findByQuoteId",
  "createDeliveryAttempt", "getDeliveryAttempt", "updateDeliveryAttempt",
]);

const ok = (value, extra = {}) => ({ ok: true, value, ...extra });
const fail = (error) => ({ ok: false, error });
const clone = (value) => value == null ? value : structuredClone(value);
const validId = (value) => typeof value === "string" && /^[A-Za-z0-9:_.-]{1,200}$/.test(value);

function assertGenerationLifecycleRepository(repository) {
  for (const method of METHODS) {
    if (typeof repository?.[method] !== "function") throw new TypeError(`GENERATION_REPOSITORY_METHOD_REQUIRED:${method}`);
  }
  return repository;
}

function createInMemoryGenerationLifecycleRepository({ balances = {}, failpoint = async () => {} } = {}) {
  const wallets = new Map(Object.entries(balances));
  const reservations = new Map();
  const attempts = new Map();
  const finalFiles = new Map();
  const deliveries = new Map();
  const idempotency = new Map();
  const ledger = [];
  let queue = Promise.resolve();

  async function serial(fn) {
    const prior = queue;
    let release;
    queue = new Promise((resolve) => { release = resolve; });
    await prior;
    try { return await fn(); } finally { release(); }
  }

  function replay(key, operation, fingerprint) {
    const record = idempotency.get(key);
    if (!record) return null;
    if (record.operation !== operation || record.fingerprint !== fingerprint) return fail("GENERATION_IDEMPOTENCY_CONFLICT");
    return ok(clone(record.result), { duplicate: true });
  }

  function remember(key, operation, fingerprint, result) {
    idempotency.set(key, { operation, fingerprint, result: clone(result) });
  }

  async function reserveCredits({ reservation, idempotencyKey }) {
    return serial(async () => {
      if (!validId(idempotencyKey) || !validId(reservation?.reservation_id) || !validId(reservation?.owner_wa_id) ||
          !validId(reservation?.quote_id) || !Number.isSafeInteger(reservation?.amount) || reservation.amount < 1) {
        return fail("CREDIT_RESERVATION_INPUT_INVALID");
      }
      const fingerprint = `${reservation.owner_wa_id}:${reservation.quote_id}:${reservation.amount}`;
      const repeated = replay(idempotencyKey, "reserve", fingerprint);
      if (repeated) return repeated;
      const existing = [...reservations.values()].find((entry) => entry.quote_id === reservation.quote_id && ["RESERVED", "CAPTURED"].includes(entry.status));
      if (existing) return existing.amount === reservation.amount && existing.owner_wa_id === reservation.owner_wa_id
        ? ok(clone(existing), { duplicate: true }) : fail("CREDIT_RESERVATION_CONFLICT");
      const balance = wallets.get(reservation.owner_wa_id) ?? 0;
      const held = [...reservations.values()].filter((entry) => entry.owner_wa_id === reservation.owner_wa_id && entry.status === "RESERVED")
        .reduce((sum, entry) => sum + entry.amount, 0);
      if (balance - held < reservation.amount) return fail("INSUFFICIENT_CREDITS");
      await failpoint("before_reservation", clone(reservation));
      const stored = { ...clone(reservation), status: "RESERVED", revision: 1 };
      reservations.set(stored.reservation_id, stored);
      remember(idempotencyKey, "reserve", fingerprint, stored);
      return ok(clone(stored));
    });
  }

  async function captureReservation({ reservationId, idempotencyKey, capturedAt }) {
    return serial(async () => {
      if (!validId(reservationId) || !validId(idempotencyKey)) return fail("CREDIT_CAPTURE_INPUT_INVALID");
      const repeated = replay(idempotencyKey, "capture", reservationId);
      if (repeated) return repeated;
      const record = reservations.get(reservationId);
      if (!record) return fail("CREDIT_RESERVATION_NOT_FOUND");
      if (record.status === "CAPTURED") return ok(clone(record), { duplicate: true });
      if (record.status !== "RESERVED") return fail("CREDIT_RESERVATION_NOT_CAPTURABLE");
      await failpoint("before_capture", clone(record));
      const balance = wallets.get(record.owner_wa_id) ?? 0;
      if (balance < record.amount) return fail("INSUFFICIENT_CREDITS");
      wallets.set(record.owner_wa_id, balance - record.amount);
      Object.assign(record, { status: "CAPTURED", captured_at: capturedAt, revision: record.revision + 1 });
      ledger.push({ ledger_type: "GENERATION_CAPTURE", reservation_id: reservationId, amount: -record.amount, idempotency_key: idempotencyKey });
      remember(idempotencyKey, "capture", reservationId, record);
      return ok(clone(record));
    });
  }

  async function releaseReservation({ reservationId, idempotencyKey, releasedAt }) {
    return serial(async () => {
      if (!validId(reservationId) || !validId(idempotencyKey)) return fail("CREDIT_RELEASE_INPUT_INVALID");
      const repeated = replay(idempotencyKey, "release", reservationId);
      if (repeated) return repeated;
      const record = reservations.get(reservationId);
      if (!record) return fail("CREDIT_RESERVATION_NOT_FOUND");
      if (record.status === "RELEASED") return ok(clone(record), { duplicate: true });
      if (record.status !== "RESERVED") return fail("CREDIT_RESERVATION_NOT_RELEASABLE");
      Object.assign(record, { status: "RELEASED", released_at: releasedAt, revision: record.revision + 1 });
      remember(idempotencyKey, "release", reservationId, record);
      return ok(clone(record));
    });
  }

  async function getReservation({ reservationId }) {
    const value = reservations.get(reservationId);
    return value ? ok(clone(value)) : fail("CREDIT_RESERVATION_NOT_FOUND");
  }

  async function createGenerationAttempt({ attempt, idempotencyKey }) {
    return serial(async () => {
      if (!validId(attempt?.generation_attempt_id) || !validId(idempotencyKey)) return fail("GENERATION_ATTEMPT_INPUT_INVALID");
      const repeated = replay(idempotencyKey, "attempt", attempt.quote_id);
      if (repeated) return repeated;
      const existing = [...attempts.values()].find((entry) => entry.quote_id === attempt.quote_id && entry.status !== "CANCELLED");
      if (existing) return ok(clone(existing), { duplicate: true });
      await failpoint("before_attempt", clone(attempt));
      const stored = { ...clone(attempt), status: "STARTED", revision: 1 };
      attempts.set(stored.generation_attempt_id, stored);
      remember(idempotencyKey, "attempt", attempt.quote_id, stored);
      return ok(clone(stored));
    });
  }

  async function getGenerationAttempt({ generationAttemptId }) {
    const value = attempts.get(generationAttemptId);
    return value ? ok(clone(value)) : fail("GENERATION_ATTEMPT_NOT_FOUND");
  }

  async function findByQuoteId({ quoteId }) {
    const value = [...attempts.values()].find((entry) => entry.quote_id === quoteId);
    return ok(value ? clone(value) : null);
  }

  async function updateGenerationAttempt({ generationAttemptId, expectedStatus, changes }) {
    return serial(async () => {
      const value = attempts.get(generationAttemptId);
      if (!value) return fail("GENERATION_ATTEMPT_NOT_FOUND");
      if (value.status !== expectedStatus) return fail("GENERATION_ATTEMPT_STATUS_CONFLICT");
      if (!ATTEMPT_STATUSES.includes(changes?.status)) return fail("GENERATION_ATTEMPT_STATUS_INVALID");
      await failpoint(`before_attempt_${changes.status.toLowerCase()}`, clone(value));
      Object.assign(value, clone(changes), { revision: value.revision + 1 });
      return ok(clone(value));
    });
  }

  async function promoteFinalFile({ finalFile, idempotencyKey }) {
    return serial(async () => {
      if (!validId(finalFile?.final_file_id) || !validId(idempotencyKey)) return fail("FINAL_FILE_INPUT_INVALID");
      const repeated = replay(idempotencyKey, "promote", finalFile.generation_attempt_id);
      if (repeated) return repeated;
      const existing = [...finalFiles.values()].find((entry) => entry.generation_attempt_id === finalFile.generation_attempt_id);
      if (existing) return ok(clone(existing), { duplicate: true });
      await failpoint("before_promotion", clone(finalFile));
      const stored = Object.freeze({ ...clone(finalFile), immutable: true });
      finalFiles.set(stored.final_file_id, stored);
      remember(idempotencyKey, "promote", finalFile.generation_attempt_id, stored);
      return ok(clone(stored));
    });
  }

  async function getFinalFile({ finalFileId }) {
    const value = finalFiles.get(finalFileId);
    return value ? ok(clone(value)) : fail("FINAL_FILE_NOT_FOUND");
  }

  async function createDeliveryAttempt({ delivery, idempotencyKey }) {
    return serial(async () => {
      if (!validId(delivery?.delivery_attempt_id) || !validId(idempotencyKey)) return fail("DELIVERY_ATTEMPT_INPUT_INVALID");
      const repeated = replay(idempotencyKey, "delivery", delivery.final_file_id);
      if (repeated) return repeated;
      const stored = { ...clone(delivery), status: "PENDING", attempt_count: 0, revision: 1 };
      deliveries.set(stored.delivery_attempt_id, stored);
      remember(idempotencyKey, "delivery", delivery.final_file_id, stored);
      return ok(clone(stored));
    });
  }

  async function getDeliveryAttempt({ deliveryAttemptId }) {
    const value = deliveries.get(deliveryAttemptId);
    return value ? ok(clone(value)) : fail("DELIVERY_ATTEMPT_NOT_FOUND");
  }

  async function updateDeliveryAttempt({ deliveryAttemptId, changes }) {
    return serial(async () => {
      const value = deliveries.get(deliveryAttemptId);
      if (!value) return fail("DELIVERY_ATTEMPT_NOT_FOUND");
      if (!DELIVERY_STATUSES.includes(changes?.status)) return fail("DELIVERY_STATUS_INVALID");
      Object.assign(value, clone(changes), { revision: value.revision + 1 });
      return ok(clone(value));
    });
  }

  return Object.freeze(assertGenerationLifecycleRepository({
    reserveCredits, captureReservation, releaseReservation, getReservation,
    createGenerationAttempt, getGenerationAttempt, updateGenerationAttempt, promoteFinalFile, getFinalFile, findByQuoteId,
    createDeliveryAttempt, getDeliveryAttempt, updateDeliveryAttempt,
    inspect: () => clone({ balances: Object.fromEntries(wallets), reservations: [...reservations.values()], attempts: [...attempts.values()], finalFiles: [...finalFiles.values()], deliveries: [...deliveries.values()], ledger }),
  }));
}

module.exports = { ATTEMPT_STATUSES, DELIVERY_STATUSES, RESERVATION_STATUSES, assertGenerationLifecycleRepository, createInMemoryGenerationLifecycleRepository };
