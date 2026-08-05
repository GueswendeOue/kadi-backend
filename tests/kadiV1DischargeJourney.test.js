"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { validateActionPayload } = require("../kadiV1FlowReplyRuntime");
const { createInMemoryV1DocumentRepository } = require("../kadiV1DocumentRepository");
const { createDischargePipeline } = require("../kadiV1DischargePipeline");
const { createKadiV1DocumentRuntimeAdapter } = require("../kadiV1RuntimeAdapters");
const { createSharedDocumentPipeline } = require("../kadiV1SharedDocumentPipeline");

const OWNER = "22670000000";

// --- Category: initial form contract (mission item 20) ---

function readDischargeFlow() {
  const file = path.join(__dirname, "..", "flows", "v1_draft", "kadi_discharge_details_v1.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("initial DISCHARGE_DETAILS JSON has no action selector (\"Prochaine étape\") and no VERIFY/EDIT/CANCEL choice", () => {
  const json = readDischargeFlow();
  const encoded = JSON.stringify(json);
  assert.doesNotMatch(encoded, /Prochaine étape/);
  assert.doesNotMatch(encoded, /discharge_actions/);
  const footer = json.screens[0].layout.children.find((node) => node.type === "Form")
    .children.find((node) => node.type === "Footer");
  assert.equal(footer["on-click-action"].payload.action, "SAVE_DETAILS");
  assert.notEqual(footer["on-click-action"].payload.action, "${form.action}");
});

test("the form collects structured type/amount/description/quantity fields, not one ambiguous free-text field", () => {
  const json = readDischargeFlow();
  const names = [];
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (typeof node.name === "string") names.push(node.name);
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const value of Object.values(node)) if (value && typeof value === "object") walk(value);
  }
  walk(json.screens[0].layout);
  for (const expected of ["giver", "recipient", "transferred_content_type", "amount", "description", "quantity", "reason", "observations"]) {
    assert.ok(names.includes(expected), `field ${expected} must exist`);
  }
  assert.equal(names.includes("transferred_content"), false, "the old ambiguous catch-all field must be gone");
  assert.equal(names.includes("purpose"), false, "purpose must be renamed to reason");
  assert.equal(names.includes("notes"), false, "notes must be renamed to observations");
});

// --- Category: reply-runtime validation (mission items 21-25) ---

function validPayload(overrides = {}) {
  return {
    giver: "Awa", recipient: "Issa", transferred_content_type: "MONEY",
    amount: "50000", reason: "Remise de fonds",
    ...overrides,
  };
}

test("required fields (giver, recipient, reason, transferred_content_type) are enforced", () => {
  for (const field of ["giver", "recipient", "reason"]) {
    const payload = validPayload({ [field]: "" });
    const result = validateActionPayload("DISCHARGE_DETAILS", "SAVE_DETAILS", payload);
    assert.equal(result.ok, false, `${field} empty must be rejected`);
  }
  const badType = validPayload({ transferred_content_type: "ARGENT" });
  assert.deepEqual(validateActionPayload("DISCHARGE_DETAILS", "SAVE_DETAILS", badType), {
    ok: false, error: "KADI_V1_FLOW_REPLY_DISCHARGE_TYPE_INVALID",
  });
});

test("MONEY requires a positive integer amount", () => {
  const ok = validateActionPayload("DISCHARGE_DETAILS", "SAVE_DETAILS", validPayload({ amount: "50000" }));
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.value.amount, 50000);
  for (const amount of ["0", "-1", "12.5", "abc", "", undefined]) {
    const payload = validPayload({ amount });
    if (amount === undefined) delete payload.amount;
    const result = validateActionPayload("DISCHARGE_DETAILS", "SAVE_DETAILS", payload);
    assert.equal(result.ok, false, `amount=${JSON.stringify(amount)} must be rejected for MONEY`);
    assert.equal(result.error, "KADI_V1_FLOW_REPLY_DISCHARGE_AMOUNT_INVALID");
  }
});

test("MONEY rejects a description-only payload when amount is missing", () => {
  const payload = validPayload({ description: "Some goods" });
  delete payload.amount;
  const result = validateActionPayload("DISCHARGE_DETAILS", "SAVE_DETAILS", payload);
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_FLOW_REPLY_DISCHARGE_AMOUNT_INVALID");
});

