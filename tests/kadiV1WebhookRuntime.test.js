"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  RECOVERABLE_TEXT,
  GENERATION_RETRY_TEXT,
  createKadiV1WebhookRuntime,
  idempotencyFor,
  mapMetaMessageToConversationInput,
  parseNfmReply,
  safeInternalReason,
} = require("../kadiV1WebhookRuntime");

function enabledConfig(overrides = {}) {
  return {
    enabled: true,
    features: { webhook: true },
    rollout: { mode: "FULL", valid: true, canaryOwnerCount: 0, canaryWaIds: [] },
    ...overrides,
  };
}

function textMessage(overrides = {}) {
  return { id: "wamid.text.1", from: "22670000000", type: "text", text: { body: "Je veux une facture" }, ...overrides };
}

function nfmMessage(response, overrides = {}) {
  return {
    id: "wamid.flow.1",
    from: "22670000000",
    type: "interactive",
    interactive: { type: "nfm_reply", nfm_reply: { response_json: JSON.stringify(response) } },
    ...overrides,
  };
}

function harness(overrides = {}) {
  const calls = [];
  const runtime = createKadiV1WebhookRuntime({
    config: enabledConfig(),
    orchestrator: {
      handle: async (input) => {
        calls.push(["conversation", input]);
        return overrides.conversationResponse || {
          handled: true,
          canonical_text: "Bien sûr. Envoyez-moi les informations.",
          business_action: "DOCUMENT_STARTED",
          flow_request: null,
          voice_request: null,
          events: [],
        };
      },
    },
    flowReplyRuntime: {
      handle: async (input) => {
        calls.push(["flow_reply", input]);
        return overrides.flowReplyResult || { ok: true, value: { handled: true, action: input.action, duplicate: false, result: { saved: true } } };
      },
    },
    mediaResolver: {
      resolveAudio: async (input) => { calls.push(["audio", input]); return { ok: true, value: { text: "Ajoute deux sacs de ciment" } }; },
      resolveImage: async (input) => { calls.push(["image", input]); return { ok: true, value: { media: { media_id: "media:image:1" } } }; },
      resolvePdf: async (input) => { calls.push(["pdf", input]); return { ok: true, value: { media: { media_id: "media:pdf:1" } } }; },
    },
    presenter: {
      presentConversation: async (input) => calls.push(["present_conversation", input]),
      presentFlowReply: async (input) => calls.push(["present_flow_reply", input]),
      presentRecoverableError: async (input) => calls.push(["present_error", input]),
    },
    logger: { log: (label, record) => calls.push(["log", { label, record }]) },
    ...overrides.runtime,
  });
  return { runtime, calls };
}

test("disabled webhook runtime requires no operational ports and preserves legacy routing", async () => {
  const runtime = createKadiV1WebhookRuntime({ config: { enabled: false, features: {} } });
  assert.deepEqual(await runtime.handleIncomingValue({ messages: [textMessage()] }), {
    handled: false,
    reason: "KADI_V1_WEBHOOK_DISABLED",
  });
});

test("valid nfm_reply is handled before conversation routing and binds owner from Meta", async () => {
  const { runtime, calls } = harness();
  const message = nfmMessage({ session_id: "kadi_session:1", flow_key: "DOCUMENT_CONTENT", action: "ADD_CONTENT", data: { description: "Ciment", quantity: 2, unit_price: 6500 } });
  const result = await runtime.handleIncomingValue({ messages: [message] });
  assert.equal(result.handled, true);
  assert.equal(calls.some(([name]) => name === "conversation"), false);
  const reply = calls.find(([name]) => name === "flow_reply")[1];
  assert.equal(reply.ownerWaId, "22670000000");
  assert.equal(reply.sessionId, "kadi_session:1");
  assert.equal(reply.flowKey, "DOCUMENT_CONTENT");
  assert.equal(reply.idempotencyKey, idempotencyFor("reply", message));
  assert.equal(Object.hasOwn(reply.data, "ownerWaId"), false);
  assert.equal(calls.filter(([name]) => name === "present_flow_reply").length, 1);
});

