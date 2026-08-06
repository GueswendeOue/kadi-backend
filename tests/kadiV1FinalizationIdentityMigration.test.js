"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// fix/kadi-v1-pdf-final-state-and-tax-rate-r0 — forward-only migration that
// moves issued_at/document_number assignment from GENERATED to
// GENERATION_IN_PROGRESS inside kadi_v1_persist_transition (via a
// create-or-replace of the existing function, not an edit of any applied
// migration file) and adds a new deterministic document-number generator.
// This never touches any previously applied migration file.

const ROOT = path.resolve(__dirname, "..");
const SUPABASE_FILE = path.join(ROOT, "supabase", "migrations", "20260806010000_add_kadi_v1_finalization_identity.sql");
const MIGRATIONS_FILE = path.join(ROOT, "migrations", "20260806_add_kadi_v1_finalization_identity.sql");

test("the new migration exists in both supabase/migrations/ and migrations/", () => {
  assert.ok(fs.existsSync(SUPABASE_FILE), "supabase/migrations/ copy is missing");
  assert.ok(fs.existsSync(MIGRATIONS_FILE), "migrations/ copy is missing");
});

test("the two new migration copies are byte-identical", () => {
  const supabaseBuffer = fs.readFileSync(SUPABASE_FILE);
  const migrationsBuffer = fs.readFileSync(MIGRATIONS_FILE);
  assert.equal(Buffer.compare(supabaseBuffer, migrationsBuffer), 0);
});

test("no previously applied migration file was modified by this change", () => {
  const previouslyApplied = [
    ["supabase/migrations/20260803022056_add_kadi_v1_preview_generation.sql", "migrations/20260802_add_kadi_v1_preview_generation.sql"],
    ["supabase/migrations/20260803022133_add_kadi_v1_generation_lifecycle.sql", null],
  ];
  for (const [supabaseRelative, migrationsRelative] of previouslyApplied) {
    const supabasePath = path.join(ROOT, supabaseRelative);
    assert.ok(fs.existsSync(supabasePath), `${supabaseRelative} must still exist untouched`);
    const sql = fs.readFileSync(supabasePath, "utf8");
    assert.doesNotMatch(sql, /kadi_v1_generate_document_number/, "the applied migration must not have been rewritten in place");
    if (migrationsRelative) {
      const migrationsPath = path.join(ROOT, migrationsRelative);
      assert.ok(fs.existsSync(migrationsPath));
      assert.equal(fs.readFileSync(migrationsPath, "utf8"), sql);
    }
  }
});

test("kadi_v1_persist_transition is redefined via create or replace, not a table/column/policy change", () => {
  const sql = fs.readFileSync(SUPABASE_FILE, "utf8");
  assert.match(sql, /create or replace function public\.kadi_v1_persist_transition/);
  assert.match(sql, /create or replace function public\.kadi_v1_generate_document_number/);
  const forbidden = [
    /create\s+table/i,
    /drop\s+table/i,
    /drop\s+function/i,
    /create\s+policy/i,
    /drop\s+policy/i,
    /add\s+column/i,
    /drop\s+column/i,
    /delete\s+from/i,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(sql, pattern, pattern.toString());
});

test("issued_at/document_number are assigned only once, at GENERATION_IN_PROGRESS, exclusively from clock_timestamp()/the generator — never trusted from the caller snapshot", () => {
  const sql = fs.readFileSync(SUPABASE_FILE, "utf8");
  assert.match(sql, /v_document\.issued_at is null and p_to_state = 'GENERATION_IN_PROGRESS'/);
  assert.match(sql, /v_issued_at := clock_timestamp\(\);/);
  assert.match(sql, /v_document_number := public\.kadi_v1_generate_document_number\(v_document\.document_type, p_document_id, v_issued_at\);/);
  // once already set, both must be preserved and any conflicting caller-supplied value rejected
  assert.match(sql, /KADI_V1_SERVER_FIELD_FORBIDDEN/);
  const forbiddenCount = (sql.match(/KADI_V1_SERVER_FIELD_FORBIDDEN/g) || []).length;
  assert.equal(forbiddenCount, 2, "one guard for issued_at, one for document_number");
});

test("the document_number generator is deterministic SQL with no randomness or external dependency", () => {
  const sql = fs.readFileSync(SUPABASE_FILE, "utf8");
  const match = /create or replace function public\.kadi_v1_generate_document_number[\s\S]*?\$\$;/.exec(sql);
  assert.ok(match, "generator function body not found");
  const body = match[0];
  assert.match(body, /language sql/);
  assert.match(body, /immutable/);
  assert.doesNotMatch(body, /random\(/i);
  assert.doesNotMatch(body, /gen_random_uuid/i);
});

test("the id-tail suffix targets exactly 8 characters — lpad must not truncate the 8-character right() extraction down to 4", () => {
  const sql = fs.readFileSync(SUPABASE_FILE, "utf8");
  // PostgreSQL's lpad(string, length, fill) TRUNCATES string when it is
  // already longer than length — right(id, 8) always returns up to 8
  // characters, so a target length of 4 here would silently drop 4 of
  // those characters instead of ever padding anything. Target length must
  // equal the right()-extraction length (8), not be smaller than it.
  assert.match(
    sql,
    /upper\(lpad\(right\(regexp_replace\(p_document_id, '\[\^A-Za-z0-9\]', '', 'g'\), 8\), 8, '0'\)\)/,
    "lpad target length must be 8, matching right()'s extraction length, or the suffix silently truncates to 4 characters"
  );
  assert.doesNotMatch(sql, /right\([^)]*\), 8\), 4, '0'\)/, "the original 4-character truncation bug must not be present");
});

test("service-role-only grants are preserved for both functions", () => {
  const sql = fs.readFileSync(SUPABASE_FILE, "utf8");
  for (const fn of [
    "kadi_v1_generate_document_number(text, text, timestamptz)",
    "kadi_v1_persist_transition(text, text, integer, jsonb, jsonb, text, text, text, text, jsonb)",
  ]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} from public;`));
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} to service_role;`));
  }
});