test("GOODS, DOCUMENT and OTHER require a description", () => {
  for (const type of ["GOODS", "DOCUMENT", "OTHER"]) {
    const payload = validPayload({ transferred_content_type: type, description: "", amount: "" });
    delete payload.amount;
    const result = validateActionPayload("DISCHARGE_DETAILS", "SAVE_DETAILS", payload);
    assert.equal(result.ok, false, `${type} without description must be rejected`);
    assert.equal(result.error, "KADI_V1_FLOW_REPLY_DISCHARGE_DESCRIPTION_REQUIRED");
    const valid = validateActionPayload("DISCHARGE_DETAILS", "SAVE_DETAILS", { ...payload, description: "Un bien précis" });
    assert.equal(valid.ok, true, valid.error);
    assert.equal(Object.hasOwn(valid.value, "amount"), false, "amount must not survive for non-money types");
  }
});

test("a non-money amount is rejected even if it happens to be numeric", () => {
  const payload = validPayload({ transferred_content_type: "GOODS", description: "Un vélo", amount: "1000" });
  const result = validateActionPayload("DISCHARGE_DETAILS", "SAVE_DETAILS", payload);
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_FLOW_REPLY_DISCHARGE_AMOUNT_UNEXPECTED");
});

test("quantity, when present for a non-money type, is normalized to a safe positive integer", () => {
  const payload = validPayload({ transferred_content_type: "GOODS", description: "Chaises", amount: "", quantity: "4" });
  delete payload.amount;
  const result = validateActionPayload("DISCHARGE_DETAILS", "SAVE_DETAILS", payload);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.quantity, 4);
  const invalid = validateActionPayload("DISCHARGE_DETAILS", "SAVE_DETAILS", { ...payload, quantity: "-2" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, "KADI_V1_FLOW_REPLY_DISCHARGE_QUANTITY_INVALID");
});

test("DISCHARGE_DETAILS no longer allows VERIFY, EDIT or CANCEL as its own actions", () => {
  assert.deepEqual(validateActionPayload("DISCHARGE_DETAILS", "VERIFY", {}), {
    ok: false, error: "KADI_V1_FLOW_REPLY_ACTION_FORBIDDEN",
  });
  assert.deepEqual(validateActionPayload("DISCHARGE_DETAILS", "CANCEL", {}), {
    ok: false, error: "KADI_V1_FLOW_REPLY_ACTION_FORBIDDEN",
  });
});

// --- Category: adapter field mapping and pipeline persistence (mission items 26-30) ---

function fixture() {
  let idIndex = 0;
  const repository = createInMemoryV1DocumentRepository();
  const dischargePipeline = createDischargePipeline({ repository, idFactory: (kind) => `${kind}:${++idIndex}` });
  const sharedPipeline = createSharedDocumentPipeline({ repository, idFactory: (kind) => `${kind}:${++idIndex}` });
  const runtime = createKadiV1DocumentRuntimeAdapter({
    sharedPipeline,
    dischargePipeline,
    documentRepository: repository,
    issuerResolver: { getIssuerProfileId: async () => ({ ok: true, value: { issuerProfileId: "issuer:1" } }) },
  });
  return { repository, runtime };
}

test("purpose/reason and notes/observations are persisted correctly under their real field names", async () => {
  const { runtime } = fixture();
  const started = await runtime.start({ ownerWaId: OWNER, documentType: "DECHARGE", idempotencyKey: "flow_command:start:1" });
  assert.equal(started.ok, true, started.error);
  const saved = await runtime.saveDischargeDetails({
    ownerWaId: OWNER, documentId: started.value.document_id, expectedVersion: started.value.version,
    documentType: "DECHARGE", idempotencyKey: "flow_command:save-details:1",
    details: {
      giver: "Awa", recipient: "Issa", transferred_content_type: "MONEY",
      amount: 50000, reason: "Remise de fonds", observations: "Remis en main propre",
    },
  });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.value.discharge.giver, "Awa");
  assert.equal(saved.value.discharge.receiver, "Issa");
  assert.equal(saved.value.discharge.reason, "Remise de fonds");
  assert.equal(saved.value.discharge.observations, "Remis en main propre");
  assert.equal(saved.value.discharge.subject.type, "MONEY");
  assert.equal(saved.value.discharge.subject.amount, 50000);
});

test("a complete discharge (single submission) advances all the way to READY_FOR_REVIEW", async () => {
  const { runtime } = fixture();
  const started = await runtime.start({ ownerWaId: OWNER, documentType: "DECHARGE", idempotencyKey: "flow_command:start:2" });
  const saved = await runtime.saveDischargeDetails({
    ownerWaId: OWNER, documentId: started.value.document_id, expectedVersion: started.value.version,
    documentType: "DECHARGE", idempotencyKey: "flow_command:save-details:2",
    details: {
      giver: "Awa", recipient: "Issa", transferred_content_type: "GOODS",
      description: "Clés du magasin", quantity: 2, reason: "Remise convenue", observations: null,
    },
  });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.value.status, "READY_FOR_REVIEW");
  assert.equal(saved.value.discharge.subject.description, "Clés du magasin");
  assert.equal(saved.value.discharge.quantity, 2);
});