test("malformed recognized nfm_reply is absorbed and produces one recoverable response", async () => {
  const { runtime, calls } = harness();
  const message = nfmMessage({ session_id: "bad id", flow_key: "DOCUMENT_CONTENT", action: "ADD_CONTENT", data: {} });
  const result = await runtime.handleIncomingValue({ messages: [message] });
  assert.equal(result.handled, true);
  assert.equal(result.results[0].accepted, false);
  assert.equal(calls.some(([name]) => name === "flow_reply"), false);
  const errors = calls.filter(([name]) => name === "present_error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1].canonicalText, RECOVERABLE_TEXT);
});

test("a render/private-storage generation failure shows the retry-safe message, never the generic one", async () => {
  for (const reason of ["FINAL_RENDER_FAILED", "FINAL_PDF_INVALID", "FINAL_PDF_CORRUPT", "FINAL_PDF_PAGE_COUNT_MISMATCH", "FINAL_STORAGE_FAILED", "FINAL_STORAGE_NOT_PRIVATE"]) {
    const { runtime, calls } = harness({ flowReplyResult: { ok: false, error: reason } });
    const message = nfmMessage({ session_id: "kadi_session:1", flow_key: "GENERATION_CONFIRMATION", action: "CONFIRM_GENERATION", data: { quote_id: "quote:1" } });
    await runtime.handleIncomingValue({ messages: [message] });
    const errors = calls.filter(([name]) => name === "present_error");
    assert.equal(errors.length, 1, reason);
    assert.equal(errors[0][1].canonicalText, GENERATION_RETRY_TEXT, reason);
    assert.notEqual(errors[0][1].canonicalText, RECOVERABLE_TEXT, reason);
  }
});

test("an unrelated recoverable failure keeps the generic message, not the generation-retry one", async () => {
  const { runtime, calls } = harness({ flowReplyResult: { ok: false, error: "KADI_V1_SESSION_UNEXPECTED_FLOW" } });
  const message = nfmMessage({ session_id: "kadi_session:1", flow_key: "DOCUMENT_CONTENT", action: "ADD_CONTENT", data: { description: "Ciment", quantity: 2, unit_price: 6500 } });
  await runtime.handleIncomingValue({ messages: [message] });
  const errors = calls.filter(([name]) => name === "present_error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1].canonicalText, RECOVERABLE_TEXT);
});

test("flow reply envelope rejects extra authority-bearing top-level fields", () => {
  const message = nfmMessage({ session_id: "kadi_session:1", flow_key: "DOCUMENT_CONTENT", action: "ADD_CONTENT", data: {}, ownerWaId: "22671111111" });
  assert.deepEqual(parseNfmReply(message, "22670000000"), { ok: false, error: "KADI_V1_FLOW_REPLY_ENVELOPE_FIELD_FORBIDDEN" });
});

test("text message maps to canonical conversation input and is presented once", async () => {
  const { runtime, calls } = harness();
  const result = await runtime.handleIncomingValue({ messages: [textMessage()] });
  assert.equal(result.handled, true);
  const input = calls.find(([name]) => name === "conversation")[1];
  assert.equal(input.inputType, "TEXT");
  assert.equal(input.text, "Je veux une facture");
  assert.match(input.correlationId, /^meta:[a-f0-9]{16}$/);
  assert.match(input.idempotencyKey, /^conversation:[a-f0-9]{16}$/);
  assert.equal(calls.filter(([name]) => name === "present_conversation").length, 1);
});

test("audio, image and PDF inputs use their dedicated resolvers", async () => {
  const { runtime, calls } = harness();
  await runtime.handleIncomingValue({ messages: [{ id: "a1", from: "22670000000", type: "audio", audio: { id: "media-a" } }] });
  await runtime.handleIncomingValue({ messages: [{ id: "i1", from: "22670000000", type: "image", image: { id: "media-i" } }] });
  await runtime.handleIncomingValue({ messages: [{ id: "p1", from: "22670000000", type: "document", document: { id: "media-p", mime_type: "application/pdf" } }] });
  const inputs = calls.filter(([name]) => name === "conversation").map(([, input]) => input.inputType);
  assert.deepEqual(inputs, ["TRANSCRIPTION", "IMAGE", "PDF"]);
  assert.equal(calls.filter(([name]) => name === "audio").length, 1);
  assert.equal(calls.filter(([name]) => name === "image").length, 1);
  assert.equal(calls.filter(([name]) => name === "pdf").length, 1);
});

test("button and list replies become menu actions without exposing payload internals", async () => {
  const { runtime, calls } = harness();
  await runtime.handleIncomingValue({ messages: [{ id: "b1", from: "22670000000", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "invoice", title: "Facture" } } }] });
  const input = calls.find(([name]) => name === "conversation")[1];
  assert.equal(input.inputType, "MENU_ACTION");
  assert.equal(input.action, "Facture");
});

test("unsupported document type remains available to the legacy boundary", async () => {
  const { runtime, calls } = harness();
  const result = await runtime.handleIncomingValue({ messages: [{ id: "d1", from: "22670000000", type: "document", document: { mime_type: "image/png" } }] });
  assert.equal(result.handled, false);
  assert.equal(calls.some(([name]) => name === "conversation"), false);
  assert.equal(calls.some(([name]) => name === "present_error"), false);
});

