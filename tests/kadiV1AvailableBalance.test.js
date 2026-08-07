"use strict";

// T6/BALANCE-001: focused, repository/contract-level coverage of the
// reservation-lifecycle arithmetic mandated by the mission (Tests A-H),
// the Supabase-backed repository's fail-closed contract, and the shared
// presentation formatter — independent of the full production-composition
// E2E proof in tests/kadiV1AvailableBalanceE2E.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createInMemoryRechargeRepository } = require("../kadiV1RechargeRepository");
const { createSupabaseRechargeRepository } = require("../kadiV1SupabaseRechargeRepository");
const { createKadiV1BalanceReader } = require("../kadiV1ProductionInfrastructure");
const { formatAvailableBalanceText } = require("../kadiV1BalancePresentation");

const OWNER = "22670000000";

function repositoryWithReserved(total, reserved) {
  return createInMemoryRechargeRepository({
    balances: { [OWNER]: total },
    reservedAmountProvider: async () => reserved,
  });
}

// ===== Mandatory reservation lifecycle cases (A-H) =====

test("A. No reservation: available equals total", async () => {
  const repository = repositoryWithReserved(10, 0);
  const result = await repository.getAvailableBalance({ ownerWaId: OWNER });
  assert.deepEqual(result, { ok: true, value: { total_credits: 10, reserved_credits: 0, available_credits: 10 } });
});

test("B. One live RESERVED reservation: available is reduced", async () => {
  const repository = repositoryWithReserved(10, 3);
  const result = await repository.getAvailableBalance({ ownerWaId: OWNER });
  assert.deepEqual(result.value, { total_credits: 10, reserved_credits: 3, available_credits: 7 });
});

test("C. Multiple live RESERVED reservations: their sum is subtracted", async () => {
  const repository = repositoryWithReserved(10, 2 + 3);
  const result = await repository.getAvailableBalance({ ownerWaId: OWNER });
  assert.deepEqual(result.value, { total_credits: 10, reserved_credits: 5, available_credits: 5 });
});

test("D. A RELEASED reservation does not count", async () => {
  // reservedAmountProvider models "live RESERVED sum only" — a released
  // reservation is already excluded upstream (kadi_v1_wallet_reservations
  // WHERE status = 'RESERVED'), so the provider simply returns 0 here.
  const repository = repositoryWithReserved(10, 0);
  const result = await repository.getAvailableBalance({ ownerWaId: OWNER });
  assert.deepEqual(result.value, { total_credits: 10, reserved_credits: 0, available_credits: 10 });
});

test("E. A CAPTURED reservation is not subtracted a second time — the wallet total already reflects the consumption", async () => {
  // Authoritative final state: wallet total already consumed by the real
  // capture path (7, not 10), and the CAPTURED reservation itself is
  // already excluded from the RESERVED sum (kadi_v1_capture_generation_reservation
  // flips status to CAPTURED atomically with the credit consumption).
  const repository = repositoryWithReserved(7, 0);
  const result = await repository.getAvailableBalance({ ownerWaId: OWNER });
  assert.deepEqual(result.value, { total_credits: 7, reserved_credits: 0, available_credits: 7 }, "must be 7, never 4 (double-subtracted)");
});

test("F. Mixed RESERVED and RELEASED: only the live RESERVED amount counts", async () => {
  // total=10, one RESERVED=2 (live), one RELEASED=3 (excluded) -> available=8
  const repository = repositoryWithReserved(10, 2);
  const result = await repository.getAvailableBalance({ ownerWaId: OWNER });
  assert.deepEqual(result.value, { total_credits: 10, reserved_credits: 2, available_credits: 8 });
});

test("G. Exact boundary: reserved equals total, available is exactly zero", async () => {
  const repository = repositoryWithReserved(3, 3);
  const result = await repository.getAvailableBalance({ ownerWaId: OWNER });
  assert.deepEqual(result.value, { total_credits: 3, reserved_credits: 3, available_credits: 0 });
});

test("H. Malformed/impossible state (reserved > total) fails closed — no negative or guessed number", async () => {
  const repository = repositoryWithReserved(5, 8);
  const result = await repository.getAvailableBalance({ ownerWaId: OWNER });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_BALANCE_INVALID" });
});

test("getBalance() itself is completely unaffected — still the raw number, unchanged, for kadiV1RechargeService.js's resumePendingGeneration", async () => {
  const repository = repositoryWithReserved(10, 3);
  const raw = await repository.getBalance({ ownerWaId: OWNER });
  assert.deepEqual(raw, { ok: true, value: 10 }, "getBalance() must still return the raw wallet total, ignoring reservations entirely");
});

// ===== Supabase-backed repository: fail-closed RPC contract =====

function fakeSupabaseClient(rpcResult) {
  return {
    from() { throw new Error("UNEXPECTED_CALL:from"); },
    async rpc(name, args) {
      assert.equal(name, "kadi_v1_get_wallet_balance");
      assert.deepEqual(args, { p_owner_wa_id: OWNER });
      return rpcResult;
    },
  };
}

test("Supabase repository: a well-formed RPC row produces the canonical shape", async () => {
  const client = fakeSupabaseClient({ data: { balance: 10, total_credits: 10, reserved_credits: 3, available_credits: 7 }, error: null });
  const repository = createSupabaseRechargeRepository(client);
  const result = await repository.getAvailableBalance({ ownerWaId: OWNER });
  assert.deepEqual(result, { ok: true, value: { total_credits: 10, reserved_credits: 3, available_credits: 7 } });
});

