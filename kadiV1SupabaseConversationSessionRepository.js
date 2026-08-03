"use strict";

const {
  assertConversationSessionRepository,
  validateSessionRecord,
} = require("./kadiV1ConversationSession");

const TABLE_NAME = "kadi_v1_conversation_sessions";
const SESSION_FIELDS = Object.freeze([
  "session_id",
  "owner_wa_id",
  "document_id",
  "document_version",
  "document_type",
  "document_state",
  "expected_flow_key",
  "return_state",
  "status",
  "opened_at",
  "expires_at",
  "consumed_at",
  "revoked_at",
  "consumed_reply_key",
  "idempotency_key",
]);
const SELECT_COLUMNS = SESSION_FIELDS.join(",");
const OWNER_PATTERN = /^\d{8,20}$/;
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9:_.-]{1,200}$/;

const KNOWN_ERROR_CODES = Object.freeze([
  "KADI_V1_SESSION_IDEMPOTENCY_CONFLICT",
  "KADI_V1_SESSION_ID_CONFLICT",
  "KADI_V1_SESSION_NOT_FOUND",
  "KADI_V1_SESSION_OWNER_MISMATCH",
  "KADI_V1_SESSION_NOT_OPEN",
  "KADI_V1_SESSION_TRANSITION_INVALID",
  "KADI_V1_SESSION_IMMUTABLE_FIELD_CONFLICT",
  "KADI_V1_SESSION_CREATE_FAILED",
  "KADI_V1_SESSION_SAVE_FAILED",
  "KADI_V1_SESSION_READ_FAILED",
]);

function ok(value, extra = {}) {
  return { ok: true, value, ...extra };
}

function fail(error) {
  return { ok: false, error };
}

function mapError(error, fallback) {
  const text = [
    error?.message,
    error?.details,
    error?.hint,
    error?.code,
  ]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();

  for (const code of KNOWN_ERROR_CODES) {
    if (text.includes(code)) return code;
  }

  if (String(error?.code || "") === "23505") {
    return "KADI_V1_SESSION_ID_CONFLICT";
  }

  return fallback;
}

function pickSessionFields(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return Object.fromEntries(
    SESSION_FIELDS.map((field) => [field, raw[field] ?? null])
  );
}

function normalizeSession(raw, fallbackError) {
  const candidate = pickSessionFields(raw);
  const checked = validateSessionRecord(candidate);
  return checked.ok ? ok(checked.value) : fail(fallbackError);
}

function normalizeRpcResult(data, fallbackError) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return fail(fallbackError);
  }
  if (data.ok !== true || !data.session) {
    return fail(
      typeof data.error === "string" && data.error
        ? data.error
        : fallbackError
    );
  }
  const normalized = normalizeSession(data.session, fallbackError);
  return normalized.ok
    ? ok(normalized.value, { duplicate: data.duplicate === true })
    : normalized;
}

function createSupabaseV1ConversationSessionRepository(client) {
  if (
    !client ||
    typeof client !== "object" ||
    typeof client.from !== "function" ||
    typeof client.rpc !== "function"
  ) {
    throw new TypeError("KADI_V1_SUPABASE_SESSION_CLIENT_REQUIRED");
  }

  async function create(session) {
    const checked = validateSessionRecord(session);
    if (!checked.ok) return checked;

    const { data, error } = await client.rpc(
      "kadi_v1_create_conversation_session",
      { p_session: checked.value }
    );

    if (error) {
      return fail(mapError(error, "KADI_V1_SESSION_CREATE_FAILED"));
    }

    return normalizeRpcResult(data, "KADI_V1_SESSION_CREATE_FAILED");
  }

  async function getById({ sessionId }) {
    if (!ID_PATTERN.test(sessionId || "")) {
      return fail("KADI_V1_SESSION_ID_INVALID");
    }

    const { data, error } = await client
      .from(TABLE_NAME)
      .select(SELECT_COLUMNS)
      .eq("session_id", sessionId)
      .maybeSingle();

    if (error) {
      return fail(mapError(error, "KADI_V1_SESSION_READ_FAILED"));
    }
    if (!data) return ok(null);

    return normalizeSession(data, "KADI_V1_SESSION_READ_FAILED");
  }

  async function getByIdempotencyKey({ idempotencyKey }) {
    if (!IDEMPOTENCY_PATTERN.test(idempotencyKey || "")) {
      return fail("KADI_V1_SESSION_IDEMPOTENCY_INVALID");
    }

    const { data, error } = await client
      .from(TABLE_NAME)
      .select(SELECT_COLUMNS)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (error) {
      return fail(mapError(error, "KADI_V1_SESSION_READ_FAILED"));
    }
    if (!data) return ok(null);

    return normalizeSession(data, "KADI_V1_SESSION_READ_FAILED");
  }

  async function save(session) {
    const checked = validateSessionRecord(session);
    if (!checked.ok) return checked;

    const { data, error } = await client.rpc(
      "kadi_v1_save_conversation_session",
      { p_session: checked.value }
    );

    if (error) {
      return fail(mapError(error, "KADI_V1_SESSION_SAVE_FAILED"));
    }

    return normalizeRpcResult(data, "KADI_V1_SESSION_SAVE_FAILED");
  }

  async function findOpenByOwner({ ownerWaId }) {
    if (!OWNER_PATTERN.test(ownerWaId || "")) {
      return fail("KADI_V1_SESSION_OWNER_INVALID");
    }

    const { data, error } = await client
      .from(TABLE_NAME)
      .select(SELECT_COLUMNS)
      .eq("owner_wa_id", ownerWaId)
      .eq("status", "OPEN")
      .order("opened_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      return fail(mapError(error, "KADI_V1_SESSION_READ_FAILED"));
    }
    if (!data) return ok(null);

    return normalizeSession(data, "KADI_V1_SESSION_READ_FAILED");
  }

  return assertConversationSessionRepository(
    Object.freeze({
      create,
      getById,
      getByIdempotencyKey,
      save,
      findOpenByOwner,
    })
  );
}

module.exports = {
  KNOWN_ERROR_CODES,
  SELECT_COLUMNS,
  SESSION_FIELDS,
  TABLE_NAME,
  createSupabaseV1ConversationSessionRepository,
  mapError,
};
