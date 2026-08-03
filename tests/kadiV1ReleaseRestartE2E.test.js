"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createConversationSessionService,
  validateSessionRecord,
} = require("../kadiV1ConversationSession");
const { createKadiV1FlowCommandRuntime } = require("../kadiV1FlowCommandRuntime");
const { createKadiV1FlowReplyRuntime } = require("../kadiV1FlowReplyRuntime");
const { createKadiV1RuntimeConfig } = require("../kadiV1RuntimeConfig");
const { createKadiV1WebhookRuntime } = require("../kadiV1WebhookRuntime");

const OWNER = "22670000000";
const OTHER_OWNER = "22671111111";
const START = "2026-08-03T00:00:00.000Z";

const ok = (value, extra = {}) => ({ ok: true, value, ...extra });
const fail = (error) => ({ ok: false, error });
const clone = (value) => value == null ? value : structuredClone(value);

function createDurableStore() {
  return { sessions: new Map(), idempotency: new Map() };
}

function createDurableSessionRepository(store) {
  async function create(session) {
    const checked = validateSessionRecord(session);
    if (!checked.ok) return checked;
    const replayId = store.idempotency.get(session.idempotency_key);
    if (replayId) return ok(clone(store.sessions.get(replayId)), { duplicate: true });
    if (store.sessions.has(session.session_id)) return fail("KADI_V1_SESSION_ID_CONFLICT");
    store.sessions.set(session.session_id, clone(session));
    store.idempotency.set(session.idempotency_key, session.session_id);
    return ok(clone(session));
  }

  async function getById({ sessionId }) {
    return ok(clone(store.sessions.get(sessionId) || null));
  }

  async function getByIdempotencyKey({ idempotencyKey }) {
    const sessionId = store.idempotency.get(idempotencyKey);
    return ok(sessionId ? clone(store.sessions.get(sessionId)) : null);
  }

  async function save(session) {
    const checked = validateSessionRecord(session);
    if (!checked.ok) return checked;
    const current = store.sessions.get(session.session_id);
    if (!current) return fail("KADI_V1_SESSION_NOT_FOUND");
    if (current.owner_wa_id !== session.owner_wa_id) return fail("KADI_V1_SESSION_OWNER_MISMATCH");
    store.sessions.set(session.session_id, clone(session));
    return ok(clone(session));
  }

  async function findOpenByOwner({ ownerWaId }) {
    const matches = [...store.sessions.values()]
      .filter((session) => session.owner_wa_id === ownerWaId && session.status === "OPEN")
      .sort((left, right) => Date.parse(right.opened_at) - Date.parse(left.opened_at));
    return ok(clone(matches[0] || null));
  }

  return Object.freeze({ create, getById, getByIdempotencyKey, save, findOpenByOwner });
}

function createRestartHarness() {
  const store = createDurableStore();
  let nowMs = Date.parse(START);
  let sessionSequence = 0;
  const writes = new Map();
  const calls = [];

  function createSessionService() {
    return createConversationSessionService({
      repository: createDurableSessionRepository(store),
      clock: () => new Date(nowMs).toISOString(),
      idFactory: () => `kadi_session:restart:${++sessionSequence}`,
    });
  }

  function idempotentWrite(name, payload, value) {
    const key = `${name}:${payload.idempotencyKey}`;
    if (writes.has(key)) return ok(clone(writes.get(key)), { duplicate: true });
    writes.set(key, clone(value));
    calls.push([name, clone(payload)]);
    return ok(clone(value));
  }

  function createReplyRuntime(sessionService) {
    const noop = async () => ok({});
    const documentRuntime = {
      start: noop,
      setClient: async (payload) => idempotentWrite("document.setClient", payload, {
        document_id: payload.documentId,
        version: payload.expectedVersion + 1,
        document_type: payload.documentType,
        status: "COLLECTING",
      }),
      addContent: noop,
      updateContent: noop,
      removeContent: noop,
      setOptions: noop,
      verify: noop,
      beginEdit: noop,
      saveForLater: noop,
      saveDischargeDetails: noop,
      cancel: noop,
    };
    const commandRuntime = createKadiV1FlowCommandRuntime({
      onboardingRuntime: { continueOnboarding: noop },
      documentRuntime,
      previewRuntime: { prepare: noop },
      generationRuntime: { confirm: noop },
      rechargeRuntime: { selectPack: noop, checkPayment: noop, cancel: noop },
      historyRuntime: { search: noop, open: noop },
      walletRuntime: { getBalance: async () => ok({ credits: 5 }) },
    });
    return createKadiV1FlowReplyRuntime({ sessionService, commandRuntime });
  }

  async function openClientSession(service, key = "default") {
    return service.open({
      ownerWaId: OWNER,
      document: {
        document_id: "document:restart:1",
        version: 3,
        document_type: "FACTURE",
        status: "COLLECTING",
      },
      expectedFlowKey: "DOCUMENT_CLIENT",
      idempotencyKey: `release_restart:open:${key}`,
    });
  }

  return {
    store,
    calls,
    createSessionService,
    createReplyRuntime,
    openClientSession,
    advanceMs(milliseconds) { nowMs += milliseconds; },
    count(name) { return calls.filter(([call]) => call === name).length; },
  };
}

