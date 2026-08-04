"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createKadiV1IssuerResolver } = require("../kadiV1ProductionInfrastructure");

// P8.A1-B objective 4 — issuer profile resolution by issuer_profile_id,
// producing exactly the shape pdf/kadiPdfLayoutCommon.js:drawBusinessHeader
// reads (business_name/address/phone/email), with owner_name kept alongside
// for the "business_name absent -> use owner_name" business rule.

function fakeSupabase(row, { queryError = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push(table);
      return {
        select(columns) {
          calls.push(columns);
          return {
            eq(column, value) {
              calls.push([column, value]);
              return {
                async maybeSingle() {
                  if (queryError) return { data: null, error: queryError };
                  return { data: row, error: null };
                },
              };
            },
          };
        },
      };
    },
    rpc() { throw new Error("RPC_FORBIDDEN"); },
    storage: { from() { throw new Error("STORAGE_FORBIDDEN"); } },
  };
}

test("resolves owner_name and business_name into the exact PDF renderer shape", async () => {
  const client = fakeSupabase({ id: "issuer:1", owner_name: "Awa Traoré", business_name: "Kadi Boutique", address: "Ouaga", phone: "+22670000000", email: null });
  const resolver = createKadiV1IssuerResolver({ client });
  const result = await resolver.getIssuerProfileById({ issuerProfileId: "issuer:1" });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, {
    business_name: "Kadi Boutique",
    owner_name: "Awa Traoré",
    address: "Ouaga",
    phone: "+22670000000",
    email: null,
  });
  assert.deepEqual(client.calls, ["business_profiles", "*", ["id", "issuer:1"]]);
});

test("falls back business_name to owner_name when business_name is absent", async () => {
  const client = fakeSupabase({ id: "issuer:2", owner_name: "Issa Kaboré", business_name: null, address: null, phone: null, email: null });
  const resolver = createKadiV1IssuerResolver({ client });
  const result = await resolver.getIssuerProfileById({ issuerProfileId: "issuer:2" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.business_name, "Issa Kaboré");
  assert.equal(result.value.owner_name, "Issa Kaboré");
});

test("rejects an invalid issuer_profile_id before any query", async () => {
  const client = fakeSupabase({ id: "issuer:3", owner_name: "X" });
  const resolver = createKadiV1IssuerResolver({ client });
  const result = await resolver.getIssuerProfileById({ issuerProfileId: "not valid!" });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_ISSUER_PROFILE_ID_INVALID" });
  assert.deepEqual(client.calls, []);
});

test("a query error is a recoverable failure, never a silently anonymous profile", async () => {
  const client = fakeSupabase(null, { queryError: { message: "connection reset" } });
  const resolver = createKadiV1IssuerResolver({ client });
  const result = await resolver.getIssuerProfileById({ issuerProfileId: "issuer:4" });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_ISSUER_PROFILE_LOOKUP_FAILED" });
});

test("a missing row is reported distinctly from an empty profile", async () => {
  const client = fakeSupabase(null);
  const resolver = createKadiV1IssuerResolver({ client });
  const result = await resolver.getIssuerProfileById({ issuerProfileId: "issuer:5" });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_ISSUER_PROFILE_NOT_FOUND" });
});

test("a row with neither owner_name nor business_name is treated as not found", async () => {
  const client = fakeSupabase({ id: "issuer:6", owner_name: "", business_name: null });
  const resolver = createKadiV1IssuerResolver({ client });
  const result = await resolver.getIssuerProfileById({ issuerProfileId: "issuer:6" });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_ISSUER_PROFILE_NOT_FOUND" });
});

test("getIssuerProfileId (wa_id lookup) still works unchanged alongside the new port", async () => {
  const client = fakeSupabase({ id: "issuer:7" });
  const resolver = createKadiV1IssuerResolver({ client });
  const result = await resolver.getIssuerProfileId({ ownerWaId: "22670626055" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.issuerProfileId, "issuer:7");
});
