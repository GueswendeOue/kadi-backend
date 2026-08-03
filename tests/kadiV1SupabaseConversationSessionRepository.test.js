"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  TABLE_NAME,
  createSupabaseV1ConversationSessionRepository,
  mapError,
} = require("../kadiV1SupabaseConversationSessionRepository");

function openSession(overrides = {}) {
  return {
    session_id: "kadi_session:test:1",
    owner_wa_id: "22670626055",
    document_id: null,
    document_version: null,
    document_type: null,
    document_state: null,
    expected_flow_key: "MENU",
    return_state: null,
    status: "OPEN",
    opened_at: "2026-08-03T20:00:00.000Z",
    expires_at: "2026-08-03T20:30:00.000Z",
    consumed_at: null,
    revoked_at: null,
    consumed_reply_key: null,
    idempotency_key: "session_open:test:1",
    ...overrides,
  };
}

function makeQuery(data = null, error = null) {
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

test("construction is side-effect free and validates the Supabase client", () => {
  let calls = 0;
  const client = {
    from() {
      calls += 1;
      throw new Error("BOOT_QUERY_FORBIDDEN");
    },
    rpc() {
      calls += 1;
      throw new Error("BOOT_RPC_FORBIDDEN");
    },
  };

  const repository =
    createSupabaseV1ConversationSessionRepository(client);

  assert.equal(calls, 0);
  assert.equal(typeof repository.create, "function");
  assert.equal(typeof repository.findOpenByOwner, "function");

  assert.throws(
    () => createSupabaseV1ConversationSessionRepository({}),
    /KADI_V1_SUPABASE_SESSION_CLIENT_REQUIRED/
  );
});

test("create validates locally and delegates to the atomic RPC", async () => {
  const calls = [];
  const session = openSession();
  const client = {
    from() {
      throw new Error("READ_NOT_EXPECTED");
    },
    async rpc(name, args) {
      calls.push([name, args]);
      return {
        data: {
          ok: true,
          duplicate: false,
          session: { ...session, revision: 1 },
        },
        error: null,
      };
    },
  };

  const repository =
    createSupabaseV1ConversationSessionRepository(client);

  const created = await repository.create(session);

  assert.equal(created.ok, true, created.error);
  assert.equal(created.duplicate, false);
  assert.deepEqual(created.value, session);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0][0],
    "kadi_v1_create_conversation_session"
  );
  assert.deepEqual(calls[0][1], { p_session: session });

  const invalid = await repository.create({
    ...session,
    owner_wa_id: "not-a-number",
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, "KADI_V1_SESSION_OWNER_INVALID");
  assert.equal(calls.length, 1);
});

test("create preserves server duplicate evidence", async () => {
  const session = openSession();
  const repository =
    createSupabaseV1ConversationSessionRepository({
      from() {
        throw new Error("READ_NOT_EXPECTED");
      },
      async rpc() {
        return {
          data: {
            ok: true,
            duplicate: true,
            session: { ...session, revision: 7 },
          },
          error: null,
        };
      },
    });

  const result = await repository.create(session);
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, true);
  assert.deepEqual(result.value, session);
});

test("getById reads only the V1 session table", async () => {
  const session = openSession();
  const { query, calls } = makeQuery({
    ...session,
    revision: 1,
    updated_at: "2026-08-03T20:00:00.000Z",
  });
  const tables = [];
  const repository =
    createSupabaseV1ConversationSessionRepository({
      from(table) {
        tables.push(table);
        return query;
      },
      async rpc() {
        throw new Error("RPC_NOT_EXPECTED");
      },
    });

  const result = await repository.getById({
    sessionId: session.session_id,
  });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, session);
  assert.deepEqual(tables, [TABLE_NAME]);
  assert.ok(
    calls.some(
      (call) =>
        call[0] === "eq" &&
        call[1] === "session_id" &&
        call[2] === session.session_id
    )
  );
});

test("getByIdempotencyKey returns null without inventing a session", async () => {
  const { query } = makeQuery(null);
  const repository =
    createSupabaseV1ConversationSessionRepository({
      from() {
        return query;
      },
      async rpc() {
        throw new Error("RPC_NOT_EXPECTED");
      },
    });

  const result = await repository.getByIdempotencyKey({
    idempotencyKey: "session_open:missing",
  });

  assert.deepEqual(result, { ok: true, value: null });
});

