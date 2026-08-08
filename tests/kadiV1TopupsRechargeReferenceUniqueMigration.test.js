"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// fix/kadi-v1-orange-money-real-provider-t10 (R1, independent review) —
// ORANGE_TOPUP_REFERENCE_CONCURRENCY_001. Forward-only, additive-only
// migration: a partial unique index on public.kadi_topups(reference),
// scoped only to Kadi V1's own `recharge:` reference namespace, so
// concurrent createPaymentRequest() calls for the same V1 merchant
// reference can no longer create two physical topup rows — while never
// touching the existing legacy duplicate reference group (which uses a
// non-V1 reference shape) or any other legacy row. This never touches any
// previously applied migration file.

const ROOT = path.resolve(__dirname, "..");
const SUPABASE_FILE = path.join(ROOT, "supabase", "migrations", "20260809030000_add_kadi_v1_topups_recharge_reference_unique.sql");
const MIGRATIONS_FILE = path.join(ROOT, "migrations", "20260809_add_kadi_v1_topups_recharge_reference_unique.sql");

test("the new migration exists in both supabase/migrations/ and migrations/", () => {
  assert.ok(fs.existsSync(SUPABASE_FILE), "supabase/migrations/ copy is missing");
  assert.ok(fs.existsSync(MIGRATIONS_FILE), "migrations/ copy is missing");
});

test("the two new migration copies are byte-identical", () => {
  const supabaseBuffer = fs.readFileSync(SUPABASE_FILE);
  const migrationsBuffer = fs.readFileSync(MIGRATIONS_FILE);
  assert.equal(Buffer.compare(supabaseBuffer, migrationsBuffer), 0);
});

test("the migration only ever creates a partial unique index — no table/column/policy/grant/data change", () => {
  const raw = fs.readFileSync(SUPABASE_FILE, "utf8");
  // Executable SQL only — the prose comment block above it legitimately
  // discusses RLS/grants/rows in plain English to explain why they are
  // untouched, which must not trip these statement-level checks.
  const sql = raw.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  assert.match(sql, /create unique index if not exists kadi_topups_v1_recharge_reference_unique/);
  assert.match(sql, /on public\.kadi_topups \(reference\)/);
  assert.match(sql, /where reference like 'recharge:%'/);
  const forbidden = [
    /create\s+table/i,
    /drop\s+table/i,
    /drop\s+index/i,
    /create\s+function/i,
    /drop\s+function/i,
    /create\s+policy/i,
    /drop\s+policy/i,
    /alter\s+table/i,
    /add\s+column/i,
    /drop\s+column/i,
    /grant\s/i,
    /revoke\s/i,
    /insert\s+into/i,
    /update\s+public\./i,
    /delete\s+from/i,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(sql, pattern, pattern.toString());
});

test("the index is idempotent-safe to re-run (if not exists) and scoped to a WHERE predicate, never table-wide", () => {
  const sql = fs.readFileSync(SUPABASE_FILE, "utf8");
  assert.match(sql, /unique index if not exists/, "must be safe to re-run");
  assert.match(sql, /where reference like 'recharge:%'/, "must be a partial index, never a table-wide unique(reference)");
  assert.doesNotMatch(sql, /create unique index if not exists kadi_topups_v1_recharge_reference_unique\s*\n\s*on public\.kadi_topups \(reference\);/, "must never be table-wide (no WHERE clause)");
});

test("the migration file documents the exact V1 reference namespace proof (kadiV1RechargeService.js's makeId(\"recharge\", ...))", () => {
  const sql = fs.readFileSync(SUPABASE_FILE, "utf8");
  assert.match(sql, /makeId\("recharge", \.\.\.\)/);
  assert.match(sql, /reference like 'recharge:%'/);
});

test("the migration never records or references the actual legacy duplicated value — only anonymized counts/shape", () => {
  const sql = fs.readFileSync(SUPABASE_FILE, "utf8");
  assert.match(sql, /one pre-existing\s*\n-- duplicated-reference group/, "must reference the finding only in anonymized/aggregate form");
  // No long non-"recharge:" quoted literal that could be a real reference value.
  assert.doesNotMatch(sql, /'[A-Za-z0-9_-]{8,}'/, "must never embed a literal reference-shaped string other than the recharge: predicate itself");
});

test("no previously applied migration file was modified by this change", () => {
  const previouslyApplied = [
    ["supabase/migrations/20260807220000_add_kadi_v1_available_wallet_balance.sql", "migrations/20260807_add_kadi_v1_available_wallet_balance.sql"],
  ];
  for (const [supabaseRelative, migrationsRelative] of previouslyApplied) {
    const supabasePath = path.join(ROOT, supabaseRelative);
    assert.ok(fs.existsSync(supabasePath), `${supabaseRelative} must still exist untouched`);
    const sql = fs.readFileSync(supabasePath, "utf8");
    assert.doesNotMatch(sql, /kadi_topups_v1_recharge_reference_unique/, "the applied migration must not have been rewritten in place to add this index");
    if (migrationsRelative) {
      const migrationsPath = path.join(ROOT, migrationsRelative);
      assert.ok(fs.existsSync(migrationsPath));
      assert.equal(fs.readFileSync(migrationsPath, "utf8"), sql);
    }
  }
});