function replyInput(session, idempotencyKey = "reply:restart:1") {
  return {
    ownerWaId: OWNER,
    sessionId: session.session_id,
    flowKey: "DOCUMENT_CLIENT",
    action: "SAVE_CLIENT",
    data: { name: "Client après redémarrage" },
    idempotencyKey,
  };
}

test("release restart: an open persisted session is recovered by a new service instance", async () => {
  const harness = createRestartHarness();
  const firstProcess = harness.createSessionService();
  const opened = await harness.openClientSession(firstProcess);
  assert.equal(opened.ok, true, opened.error);

  const restartedProcess = harness.createSessionService();
  const active = await restartedProcess.getActive({ ownerWaId: OWNER });
  assert.equal(active.ok, true, active.error);
  assert.equal(active.value.session_id, opened.value.session_id);
  assert.equal(active.value.document_id, "document:restart:1");
  assert.equal(active.value.document_version, 3);
  assert.equal(active.value.expected_flow_key, "DOCUMENT_CLIENT");
});

test("release restart: a Flow reply after restart keeps the immutable server document context", async () => {
  const harness = createRestartHarness();
  const opened = await harness.openClientSession(harness.createSessionService());
  const restartedSessions = harness.createSessionService();
  const replies = harness.createReplyRuntime(restartedSessions);

  const result = await replies.handle(replyInput(opened.value));
  assert.equal(result.ok, true, result.error);
  assert.equal(harness.count("document.setClient"), 1);
  const payload = harness.calls[0][1];
  assert.equal(payload.documentId, "document:restart:1");
  assert.equal(payload.expectedVersion, 3);
  assert.equal(payload.documentType, "FACTURE");
  assert.equal(payload.documentState, "COLLECTING");
});

test("release restart: the same persisted reply remains idempotent across a second restart", async () => {
  const harness = createRestartHarness();
  const opened = await harness.openClientSession(harness.createSessionService());
  const firstReplyProcess = harness.createReplyRuntime(harness.createSessionService());
  const first = await firstReplyProcess.handle(replyInput(opened.value, "reply:restart:same"));
  assert.equal(first.ok, true, first.error);

  const secondReplyProcess = harness.createReplyRuntime(harness.createSessionService());
  const replay = await secondReplyProcess.handle(replyInput(opened.value, "reply:restart:same"));
  assert.equal(replay.ok, true, replay.error);
  assert.equal(replay.value.duplicate, true);
  assert.equal(harness.count("document.setClient"), 1);
});

test("release restart: a consumed session rejects a different Meta reply id after restart", async () => {
  const harness = createRestartHarness();
  const opened = await harness.openClientSession(harness.createSessionService());
  const first = await harness.createReplyRuntime(harness.createSessionService())
    .handle(replyInput(opened.value, "reply:restart:first"));
  assert.equal(first.ok, true, first.error);

  const conflicting = await harness.createReplyRuntime(harness.createSessionService())
    .handle(replyInput(opened.value, "reply:restart:different"));
  assert.deepEqual(conflicting, { ok: false, error: "KADI_V1_SESSION_ALREADY_CONSUMED" });
  assert.equal(harness.count("document.setClient"), 1);
});

test("release restart: an expired persisted session fails closed after restart", async () => {
  const harness = createRestartHarness();
  const opened = await harness.openClientSession(harness.createSessionService(), "expired");
  harness.advanceMs(31 * 60 * 1000);

  const result = await harness.createReplyRuntime(harness.createSessionService())
    .handle(replyInput(opened.value, "reply:restart:expired"));
  assert.deepEqual(result, { ok: false, error: "KADI_V1_SESSION_EXPIRED" });
  assert.equal(harness.count("document.setClient"), 0);
  assert.equal(harness.store.sessions.get(opened.value.session_id).status, "EXPIRED");
});

test("release restart: persisted ownership remains authoritative after restart", async () => {
  const harness = createRestartHarness();
  const opened = await harness.openClientSession(harness.createSessionService(), "owner");
  const restarted = harness.createSessionService();
  const denied = await restarted.validateReply({
    ownerWaId: OTHER_OWNER,
    sessionId: opened.value.session_id,
    flowKey: "DOCUMENT_CLIENT",
  });
  assert.deepEqual(denied, { ok: false, error: "KADI_V1_SESSION_OWNER_MISMATCH" });
});

test("release rehearsal: default flags keep the webhook inert without operational ports", async () => {
  const config = createKadiV1RuntimeConfig({});
  const runtime = createKadiV1WebhookRuntime({ config });
  const result = await runtime.handleIncomingValue({
    messages: [{ id: "wamid.release.rehearsal", from: OWNER, type: "text", text: { body: "facture" } }],
  });
  assert.deepEqual(result, { handled: false, reason: "KADI_V1_WEBHOOK_DISABLED" });
  assert.equal(config.enabled, false);
  assert.equal(Object.values(config.features).some(Boolean), false);
  assert.equal(Object.values(config.flowIds).every((value) => value === null), true);
});