test("save uses the atomic transition RPC and preserves duplicates", async () => {
  const consumed = openSession({
    status: "CONSUMED",
    consumed_at: "2026-08-03T20:05:00.000Z",
    consumed_reply_key: "reply:test:1",
  });
  const calls = [];
  const repository =
    createSupabaseV1ConversationSessionRepository({
      from() {
        throw new Error("READ_NOT_EXPECTED");
      },
      async rpc(name, args) {
        calls.push([name, args]);
        return {
          data: {
            ok: true,
            duplicate: true,
            session: { ...consumed, revision: 2 },
          },
          error: null,
        };
      },
    });

  const result = await repository.save(consumed);

  assert.equal(result.ok, true, result.error);
  assert.equal(result.duplicate, true);
  assert.deepEqual(result.value, consumed);
  assert.equal(
    calls[0][0],
    "kadi_v1_save_conversation_session"
  );
});

test("findOpenByOwner orders by newest open session and limits to one", async () => {
  const session = openSession();
  const { query, calls } = makeQuery(session);
  const repository =
    createSupabaseV1ConversationSessionRepository({
      from() {
        return query;
      },
      async rpc() {
        throw new Error("RPC_NOT_EXPECTED");
      },
    });

  const result = await repository.findOpenByOwner({
    ownerWaId: session.owner_wa_id,
  });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, session);
  assert.ok(
    calls.some(
      (call) =>
        call[0] === "eq" &&
        call[1] === "owner_wa_id" &&
        call[2] === session.owner_wa_id
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call[0] === "eq" &&
        call[1] === "status" &&
        call[2] === "OPEN"
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call[0] === "order" &&
        call[1] === "opened_at" &&
        call[2].ascending === false
    )
  );
  assert.ok(
    calls.some((call) => call[0] === "limit" && call[1] === 1)
  );
});

test("database errors are reduced to controlled codes", async () => {
  const repository =
    createSupabaseV1ConversationSessionRepository({
      from() {
        throw new Error("READ_NOT_EXPECTED");
      },
      async rpc() {
        return {
          data: null,
          error: {
            message:
              "KADI_V1_SESSION_IDEMPOTENCY_CONFLICT: hidden details",
          },
        };
      },
    });

  const result = await repository.create(openSession());

  assert.deepEqual(result, {
    ok: false,
    error: "KADI_V1_SESSION_IDEMPOTENCY_CONFLICT",
  });

  assert.equal(
    mapError({ code: "23505" }, "fallback"),
    "KADI_V1_SESSION_ID_CONFLICT"
  );
});

test("malformed database records fail closed", async () => {
  const malformed = openSession({
    owner_wa_id: "invalid",
  });
  const { query } = makeQuery(malformed);
  const repository =
    createSupabaseV1ConversationSessionRepository({
      from() {
        return query;
      },
      async rpc() {
        throw new Error("RPC_NOT_EXPECTED");
      },
    });

  const result = await repository.getById({
    sessionId: "kadi_session:test:1",
  });

  assert.deepEqual(result, {
    ok: false,
    error: "KADI_V1_SESSION_READ_FAILED",
  });
});

test("the additive migration is private and service-role-only", () => {
  const sql = fs
    .readFileSync(
      path.join(
        __dirname,
        "..",
        "migrations",
        "20260803_add_kadi_v1_conversation_sessions.sql"
      ),
      "utf8"
    )
    .toLowerCase()
    .replace(/\s+/g, " ");

  assert.ok(
    sql.includes(
      "create table if not exists public.kadi_v1_conversation_sessions"
    )
  );
  assert.ok(
    sql.includes(
      "alter table public.kadi_v1_conversation_sessions enable row level security"
    )
  );
  assert.ok(
    sql.includes(
      "revoke all on table public.kadi_v1_conversation_sessions from anon"
    )
  );
  assert.ok(
    sql.includes(
      "grant select, insert, update on table public.kadi_v1_conversation_sessions to service_role"
    )
  );
  assert.equal(/\bdrop\s+table\b/.test(sql), false);
  assert.equal(/\btruncate\b/.test(sql), false);
  assert.equal(/\bdelete\s+from\b/.test(sql), false);
});
