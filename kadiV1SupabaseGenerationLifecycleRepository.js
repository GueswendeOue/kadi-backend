"use strict";

const { assertGenerationLifecycleRepository } = require("./kadiV1GenerationLifecycleRepository");

const ok = (value, extra = {}) => ({ ok: true, value, ...extra });
const fail = (error) => ({ ok: false, error });
const row = (data) => Array.isArray(data) ? data[0] : data;

function mapError(error, fallback) {
  const text = `${error?.message || ""} ${error?.details || ""}`;
  if (/INSUFFICIENT_CREDITS/i.test(text)) return "INSUFFICIENT_CREDITS";
  if (/NOT_CAPTURABLE/i.test(text)) return "CREDIT_RESERVATION_NOT_CAPTURABLE";
  if (/NOT_RELEASABLE/i.test(text)) return "CREDIT_RESERVATION_NOT_RELEASABLE";
  if (/duplicate key|unique constraint/i.test(text)) return "GENERATION_CONCURRENCY_CONFLICT";
  return fallback;
}

function createSupabaseGenerationLifecycleRepository(client) {
  if (!client || typeof client.from !== "function" || typeof client.rpc !== "function") throw new TypeError("SUPABASE_CLIENT_REQUIRED");

  async function reserveCredits({ reservation, idempotencyKey }) {
    const { data, error } = await client.rpc("kadi_v1_reserve_generation_credits", {
      p_reservation_id: reservation.reservation_id, p_owner_wa_id: reservation.owner_wa_id,
      p_quote_id: reservation.quote_id, p_amount: reservation.amount, p_idempotency_key: idempotencyKey,
    });
    if (error) return fail(mapError(error, "CREDIT_RESERVATION_FAILED"));
    const value = row(data);
    return value?.ok === false ? fail(value.error || "CREDIT_RESERVATION_FAILED") : ok(value, { duplicate: value?.duplicate === true });
  }

  async function captureReservation({ reservationId, idempotencyKey }) {
    const { data, error } = await client.rpc("kadi_v1_capture_generation_reservation", { p_reservation_id: reservationId, p_idempotency_key: idempotencyKey });
    return error ? fail(mapError(error, "CREDIT_CAPTURE_FAILED")) : ok(row(data), { duplicate: row(data)?.duplicate === true });
  }

  async function releaseReservation({ reservationId, idempotencyKey }) {
    const { data, error } = await client.rpc("kadi_v1_release_generation_reservation", { p_reservation_id: reservationId, p_idempotency_key: idempotencyKey });
    return error ? fail(mapError(error, "CREDIT_RELEASE_FAILED")) : ok(row(data), { duplicate: row(data)?.duplicate === true });
  }

  async function getOne(table, field, value, notFound) {
    const result = await client.from(table).select("*").eq(field, value).maybeSingle();
    return result.error || !result.data ? fail(notFound) : ok(result.data);
  }

  const getReservation = ({ reservationId }) => getOne("kadi_v1_wallet_reservations", "reservation_id", reservationId, "CREDIT_RESERVATION_NOT_FOUND");
  const getGenerationAttempt = ({ generationAttemptId }) => getOne("kadi_v1_generation_attempts", "generation_attempt_id", generationAttemptId, "GENERATION_ATTEMPT_NOT_FOUND");
  const getFinalFile = ({ finalFileId }) => getOne("kadi_v1_final_files", "final_file_id", finalFileId, "FINAL_FILE_NOT_FOUND");
  const getDeliveryAttempt = ({ deliveryAttemptId }) => getOne("kadi_v1_delivery_attempts", "delivery_attempt_id", deliveryAttemptId, "DELIVERY_ATTEMPT_NOT_FOUND");

  async function insertOne(table, value, conflictField, conflictValue, fallback) {
    const existing = await client.from(table).select("*").eq(conflictField, conflictValue).maybeSingle();
    if (!existing.error && existing.data) return ok(existing.data, { duplicate: true });
    const result = await client.from(table).insert(value).select("*").single();
    if (!result.error) return ok(result.data);
    const raced = await client.from(table).select("*").eq(conflictField, conflictValue).maybeSingle();
    return !raced.error && raced.data ? ok(raced.data, { duplicate: true }) : fail(mapError(result.error, fallback));
  }

  const createGenerationAttempt = ({ attempt }) => insertOne("kadi_v1_generation_attempts", attempt, "confirmation_key", attempt.confirmation_key, "GENERATION_ATTEMPT_CREATE_FAILED");

  async function findByQuoteId({ quoteId }) {
    const result = await client.from("kadi_v1_generation_attempts").select("*").eq("quote_id", quoteId).maybeSingle();
    return result.error ? fail("GENERATION_ATTEMPT_LOOKUP_FAILED") : ok(result.data || null);
  }

  async function updateGenerationAttempt({ generationAttemptId, expectedStatus, changes }) {
    const current = await getGenerationAttempt({ generationAttemptId });
    if (!current.ok || current.value.status !== expectedStatus) return fail("GENERATION_ATTEMPT_STATUS_CONFLICT");
    const result = await client.from("kadi_v1_generation_attempts").update({ ...changes, revision: current.value.revision + 1 })
      .eq("generation_attempt_id", generationAttemptId).eq("status", expectedStatus).eq("revision", current.value.revision).select("*").maybeSingle();
    return result.error || !result.data ? fail("GENERATION_ATTEMPT_CONCURRENCY_CONFLICT") : ok(result.data);
  }

  async function promoteFinalFile({ finalFile }) {
    return insertOne("kadi_v1_final_files", finalFile, "generation_attempt_id", finalFile.generation_attempt_id, "FINAL_FILE_PROMOTION_FAILED");
  }

  async function createDeliveryAttempt({ delivery, idempotencyKey }) {
    return insertOne("kadi_v1_delivery_attempts", { ...delivery, idempotency_key: idempotencyKey }, "idempotency_key", idempotencyKey, "DELIVERY_ATTEMPT_CREATE_FAILED");
  }

  async function updateDeliveryAttempt({ deliveryAttemptId, expectedStatus, changes }) {
    const current = await getDeliveryAttempt({ deliveryAttemptId });
    if (!current.ok) return current;
    if (expectedStatus != null && current.value.status !== expectedStatus) return fail("DELIVERY_ATTEMPT_CONCURRENCY_CONFLICT");
    const result = await client.from("kadi_v1_delivery_attempts").update({ ...changes, revision: current.value.revision + 1 })
      .eq("delivery_attempt_id", deliveryAttemptId).eq("revision", current.value.revision).select("*").maybeSingle();
    return result.error || !result.data ? fail("DELIVERY_ATTEMPT_CONCURRENCY_CONFLICT") : ok(result.data);
  }

  async function findDeliveryAttemptByFinalFileId({ finalFileId }) {
    const result = await client.from("kadi_v1_delivery_attempts").select("*").eq("final_file_id", finalFileId).maybeSingle();
    return result.error ? fail("DELIVERY_ATTEMPT_LOOKUP_FAILED") : ok(result.data || null);
  }

  return Object.freeze(assertGenerationLifecycleRepository({
    reserveCredits, captureReservation, releaseReservation, getReservation,
    createGenerationAttempt, getGenerationAttempt, updateGenerationAttempt, promoteFinalFile, getFinalFile, findByQuoteId,
    createDeliveryAttempt, getDeliveryAttempt, updateDeliveryAttempt, findDeliveryAttemptByFinalFileId,
  }));
}

module.exports = { createSupabaseGenerationLifecycleRepository, mapError };
