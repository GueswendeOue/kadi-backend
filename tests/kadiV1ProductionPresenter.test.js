"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createKadiV1ProductionPresenter,
  loadFlowRegistry,
} = require("../kadiV1ProductionPresenter");

const OWNER = "22670000000";
const FLOW_IDS = Object.freeze({
  ONBOARDING: "100001",
  MENU: "100002",
  DOCUMENT_TYPE: "100003",
  DOCUMENT_CLIENT: "100004",
  DOCUMENT_CONTENT: "100005",
  DOCUMENT_OPTIONS: "100006",
  DOCUMENT_REVIEW: "100007",
  EDIT_CLIENT: "100008",
  EDIT_CONTENT: "100009",
  EDIT_OPTIONS: "100010",
  DOCUMENT_PREVIEW: "100011",
  GENERATION_CONFIRMATION: "100012",
  RECHARGE: "100013",
  HISTORY_SEARCH: "100014",
  DISCHARGE_DETAILS: "100015",
});

function config() {
  return {
    enabled: true,
    features: { voice: true },
    flowIds: FLOW_IDS,
  };
}

function harness(overrides = {}) {
  const calls = [];
  const presenter = createKadiV1ProductionPresenter({
    config: config(),
    whatsappApi: {
      async sendTypingIndicator(messageId) {
        calls.push(["typing", messageId]);
      },
      async sendText(to, text) {
        calls.push(["text", { to, text }]);
      },
      async sendFlow(payload) {
        calls.push(["flow", payload]);
      },
    },
    sessionService: {
      async open(command) {
        calls.push(["session", command]);
        return {
          ok: true,
          value: {
            session_id: "kadi_session:presenter1",
          },
          duplicate: false,
        };
      },
    },
    ...overrides,
  });
  return { presenter, calls };
}

test("all fifteen draft Flows expose one matching entry screen and session input", () => {
  const registry = loadFlowRegistry();
  assert.equal(Object.keys(registry).length, 15);
  for (const [flowKey, contract] of Object.entries(registry)) {
    assert.equal(contract.entryScreen, flowKey);
    assert.ok(contract.dataKeys.includes("session_id"));
  }
});

test("conversation sends canonical text before a server-bound Flow", async () => {
  const { presenter, calls } = harness();
  const result = await presenter.presentConversation({
    ownerWaId: OWNER,
    messageId: "wamid:conversation1",
    response: {
      handled: true,
      canonical_text: "Vérifiez les informations.",
      business_action: "DOCUMENT_READY",
      next_state: "READY_FOR_REVIEW",
      flow_request: {
        flow_key: "DOCUMENT_REVIEW",
        prefill: {
          document_id: "document:1",
          document_version: 4,
          document_type: "FACTURE",
        },
      },
      voice_request: null,
      events: [],
    },
  });

  assert.deepEqual(
    calls.map(([name]) => name),
    ["typing", "text", "session", "flow"]
  );
  assert.equal(result.text_sent, true);
  assert.equal(result.flow_sent, true);

  const session = calls.find(([name]) => name === "session")[1];
  assert.deepEqual(session.document, {
    document_id: "document:1",
    version: 4,
    document_type: "FACTURE",
    status: "READY_FOR_REVIEW",
  });
  assert.equal(session.expectedFlowKey, "DOCUMENT_REVIEW");

  const payload = calls.find(([name]) => name === "flow")[1];
  const parameters = payload.interactive.action.parameters;
  assert.equal(parameters.flow_id, FLOW_IDS.DOCUMENT_REVIEW);
  assert.equal(parameters.flow_token, "kadi_session:presenter1");
  assert.equal(
    parameters.flow_action_payload.screen,
    "DOCUMENT_REVIEW"
  );
  assert.equal(
    parameters.flow_action_payload.data.session_id,
    "kadi_session:presenter1"
  );
  assert.equal(
    Object.hasOwn(
      parameters.flow_action_payload.data,
      "document_id"
    ),
    false
  );
  assert.equal(
    Object.hasOwn(
      parameters.flow_action_payload.data,
      "document_version"
    ),
    false
  );
});

test("duplicate Flow reply produces no duplicate outward message", async () => {
  const { presenter, calls } = harness();
  const result = await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:duplicate",
    result: {
      handled: true,
      action: "ADD_CONTENT",
      duplicate: true,
      result: { item_id: "item:1" },
    },
  });
  assert.equal(result.duplicate, true);
  assert.deepEqual(calls, []);
});

test("preview result opens generation confirmation with the authoritative quote id", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:preview",
    result: {
      handled: true,
      action: "PREPARE_PDF",
      duplicate: false,
      result: {
        quote: { quote_id: "quote:1" },
        document: {
          document_id: "document:1",
          version: 5,
          document_type: "FACTURE",
          status: "AWAITING_GENERATION_CONFIRMATION",
        },
      },
    },
  });

  const payload = calls.find(([name]) => name === "flow")[1];
  const parameters = payload.interactive.action.parameters;
  assert.equal(
    parameters.flow_action_payload.screen,
    "GENERATION_CONFIRMATION"
  );
  assert.equal(
    parameters.flow_action_payload.data.quote_id,
    "quote:1"
  );
});

test("recoverable error sends only canonical user text and never exposes the reason", async () => {
  const { presenter, calls } = harness();
  await presenter.presentRecoverableError({
    ownerWaId: OWNER,
    messageId: "wamid:error",
    canonicalText: "Réessayez dans un instant.",
    reason: "PRIVATE_PROVIDER_FAILURE",
  });
  const serialized = JSON.stringify(calls);
  assert.match(serialized, /Réessayez dans un instant/);
  assert.doesNotMatch(serialized, /PRIVATE_PROVIDER_FAILURE/);
});

test("voice failure is non-blocking after the mandatory text", async () => {
  const { presenter, calls } = harness({
    voiceResponseEngine: {
      async generate() {
        throw Object.assign(new Error("private"), {
          code: "VOICE_PROVIDER_FAILED",
        });
      },
    },
    voiceDelivery: {
      async sendGeneratedVoice() {
        calls.push(["voice"]);
      },
    },
    logger: { log() {} },
  });

  const result = await presenter.presentConversation({
    ownerWaId: OWNER,
    messageId: "wamid:voice",
    response: {
      handled: true,
      canonical_text: "Votre document est prêt.",
      business_action: "DOCUMENT_READY",
      next_state: null,
      flow_request: null,
      voice_request: {
        mode: "TEXT_AND_VOICE",
        reason: "POLICY",
      },
      events: [],
    },
  });

  assert.equal(result.text_sent, true);
  assert.equal(result.voice_sent, false);
  assert.equal(calls.filter(([name]) => name === "text").length, 1);
  assert.equal(calls.filter(([name]) => name === "voice").length, 0);
});

test("production presenter construction performs no Supabase or WhatsApp I/O", () => {
  let externalCalls = 0;
  const presenter = createKadiV1ProductionPresenter({
    config: config(),
    supabase: {
      from() {
        externalCalls += 1;
        throw new Error("BOOT_QUERY_FORBIDDEN");
      },
      rpc() {
        externalCalls += 1;
        throw new Error("BOOT_RPC_FORBIDDEN");
      },
    },
    whatsappApi: {
      async sendText() {
        externalCalls += 1;
      },
      async sendFlow() {
        externalCalls += 1;
      },
    },
  });
  assert.equal(externalCalls, 0);
  assert.equal(presenter.readiness.ready, true);
  assert.equal(presenter.readiness.boot_external_calls, 0);
});
