"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createKadiV1ProductionPresenter,
  loadFlowRegistry,
  buildV1FlowMessage,
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

test("DOCUMENT_CONTENT registry exposes both terminal screens through a closed screen registry", () => {
  const registry = loadFlowRegistry();
  const contract = registry.DOCUMENT_CONTENT;
  assert.equal(contract.entryScreen, "DOCUMENT_CONTENT");
  assert.deepEqual([...contract.allowedScreenIds].sort(), ["ARTICLE_FORM", "DOCUMENT_CONTENT"]);
  assert.deepEqual(Object.keys(contract.screensById).sort(), ["ARTICLE_FORM", "DOCUMENT_CONTENT"]);
  assert.deepEqual(Object.keys(contract.defaultsByScreenId).sort(), ["ARTICLE_FORM", "DOCUMENT_CONTENT"]);
  assert.ok(contract.screensById.ARTICLE_FORM.dataKeys.includes("session_id"));
  assert.ok(contract.screensById.ARTICLE_FORM.dataKeys.includes("unit_options"));
  assert.equal(contract.screensById.ARTICLE_FORM.dataKeys.includes("description"), false);
});

test("the fourteen other Flows expose only their own screen id in the registry", () => {
  const registry = loadFlowRegistry();
  for (const [flowKey, contract] of Object.entries(registry)) {
    if (flowKey === "DOCUMENT_CONTENT") continue;
    assert.deepEqual(contract.allowedScreenIds, [flowKey]);
    assert.deepEqual(Object.keys(contract.screensById), [flowKey]);
  }
});

test("buildV1FlowMessage refuses a screen outside the Flow's allowed screen registry", () => {
  const registry = loadFlowRegistry();
  assert.throws(() => buildV1FlowMessage({
    to: OWNER,
    flowKey: "DOCUMENT_CONTENT",
    flowId: FLOW_IDS.DOCUMENT_CONTENT,
    sessionId: "kadi_session:screen-guard",
    flowMode: "draft",
    contract: registry.DOCUMENT_CONTENT,
    data: { session_id: "kadi_session:screen-guard" },
    screen: "SOME_UNDECLARED_SCREEN",
  }), /KADI_V1_PRESENTER_SCREEN_INVALID/);
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

test("START_ADD_CONTENT reopens the same Flow directly on the empty ARTICLE_FORM screen", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:start-add",
    result: {
      handled: true,
      action: "START_ADD_CONTENT",
      duplicate: false,
      result: {
        document_id: "document:1",
        version: 2,
        document_type: "FACTURE",
        status: "COLLECTING",
        items: [{ item_id: "item:1", description: "Ciment", quantity: 2, unit_price: 5000 }],
      },
    },
  });
  const payload = calls.find(([name]) => name === "flow")[1];
  const parameters = payload.interactive.action.parameters;
  assert.equal(parameters.flow_id, FLOW_IDS.DOCUMENT_CONTENT);
  assert.equal(parameters.flow_action_payload.screen, "ARTICLE_FORM");
  assert.ok(Array.isArray(parameters.flow_action_payload.data.unit_options));
  assert.equal(Object.hasOwn(parameters.flow_action_payload.data, "description"), false, "ARTICLE_FORM must never carry a stale prefill");
  assert.equal(Object.hasOwn(parameters.flow_action_payload.data, "quantity"), false, "ARTICLE_FORM must never carry a stale prefill");
});

test("a successful ADD_CONTENT reopens the DOCUMENT_CONTENT decision screen", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:add-content",
    result: {
      handled: true,
      action: "ADD_CONTENT",
      duplicate: false,
      result: {
        document_id: "document:1",
        version: 3,
        document_type: "FACTURE",
        status: "COLLECTING",
        items: [{ item_id: "item:1", description: "Ciment", quantity: 2, unit_price: 5000 }],
      },
    },
  });
  const payload = calls.find(([name]) => name === "flow")[1];
  const parameters = payload.interactive.action.parameters;
  assert.equal(parameters.flow_action_payload.screen, "DOCUMENT_CONTENT");
});

test("SAVE_CLIENT on a document with no items yet opens ARTICLE_FORM directly instead of the decision screen", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:save-client",
    result: {
      handled: true,
      action: "SAVE_CLIENT",
      duplicate: false,
      result: {
        document_id: "document:1",
        version: 2,
        document_type: "FACTURE",
        status: "COLLECTING",
        items: [],
      },
    },
  });
  const payload = calls.find(([name]) => name === "flow")[1];
  const parameters = payload.interactive.action.parameters;
  assert.equal(parameters.flow_id, FLOW_IDS.DOCUMENT_CONTENT);
  assert.equal(parameters.flow_action_payload.screen, "ARTICLE_FORM");
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
