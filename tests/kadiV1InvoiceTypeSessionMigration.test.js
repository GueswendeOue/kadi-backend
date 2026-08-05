"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// P8.A2 — forward-only migration adding INVOICE_TYPE to
// kadi_v1_conversation_sessions_expected_flow_key_check. This never touches
// any previously applied migration; it only asserts the new pair of files.

const ROOT = path.resolve(__dirname, "..");
const SUPABASE_FILE = path.join(ROOT, "supabase", "migrations", "20260805030000_add_kadi_v1_invoice_type_flow_key.sql");
const MIGRATIONS_FILE = path.join(ROOT, "migrations", "20260805_add_kadi_v1_invoice_type_flow_key.sql");

const EXPECTED_VALUES = [
  "ONBOARDING", "MENU", "DOCUMENT_TYPE", "INVOICE_TYPE", "DOCUMENT_CLIENT",
  "DOCUMENT_CONTENT", "ARTICLE_FORM", "DOCUMENT_OPTIONS", "DOCUMENT_REVIEW",
  "EDIT_CLIENT", "EDIT_CONTENT", "EDIT_OPTIONS",
  "DOCUMENT_PREVIEW", "GENERATION_CONFIRMATION", "RECHARGE",
  "HISTORY_SEARCH", "DISCHARGE_DETAILS",
];

const PREVIOUS_16_VALUES = [
  "ONBOARDING", "MENU", "DOCUMENT_TYPE", "DOCUMENT_CLIENT",
  "DOCUMENT_CONTENT", "ARTICLE_FORM", "DOCUMENT_OPTIONS", "DOCUMENT_REVIEW",
  "EDIT_CLIENT", "EDIT_CONTENT", "EDIT_OPTIONS",
  "DOCUMENT_PREVIEW", "GENERATION_CONFIRMATION", "RECHARGE",
  "HISTORY_SEARCH", "DISCHARGE_DETAILS",
];

test("the new migration exists in both supabase/migrations/ and migrations/", () => {
  assert.ok(fs.existsSync(SUPABASE_FILE), "supabase/migrations/ copy is missing");
  assert.ok(fs.existsSync(MIGRATIONS_FILE), "migrations/ copy is missing");
});

test("the already-applied migrations were not touched", () => {
  const appliedSupabase = path.join(ROOT, "supabase", "migrations", "20260805020000_add_kadi_v1_article_form_flow_key.sql");
  const appliedMigrations = path.join(ROOT, "migrations", "20260805_add_kadi_v1_article_form_flow_key.sql");
  const supabaseSql = fs.readFileSync(appliedSupabase, "utf8");
  const migrationsSql = fs.readFileSync(appliedMigrations, "utf8");
  // The previous constraint (without INVOICE_TYPE) must still be exactly
  // what was already deployed — this fix must be forward-only.
  assert.doesNotMatch(supabaseSql, /INVOICE_TYPE/);
  assert.doesNotMatch(migrationsSql, /INVOICE_TYPE/);
  assert.equal(supabaseSql, migrationsSql);
});

test("the two new migration copies are byte-identical", () => {
  const supabaseBuffer = fs.readFileSync(SUPABASE_FILE);
  const migrationsBuffer = fs.readFileSync(MIGRATIONS_FILE);
  assert.equal(Buffer.compare(supabaseBuffer, migrationsBuffer), 0);
});

test("the new constraint contains INVOICE_TYPE right after DOCUMENT_TYPE, plus every previous value, and nothing else", () => {
  const sql = fs.readFileSync(SUPABASE_FILE, "utf8");
  const match = /add constraint kadi_v1_conversation_sessions_expected_flow_key_check\s*\n\s*check \(\s*\n\s*expected_flow_key in \(([\s\S]*?)\)\s*\n\s*\);/.exec(sql);
  assert.ok(match, "add constraint block not found in the expected shape");
  const listedValues = [...match[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(listedValues, EXPECTED_VALUES);
  assert.equal(listedValues.indexOf("INVOICE_TYPE"), listedValues.indexOf("DOCUMENT_TYPE") + 1, "INVOICE_TYPE must sit right after DOCUMENT_TYPE");
  for (const value of PREVIOUS_16_VALUES) assert.ok(EXPECTED_VALUES.includes(value), `${value} must be preserved`);
  assert.equal(listedValues.length, PREVIOUS_16_VALUES.length + 1, "exactly one new value must be added");
  assert.equal(listedValues.length, 17, "the constraint must list exactly 17 values");
});

test("the migration drops the old constraint by name before recreating it, defensively (IF EXISTS)", () => {
  const sql = fs.readFileSync(SUPABASE_FILE, "utf8");
  assert.match(sql, /drop constraint if exists kadi_v1_conversation_sessions_expected_flow_key_check;/);
});

test("no other SQL object, column, index, function, policy or data is touched", () => {
  const sql = fs.readFileSync(SUPABASE_FILE, "utf8");
  const forbidden = [
    /create\s+table/i,
    /drop\s+table/i,
    /create\s+or\s+replace\s+function/i,
    /drop\s+function/i,
    /create\s+policy/i,
    /drop\s+policy/i,
    /create\s+index/i,
    /drop\s+index/i,
    /\bgrant\s/i,
    /\brevoke\s/i,
    /insert\s+into/i,
    /^\s*update\s+public\./im,
    /delete\s+from/i,
    /add\s+column/i,
    /drop\s+column/i,
    /enable\s+row\s+level\s+security/i,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(sql, pattern, pattern.toString());

  // Every "alter table" statement must target only this one table and
  // only touch the expected_flow_key check constraint.
  const alterStatements = sql.match(/alter\s+table[^;]*;/gi) || [];
  assert.equal(alterStatements.length, 2, "expected exactly the drop + add constraint statements");
  for (const statement of alterStatements) {
    assert.match(statement, /alter table public\.kadi_v1_conversation_sessions/i);
    assert.match(statement, /constraint\s+(if exists\s+)?kadi_v1_conversation_sessions_expected_flow_key_check/i);
  }
});
