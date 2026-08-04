"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createKadiV1FlowReplyRuntime,
  validateActionPayload,
} = require("../kadiV1FlowReplyRuntime");
const {
  createConversationSessionService,
  createMemoryConversationSessionRepository,
} = require("../kadiV1ConversationSession");

const OWNER = "22670626055";
let tick = 0;

function makeSessionService() {
  tick = 0;
  return createConversationSessionService({
    repository: createMemoryConversationSessionRepository(),
    clock: () => new Date(Date.parse("2026-08-02T20:00:00.000Z") + tick++ * 1000).toISOString(),
    idFactory: () => "kadi_session:onboarding:1",
  });
}

async function openOnboardingSession(service) {
  const opened = await service.open({
    ownerWaId: OWNER,
    document: null,
    expectedFlowKey: "ONBOARDING",
    returnState: null,
    idempotencyKey: "open:onboarding:1",
  });
  assert.equal(opened.ok, true);
  return opened.value;
}

// ── Validation statique ──────────────────────────────────────────────────────

test("ONBOARDING START with missing owner_name is rejected before session consumption", () => {
  const result = validateActionPayload("ONBOARDING", "START", {});
  assert.deepEqual(result, { ok: false, error: "KADI_V1_FLOW_REPLY_OWNER_NAME_REQUIRED" });
});

test("ONBOARDING START with empty string owner_name is rejected", () => {
  const result = validateActionPayload("ONBOARDING", "START", { owner_name: "" });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_FLOW_REPLY_OWNER_NAME_REQUIRED" });
});

test("ONBOARDING START with whitespace-only owner_name is rejected", () => {
  const result = validateActionPayload("ONBOARDING", "START", { owner_name: "   " });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_FLOW_REPLY_OWNER_NAME_REQUIRED" });
});

test("ONBOARDING START with non-string owner_name is rejected", () => {
  const result = validateActionPayload("ONBOARDING", "START", { owner_name: 123 });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_FLOW_REPLY_OWNER_NAME_REQUIRED" });
});

test("ONBOARDING START with null owner_name is rejected", () => {
  const result = validateActionPayload("ONBOARDING", "START", { owner_name: null });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_FLOW_REPLY_OWNER_NAME_REQUIRED" });
});

// ── Session non consommée sur START invalide ─────────────────────────────────

test("empty START does not consume the session and does not call the command runtime", async () => {
  const sessions = makeSessionService();
  await openOnboardingSession(sessions);

  let commandCalled = false;
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: {
      execute: async () => {
        commandCalled = true;
        return { ok: true, value: { next_flow_key: "MENU" } };
      },
    },
  });

  const result = await runtime.handle({
    ownerWaId: OWNER,
    sessionId: "kadi_session:onboarding:1",
    flowKey: "ONBOARDING",
    action: "START",
    data: {},
    idempotencyKey: "reply:onboarding:empty:1",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_FLOW_REPLY_OWNER_NAME_REQUIRED");
  assert.equal(commandCalled, false, "command runtime must not be called on invalid START");
});

test("whitespace START does not consume the session", async () => {
  const sessions = makeSessionService();
  await openOnboardingSession(sessions);

  let commandCalled = false;
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: {
      execute: async () => {
        commandCalled = true;
        return { ok: true, value: { next_flow_key: "MENU" } };
      },
    },
  });

  const result = await runtime.handle({
    ownerWaId: OWNER,
    sessionId: "kadi_session:onboarding:1",
    flowKey: "ONBOARDING",
    action: "START",
    data: { owner_name: "  " },
    idempotencyKey: "reply:onboarding:ws:1",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_FLOW_REPLY_OWNER_NAME_REQUIRED");
  assert.equal(commandCalled, false);
});

// ── Cas positif ──────────────────────────────────────────────────────────────

test("valid START with owner_name completes the profile exactly once and opens MENU", async () => {
  const sessions = makeSessionService();
  await openOnboardingSession(sessions);

  const completedProfiles = [];
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: {
      execute: async (command) => {
        completedProfiles.push(command);
        return {
          ok: true,
          value: { next_flow_key: "MENU" },
        };
      },
    },
  });

  const result = await runtime.handle({
    ownerWaId: OWNER,
    sessionId: "kadi_session:onboarding:1",
    flowKey: "ONBOARDING",
    action: "START",
    data: { owner_name: "Philippe", business_name: "Atelier Philippe" },
    idempotencyKey: "reply:onboarding:valid:1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.handled, true);
  assert.equal(result.value.action, "START");
  assert.equal(result.value.duplicate, false);
  assert.deepEqual(result.value.result, { next_flow_key: "MENU" });

  assert.equal(completedProfiles.length, 1, "profile completed exactly once");
  assert.equal(completedProfiles[0].flowKey, "ONBOARDING");
  assert.equal(completedProfiles[0].action, "START");
  assert.deepEqual(completedProfiles[0].data, {
    owner_name: "Philippe",
    business_name: "Atelier Philippe",
  });
});

test("valid START without business_name is accepted", () => {
  const result = validateActionPayload("ONBOARDING", "START", { owner_name: "Philippe" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { owner_name: "Philippe" });
});