test("Supabase repository: an array-wrapped RPC row (Postgres RPC convention) is unwrapped correctly", async () => {
  const client = fakeSupabaseClient({ data: [{ balance: 5, total_credits: 5, reserved_credits: 0, available_credits: 5 }], error: null });
  const repository = createSupabaseRechargeRepository(client);
  const result = await repository.getAvailableBalance({ ownerWaId: OWNER });
  assert.deepEqual(result.value, { total_credits: 5, reserved_credits: 0, available_credits: 5 });
});

test("Supabase repository: an RPC error fails closed", async () => {
  const client = fakeSupabaseClient({ data: null, error: { message: "connection reset" } });
  const repository = createSupabaseRechargeRepository(client);
  const result = await repository.getAvailableBalance({ ownerWaId: OWNER });
  assert.deepEqual(result, { ok: false, error: "WALLET_BALANCE_LOOKUP_FAILED" });
});

test("Supabase repository: an impossible RPC result (reserved > total) fails closed, never fabricated", async () => {
  const client = fakeSupabaseClient({ data: { balance: 5, total_credits: 5, reserved_credits: 8, available_credits: -3 }, error: null });
  const repository = createSupabaseRechargeRepository(client);
  const result = await repository.getAvailableBalance({ ownerWaId: OWNER });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_BALANCE_INVALID" });
});

test("Supabase repository: a non-integer field fails closed", async () => {
  const client = fakeSupabaseClient({ data: { balance: 5, total_credits: 5.5, reserved_credits: 0, available_credits: 5.5 }, error: null });
  const repository = createSupabaseRechargeRepository(client);
  const result = await repository.getAvailableBalance({ ownerWaId: OWNER });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_BALANCE_INVALID" });
});

test("Supabase repository: an inconsistent triple (available != total - reserved) fails closed", async () => {
  const client = fakeSupabaseClient({ data: { balance: 10, total_credits: 10, reserved_credits: 3, available_credits: 6 }, error: null });
  const repository = createSupabaseRechargeRepository(client);
  const result = await repository.getAvailableBalance({ ownerWaId: OWNER });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_BALANCE_INVALID" });
});

test("Supabase repository: getBalance() still reads only the raw balance field, unaffected by the new fields being present", async () => {
  const client = fakeSupabaseClient({ data: { balance: 10, total_credits: 10, reserved_credits: 3, available_credits: 7 }, error: null });
  const repository = createSupabaseRechargeRepository(client);
  const raw = await repository.getBalance({ ownerWaId: OWNER });
  assert.deepEqual(raw, { ok: true, value: 10 });
});

// ===== BalanceReader: end-to-end of the repository-to-reader boundary =====

test("BalanceReader requires getAvailableBalance on construction (not getBalance)", () => {
  assert.throws(() => createKadiV1BalanceReader({ rechargeRepository: { getBalance: async () => ({}) } }), TypeError);
  assert.doesNotThrow(() => createKadiV1BalanceReader({ rechargeRepository: { getAvailableBalance: async () => ({}) } }));
});

test("BalanceReader propagates a repository-level fail-closed result unchanged", async () => {
  const reader = createKadiV1BalanceReader({ rechargeRepository: repositoryWithReserved(5, 8) });
  const result = await reader.getBalance({ ownerWaId: OWNER });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_BALANCE_INVALID" });
});

test("BalanceReader rejects an invalid ownerWaId before ever touching the repository", async () => {
  let called = false;
  const reader = createKadiV1BalanceReader({ rechargeRepository: { getAvailableBalance: async () => { called = true; return { ok: true, value: {} }; } } });
  const result = await reader.getBalance({ ownerWaId: "not-a-real-id" });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_BALANCE_OWNER_INVALID" });
  assert.equal(called, false);
});

// ===== Shared presentation formatter =====

test("formatAvailableBalanceText: exact mission copy for 0, 1, N credits, no reservation", () => {
  assert.equal(formatAvailableBalanceText({ availableCredits: 0 }), "Vous avez 0 crédit disponible.");
  assert.equal(formatAvailableBalanceText({ availableCredits: 1 }), "Vous avez 1 crédit disponible.");
  assert.equal(formatAvailableBalanceText({ availableCredits: 5 }), "Vous avez 5 crédits disponibles.");
});

test("formatAvailableBalanceText: a short second sentence appears only when credits are held, singular/plural correct", () => {
  assert.equal(
    formatAvailableBalanceText({ availableCredits: 7, reservedCredits: 3 }),
    "Vous avez 7 crédits disponibles.\n3 crédits sont temporairement réservés pour une génération en cours."
  );
  assert.equal(
    formatAvailableBalanceText({ availableCredits: 7, reservedCredits: 1 }),
    "Vous avez 7 crédits disponibles.\n1 crédit est temporairement réservé pour une génération en cours."
  );
  assert.equal(formatAvailableBalanceText({ availableCredits: 7, reservedCredits: 0 }), "Vous avez 7 crédits disponibles.");
});

test("formatAvailableBalanceText: never exposes internal identifiers, and rejects negative/non-integer input", () => {
  const text = formatAvailableBalanceText({ availableCredits: 3, reservedCredits: 2 });
  assert.doesNotMatch(text, /reservation|quote|wallet|profile|id:|status/i);
  assert.throws(() => formatAvailableBalanceText({ availableCredits: -1 }), TypeError);
  assert.throws(() => formatAvailableBalanceText({ availableCredits: 1.5 }), TypeError);
  assert.throws(() => formatAvailableBalanceText({ availableCredits: 3, reservedCredits: -1 }), TypeError);
});
