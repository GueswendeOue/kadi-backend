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

test("paid credit classifier excludes non-revenue grants and rollbacks", () => {
  for (const reason of [
    "demo_reset",
    "bonus",
    "welcome_bonus",
    "grant",
    "admin_grant",
    "rollback_pdf_failed",
  ]) {
    assert.equal(
      _private.isExcludedCreditGrant({
        delta: 20,
        reason,
        meta: {},
      }),
      true,
      reason
    );

    assert.equal(
      _private.isPaidCreditTx({
        delta: 20,
        reason,
        meta: {},
      }),
      false,
      reason
    );
  }
});

test("paid business metrics separate paid users, paid PDFs and post-topup PDFs", () => {
  const creditEventsAll = [
    {
      wa_id: "2261",
      delta: 20,
      reason: "manual_om_topup",
      created_at: "2026-04-01T00:00:00.000Z",
      meta: { amountFcfa: 2000 },
    },
    {
      wa_id: "2262",
      delta: 20,
      reason: "manual_om_topup",
      created_at: "2026-04-20T00:00:00.000Z",
      meta: { amountFcfa: 2000 },
    },
    {
      wa_id: "2262",
      delta: -1,
      reason: "pdf",
      created_at: "2026-04-21T00:00:00.000Z",
      meta: {},
    },
    {
      wa_id: "2261",
      delta: -2,
      reason: "ocr_pdf",
      created_at: "2026-04-22T00:00:00.000Z",
      meta: {},
    },
    {
      wa_id: "2263",
      delta: -1,
      reason: "pdf",
      created_at: "2026-04-23T00:00:00.000Z",
      meta: {},
    },
    {
      wa_id: "2264",
      delta: 99,
      reason: "admin_test_credit",
      created_at: "2026-04-24T00:00:00.000Z",
      meta: { isTestCredit: true, excludeFromRevenue: true },
    },
  ];

  const tx30 = creditEventsAll.slice(1);
  const metrics = _private.buildPaidBusinessMetrics({
    creditEventsAll,
    tx30,
    active30: 10,
    usersWithDocs: 5,
    packCredits: 20,
    packPriceFcfa: 2000,
  });

  assert.equal(metrics.revenueMonth, 2000);
  assert.equal(metrics.creditsPaid30, 20);
  assert.equal(metrics.paymentsReceived30d, 1);
  assert.equal(metrics.paidUsers30d, 1);
  assert.equal(metrics.activeToPaidRate, 10);
  assert.equal(metrics.docUsersToPaidRate, 20);
  assert.equal(metrics.pdfByPayingUsers30d, 1);
  assert.equal(metrics.pdfAfterFirstTopup30d, 2);
  assert.equal(metrics.paidCreditPdfConsumed30dProxy, 1);
  assert.equal(metrics.creditsUsedAfterFirstTopup30d, 3);
});

test("business insights use monetization alert instead of Doc to paid alert", () => {
  const insights = _private.buildYcInsights({
    totalUsers: 2405,
    active7: 108,
    active30: 1004,
    docs7: 16,
    docs30: 162,
    docsGenerated: 660,
    usersWithDocs: 660,
    paidUsers: 2,
    usersZeroCredits: 0,
    docs7Growth: 0,
    signupToActive30Rate: 42,
    activeToCreatedRate: 20,
  });

  assert.equal(
    insights.alerts.some((alert) => alert.includes("Conversion Doc→Payé")),
    false
  );
  assert.equal(
    insights.alerts.includes(
      "• Monétisation faible : 2 clients payants sur 1004 actifs 30j"
    ),
    true
  );
});
