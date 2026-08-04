"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createKadiV1FlowReplyRuntime,
  validateActionPayload,
  FLOW_ACTIONS,
} = require("../kadiV1FlowReplyRuntime");
const {
  createConversationSessionService,
  createMemoryConversationSessionRepository,
} = require("../kadiV1ConversationSession");

// P8.A1 — DOCUMENT_CONTENT relaxes the locked one-screen contract into two
// terminal screens (DOCUMENT_CONTENT decision, ARTICLE_FORM item entry)
// under the same flow_key. These tests exercise the reply-runtime path a
// real WhatsApp Flow completion takes for each screen.

const OWNER = "22670626055";
let tick = 0;

function makeSessionService(id = "kadi_session:article-form:1") {
  tick = 0;
  return createConversationSessionService({
    repository: createMemoryConversationSessionRepository(),
    clock: () => new Date(Date.parse("2026-08-04T10:00:00.000Z") + tick++ * 1000).toISOString(),
    idFactory: () => id,
  });
}

async function openContentSession(service, sessionId, overrides = {}) {
  const opened = await service.open({
    ownerWaId: OWNER,
    document: {
      document_id: "document:1",
      version: 1,
      document_type: "FACTURE",
      status: "COLLECTING",
    },
    expectedFlowKey: "DOCUMENT_CONTENT",
    returnState: "COLLECTING",
    idempotencyKey: `open:article-form:${sessionId}`,
    ...overrides,
  });
  assert.equal(opened.ok, true);
  return opened.value;
}

test("START_ADD_CONTENT is a declared DOCUMENT_CONTENT action", () => {
  assert.equal(FLOW_ACTIONS.DOCUMENT_CONTENT.includes("START_ADD_CONTENT"), true);
});

test("START_ADD_CONTENT with an empty payload is accepted", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "START_ADD_CONTENT", {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {});
});

test("START_ADD_CONTENT rejects any field, since the decision screen never collects article data", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "START_ADD_CONTENT", { description: "Ciment" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN");
});

test("START_ADD_CONTENT reply dispatches to the command runtime under the DOCUMENT_CONTENT flow_key", async () => {
  const sessionId = "kadi_session:article-form:start:1";
  const sessions = makeSessionService(sessionId);
  await openContentSession(sessions, sessionId);

  const dispatched = [];
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: {
      execute: async (command) => {
        dispatched.push(command);
        return { ok: true, value: { document_id: "document:1", version: 1, document_type: "FACTURE", status: "COLLECTING", items: [] } };
      },
    },
  });

  const result = await runtime.handle({
    ownerWaId: OWNER,
    sessionId,
    flowKey: "DOCUMENT_CONTENT",
    action: "START_ADD_CONTENT",
    data: {},
    idempotencyKey: "reply:article-form:start:1",
  });

  assert.equal(result.ok, true);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].action, "START_ADD_CONTENT");
  assert.equal(dispatched[0].flowKey, "DOCUMENT_CONTENT");
});

test("ADD_CONTENT submitted from the ARTICLE_FORM screen still carries flow_key=DOCUMENT_CONTENT and is dispatched once", async () => {
  const sessionId = "kadi_session:article-form:add:1";
  const sessions = makeSessionService(sessionId);
  await openContentSession(sessions, sessionId);

  const dispatched = [];
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: {
      execute: async (command) => {
        dispatched.push(command);
        return {
          ok: true,
          value: {
            document_id: "document:1", version: 2, document_type: "FACTURE", status: "COLLECTING",
            items: [{ item_id: "item:1", description: "Ciment", quantity: 2, unit_price: 5000 }],
          },
        };
      },
    },
  });

  const result = await runtime.handle({
    ownerWaId: OWNER,
    sessionId,
    flowKey: "DOCUMENT_CONTENT",
    action: "ADD_CONTENT",
    data: { description: "Ciment", quantity: "2", unit: "sac", unit_price: "5000" },
    idempotencyKey: "reply:article-form:add:1",
  });

  assert.equal(result.ok, true);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].flowKey, "DOCUMENT_CONTENT");
  assert.equal(dispatched[0].action, "ADD_CONTENT");
});

test("a second START_ADD_CONTENT reply on the same idempotency key is reported as a duplicate", async () => {
  // The reply runtime always forwards to the command runtime with a stable
  // flow_command idempotency key (kadiV1FlowReplyRuntime.js consumeReply);
  // domain-level dedup on that key is the command runtime's responsibility,
  // mirrored here the same way the existing ADD_CONTENT replay test does it.
  const sessionId = "kadi_session:article-form:replay:1";
  const sessions = makeSessionService(sessionId);
  await openContentSession(sessions, sessionId);

  const seen = new Map();
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: {
      execute: async (command) => {
        if (seen.has(command.idempotencyKey)) return { ok: true, value: seen.get(command.idempotencyKey), duplicate: true };
        const value = { document_id: "document:1", version: 1, document_type: "FACTURE", status: "COLLECTING", items: [] };
        seen.set(command.idempotencyKey, value);
        return { ok: true, value };
      },
    },
  });

  const reply = {
    ownerWaId: OWNER,
    sessionId,
    flowKey: "DOCUMENT_CONTENT",
    action: "START_ADD_CONTENT",
    data: {},
    idempotencyKey: "reply:article-form:replay:1",
  };
  const first = await runtime.handle(reply);
  const second = await runtime.handle(reply);
  assert.equal(first.ok, true);
  assert.equal(first.value.duplicate, false);
  assert.equal(second.ok, true);
  assert.equal(second.value.duplicate, true);
  assert.equal(seen.size, 1);
});