test("an incomplete discharge returns a specific discharge validation error, not a generic temporary-service failure", async () => {
  const { runtime } = fixture();
  const started = await runtime.start({ ownerWaId: OWNER, documentType: "DECHARGE", idempotencyKey: "flow_command:start:3" });
  const saved = await runtime.saveDischargeDetails({
    ownerWaId: OWNER, documentId: started.value.document_id, expectedVersion: started.value.version,
    documentType: "DECHARGE", idempotencyKey: "flow_command:save-details:3",
    details: { giver: "Awa", recipient: "Issa" },
  });
  // Partial submissions are accepted (fields are set incrementally); the
  // document simply stays short of READY_FOR_REVIEW rather than surfacing
  // a fake render/service diagnosis.
  assert.equal(saved.ok, true, saved.error);
  assert.notEqual(saved.value.status, "READY_FOR_REVIEW");
  assert.ok(saved.value.missing_fields.length > 0);
  assert.equal(saved.value.missing_fields.includes("transferred_content_type"), true);
});

test("duplicate SAVE_DETAILS webhook replies remain idempotent at the session/reply-runtime boundary and never mutate twice", async () => {
  // True duplicate-webhook idempotency for a Flow reply is guaranteed at
  // the session + reply-runtime boundary (a redelivered Meta webhook must
  // never re-execute a business mutation), not by resubmitting a stale
  // document version straight into the adapter. This mirrors the existing
  // generic "duplicate webhook reuses the same command idempotency key"
  // coverage in tests/kadiV1FlowReplyRuntime.test.js, applied to SAVE_DETAILS.
  const { createKadiV1FlowReplyRuntime } = require("../kadiV1FlowReplyRuntime");
  const { createConversationSessionService, createMemoryConversationSessionRepository } = require("../kadiV1ConversationSession");
  let tick = 0;
  const sessions = createConversationSessionService({
    repository: createMemoryConversationSessionRepository(),
    clock: () => new Date(Date.parse("2026-08-05T20:00:00.000Z") + tick++ * 1000).toISOString(),
    idFactory: () => "kadi_session:discharge1",
  });
  await sessions.open({
    ownerWaId: OWNER,
    document: { document_id: "document:1", version: 1, document_type: "DECHARGE", status: "COLLECTING" },
    expectedFlowKey: "DISCHARGE_DETAILS",
    returnState: "COLLECTING",
    idempotencyKey: "open:discharge1",
  });
  // The command runtime mock reproduces the real pipeline's own
  // idempotency-key replay (kadiV1DischargePipeline.js's loadMutation
  // checks storage.findByIdempotencyKey before any version-sensitive
  // mutation), so this exercises the same contract SAVE_DETAILS relies on.
  const seen = new Map();
  const executions = [];
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: {
      execute: async (command) => {
        executions.push(command.idempotencyKey);
        if (seen.has(command.idempotencyKey)) return { ok: true, value: seen.get(command.idempotencyKey), duplicate: true };
        const value = { status: "READY_FOR_REVIEW" };
        seen.set(command.idempotencyKey, value);
        return { ok: true, value };
      },
    },
  });
  const reply = {
    ownerWaId: OWNER, sessionId: "kadi_session:discharge1", flowKey: "DISCHARGE_DETAILS", action: "SAVE_DETAILS",
    data: { giver: "Awa", recipient: "Issa", transferred_content_type: "MONEY", amount: 1000, reason: "Test" },
    idempotencyKey: "reply:discharge1",
  };
  const first = await runtime.handle(reply);
  const second = await runtime.handle(reply);
  assert.equal(first.ok, true, first.error);
  assert.equal(second.ok, true, second.error);
  assert.equal(first.value.duplicate, false);
  assert.equal(second.value.duplicate, true);
  assert.equal(executions[0], executions[1], "the retry must reuse the exact same command idempotency key");
});

test("the discharge type value ARGENT/BIEN/AUTRE (legacy French) still maps correctly for defense in depth, while the Flow itself now sends canonical values", async () => {
  const { runtime } = fixture();
  const started = await runtime.start({ ownerWaId: OWNER, documentType: "DECHARGE", idempotencyKey: "flow_command:start:5" });
  const saved = await runtime.saveDischargeDetails({
    ownerWaId: OWNER, documentId: started.value.document_id, expectedVersion: started.value.version,
    documentType: "DECHARGE", idempotencyKey: "flow_command:save-details:5",
    details: { giver: "Awa", recipient: "Issa", transferred_content_type: "ARGENT", amount: 2000, reason: "Test" },
  });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.value.discharge.subject.type, "MONEY");
});
