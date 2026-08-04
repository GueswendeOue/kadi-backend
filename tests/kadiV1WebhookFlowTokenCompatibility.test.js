"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createKadiV1WebhookRuntime,
  parseNfmReply,
} = require("../kadiV1WebhookRuntime");

function nfmMessage(response, overrides = {}) {
  return {
    id: "wamid.flow.meta-token.1",
    from: "22670000000",
    type: "interactive",
    interactive: {
      type: "nfm_reply",
      nfm_reply: {
        response_json: JSON.stringify(response),
      },
    },
    ...overrides,
  };
}

function validReply(overrides = {}) {
  return {
    flow_token: "kadi_session:1",
    session_id: "kadi_session:1",
    flow_key: "ONBOARDING",
    action: "START",
    data: {},
    ...overrides,
  };
}

test("Meta flow_token matching session_id is accepted and not forwarded as authority", () => {
  const message = nfmMessage(validReply());
  const parsed = parseNfmReply(message, "22670000000");

  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.sessionId, "kadi_session:1");
  assert.equal(parsed.value.flowKey, "ONBOARDING");
  assert.equal(parsed.value.action, "START");
  assert.deepEqual(parsed.value.data, {});
  assert.equal(Object.hasOwn(parsed.value, "flowToken"), false);
  assert.equal(Object.hasOwn(parsed.value.data, "flow_token"), false);
});

test("Meta flow_token mismatch is rejected fail-closed", () => {
  const message = nfmMessage(validReply({
    flow_token: "kadi_session:other",
  }));

  assert.deepEqual(
    parseNfmReply(message, "22670000000"),
    { ok: false, error: "KADI_V1_FLOW_REPLY_TOKEN_MISMATCH" }
  );
});

test("invalid Meta flow_token syntax is rejected fail-closed", () => {
  const message = nfmMessage(validReply({
    flow_token: "bad token with spaces",
  }));

  assert.deepEqual(
    parseNfmReply(message, "22670000000"),
    { ok: false, error: "KADI_V1_FLOW_REPLY_TOKEN_INVALID" }
  );
});

test("unrelated top-level fields remain forbidden", () => {
  const message = nfmMessage(validReply({
    ownerWaId: "22671111111",
  }));

  assert.deepEqual(
    parseNfmReply(message, "22670000000"),
    { ok: false, error: "KADI_V1_FLOW_REPLY_ENVELOPE_FIELD_FORBIDDEN" }
  );
});

test("realistic Meta reply reaches flow runtime exactly once", async () => {
  const calls = [];
  const runtime = createKadiV1WebhookRuntime({
    config: {
      enabled: true,
      features: { webhook: true },
      rollout: {
        mode: "CANARY",
        valid: true,
        canaryOwnerCount: 1,
        canaryWaIds: ["22670000000"],
      },
    },
    orchestrator: {
      handle: async () => {
        throw new Error("conversation runtime must not receive nfm_reply");
      },
    },
    flowReplyRuntime: {
      handle: async (input) => {
        calls.push(input);
        return {
          ok: true,
          value: {
            handled: true,
            action: input.action,
            duplicate: false,
            result: { started: true },
          },
        };
      },
    },
    mediaResolver: {
      resolveAudio: async () => ({}),
      resolveImage: async () => ({}),
      resolvePdf: async () => ({}),
    },
    presenter: {
      presentConversation: async () => {
        throw new Error("conversation presenter must not receive nfm_reply");
      },
      presentFlowReply: async (input) => calls.push({ presented: input }),
      presentRecoverableError: async (input) => calls.push({ recovered: input }),
    },
    logger: { log() {} },
  });

  const result = await runtime.handleIncomingValue({
    messages: [nfmMessage(validReply())],
  });

  assert.equal(result.handled, true);
  assert.equal(result.results[0].accepted, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].sessionId, "kadi_session:1");
  assert.equal(calls[0].action, "START");
  assert.equal(Object.hasOwn(calls[0], "flowToken"), false);
  assert.equal(Object.hasOwn(calls[1], "recovered"), false);
});
