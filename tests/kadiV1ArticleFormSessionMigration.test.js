"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// P8.A1-D — forward-only migration adding ARTICLE_FORM to
// kadi_v1_conversation_sessions_expected_flow_key_check. This never touches
// the already-applied migrations; it only asserts the new pair of files.

const ROOT = path.resolve(__dirname, "..");
const SUPABASE_FILE = path.join(ROOT, "supabase", "migrations", "20260805020000_add_kadi_v1_article_form_flow_key.sql");
const MIGRATIONS_FILE = path.join(ROOT, "migrations", "20260805_add_kadi_v1_article_form_flow_key.sql");

const EXPECTED_VALUES = [
  "ONBOARDING", "MENU", "DOCUMENT_TYPE", "DOCUMENT_CLIENT",
  "DOCUMENT_CONTENT", "ARTICLE_FORM", "DOCUMENT_OPTIONS", "DOCUMENT_REVIEW",
  "EDIT_CLIENT", "EDIT_CONTENT", "EDIT_OPTIONS",
  "DOCUMENT_PREVIEW", "GENERATION_CONFIRMATION", "RECHARGE",
  "HISTORY_SEARCH", "DISCHARGE_DETAILS",
];

const PREVIOUS_15_VALUES = [
  "ONBOARDING", "MENU", "DOCUMENT_TYPE", "DOCUMENT_CLIENT",
  "DOCUMENT_CONTENT", "DOCUMENT_OPTIONS", "DOCUMENT_REVIEW",
  "EDIT_CLIENT", "EDIT_CONTENT", "EDIT_OPTIONS",
  "DOCUMENT_PREVIEW", "GENERATION_CONFIRMATION", "RECHARGE",
  "HISTORY_SEARCH", "DISCHARGE_DETAILS",
];

test("the new migration exists in both supabase/migrations/ and migrations/", () => {
  assert.ok(fs.existsSync(SUPABASE_FILE), "supabase/migrations/ copy is missing");
  assert.ok(fs.existsSync(MIGRATIONS_FILE), "migrations/ copy is missing");
});

test("the already-applied migrations were not touched", () => {
  const appliedSupabase = path.join(ROOT, "supabase", "migrations", "20260803204500_add_kadi_v1_conversation_sessions.sql");
  const appliedMigrations = path.join(ROOT, "migrations", "20260803_add_kadi_v1_conversation_sessions.sql");
  const supabaseSql = fs.readFileSync(appliedSupabase, "utf8");
  const migrationsSql = fs.readFileSync(appliedMigrations, "utf8");
  // The old constraint (without ARTICLE_FORM) must still be exactly what
  // was already deployed — the fix must be forward-only.
  assert.doesNotMatch(supabaseSql, /ARTICLE_FORM/);
  assert.doesNotMatch(migrationsSql, /ARTICLE_FORM/);
  assert.equal(supabaseSql, migrationsSql);
});

test("the two new migration copies are byte-identical", () => {
  const supabaseBuffer = fs.readFileSync(SUPABASE_FILE);
  const migrationsBuffer = fs.readFileSync(MIGRATIONS_FILE);
  assert.equal(Buffer.compare(supabaseBuffer, migrationsBuffer), 0);
});

test("the new constraint contains ARTICLE_FORM plus every previous value, in the expected order, and nothing else", () => {
  const sql = fs.readFileSync(SUPABASE_FILE, "utf8");
  const match = /add constraint kadi_v1_conversation_sessions_expected_flow_key_check\s*\n\s*check \(\s*\n\s*expected_flow_key in \(([\s\S]*?)\)\s*\n\s*\);/.exec(sql);
  assert.ok(match, "add constraint block not found in the expected shape");
  const listedValues = [...match[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(listedValues, EXPECTED_VALUES);
  assert.ok(EXPECTED_VALUES.includes("ARTICLE_FORM"));
  for (const value of PREVIOUS_15_VALUES) assert.ok(EXPECTED_VALUES.includes(value), `${value} must be preserved`);
  assert.equal(listedValues.length, PREVIOUS_15_VALUES.length + 1, "exactly one new value must be added");
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
