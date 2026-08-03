"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const expected = {
    "20260802_create_kadi_v1_document_persistence.sql":  [
                                                             "kadi_v1_reject_immutable_mutation()",
                                                             "kadi_v1_create_document(jsonb, text, jsonb, jsonb, text, text, text, text, jsonb)",
                                                             "kadi_v1_persist_transition(text, text, integer, jsonb, jsonb, text, text, text, text, jsonb)",
                                                             "kadi_v1_append_domain_event(text, text, text, text, text, text, jsonb)"
                                                         ],
    "20260803_add_kadi_v1_conversation_sessions.sql":  [
                                                               "kadi_v1_create_conversation_session(jsonb)",
                                                               "kadi_v1_save_conversation_session(jsonb)"
                                                           ],
    "20260802_add_kadi_v1_onboarding.sql":  [
                                                "kadi_v1_create_or_get_minimal_profile(text, text)",
                                                "kadi_v1_grant_welcome_credits(text, text)",
                                                "kadi_v1_record_onboarding_event(text, text, text, text)",
                                                "kadi_v1_set_onboarding_status(text, text, text, text)"
                                            ],
    "20260802_add_kadi_v1_preview_generation.sql":  [
                                                        "kadi_v1_persist_transition(text, text, integer, jsonb, jsonb, text, text, text, text, jsonb)"
                                                    ],
    "20260802_add_kadi_v1_generation_lifecycle.sql":  [
                                                          "kadi_v1_persist_generated_transition(text, text, integer, jsonb, jsonb, text, text, text, text, jsonb)",
                                                          "kadi_v1_reserve_generation_credits(text, text, text, integer, text)",
                                                          "kadi_v1_capture_generation_reservation(text, text)",
                                                          "kadi_v1_release_generation_reservation(text, text)"
                                                      ],
    "20260802_add_kadi_v1_recharge.sql":  [
                                              "kadi_v1_create_recharge_session(jsonb, jsonb)",
                                              "kadi_v1_get_wallet_balance(text)",
                                              "kadi_v1_confirm_recharge_credit(text, text, text, text, text, integer, text, text, boolean, timestamptz, text, text, timestamptz, boolean)"
                                          ],
    "20260802_zz_add_kadi_v1_history_search.sql":  [
                                                       "kadi_v1_owned_history_bundle(text, text)",
                                                       "kadi_v1_get_owned_document_history_bundle(text, text)",
                                                       "kadi_v1_search_owned_documents(text, jsonb, timestamptz, text, integer, text)",
                                                       "kadi_v1_remember_history_duplicate(text, text, text, text)"
                                                   ]
};

function walk(directory, results = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }

    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      walk(fullPath, results);
    } else {
      results.push(fullPath);
    }
  }

  return results;
}

function normalizeSql(value) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

test("every Kadi V1 migration function is service-role-only", () => {
  const allFiles = walk(process.cwd());

  for (const [fileName, signatures] of Object.entries(expected)) {
    const matches = allFiles.filter(
      (file) => path.basename(file) === fileName
    );

    assert.equal(
      matches.length,
      1,
      `expected exactly one ${fileName}`
    );

    const sql = normalizeSql(
      fs.readFileSync(matches[0], "utf8")
    );

    for (const signature of signatures) {
      const qualified = `public.${signature}`.toLowerCase();

      assert.ok(
        sql.includes(
          `revoke all on function ${qualified} from public;`
        ),
        `PUBLIC privilege missing for ${qualified}`
      );

      assert.ok(
        sql.includes(
          `revoke all on function ${qualified} from anon;`
        ),
        `anon privilege missing for ${qualified}`
      );

      assert.ok(
        sql.includes(
          `revoke all on function ${qualified} from authenticated;`
        ),
        `authenticated privilege missing for ${qualified}`
      );

      assert.ok(
        sql.includes(
          `grant execute on function ${qualified} to service_role;`
        ),
        `service_role privilege missing for ${qualified}`
      );
    }
  }
});