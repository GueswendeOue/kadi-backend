"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FLOW_ACTIONS,
  ACTION_FIELDS,
  validateActionPayload,
} = require("../kadiV1FlowReplyRuntime");
const {
  ACTIONS,
  validateCommand,
  createKadiV1FlowCommandRuntime,
} = require("../kadiV1FlowCommandRuntime");
const { nextFlowForReply } = require("../kadiV1ProductionPresenter");

// P8.A1-B objective 3 — DOCUMENT_PREVIEW now exposes explicit actions
// (PREPARE_PDF, EDIT_CLIENT, EDIT_CONTENT, EDIT_OPTIONS, SAVE_FOR_LATER,
// CANCEL) instead of a generic EDIT+section pair. Every action is checked
// here for ACTION_FIELDS, validation, command handler and routing.

const DOCUMENT_PREVIEW_ACTIONS = ["PREPARE_PDF", "EDIT_CLIENT", "EDIT_CONTENT", "EDIT_OPTIONS", "SAVE_FOR_LATER", "CANCEL"];

test("FLOW_ACTIONS.DOCUMENT_PREVIEW is exactly the six explicit actions, no generic EDIT", () => {
  assert.deepEqual(FLOW_ACTIONS.DOCUMENT_PREVIEW, DOCUMENT_PREVIEW_ACTIONS);
  assert.equal(FLOW_ACTIONS.DOCUMENT_PREVIEW.includes("EDIT"), false);
});

test("every DOCUMENT_PREVIEW action is a declared global action with empty ACTION_FIELDS", () => {
  for (const action of DOCUMENT_PREVIEW_ACTIONS) {
    assert.equal(ACTIONS.includes(action), true, action);
    assert.deepEqual(ACTION_FIELDS[action], [], action);
  }
});

test("every DOCUMENT_PREVIEW action validates with an empty payload", () => {
  for (const action of DOCUMENT_PREVIEW_ACTIONS) {
    const result = validateActionPayload("DOCUMENT_PREVIEW", action, {});
    assert.equal(result.ok, true, `${action}: ${result.error}`);
  }
});

test("every DOCUMENT_PREVIEW action passes validateCommand with document context", () => {
  for (const action of DOCUMENT_PREVIEW_ACTIONS) {
    const result = validateCommand({
      ownerWaId: "22670626055",
      flowKey: "DOCUMENT_PREVIEW",
      action,
      data: {},
      idempotencyKey: `flow_command:reply:preview:${action}`,
      documentContext: {
        document_id: "document:1", document_version: 2, document_type: "FACTURE", document_state: "VERIFIED", return_state: "VERIFIED",
      },
    });
    assert.equal(result.ok, true, `${action}: ${result.error}`);
  }
});

function makeRuntime(calls) {
  const record = (name) => async (payload) => {
    calls.push({ name, payload });
    return { ok: true, value: { name, status: "VERIFIED" } };
  };
  return createKadiV1FlowCommandRuntime({
    onboardingRuntime: { continueOnboarding: record("continueOnboarding") },
    documentRuntime: {
      start: record("start"), setClient: record("setClient"), startAddContent: record("startAddContent"), addContent: record("addContent"),
      updateContent: record("updateContent"), removeContent: record("removeContent"), finishContent: record("finishContent"),
      setOptions: record("setOptions"), verify: record("verify"), beginEdit: record("beginEdit"),
      saveForLater: record("saveForLater"), saveDischargeDetails: record("saveDischargeDetails"), cancel: record("cancel"),
    },
    previewRuntime: { prepare: record("preparePreview") },
    generationRuntime: { confirm: record("confirmGeneration") },
    rechargeRuntime: { selectPack: record("selectPack"), checkPayment: record("checkPayment"), cancel: record("cancelRecharge") },
    historyRuntime: { search: record("searchHistory"), open: record("openHistory") },
    walletRuntime: { getBalance: record("getBalance") },
  });
}

function documentPreviewCommand(action) {
  return {
    ownerWaId: "22670000000",
    flowKey: "DOCUMENT_PREVIEW",
    action,
    data: {},
    idempotencyKey: `flow_command:reply:preview:${action}`,
    documentContext: {
      document_id: "document:1", document_version: 2, document_type: "FACTURE", document_state: "VERIFIED", return_state: "VERIFIED",
    },
  };
}

test("PREPARE_PDF is routed to the preview runtime", async () => {
  const calls = [];
  await makeRuntime(calls).execute(documentPreviewCommand("PREPARE_PDF"));
  assert.deepEqual(calls.map((c) => c.name), ["preparePreview"]);
});

test("EDIT_CLIENT, EDIT_CONTENT and EDIT_OPTIONS all call beginEdit with the matching section", async () => {
  for (const [action, section] of [["EDIT_CLIENT", "CLIENT"], ["EDIT_CONTENT", "CONTENT"], ["EDIT_OPTIONS", "OPTIONS"]]) {
    const calls = [];
    await makeRuntime(calls).execute(documentPreviewCommand(action));
    assert.deepEqual(calls.map((c) => c.name), ["beginEdit"], action);
    assert.equal(calls[0].payload.section, section, action);
  }
});

test("SAVE_FOR_LATER calls saveForLater", async () => {
  const calls = [];
  await makeRuntime(calls).execute(documentPreviewCommand("SAVE_FOR_LATER"));
  assert.deepEqual(calls.map((c) => c.name), ["saveForLater"]);
});

test("CANCEL from DOCUMENT_PREVIEW calls the real document cancellation, not a hollow no-op", async () => {
  const calls = [];
  await makeRuntime(calls).execute(documentPreviewCommand("CANCEL"));
  assert.deepEqual(calls.map((c) => c.name), ["cancel"]);
});

test("EDIT_CLIENT, EDIT_CONTENT and EDIT_OPTIONS route to their own dedicated edit Flow", () => {
  // beginEdit's real handler (kadiV1RuntimeAdapters.js) reopens the document
  // out of VERIFIED via reopenForCorrection before returning it, so by the
  // time the presenter sees the result its status is already editable again
  // (e.g. COLLECTING) — never still VERIFIED.
  const result = { document_id: "document:1", version: 2, document_type: "FACTURE", status: "COLLECTING", items: [], client: null };
  assert.equal(nextFlowForReply("EDIT_CLIENT", result), "EDIT_CLIENT");
  assert.equal(nextFlowForReply("EDIT_CONTENT", result), "EDIT_CONTENT");
  assert.equal(nextFlowForReply("EDIT_OPTIONS", result), "EDIT_OPTIONS");
});

test("SAVE_FOR_LATER and CANCEL open no next Flow", () => {
  const result = { document_id: "document:1", version: 2, document_type: "FACTURE", status: "COLLECTING", items: [], client: null };
  assert.equal(nextFlowForReply("SAVE_FOR_LATER", result), null);
  assert.equal(nextFlowForReply("CANCEL", result), null);
});
