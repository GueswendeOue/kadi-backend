"use strict";

const crypto = require("node:crypto");
const { DOCUMENT_STATES } = require("./kadiV1DocumentStateMachine");
const { FLOW_KEYS, DOCUMENT_TYPES } = require("./kadiV1FlowRouter");

const SESSION_STATUSES = Object.freeze(["OPEN", "CONSUMED", "EXPIRED", "REVOKED"]);
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const OWNER_PATTERN = /^\d{8,20}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9:_.-]{1,200}$/;

function ok(value, extra = {}) {
  return { ok: true, value, ...extra };
}

function fail(error) {
  return { ok: false, error };
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function validateSessionRecord(raw) {
  if (!isPlainObject(raw)) return fail("KADI_V1_SESSION_INVALID");
  const allowed = new Set([
    "session_id", "owner_wa_id", "document_id", "document_version", "document_type",
    "document_state", "expected_flow_key", "return_state", "status", "opened_at",
    "expires_at", "consumed_at", "revoked_at", "consumed_reply_key", "idempotency_key",
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return fail("KADI_V1_SESSION_FIELD_FORBIDDEN");
  if (!ID_PATTERN.test(raw.session_id || "")) return fail("KADI_V1_SESSION_ID_INVALID");
  if (!OWNER_PATTERN.test(raw.owner_wa_id || "")) return fail("KADI_V1_SESSION_OWNER_INVALID");
  if (raw.document_id != null && !ID_PATTERN.test(raw.document_id)) return fail("KADI_V1_SESSION_DOCUMENT_ID_INVALID");
  if (raw.document_version != null && (!Number.isSafeInteger(raw.document_version) || raw.document_version < 1)) {
    return fail("KADI_V1_SESSION_DOCUMENT_VERSION_INVALID");
  }
  if (raw.document_type != null && !DOCUMENT_TYPES.includes(raw.document_type)) return fail("KADI_V1_SESSION_DOCUMENT_TYPE_INVALID");
  if (raw.document_state != null && !DOCUMENT_STATES.includes(raw.document_state)) return fail("KADI_V1_SESSION_DOCUMENT_STATE_INVALID");
  if (!FLOW_KEYS.includes(raw.expected_flow_key)) return fail("KADI_V1_SESSION_FLOW_KEY_INVALID");
  if (raw.return_state != null && !DOCUMENT_STATES.includes(raw.return_state)) return fail("KADI_V1_SESSION_RETURN_STATE_INVALID");
  if (!SESSION_STATUSES.includes(raw.status)) return fail("KADI_V1_SESSION_STATUS_INVALID");
  if (!IDEMPOTENCY_PATTERN.test(raw.idempotency_key || "")) return fail("KADI_V1_SESSION_IDEMPOTENCY_INVALID");
  const openedAt = Date.parse(raw.opened_at);
  const expiresAt = Date.parse(raw.expires_at);
  if (!Number.isFinite(openedAt) || !Number.isFinite(expiresAt) || expiresAt <= openedAt) {
    return fail("KADI_V1_SESSION_EXPIRY_INVALID");
  }
  for (const key of ["consumed_at", "revoked_at"]) {
    if (raw[key] != null && !Number.isFinite(Date.parse(raw[key]))) return fail("KADI_V1_SESSION_TIMESTAMP_INVALID");
  }
  if (raw.consumed_reply_key != null && !IDEMPOTENCY_PATTERN.test(raw.consumed_reply_key)) {
    return fail("KADI_V1_SESSION_CONSUMED_REPLY_KEY_INVALID");
  }
  if (raw.status === "CONSUMED" && raw.consumed_at == null) return fail("KADI_V1_SESSION_CONSUMED_AT_REQUIRED");
  if (raw.status === "CONSUMED" && raw.consumed_reply_key == null) return fail("KADI_V1_SESSION_CONSUMED_REPLY_KEY_REQUIRED");
  if (raw.status === "REVOKED" && raw.revoked_at == null) return fail("KADI_V1_SESSION_REVOKED_AT_REQUIRED");
  return ok(Object.freeze(clone(raw)));
}

function createMemoryConversationSessionRepository(seed = []) {
  const sessions = new Map();
  const idempotency = new Map();

  for (const candidate of seed) {
    const checked = validateSessionRecord(candidate);
    if (!checked.ok) throw new TypeError(checked.error);
    if (sessions.has(candidate.session_id) || idempotency.has(candidate.idempotency_key)) {
      throw new TypeError("KADI_V1_SESSION_SEED_DUPLICATE");
    }
    sessions.set(candidate.session_id, clone(candidate));
    idempotency.set(candidate.idempotency_key, candidate.session_id);
  }

  async function create(session) {
    const checked = validateSessionRecord(session);
    if (!checked.ok) return checked;
    const replayId = idempotency.get(session.idempotency_key);
    if (replayId) return ok(clone(sessions.get(replayId)), { duplicate: true });
    if (sessions.has(session.session_id)) return fail("KADI_V1_SESSION_ID_CONFLICT");
    sessions.set(session.session_id, clone(session));
    idempotency.set(session.idempotency_key, session.session_id);
    return ok(clone(session));
  }

  async function getById({ sessionId }) {
    if (!ID_PATTERN.test(sessionId || "")) return fail("KADI_V1_SESSION_ID_INVALID");
    return ok(clone(sessions.get(sessionId) || null));
  }

  async function getByIdempotencyKey({ idempotencyKey }) {
    if (!IDEMPOTENCY_PATTERN.test(idempotencyKey || "")) return fail("KADI_V1_SESSION_IDEMPOTENCY_INVALID");
    const sessionId = idempotency.get(idempotencyKey);
    return ok(sessionId ? clone(sessions.get(sessionId)) : null);
  }

  async function save(session) {
    const checked = validateSessionRecord(session);
    if (!checked.ok) return checked;
    const current = sessions.get(session.session_id);
    if (!current) return fail("KADI_V1_SESSION_NOT_FOUND");
    if (current.owner_wa_id !== session.owner_wa_id) return fail("KADI_V1_SESSION_OWNER_MISMATCH");
    sessions.set(session.session_id, clone(session));
    return ok(clone(session));
  }

  async function findOpenByOwner({ ownerWaId }) {
    if (!OWNER_PATTERN.test(ownerWaId || "")) return fail("KADI_V1_SESSION_OWNER_INVALID");
    const matches = [...sessions.values()]
      .filter((session) => session.owner_wa_id === ownerWaId && session.status === "OPEN")
      .sort((left, right) => Date.parse(right.opened_at) - Date.parse(left.opened_at));
    return ok(clone(matches[0] || null));
  }

  return Object.freeze({ create, getById, getByIdempotencyKey, save, findOpenByOwner });
}

function assertConversationSessionRepository(repository) {
  const methods = ["create", "getById", "getByIdempotencyKey", "save", "findOpenByOwner"];
  if (!repository || typeof repository !== "object") throw new TypeError("KADI_V1_SESSION_REPOSITORY_REQUIRED");
  for (const method of methods) if (typeof repository[method] !== "function") throw new TypeError(`KADI_V1_SESSION_REPOSITORY_METHOD_REQUIRED:${method}`);
  return repository;
}

function createConversationSessionService({
  repository,
  ttlMs = 30 * 60 * 1000,
  clock = () => new Date().toISOString(),
  idFactory = () => `kadi_session:${crypto.randomUUID()}`,
} = {}) {
  const storage = assertConversationSessionRepository(repository);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60 * 1000) throw new TypeError("KADI_V1_SESSION_TTL_INVALID");
  if (typeof clock !== "function" || typeof idFactory !== "function") throw new TypeError("KADI_V1_SESSION_DEPENDENCY_INVALID");

  async function expireIfNeeded(session, nowIso) {
    if (session.status !== "OPEN" || Date.parse(session.expires_at) > Date.parse(nowIso)) return ok(session);
    const expired = { ...session, status: "EXPIRED" };
    const saved = await storage.save(expired);
    return saved.ok ? fail("KADI_V1_SESSION_EXPIRED") : saved;
  }

  async function open({ ownerWaId, document = null, expectedFlowKey, returnState = null, idempotencyKey }) {
    if (!OWNER_PATTERN.test(ownerWaId || "")) return fail("KADI_V1_SESSION_OWNER_INVALID");
    if (!FLOW_KEYS.includes(expectedFlowKey)) return fail("KADI_V1_SESSION_FLOW_KEY_INVALID");
    if (!IDEMPOTENCY_PATTERN.test(idempotencyKey || "")) return fail("KADI_V1_SESSION_IDEMPOTENCY_INVALID");
    if (returnState != null && !DOCUMENT_STATES.includes(returnState)) return fail("KADI_V1_SESSION_RETURN_STATE_INVALID");

    const replay = await storage.getByIdempotencyKey({ idempotencyKey });
    if (!replay.ok) return replay;
    if (replay.value) {
      if (replay.value.owner_wa_id !== ownerWaId) return fail("KADI_V1_SESSION_IDEMPOTENCY_CONFLICT");
      return ok(replay.value, { duplicate: true });
    }

    const nowIso = new Date(clock()).toISOString();
    const session = {
      session_id: idFactory(),
      owner_wa_id: ownerWaId,
      document_id: document?.document_id ?? null,
      document_version: document?.version ?? null,
      document_type: document?.document_type ?? null,
      document_state: document?.status ?? null,
      expected_flow_key: expectedFlowKey,
      return_state: returnState,
      status: "OPEN",
      opened_at: nowIso,
      expires_at: new Date(Date.parse(nowIso) + ttlMs).toISOString(),
      consumed_at: null,
      revoked_at: null,
      consumed_reply_key: null,
      idempotency_key: idempotencyKey,
    };
    const checked = validateSessionRecord(session);
    if (!checked.ok) return checked;
    return storage.create(checked.value);
  }

  async function validateReply({ ownerWaId, sessionId, flowKey }) {
    if (!OWNER_PATTERN.test(ownerWaId || "")) return fail("KADI_V1_SESSION_OWNER_INVALID");
    if (!ID_PATTERN.test(sessionId || "")) return fail("KADI_V1_SESSION_ID_INVALID");
    if (!FLOW_KEYS.includes(flowKey)) return fail("KADI_V1_SESSION_FLOW_KEY_INVALID");
    const loaded = await storage.getById({ sessionId });
    if (!loaded.ok) return loaded;
    if (!loaded.value) return fail("KADI_V1_SESSION_NOT_FOUND");
    if (loaded.value.owner_wa_id !== ownerWaId) return fail("KADI_V1_SESSION_OWNER_MISMATCH");
    const current = await expireIfNeeded(loaded.value, new Date(clock()).toISOString());
    if (!current.ok) return current;
    if (current.value.status !== "OPEN") return fail("KADI_V1_SESSION_NOT_OPEN");
    if (current.value.expected_flow_key !== flowKey) return fail("KADI_V1_SESSION_UNEXPECTED_FLOW");
    return ok(current.value);
  }

  async function consumeReply({ ownerWaId, sessionId, flowKey, idempotencyKey }) {
    if (!IDEMPOTENCY_PATTERN.test(idempotencyKey || "")) return fail("KADI_V1_SESSION_IDEMPOTENCY_INVALID");
    const checked = await validateReply({ ownerWaId, sessionId, flowKey });
    if (!checked.ok) {
      const loaded = await storage.getById({ sessionId });
      if (loaded.ok && loaded.value?.status === "CONSUMED" && loaded.value.owner_wa_id === ownerWaId && loaded.value.expected_flow_key === flowKey) {
        if (loaded.value.consumed_reply_key === idempotencyKey) return ok(loaded.value, { duplicate: true });
        return fail("KADI_V1_SESSION_ALREADY_CONSUMED");
      }
      return checked;
    }
    const consumed = {
      ...checked.value,
      status: "CONSUMED",
      consumed_at: new Date(clock()).toISOString(),
      consumed_reply_key: idempotencyKey,
    };
    return storage.save(consumed);
  }

  async function revoke({ ownerWaId, sessionId }) {
    const loaded = await storage.getById({ sessionId });
    if (!loaded.ok) return loaded;
    if (!loaded.value) return fail("KADI_V1_SESSION_NOT_FOUND");
    if (loaded.value.owner_wa_id !== ownerWaId) return fail("KADI_V1_SESSION_OWNER_MISMATCH");
    if (loaded.value.status === "REVOKED") return ok(loaded.value, { duplicate: true });
    if (loaded.value.status !== "OPEN") return fail("KADI_V1_SESSION_NOT_OPEN");
    return storage.save({ ...loaded.value, status: "REVOKED", revoked_at: new Date(clock()).toISOString() });
  }

  async function getActive({ ownerWaId }) {
    const found = await storage.findOpenByOwner({ ownerWaId });
    if (!found.ok || !found.value) return found;
    return expireIfNeeded(found.value, new Date(clock()).toISOString());
  }

  return Object.freeze({ open, validateReply, consumeReply, revoke, getActive });
}

module.exports = {
  SESSION_STATUSES,
  assertConversationSessionRepository,
  createConversationSessionService,
  createMemoryConversationSessionRepository,
  validateSessionRecord,
};
