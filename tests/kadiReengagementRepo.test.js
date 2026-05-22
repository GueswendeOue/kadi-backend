"use strict";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "test-service-role-key";

const test = require("node:test");
const assert = require("node:assert/strict");

const { _private } = require("../kadiReengagementRepo");

function restoreEnv(key, value) {
  if (value == null) delete process.env[key];
  else process.env[key] = value;
}

function candidate(events) {
  return _private.buildExhaustedCreditCandidate(
    {
      wa_id: "22670000001",
      owner_name: "Client",
      created_at: "2026-05-01T08:00:00.000Z",
      last_seen: "2026-05-12T08:00:00.000Z",
    },
    events
  );
}

test("exhausted credit candidate requires strict zero balance after document consumption", () => {
  const row = candidate([
    {
      wa_id: "22670000001",
      delta: 2,
      reason: "manual_om_topup",
      created_at: "2026-05-10T08:00:00.000Z",
      meta: { amountFcfa: 1000 },
    },
    {
      wa_id: "22670000001",
      delta: -2,
      reason: "pdf_stamp",
      created_at: "2026-05-11T08:00:00.000Z",
      meta: {},
    },
  ]);

  assert.equal(row.wa_id, "22670000001");
  assert.equal(row.balance, 0);
  assert.equal(row.exhausted_at, "2026-05-11T08:00:00.000Z");
  assert.equal(row.last_activity_at, "2026-05-12T08:00:00.000Z");
});

test("exhausted credit candidate excludes users with positive balance", () => {
  const row = candidate([
    {
      wa_id: "22670000001",
      delta: 3,
      reason: "manual_om_topup",
      created_at: "2026-05-10T08:00:00.000Z",
      meta: { amountFcfa: 1000 },
    },
    {
      wa_id: "22670000001",
      delta: -2,
      reason: "pdf_stamp",
      created_at: "2026-05-11T08:00:00.000Z",
      meta: {},
    },
  ]);

  assert.equal(row, null);
});

test("exhausted credit candidate excludes recharge after exhaustion", () => {
  const row = candidate([
    {
      wa_id: "22670000001",
      delta: 1,
      reason: "manual_om_topup",
      created_at: "2026-05-10T08:00:00.000Z",
      meta: { amountFcfa: 1000 },
    },
    {
      wa_id: "22670000001",
      delta: -1,
      reason: "pdf",
      created_at: "2026-05-11T08:00:00.000Z",
      meta: {},
    },
    {
      wa_id: "22670000001",
      delta: 10,
      reason: "manual_om_topup",
      created_at: "2026-05-12T08:00:00.000Z",
      meta: { amountFcfa: 1000 },
    },
    {
      wa_id: "22670000001",
      delta: -10,
      reason: "not_pdf",
      created_at: "2026-05-13T08:00:00.000Z",
      meta: {},
    },
  ]);

  assert.equal(row, null);
});

test("exhausted credit candidate ignores admin test and non-revenue credit grants", () => {
  assert.equal(
    _private.isExcludedCreditEvent({
      delta: 20,
      reason: "admin_test_credit",
      meta: { isTestCredit: true, excludeFromRevenue: true },
    }),
    true
  );

  assert.equal(
    _private.isExcludedCreditEvent({
      delta: 20,
      reason: "manual_om_topup",
      meta: { excludeFromRevenue: true },
    }),
    true
  );
});

test("default excluded wa ids include admin and configured test numbers", () => {
  const oldAdmin = process.env.KADI_ADMIN_WA;
  const oldAdmin2 = process.env.ADMIN_WA_ID;
  const oldExclude = process.env.KADI_REENGAGEMENT_EXCLUDE_WA_IDS;
  const oldTests = process.env.KADI_TEST_WA_IDS;

  process.env.KADI_ADMIN_WA = "22670000001";
  process.env.ADMIN_WA_ID = "22670000002";
  process.env.KADI_REENGAGEMENT_EXCLUDE_WA_IDS = "22670000003,22670000004";
  process.env.KADI_TEST_WA_IDS = "22670000005 22670000006";

  const ids = _private.getDefaultExcludedWaIds();

  restoreEnv("KADI_ADMIN_WA", oldAdmin);
  restoreEnv("ADMIN_WA_ID", oldAdmin2);
  restoreEnv("KADI_REENGAGEMENT_EXCLUDE_WA_IDS", oldExclude);
  restoreEnv("KADI_TEST_WA_IDS", oldTests);

  assert.equal(
    [
      "22670000001",
      "22670000002",
      "22670000003",
      "22670000004",
      "22670000005",
      "22670000006",
    ].every((id) => ids.includes(id)),
    true
  );
});
