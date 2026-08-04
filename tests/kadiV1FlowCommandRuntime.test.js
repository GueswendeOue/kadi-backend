"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createKadiV1FlowCommandRuntime,
  validateCommand,
} = require("../kadiV1FlowCommandRuntime");

function makeRuntime(calls) {
  const record = (name, value = {}) => async (payload) => {
    calls.push({ name, payload });
    return { ok: true, value: { name, ...value } };
  };
  return createKadiV1FlowCommandRuntime({
    onboardingRuntime: { continueOnboarding: record("continueOnboarding") },
    documentRuntime: {
      start: record("start"), setClient: record("setClient"), addContent: record("addContent"),
      updateContent: record("updateContent"), removeContent: record("removeContent"), finishContent: record("finishContent"),
      setOptions: record("setOptions"), verify: record("verify"), beginEdit: record("beginEdit"),
      saveForLater: record("saveForLater"), saveDischargeDetails: record("saveDischargeDetails"), cancel: record("cancelDocument"),
    },
    previewRuntime: { prepare: record("preparePreview") },
    generationRuntime: { confirm: record("confirmGeneration") },
    rechargeRuntime: { selectPack: record("selectPack"), checkPayment: record("checkPayment"), cancel: record("cancelRecharge") },
    historyRuntime: { search: record("searchHistory"), open: record("openHistory") },
    walletRuntime: { getBalance: record("getBalance", { credits: 5 }) },
  });
}

function command(overrides = {}) {
  return {
    ownerWaId: "22670000000",
    flowKey: "DOCUMENT_CONTENT",
    action: "ADD_CONTENT",
    data: { description: "Ciment", quantity: 2, unit: "sac", unit_price: 6500 },
    idempotencyKey: "flow_command:reply:1",
    documentContext: {
      document_id: "document:1",
      document_version: 3,
      document_type: "FACTURE",
      document_state: "COLLECTING",
      return_state: "COLLECTING",
    },
    ...overrides,
  };
}

test("rejects command without the source flow key", () => {
  assert.deepEqual(validateCommand(command({ flowKey: null })), { ok: false, error: "KADI_V1_FLOW_COMMAND_FLOW_KEY_INVALID" });
});

test("menu without a type routes to the document type screen", async () => {
  const calls = [];
  const result = await makeRuntime(calls).execute(command({ flowKey: "MENU", action: "PREPARE_DOCUMENT", data: {}, documentContext: null }));
  assert.equal(result.ok, true);
  assert.equal(result.value.next_flow_key, "DOCUMENT_TYPE");
  assert.equal(calls.length, 0);
});

test("document type selection starts the correct document", async () => {
  const calls = [];
  const result = await makeRuntime(calls).execute(command({ flowKey: "DOCUMENT_TYPE", action: "SELECT_DOCUMENT_TYPE", data: { document_type: "DEVIS" }, documentContext: null }));
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], {
    name: "start",
    payload: { ownerWaId: "22670000000", idempotencyKey: "flow_command:reply:1", documentType: "DEVIS" },
  });
});

test("client update uses only server-bound document identity and version", async () => {
  const calls = [];
  await makeRuntime(calls).execute(command({ flowKey: "DOCUMENT_CLIENT", action: "SAVE_CLIENT", data: { name: "Awa" } }));
  assert.equal(calls[0].name, "setClient");
  assert.equal(calls[0].payload.documentId, "document:1");
  assert.equal(calls[0].payload.expectedVersion, 3);
  assert.equal(calls[0].payload.ownerWaId, "22670000000");
  assert.deepEqual(calls[0].payload.client, { name: "Awa" });
});

test("item update separates server item id from editable content", async () => {
  const calls = [];
  await makeRuntime(calls).execute(command({ flowKey: "EDIT_CONTENT", action: "UPDATE_CONTENT", data: { item_id: "item:7", quantity: 4 } }));
  assert.equal(calls[0].name, "updateContent");
  assert.equal(calls[0].payload.itemId, "item:7");
  assert.deepEqual(calls[0].payload.content, { quantity: 4 });
});

