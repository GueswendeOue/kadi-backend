"use strict";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "test-service-role-key";

const test = require("node:test");
const assert = require("node:assert/strict");

const { _private } = require("../kadiStatsRepo");

test("paid credit classifier excludes admin test credits from business stats", () => {
  assert.equal(
    _private.isPaidCreditTx({
      delta: 20,
      reason: "admin_test_credit",
      meta: {
        source: "admin_test_command",
        isTestCredit: true,
        excludeFromRevenue: true,
      },
    }),
    false
  );

  assert.equal(
    _private.isPaidCreditTx({
      delta: 20,
      reason: "manual_om_topup",
      meta: {
        excludeFromRevenue: true,
      },
    }),
    false
  );

  assert.equal(
    _private.isPaidCreditTx({
      delta: 20,
      reason: "manual_om_topup",
      meta: {
        amountFcfa: 1000,
        source: "admin_command",
      },
    }),
    true
  );
});