test("same Meta message id produces the same idempotency key", async () => {
  const mediaResolver = { resolveAudio: async () => ({}), resolveImage: async () => ({}), resolvePdf: async () => ({}) };
  const first = await mapMetaMessageToConversationInput({ ownerWaId: "22670000000", message: textMessage(), value: {}, mediaResolver });
  const second = await mapMetaMessageToConversationInput({ ownerWaId: "22670000000", message: textMessage(), value: {}, mediaResolver });
  assert.equal(first.value.idempotencyKey, second.value.idempotencyKey);
});

test("runtime logs only safe message references and controlled reasons", async () => {
  const { runtime, calls } = harness();
  await runtime.handleIncomingValue({ messages: [textMessage({ text: { body: "Client secret 70000000" } })] });
  const serialized = JSON.stringify(calls.filter(([name]) => name === "log"));
  assert.doesNotMatch(serialized, /Client secret|70000000|22670000000/);
});

test("safeInternalReason accepts only the closed KADI_V1_ code pattern", () => {
  assert.equal(safeInternalReason(new Error("KADI_V1_SESSION_CREATE_FAILED"), "FALLBACK"), "KADI_V1_SESSION_CREATE_FAILED");
  assert.equal(safeInternalReason(new Error("KADI_V1_" + "X".repeat(80)), "FALLBACK"), "KADI_V1_" + "X".repeat(80));
  assert.equal(safeInternalReason(new Error("KADI_V1_" + "X".repeat(81)), "FALLBACK"), "FALLBACK", "over 80 chars after the prefix must be rejected");
  assert.equal(safeInternalReason(new Error("kadi_v1_session_create_failed"), "FALLBACK"), "FALLBACK", "lowercase must be rejected");
  assert.equal(safeInternalReason(new Error("KADI_V1_SESSION_CREATE_FAILED extra"), "FALLBACK"), "FALLBACK", "trailing content must be rejected");
  assert.equal(safeInternalReason(new Error("connection refused"), "FALLBACK"), "FALLBACK");
  assert.equal(safeInternalReason(new Error(""), "FALLBACK"), "FALLBACK");
  assert.equal(safeInternalReason({}, "FALLBACK"), "FALLBACK");
  assert.equal(safeInternalReason(null, "FALLBACK"), "FALLBACK");
});

test("a safe internal reason from a failed presentFlowReply is logged and returned", async () => {
  const { runtime, calls } = harness({
    runtime: {
      presenter: {
        presentConversation: async (input) => calls.push(["present_conversation", input]),
        presentFlowReply: async () => { throw new Error("KADI_V1_SESSION_CREATE_FAILED"); },
        presentRecoverableError: async (input) => calls.push(["present_error", input]),
      },
    },
  });
  const message = nfmMessage({ session_id: "kadi_session:1", flow_key: "DOCUMENT_CONTENT", action: "ADD_CONTENT", data: { description: "Ciment", quantity: 2, unit_price: 6500 } });
  const result = await runtime.handleIncomingValue({ messages: [message] });
  assert.equal(result.handled, true);
  assert.deepEqual(result.results[0], { handled: true, accepted: false, reason: "KADI_V1_SESSION_CREATE_FAILED" });
  const logs = calls.filter(([name]) => name === "log");
  assert.ok(logs.some(([, entry]) => entry.record.reason === "KADI_V1_SESSION_CREATE_FAILED"));
});

test("an arbitrary presentFlowReply failure message is replaced by the generic presentation-failed reason", async () => {
  const { runtime, calls } = harness({
    runtime: {
      presenter: {
        presentConversation: async (input) => calls.push(["present_conversation", input]),
        presentFlowReply: async () => { throw new Error("connection refused to db.internal:5432 for wa_id 22670000000"); },
        presentRecoverableError: async (input) => calls.push(["present_error", input]),
      },
    },
  });
  const message = nfmMessage({ session_id: "kadi_session:1", flow_key: "DOCUMENT_CONTENT", action: "ADD_CONTENT", data: { description: "Ciment", quantity: 2, unit_price: 6500 } });
  const result = await runtime.handleIncomingValue({ messages: [message] });
  assert.equal(result.handled, true);
  assert.deepEqual(result.results[0], { handled: true, accepted: false, reason: "KADI_V1_FLOW_REPLY_PRESENTATION_FAILED" });
  const serialized = JSON.stringify(calls.filter(([name]) => name === "log"));
  assert.doesNotMatch(serialized, /connection refused|db\.internal|5432|22670000000/);
});