test("preview preparation cannot proceed without a document context", async () => {
  const calls = [];
  const result = await makeRuntime(calls).execute(command({ flowKey: "DOCUMENT_PREVIEW", action: "PREPARE_PDF", data: {}, documentContext: null }));
  assert.deepEqual(result, { ok: false, error: "KADI_V1_FLOW_COMMAND_DOCUMENT_REQUIRED" });
  assert.equal(calls.length, 0);
});

test("generation confirmation passes quote id together with immutable server context", async () => {
  const calls = [];
  await makeRuntime(calls).execute(command({
    flowKey: "GENERATION_CONFIRMATION",
    action: "CONFIRM_GENERATION",
    data: { quote_id: "quote:9" },
    documentContext: { ...command().documentContext, document_state: "AWAITING_GENERATION_CONFIRMATION" },
  }));
  assert.equal(calls[0].name, "confirmGeneration");
  assert.equal(calls[0].payload.quoteId, "quote:9");
  assert.equal(calls[0].payload.documentId, "document:1");
  assert.equal(calls[0].payload.expectedVersion, 3);
});

test("cancel from recharge never calls document cancellation", async () => {
  const calls = [];
  await makeRuntime(calls).execute(command({ flowKey: "RECHARGE", action: "CANCEL", data: {}, documentContext: null }));
  assert.deepEqual(calls.map((entry) => entry.name), ["cancelRecharge"]);
});

test("history open remains owner-scoped", async () => {
  const calls = [];
  await makeRuntime(calls).execute(command({ flowKey: "HISTORY_SEARCH", action: "OPEN_DOCUMENT", data: { document_id: "document:2" }, documentContext: null }));
  assert.deepEqual(calls[0], { name: "openHistory", payload: { ownerWaId: "22670000000", documentId: "document:2" } });
});

test("discharge details are routed to the dedicated document adapter", async () => {
  const calls = [];
  await makeRuntime(calls).execute(command({
    flowKey: "DISCHARGE_DETAILS",
    action: "SAVE_DETAILS",
    data: { giver: "Awa", recipient: "Issa", transferred_content_type: "ARGENT", transferred_content: "50000 FCFA" },
    documentContext: { ...command().documentContext, document_type: "DECHARGE" },
  }));
  assert.equal(calls[0].name, "saveDischargeDetails");
  assert.equal(calls[0].payload.documentType, "DECHARGE");
});

test("adapter exceptions become closed recoverable failures", async () => {
  const bad = createKadiV1FlowCommandRuntime({
    onboardingRuntime: { continueOnboarding: async () => ({ ok: true, value: null }) },
    documentRuntime: {
      start: async () => { throw new Error("secret"); }, setClient: async () => ({}), addContent: async () => ({}),
      updateContent: async () => ({}), removeContent: async () => ({}), finishContent: async () => ({}),
      setOptions: async () => ({}), verify: async () => ({}),
      beginEdit: async () => ({}), saveForLater: async () => ({}), saveDischargeDetails: async () => ({}), cancel: async () => ({}),
    },
    previewRuntime: { prepare: async () => ({}) }, generationRuntime: { confirm: async () => ({}) },
    rechargeRuntime: { selectPack: async () => ({}), checkPayment: async () => ({}), cancel: async () => ({}) },
    historyRuntime: { search: async () => ({}), open: async () => ({}) }, walletRuntime: { getBalance: async () => ({}) },
  });
  const result = await bad.execute(command({ flowKey: "DOCUMENT_TYPE", action: "SELECT_DOCUMENT_TYPE", data: { document_type: "FACTURE" }, documentContext: null }));
  assert.deepEqual(result, { ok: false, error: "KADI_V1_DOCUMENT_START_FAILED" });
});
