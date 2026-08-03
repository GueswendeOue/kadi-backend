"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ACTIVE_DOCUMENT_STATES,
  createKadiV1UserContextService,
} = require("../kadiV1UserContextService");

const OWNER = "22670626055";

function queryResult(data, error = null) {
  const calls = [];

  const query = {
    select(value) {
      calls.push(["select", value]);
      return query;
    },
    eq(column, value) {
      calls.push(["eq", column, value]);
      return query;
    },
    in(column, values) {
      calls.push(["in", column, values]);
      return query;
    },
    order(column, options) {
      calls.push(["order", column, options]);
      return query;
    },
    limit(value) {
      calls.push(["limit", value]);
      return query;
    },
    async maybeSingle() {
      calls.push(["maybeSingle"]);
      return { data, error };
    },
  };

  return { query, calls };
}

test("user context construction performs no external call", () => {
  let calls = 0;

  const service = createKadiV1UserContextService({
    client: {
      from() {
        calls += 1;
        throw new Error("BOOT_QUERY_FORBIDDEN");
      },
    },
    onboardingRepository: {
      async getOnboardingState() {
        calls += 1;
        throw new Error("BOOT_PROFILE_FORBIDDEN");
      },
    },
    documentRepository: {
      async getDocumentById() {
        calls += 1;
        throw new Error("BOOT_DOCUMENT_FORBIDDEN");
      },
    },
  });

  assert.equal(calls, 0);
  assert.equal(typeof service.getContext, "function");
});

test("an unknown profile is represented as a new user without document lookup", async () => {
  let documentQueries = 0;

  const service = createKadiV1UserContextService({
    client: {
      from() {
        documentQueries += 1;
        throw new Error("DOCUMENT_QUERY_FORBIDDEN");
      },
    },
    onboardingRepository: {
      async getOnboardingState() {
        return {
          ok: false,
          error: "V1_PROFILE_NOT_FOUND",
        };
      },
    },
    documentRepository: {
      async getDocumentById() {
        throw new Error("DOCUMENT_LOAD_FORBIDDEN");
      },
    },
  });

  const result = await service.getContext({
    ownerWaId: OWNER,
  });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, {
    profile: null,
    is_new: true,
    active_document: null,
  });
  assert.equal(documentQueries, 0);
});

test("a completed profile without an active document returns minimal context", async () => {
  const profile = {
    onboarding_status: "COMPLETED",
    voice_response_mode: "VOICE_WHEN_HELPFUL",
  };
  const { query, calls } = queryResult(null);

  const service = createKadiV1UserContextService({
    client: {
      from(table) {
        assert.equal(table, "kadi_v1_documents");
        return query;
      },
    },
    onboardingRepository: {
      async getOnboardingState() {
        return { ok: true, value: profile };
      },
    },
    documentRepository: {
      async getDocumentById() {
        throw new Error("DOCUMENT_LOAD_FORBIDDEN");
      },
    },
  });

  const result = await service.getContext({
    ownerWaId: OWNER,
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.profile, profile);
  assert.equal(result.value.is_new, false);
  assert.equal(result.value.active_document, null);

  const stateFilter = calls.find(
    (call) => call[0] === "in"
  );

  assert.equal(stateFilter[1], "status");
  assert.deepEqual(
    stateFilter[2],
    ACTIVE_DOCUMENT_STATES
  );
  assert.ok(
    calls.some(
      (call) =>
        call[0] === "limit" &&
        call[1] === 1
    )
  );
});

test("the newest active document is restored through the authoritative repository", async () => {
  const profile = {
    onboarding_status: "COMPLETED",
    voice_response_mode: "TEXT_ONLY",
  };
  const indexRow = {
    document_id: "document:context:1",
    status: "COLLECTING",
    active_version: 3,
    updated_at: "2026-08-03T20:00:00.000Z",
    created_at: "2026-08-03T19:00:00.000Z",
  };
  const snapshot = {
    document_id: indexRow.document_id,
    document_type: "FACTURE",
    status: indexRow.status,
    version: indexRow.active_version,
    items: [],
  };
  const { query } = queryResult(indexRow);
  const loads = [];

  const service = createKadiV1UserContextService({
    client: {
      from() {
        return query;
      },
    },
    onboardingRepository: {
      async getOnboardingState() {
        return { ok: true, value: profile };
      },
    },
    documentRepository: {
      async getDocumentById(command) {
        loads.push(command);
        return { ok: true, value: snapshot };
      },
    },
  });

  const result = await service.getContext({
    ownerWaId: OWNER,
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.active_document, snapshot);
  assert.deepEqual(loads, [
    {
      documentId: indexRow.document_id,
      ownerWaId: OWNER,
    },
  ]);
});

test("profile, index and snapshot inconsistencies fail closed", async () => {
  const profileFailure = createKadiV1UserContextService({
    client: { from() {} },
    onboardingRepository: {
      async getOnboardingState() {
        return {
          ok: false,
          error: "STORAGE_DOWN",
        };
      },
    },
    documentRepository: {
      async getDocumentById() {
        return { ok: false };
      },
    },
  });

  assert.deepEqual(
    await profileFailure.getContext({
      ownerWaId: OWNER,
    }),
    {
      ok: false,
      error: "KADI_V1_USER_CONTEXT_PROFILE_LOAD_FAILED",
    }
  );

  const { query } = queryResult({
    document_id: "document:context:2",
    status: "COLLECTING",
    active_version: 2,
  });

  const mismatch = createKadiV1UserContextService({
    client: {
      from() {
        return query;
      },
    },
    onboardingRepository: {
      async getOnboardingState() {
        return {
          ok: true,
          value: {
            onboarding_status: "COMPLETED",
          },
        };
      },
    },
    documentRepository: {
      async getDocumentById() {
        return {
          ok: true,
          value: {
            document_id: "document:context:2",
            status: "COLLECTING",
            version: 1,
          },
        };
      },
    },
  });

  assert.deepEqual(
    await mismatch.getContext({
      ownerWaId: OWNER,
    }),
    {
      ok: false,
      error:
        "KADI_V1_USER_CONTEXT_ACTIVE_DOCUMENT_MISMATCH",
    }
  );
});

test("invalid ownership is rejected before any read", async () => {
  let reads = 0;

  const service = createKadiV1UserContextService({
    client: {
      from() {
        reads += 1;
      },
    },
    onboardingRepository: {
      async getOnboardingState() {
        reads += 1;
      },
    },
    documentRepository: {
      async getDocumentById() {
        reads += 1;
      },
    },
  });

  const result = await service.getContext({
    ownerWaId: "invalid",
  });

  assert.deepEqual(result, {
    ok: false,
    error: "KADI_V1_USER_CONTEXT_OWNER_INVALID",
  });
  assert.equal(reads, 0);
});
