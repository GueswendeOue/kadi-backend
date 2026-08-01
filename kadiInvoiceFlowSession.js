"use strict";

const crypto = require("node:crypto");
const { flowTokenReference } = require("./kadiInvoiceCartService");

const FLOW_TOKEN_BYTES = 32;
const FLOW_TOKEN_MAX_LENGTH = 256;
const ACTIVE_STATUS = "active";
const FLOW_TOKEN_PATTERN = /^kadi_invoice_v1:[a-f0-9]{32}:[0-9]{10,13}$/;

function hashFlowToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function validFlowToken(token) {
  return typeof token === "string" && token.length <= FLOW_TOKEN_MAX_LENGTH && FLOW_TOKEN_PATTERN.test(token);
}

function createInMemoryInvoiceFlowSessionRepository() {
  const sessions = new Map();
  return Object.freeze({
    async create(session) {
      if (sessions.has(session.flow_token_hash)) return { ok: false, error: "FLOW_SESSION_EXISTS" };
      sessions.set(session.flow_token_hash, structuredClone(session));
      return { ok: true, value: structuredClone(session) };
    },
    async getByHash(flowTokenHash) {
      const session = sessions.get(flowTokenHash);
      return session ? structuredClone(session) : null;
    },
    async revoke(flowTokenHash, revokedAt) {
      const session = sessions.get(flowTokenHash);
      if (!session) return { ok: false, error: "FLOW_SESSION_NOT_FOUND" };
      session.status = "revoked";
      session.revoked_at = revokedAt;
      sessions.set(flowTokenHash, structuredClone(session));
      return { ok: true, value: structuredClone(session) };
    },
  });
}

function createSupabaseInvoiceFlowSessionRepository(client) {
  if (!client || typeof client.from !== "function") throw new TypeError("SUPABASE_CLIENT_REQUIRED");
  return Object.freeze({
    async create(session) {
      const { data, error } = await client.from("kadi_invoice_flow_sessions").insert(session).select().single();
      return error ? { ok: false, error: "FLOW_SESSION_CREATE_FAILED" } : { ok: true, value: data };
    },
    async getByHash(flowTokenHash) {
      const { data, error } = await client.from("kadi_invoice_flow_sessions").select("*").eq("flow_token_hash", flowTokenHash).maybeSingle();
      return error ? null : data;
    },
    async revoke(flowTokenHash, revokedAt) {
      const { data, error } = await client.from("kadi_invoice_flow_sessions").update({ status: "revoked", revoked_at: revokedAt }).eq("flow_token_hash", flowTokenHash).select().maybeSingle();
      return error || !data ? { ok: false, error: "FLOW_SESSION_REVOKE_FAILED" } : { ok: true, value: data };
    },
  });
}

function createInvoiceFlowSessionService({ repository, draftRepository = null, now = () => Date.now() } = {}) {
  if (!repository) throw new TypeError("FLOW_SESSION_REPOSITORY_REQUIRED");

  async function createInvoiceFlowSession({ ownerRef, draftId, expiresAt }) {
    if (typeof ownerRef !== "string" || !ownerRef.trim() || typeof draftId !== "string" || !draftId.trim()) {
      return { ok: false, error: "FLOW_SESSION_CONTEXT_INVALID" };
    }
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now()) return { ok: false, error: "FLOW_SESSION_EXPIRY_INVALID" };
    const flowToken = `kadi_invoice_v1:${crypto.randomBytes(16).toString("hex")}:${now()}`;
    const session = {
      flow_token_hash: hashFlowToken(flowToken),
      owner_ref: ownerRef.trim(),
      draft_id: draftId.trim(),
      status: ACTIVE_STATUS,
      created_at: new Date(now()).toISOString(),
      expires_at: new Date(expiry).toISOString(),
      consumed_at: null,
      revoked_at: null,
    };
    const created = await repository.create(session);
    if (!created.ok) return created;
    if (draftRepository && typeof draftRepository.bindFlowToken === "function") {
      const bound = await draftRepository.bindFlowToken(session.draft_id, session.owner_ref, flowTokenReference(flowToken));
      if (!bound.ok) return { ok: false, error: "FLOW_SESSION_DRAFT_BIND_FAILED" };
    }
    return { ok: true, value: { flow_token: flowToken, ...session } };
  }

  async function resolveInvoiceFlowSession(flowToken) {
    if (!validFlowToken(flowToken)) return { ok: false, error: "FLOW_TOKEN_INVALID" };
    const session = await repository.getByHash(hashFlowToken(flowToken));
    if (!session) return { ok: false, error: "FLOW_TOKEN_UNKNOWN" };
    if (session.status !== ACTIVE_STATUS || session.revoked_at || session.consumed_at) return { ok: false, error: "FLOW_TOKEN_REVOKED" };
    if (!Number.isFinite(Date.parse(session.expires_at)) || Date.parse(session.expires_at) <= now()) return { ok: false, error: "FLOW_TOKEN_EXPIRED" };
    return { ok: true, value: { ownerRef: session.owner_ref, draftId: session.draft_id, flowTokenHash: session.flow_token_hash } };
  }

  async function revokeInvoiceFlowSession(flowToken) {
    if (!validFlowToken(flowToken)) return { ok: false, error: "FLOW_TOKEN_INVALID" };
    return repository.revoke(hashFlowToken(flowToken), new Date(now()).toISOString());
  }

  return Object.freeze({ createInvoiceFlowSession, resolveInvoiceFlowSession, revokeInvoiceFlowSession });
}

module.exports = {
  FLOW_TOKEN_BYTES,
  FLOW_TOKEN_MAX_LENGTH,
  createInMemoryInvoiceFlowSessionRepository,
  createInvoiceFlowSessionService,
  createSupabaseInvoiceFlowSessionRepository,
  hashFlowToken,
  validFlowToken,
};
