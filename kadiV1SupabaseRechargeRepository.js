"use strict";

const { assertRechargeRepository } = require("./kadiV1RechargeRepository");

const ok = (value, extra = {}) => ({ ok: true, value, ...extra });
const fail = (error) => ({ ok: false, error });
const row = (data) => Array.isArray(data) ? data[0] : data;

function mapRechargeError(error, fallback) {
  const text = `${error?.message || ""} ${error?.details || ""}`;
  if (/PAYMENT_EVENT_REPLAY_CONFLICT/i.test(text)) return "PAYMENT_EVENT_REPLAY_CONFLICT";
  if (/RECHARGE_SESSION_NOT_CREDITABLE/i.test(text)) return "RECHARGE_SESSION_NOT_CREDITABLE";
  if (/PAYMENT_EVENT_MISMATCH/i.test(text)) return "PAYMENT_EVENT_MISMATCH";
  if (/duplicate key|unique constraint/i.test(text)) return "RECHARGE_CONCURRENCY_CONFLICT";
  return fallback;
}

function createSupabaseRechargeRepository(client) {
  if (!client || typeof client.from !== "function" || typeof client.rpc !== "function") throw new TypeError("SUPABASE_CLIENT_REQUIRED");

  async function getOne(table, field, value, notFound) {
    const result = await client.from(table).select("*").eq(field, value).maybeSingle();
    return result.error || !result.data ? fail(notFound) : ok(result.data);
  }

  async function createRechargeSession({ session, resumeLink = null, idempotencyKey }) {
    const existing = await findSessionByIdempotencyKey(idempotencyKey);
    if (existing.ok && existing.value) return ok(existing.value, { duplicate: true });
    const result = await client.rpc("kadi_v1_create_recharge_session", {
      p_session: { ...session, create_idempotency_key: idempotencyKey },
      p_resume_link: resumeLink,
    });
    const value = row(result.data);
    return result.error ? fail(mapRechargeError(result.error, "RECHARGE_SESSION_CREATE_FAILED")) : ok(value?.session || value, { duplicate: value?.duplicate === true });
  }

  const getRechargeSession = ({ rechargeSessionId }) => getOne("kadi_v1_recharge_sessions", "recharge_session_id", rechargeSessionId, "RECHARGE_SESSION_NOT_FOUND");

  async function findSessionByIdempotencyKey(idempotencyKey) {
    const result = await client.from("kadi_v1_recharge_sessions").select("*").eq("create_idempotency_key", idempotencyKey).maybeSingle();
    return result.error ? fail("RECHARGE_SESSION_LOOKUP_FAILED") : ok(result.data || null);
  }

  async function updateRechargeSession({ rechargeSessionId, expectedStatuses, changes }) {
    const current = await getRechargeSession({ rechargeSessionId });
    if (!current.ok || !expectedStatuses.includes(current.value.status)) return fail("RECHARGE_SESSION_STATUS_CONFLICT");
    const result = await client.from("kadi_v1_recharge_sessions").update({ ...changes, revision: current.value.revision + 1 })
      .eq("recharge_session_id", rechargeSessionId).eq("revision", current.value.revision).in("status", expectedStatuses).select("*").maybeSingle();
    return result.error || !result.data ? fail("RECHARGE_SESSION_CONCURRENCY_CONFLICT") : ok(result.data);
  }

  async function recordPaymentEvent({ event, fingerprint }) {
    const existing = await getPaymentEvent({ provider: event.provider, providerEventId: event.provider_event_id });
    if (existing.ok && existing.value) return existing.value.event_fingerprint === fingerprint
      ? ok(existing.value, { duplicate: true }) : fail("PAYMENT_EVENT_REPLAY_CONFLICT");
    const result = await client.from("kadi_v1_payment_events").insert({ ...event, event_fingerprint: fingerprint }).select("*").single();
    return result.error ? fail(mapRechargeError(result.error, "PAYMENT_EVENT_RECORD_FAILED")) : ok(result.data);
  }

  async function getPaymentEvent({ provider, providerEventId }) {
    const result = await client.from("kadi_v1_payment_events").select("*").eq("provider", provider).eq("provider_event_id", providerEventId).maybeSingle();
    return result.error ? fail("PAYMENT_EVENT_LOOKUP_FAILED") : ok(result.data || null);
  }

  async function confirmPaymentAndCredit({ rechargeSessionId, event, fingerprint, idempotencyKey, creditedAt, allowLate = false }) {
    const result = await client.rpc("kadi_v1_confirm_recharge_credit", {
      p_recharge_session_id: rechargeSessionId,
      p_provider: event.provider,
      p_provider_payment_id: event.provider_payment_id,
      p_provider_event_id: event.provider_event_id,
      p_merchant_reference: event.merchant_reference,
      p_amount: event.amount,
      p_currency: event.currency,
      p_status: event.status,
      p_verified: event.verified,
      p_occurred_at: event.occurred_at,
      p_event_fingerprint: fingerprint,
      p_credit_idempotency_key: idempotencyKey,
      p_credited_at: creditedAt,
      p_allow_late: allowLate,
    });
    if (result.error) return fail(mapRechargeError(result.error, "RECHARGE_CREDIT_FAILED"));
    const value = row(result.data);
    return value?.ok === false ? fail(value.error || "RECHARGE_CREDIT_FAILED") : ok(value?.session || value, { duplicate: value?.duplicate === true, balance: value?.balance });
  }

  async function getBalance({ ownerWaId }) {
    const result = await client.rpc("kadi_v1_get_wallet_balance", { p_owner_wa_id: ownerWaId });
    return result.error ? fail("WALLET_BALANCE_LOOKUP_FAILED") : ok(Number(row(result.data)?.balance ?? row(result.data) ?? 0));
  }

  // T6/BALANCE-001: additive method, never replacing getBalance() above —
  // getBalance() remains available for its other callers.
  // RECHARGE_RESUME_AVAILABLE_BALANCE_001 (R0) switched
  // kadiV1RechargeService.js's resumePendingGeneration precheck from
  // getBalance() to THIS method. Reads the SAME single RPC call
  // (kadi_v1_get_wallet_balance), which also returns
  // total_credits/reserved_credits/available_credits computed atomically
  // alongside balance (see
  // migrations/20260807_add_kadi_v1_available_wallet_balance.sql) — one
  // database round trip, never two separate application-side reads that
  // could observe a torn snapshot across a concurrent reserve/capture.
  // Fails closed (never clamps or fabricates) if the RPC ever returns an
  // impossible financial state.
  async function getAvailableBalance({ ownerWaId }) {
    const result = await client.rpc("kadi_v1_get_wallet_balance", { p_owner_wa_id: ownerWaId });
    if (result.error) return fail("WALLET_BALANCE_LOOKUP_FAILED");
    const data = row(result.data) || {};
    const total = Number(data.total_credits);
    const reserved = Number(data.reserved_credits);
    const available = Number(data.available_credits);
    if (
      !Number.isSafeInteger(total) || total < 0 ||
      !Number.isSafeInteger(reserved) || reserved < 0 ||
      !Number.isSafeInteger(available) || available < 0 ||
      total - reserved !== available
    ) {
      return fail("KADI_V1_BALANCE_INVALID");
    }
    return ok({ total_credits: total, reserved_credits: reserved, available_credits: available });
  }

  async function createResumeLink({ link }) {
    const existing = await getResumeLink({ rechargeSessionId: link.recharge_session_id });
    if (existing.ok) return ok(existing.value, { duplicate: true });
    const result = await client.from("kadi_v1_recharge_resume_links").insert(link).select("*").single();
    return result.error ? fail("RECHARGE_RESUME_LINK_CREATE_FAILED") : ok(result.data);
  }

  const getResumeLink = ({ rechargeSessionId }) => getOne("kadi_v1_recharge_resume_links", "recharge_session_id", rechargeSessionId, "RECHARGE_RESUME_LINK_NOT_FOUND");

  async function updateResumeLink({ rechargeSessionId, expectedStatuses, changes }) {
    const current = await getResumeLink({ rechargeSessionId });
    if (!current.ok || !expectedStatuses.includes(current.value.resume_status)) return fail("RECHARGE_RESUME_STATUS_CONFLICT");
    const result = await client.from("kadi_v1_recharge_resume_links").update({ ...changes, revision: current.value.revision + 1 })
      .eq("recharge_session_id", rechargeSessionId).eq("revision", current.value.revision).in("resume_status", expectedStatuses).select("*").maybeSingle();
    return result.error || !result.data ? fail("RECHARGE_RESUME_CONCURRENCY_CONFLICT") : ok(result.data);
  }

  return Object.freeze(assertRechargeRepository({
    createRechargeSession, getRechargeSession, findSessionByIdempotencyKey, updateRechargeSession,
    recordPaymentEvent, getPaymentEvent, confirmPaymentAndCredit, getBalance, getAvailableBalance,
    createResumeLink, getResumeLink, updateResumeLink,
  }));
}

module.exports = { createSupabaseRechargeRepository, mapRechargeError };