test("presentFlowReply failures never log a WhatsApp number, payload, message content, token or raw PostgreSQL detail", async () => {
  const { runtime, calls } = harness({
    runtime: {
      presenter: {
        presentConversation: async (input) => calls.push(["present_conversation", input]),
        presentFlowReply: async () => {
          throw new Error(
            'insert or update on table "kadi_v1_conversation_sessions" violates check constraint ' +
            '"kadi_v1_conversation_sessions_expected_flow_key_check" DETAIL: Failing row contains ' +
            '(kadi_session:1, 22670000000, ..., Bearer sk-secret-token-123).'
          );
        },
        presentRecoverableError: async (input) => calls.push(["present_error", input]),
      },
    },
  });
  const message = nfmMessage({ session_id: "kadi_session:1", flow_key: "DOCUMENT_CONTENT", action: "ADD_CONTENT", data: { description: "Ciment", quantity: 2, unit_price: 6500 } });
  await runtime.handleIncomingValue({ messages: [message] });
  const serialized = JSON.stringify(calls.filter(([name]) => name === "log"));
  assert.doesNotMatch(serialized, /22670000000|sk-secret-token|Bearer|DETAIL|check constraint|Failing row/);
});

test("the normal presentFlowReply path (no throw) is unaffected by the named catch", async () => {
  const { runtime, calls } = harness();
  const message = nfmMessage({ session_id: "kadi_session:1", flow_key: "DOCUMENT_CONTENT", action: "ADD_CONTENT", data: { description: "Ciment", quantity: 2, unit_price: 6500 } });
  const result = await runtime.handleIncomingValue({ messages: [message] });
  assert.equal(result.handled, true);
  assert.equal(calls.filter(([name]) => name === "present_flow_reply").length, 1);
  assert.equal(calls.some(([name]) => name === "present_error"), false);
});

test("canary rollout sends only allowlisted owners to V1", async () => {
  const { runtime, calls } = harness({
    runtime: {
      config: enabledConfig({
        rollout: { mode: "CANARY", valid: true, canaryOwnerCount: 1, canaryWaIds: ["22670000000"] },
      }),
    },
  });
  const allowed = await runtime.handleIncomingValue({ messages: [textMessage()] });
  const denied = await runtime.handleIncomingValue({ messages: [textMessage({ id: "wamid.text.2", from: "22671111111" })] });
  assert.equal(allowed.handled, true);
  assert.deepEqual(denied.results[0], { handled: false, reason: "KADI_V1_OWNER_NOT_IN_ROLLOUT" });
  assert.equal(calls.filter(([name]) => name === "conversation").length, 1);
});

test("recognized V1 Flow reply from a non-canary owner is absorbed before legacy", async () => {
  const { runtime, calls } = harness({
    runtime: {
      config: enabledConfig({
        rollout: { mode: "CANARY", valid: true, canaryOwnerCount: 1, canaryWaIds: ["22670000000"] },
      }),
    },
  });
  const result = await runtime.handleIncomingValue({
    messages: [nfmMessage({
      session_id: "kadi_session:blocked",
      flow_key: "DOCUMENT_CONTENT",
      action: "ADD_CONTENT",
      data: { description: "Ciment", quantity: 1, unit_price: 6500 },
    }, { id: "wamid.flow.blocked", from: "22671111111" })],
  });
  assert.equal(result.handled, true);
  assert.deepEqual(result.results[0], { handled: true, accepted: false, reason: "KADI_V1_CANARY_OWNER_NOT_ALLOWED" });
  assert.equal(calls.some(([name]) => name === "flow_reply"), false);
  assert.equal(calls.some(([name]) => name === "present_error"), false);
});

test("rollout OFF and invalid rollout require no operational ports", async () => {
  const off = createKadiV1WebhookRuntime({
    config: enabledConfig({ rollout: { mode: "OFF", valid: true, canaryOwnerCount: 0, canaryWaIds: [] } }),
  });
  assert.deepEqual(await off.handleIncomingValue({ messages: [textMessage()] }), {
    handled: false,
    reason: "KADI_V1_ROLLOUT_OFF",
  });

  const invalid = createKadiV1WebhookRuntime({
    config: enabledConfig({ rollout: { mode: "OFF", valid: false, error: "KADI_V1_ROLLOUT_MODE_INVALID", canaryOwnerCount: 0, canaryWaIds: [] } }),
  });
  assert.deepEqual(await invalid.handleIncomingValue({ messages: [textMessage()] }), {
    handled: false,
    reason: "KADI_V1_ROLLOUT_CONFIG_INVALID",
  });
});
