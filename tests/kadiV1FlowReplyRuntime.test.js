"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createKadiV1FlowReplyRuntime,
  validateActionPayload,
  validateReplyEnvelope,
} = require("../kadiV1FlowReplyRuntime");
const {
  createConversationSessionService,
  createMemoryConversationSessionRepository,
} = require("../kadiV1ConversationSession");

function makeSessionService(overrides = {}) {
  let tick = 0;
  return createConversationSessionService({
    repository: createMemoryConversationSessionRepository(),
    clock: () => new Date(Date.parse("2026-08-02T20:00:00.000Z") + tick++ * 1000).toISOString(),
    idFactory: () => overrides.sessionId || "kadi_session:reply1",
  });
}

async function openSession(service, overrides = {}) {
  const opened = await service.open({
    ownerWaId: "22670000000",
    document: {
      document_id: "document:1",
      version: 3,
      document_type: "FACTURE",
      status: "COLLECTING",
    },
    expectedFlowKey: "ARTICLE_FORM",
    returnState: "COLLECTING",
    idempotencyKey: "open:reply1",
    ...overrides,
  });
  assert.equal(opened.ok, true);
  return opened.value;
}

function reply(overrides = {}) {
  return {
    ownerWaId: "22670000000",
    sessionId: "kadi_session:reply1",
    flowKey: "ARTICLE_FORM",
    action: "ADD_CONTENT",
    data: { description: "Ciment", quantity: 2, unit: "sac", unit_price: 6500 },
    idempotencyKey: "reply:1",
    ...overrides,
  };
}

test("closed action map rejects an action from another screen", () => {
  const checked = validateActionPayload("DOCUMENT_CONTENT", "CONFIRM_GENERATION", {});
  assert.deepEqual(checked, { ok: false, error: "KADI_V1_FLOW_REPLY_ACTION_FORBIDDEN" });
});

test("server-authoritative fields are rejected before session consumption", () => {
  const checked = validateReplyEnvelope(reply({ data: { description: "Ciment", total: 13000 } }));
  assert.deepEqual(checked, { ok: false, error: "KADI_V1_FLOW_REPLY_AUTHORITY_FIELD_FORBIDDEN" });
});

test("unknown top-level fields are rejected", () => {
  const checked = validateActionPayload("ARTICLE_FORM", "ADD_CONTENT", { description: "Ciment", hidden: "x" });
  assert.deepEqual(checked, { ok: false, error: "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN" });
});

test("nested forbidden authority fields are rejected", () => {
  const checked = validateActionPayload("ARTICLE_FORM", "ADD_CONTENT", { description: { label: "Ciment", issued_at: "2026-08-02" } });
  assert.deepEqual(checked, { ok: false, error: "KADI_V1_FLOW_REPLY_AUTHORITY_FIELD_FORBIDDEN" });
});

test("valid reply dispatches only server-bound document context", async () => {
  const sessions = makeSessionService();
  await openSession(sessions);
  const calls = [];
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: {
      execute: async (command) => {
        calls.push(command);
        return { ok: true, value: { status: "COLLECTING" } };
      },
    },
  });
  const result = await runtime.handle(reply());
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].documentContext, {
    document_id: "document:1",
    document_version: 3,
    document_type: "FACTURE",
    document_state: "COLLECTING",
    return_state: "COLLECTING",
  });
  assert.equal(calls[0].flowKey, "ARTICLE_FORM");
  assert.equal(calls[0].idempotencyKey, "flow_command:reply:1");
  assert.equal(Object.hasOwn(calls[0].data, "document_id"), false);
});

test("owner mismatch is absorbed before command execution", async () => {
  const sessions = makeSessionService();
  await openSession(sessions);
  let executed = false;
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: { execute: async () => { executed = true; return { ok: true, value: null }; } },
  });
  const result = await runtime.handle(reply({ ownerWaId: "22671111111" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_SESSION_OWNER_MISMATCH");
  assert.equal(executed, false);
});

test("unexpected logical screen is rejected", async () => {
  const sessions = makeSessionService();
  await openSession(sessions);
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: { execute: async () => ({ ok: true, value: null }) },
  });
  const result = await runtime.handle(reply({ flowKey: "DOCUMENT_OPTIONS", action: "SAVE_OPTIONS", data: {} }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_SESSION_UNEXPECTED_FLOW");
});

test("ADD_CONTENT is rejected when the open session was opened for DOCUMENT_CONTENT, not ARTICLE_FORM", async () => {
  const sessions = makeSessionService();
  await openSession(sessions, { expectedFlowKey: "DOCUMENT_CONTENT" });
  let executed = false;
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: { execute: async () => { executed = true; return { ok: true, value: null }; } },
  });
  const result = await runtime.handle(reply({ flowKey: "ARTICLE_FORM", action: "ADD_CONTENT" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_SESSION_UNEXPECTED_FLOW");
  assert.equal(executed, false);
});

test("duplicate webhook reuses the same command idempotency key", async () => {
  const sessions = makeSessionService();
  await openSession(sessions);
  const seen = new Map();
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: {
      execute: async (command) => {
        if (seen.has(command.idempotencyKey)) return { ok: true, value: seen.get(command.idempotencyKey), duplicate: true };
        const value = { item_id: "item:1" };
        seen.set(command.idempotencyKey, value);
        return { ok: true, value };
      },
    },
  });
  const first = await runtime.handle(reply());
  const second = await runtime.handle(reply());
  assert.equal(first.ok, true);
  assert.equal(first.value.duplicate, false);
  assert.equal(second.ok, true);
  assert.equal(second.value.duplicate, true);
  assert.deepEqual(second.value.result, { item_id: "item:1" });
});

test("recoverable command failure can be retried through consumed-session replay", async () => {
  const sessions = makeSessionService();
  await openSession(sessions);
  let attempts = 0;
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: {
      execute: async () => {
        attempts += 1;
        return attempts === 1
          ? { ok: false, error: "TEMPORARY_UNAVAILABLE" }
          : { ok: true, value: { saved: true } };
      },
    },
  });
  const first = await runtime.handle(reply());
  const second = await runtime.handle(reply());
  assert.deepEqual(first, { ok: false, error: "TEMPORARY_UNAVAILABLE" });
  assert.equal(second.ok, true);
  assert.equal(second.value.duplicate, true);
  assert.equal(attempts, 2);
});

test("oversized and excessively deep payloads fail closed", () => {
  const oversized = validateActionPayload("HISTORY_SEARCH", "SEARCH", { query: "x".repeat(17000) });
  assert.equal(oversized.error, "KADI_V1_FLOW_REPLY_PAYLOAD_TOO_LARGE");
  const deep = { query: { a: { b: { c: { d: { e: { f: "x" } } } } } } };
  const tooDeep = validateActionPayload("HISTORY_SEARCH", "SEARCH", deep);
  assert.equal(tooDeep.error, "KADI_V1_FLOW_REPLY_PAYLOAD_TOO_DEEP");
});
