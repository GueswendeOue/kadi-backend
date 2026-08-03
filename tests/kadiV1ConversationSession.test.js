"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createConversationSessionService,
  createMemoryConversationSessionRepository,
  validateSessionRecord,
} = require("../kadiV1ConversationSession");

function makeClock(start = "2026-08-02T20:00:00.000Z") {
  let now = Date.parse(start);
  return {
    now: () => new Date(now).toISOString(),
    advance: (milliseconds) => { now += milliseconds; },
  };
}

function makeHarness() {
  const clock = makeClock();
  let counter = 0;
  const repository = createMemoryConversationSessionRepository();
  const service = createConversationSessionService({
    repository,
    ttlMs: 30 * 60 * 1000,
    clock: clock.now,
    idFactory: () => `kadi_session:${++counter}`,
  });
  return { clock, repository, service };
}

const ownerWaId = "22670000000";
const document = {
  document_id: "document:1",
  version: 4,
  document_type: "FACTURE",
  status: "READY_FOR_REVIEW",
};

async function openSession(service, overrides = {}) {
  return service.open({
    ownerWaId,
    document,
    expectedFlowKey: "DOCUMENT_REVIEW",
    returnState: "READY_FOR_REVIEW",
    idempotencyKey: "flow_session:message:1",
    ...overrides,
  });
}

test("opens an owner-bound logical session without a Meta id", async () => {
  const { service } = makeHarness();
  const opened = await openSession(service);
  assert.equal(opened.ok, true);
  assert.equal(opened.value.owner_wa_id, ownerWaId);
  assert.equal(opened.value.expected_flow_key, "DOCUMENT_REVIEW");
  assert.equal(opened.value.document_version, 4);
  assert.equal(Object.hasOwn(opened.value, "flow_id"), false);
});

test("same idempotency key replays exactly one session", async () => {
  const { service } = makeHarness();
  const first = await openSession(service);
  const second = await openSession(service);
  assert.equal(first.value.session_id, second.value.session_id);
  assert.equal(second.duplicate, true);
});

test("same idempotency key cannot cross owners", async () => {
  const { service } = makeHarness();
  await openSession(service);
  const conflict = await openSession(service, { ownerWaId: "22671111111" });
  assert.equal(conflict.error, "KADI_V1_SESSION_IDEMPOTENCY_CONFLICT");
});

test("valid reply requires the same owner and expected logical key", async () => {
  const { service } = makeHarness();
  const opened = await openSession(service);
  const valid = await service.validateReply({ ownerWaId, sessionId: opened.value.session_id, flowKey: "DOCUMENT_REVIEW" });
  assert.equal(valid.ok, true);
  const wrongFlow = await service.validateReply({ ownerWaId, sessionId: opened.value.session_id, flowKey: "EDIT_CLIENT" });
  assert.equal(wrongFlow.error, "KADI_V1_SESSION_UNEXPECTED_FLOW");
  const wrongOwner = await service.validateReply({ ownerWaId: "22671111111", sessionId: opened.value.session_id, flowKey: "DOCUMENT_REVIEW" });
  assert.equal(wrongOwner.error, "KADI_V1_SESSION_OWNER_MISMATCH");
});

test("consumption is one-way and a retry is reported as duplicate", async () => {
  const { service } = makeHarness();
  const opened = await openSession(service);
  const first = await service.consumeReply({ ownerWaId, sessionId: opened.value.session_id, flowKey: "DOCUMENT_REVIEW", idempotencyKey: "flow_reply:1" });
  const second = await service.consumeReply({ ownerWaId, sessionId: opened.value.session_id, flowKey: "DOCUMENT_REVIEW", idempotencyKey: "flow_reply:1" });
  assert.equal(first.value.status, "CONSUMED");
  assert.equal(second.duplicate, true);
});

test("a consumed session rejects a different reply idempotency key", async () => {
  const { service } = makeHarness();
  const opened = await openSession(service);
  const first = await service.consumeReply({ ownerWaId, sessionId: opened.value.session_id, flowKey: "DOCUMENT_REVIEW", idempotencyKey: "flow_reply:first" });
  const second = await service.consumeReply({ ownerWaId, sessionId: opened.value.session_id, flowKey: "DOCUMENT_REVIEW", idempotencyKey: "flow_reply:different" });
  assert.equal(first.value.consumed_reply_key, "flow_reply:first");
  assert.equal(second.error, "KADI_V1_SESSION_ALREADY_CONSUMED");
});

test("expired session fails closed and cannot be consumed", async () => {
  const { service, clock } = makeHarness();
  const opened = await openSession(service);
  clock.advance(31 * 60 * 1000);
  const validation = await service.validateReply({ ownerWaId, sessionId: opened.value.session_id, flowKey: "DOCUMENT_REVIEW" });
  assert.equal(validation.error, "KADI_V1_SESSION_EXPIRED");
});

test("revoke is owner-bound and idempotent", async () => {
  const { service } = makeHarness();
  const opened = await openSession(service);
  const denied = await service.revoke({ ownerWaId: "22671111111", sessionId: opened.value.session_id });
  assert.equal(denied.error, "KADI_V1_SESSION_OWNER_MISMATCH");
  const revoked = await service.revoke({ ownerWaId, sessionId: opened.value.session_id });
  const duplicate = await service.revoke({ ownerWaId, sessionId: opened.value.session_id });
  assert.equal(revoked.value.status, "REVOKED");
  assert.equal(duplicate.duplicate, true);
});

test("getActive returns the most recent open session for one owner", async () => {
  const { service, clock } = makeHarness();
  await openSession(service, { idempotencyKey: "flow_session:first" });
  clock.advance(1000);
  const latest = await openSession(service, { expectedFlowKey: "EDIT_CLIENT", idempotencyKey: "flow_session:second" });
  const active = await service.getActive({ ownerWaId });
  assert.equal(active.value.session_id, latest.value.session_id);
});

test("record validation rejects hidden or volatile fields", () => {
  const invalid = validateSessionRecord({
    session_id: "kadi_session:1",
    owner_wa_id: ownerWaId,
    document_id: null,
    document_version: null,
    document_type: null,
    document_state: null,
    expected_flow_key: "MENU",
    return_state: null,
    status: "OPEN",
    opened_at: "2026-08-02T20:00:00.000Z",
    expires_at: "2026-08-02T20:30:00.000Z",
    consumed_at: null,
    revoked_at: null,
    idempotency_key: "flow_session:1",
    flow_id: "123456789",
  });
  assert.equal(invalid.error, "KADI_V1_SESSION_FIELD_FORBIDDEN");
});

test("document identity and state must be server-valid", async () => {
  const { service } = makeHarness();
  const badVersion = await openSession(service, { document: { ...document, version: 0 }, idempotencyKey: "flow_session:bad_version" });
  assert.equal(badVersion.error, "KADI_V1_SESSION_DOCUMENT_VERSION_INVALID");
  const badState = await openSession(service, { document: { ...document, status: "UNKNOWN" }, idempotencyKey: "flow_session:bad_state" });
  assert.equal(badState.error, "KADI_V1_SESSION_DOCUMENT_STATE_INVALID");
});
