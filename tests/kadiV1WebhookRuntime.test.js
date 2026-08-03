"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  RECOVERABLE_TEXT,
  createKadiV1WebhookRuntime,
  idempotencyFor,
  mapMetaMessageToConversationInput,
  parseNfmReply,
} = require("../kadiV1WebhookRuntime");

function enabledConfig() {
  return { enabled: true, features: { webhook: true } };
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
