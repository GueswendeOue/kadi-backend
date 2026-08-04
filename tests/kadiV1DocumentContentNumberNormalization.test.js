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
    idFactory: () => "kadi_session:content:1",
  });
}

async function openContentSession(service) {
  const opened = await service.open({
    ownerWaId: OWNER,
    document: {
      document_id: "document:1",
      version: 1,
      document_type: "FACTURE",
      status: "COLLECTING",
    },
    expectedFlowKey: "DOCUMENT_CONTENT",
    returnState: "COLLECTING",
    idempotencyKey: "open:content:1",
  });
  assert.equal(opened.ok, true);
  return opened.value;
}

// ── Payload réel WhatsApp Flow : chaînes numériques ──────────────────────────

test("real WhatsApp Flow payload with string quantity and unit_price is accepted and normalized", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Ciment",
    quantity: "2",
    unit: "unité",
    unit_price: "6000",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.quantity, 2);
  assert.equal(result.value.unit_price, 6000);
  assert.equal(result.value.description, "Ciment");
  assert.equal(result.value.unit, "unité");
});

test("integer quantity and unit_price are still accepted without change", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Sable",
    quantity: 5,
    unit: "sac",
    unit_price: 3500,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.quantity, 5);
  assert.equal(result.value.unit_price, 3500);
});

test("unit_price zero is accepted (article gratuit)", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Bonus",
    quantity: "1",
    unit_price: "0",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.quantity, 1);
  assert.equal(result.value.unit_price, 0);
});

test("UPDATE_CONTENT with string numbers is normalized for partial update", () => {
  const result = validateActionPayload("EDIT_CONTENT", "UPDATE_CONTENT", {
    item_id: "item:abc",
    quantity: "3",
    unit_price: "4500",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.quantity, 3);
  assert.equal(result.value.unit_price, 4500);
});

test("UPDATE_CONTENT without quantity or unit_price is accepted as partial update", () => {
  const result = validateActionPayload("EDIT_CONTENT", "UPDATE_CONTENT", {
    item_id: "item:abc",
    description: "Ciment modifié",
  });
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.value, "quantity"), false);
  assert.equal(Object.hasOwn(result.value, "unit_price"), false);
});

// ── Rejets : quantity invalide ────────────────────────────────────────────────

test("empty string quantity is rejected before session consumption", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Ciment",
    quantity: "",
    unit_price: "6000",
  });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_FLOW_REPLY_QUANTITY_INVALID" });
});

test("non-numeric string quantity is rejected", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Ciment",
    quantity: "deux",
    unit_price: 6000,
  });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_FLOW_REPLY_QUANTITY_INVALID" });
});

test("zero quantity string is rejected", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Ciment",
    quantity: "0",
    unit_price: 6000,
  });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_FLOW_REPLY_QUANTITY_INVALID" });
});

test("zero integer quantity is rejected", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Ciment",
    quantity: 0,
    unit_price: 6000,
  });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_FLOW_REPLY_QUANTITY_INVALID" });
});

test("negative integer quantity is rejected", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Ciment",
    quantity: -1,
    unit_price: 6000,
  });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_FLOW_REPLY_QUANTITY_INVALID" });
});

test("decimal string quantity is rejected", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Ciment",
    quantity: "1.5",
    unit_price: 6000,
  });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_FLOW_REPLY_QUANTITY_INVALID" });
});

// ── Rejets : unit_price invalide ─────────────────────────────────────────────

test("empty string unit_price is rejected", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Ciment",
    quantity: 2,
    unit_price: "",
  });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_FLOW_REPLY_UNIT_PRICE_INVALID" });
});

test("non-numeric string unit_price is rejected", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Ciment",
    quantity: 2,
    unit_price: "gratuit",
  });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_FLOW_REPLY_UNIT_PRICE_INVALID" });
});

test("negative integer unit_price is rejected", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Ciment",
    quantity: 2,
    unit_price: -1,
  });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_FLOW_REPLY_UNIT_PRICE_INVALID" });
});

test("negative string unit_price is rejected", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Ciment",
    quantity: 2,
    unit_price: "-500",
  });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_FLOW_REPLY_UNIT_PRICE_INVALID" });
});

// ── Session non consommée sur payload invalide ───────────────────────────────

test("invalid string quantity does not consume the session", async () => {
  const sessions = makeSessionService();
  await openContentSession(sessions);

  let commandCalled = false;
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: {
      execute: async () => {
        commandCalled = true;
        return { ok: true, value: { status: "COLLECTING" } };
      },
    },
  });

  const result = await runtime.handle({
    ownerWaId: OWNER,
    sessionId: "kadi_session:content:1",
    flowKey: "DOCUMENT_CONTENT",
    action: "ADD_CONTENT",
    data: { description: "Ciment", quantity: "abc", unit_price: 6000 },
    idempotencyKey: "reply:content:invalid:1",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_FLOW_REPLY_QUANTITY_INVALID");
  assert.equal(commandCalled, false, "command runtime must not be called on invalid quantity");
});

// ── Intégration : valeurs normalisées transmises au command runtime ───────────

test("string quantity and unit_price are normalized before reaching the command runtime", async () => {
  const sessions = makeSessionService();
  await openContentSession(sessions);

  const dispatched = [];
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: {
      execute: async (command) => {
        dispatched.push(command);
        return { ok: true, value: { status: "COLLECTING" } };
      },
    },
  });

  const result = await runtime.handle({
    ownerWaId: OWNER,
    sessionId: "kadi_session:content:1",
    flowKey: "DOCUMENT_CONTENT",
    action: "ADD_CONTENT",
    data: {
      description: "Ciment",
      quantity: "2",
      unit: "unité",
      unit_price: "6000",
    },
    idempotencyKey: "reply:content:valid:1",
  });

  assert.equal(result.ok, true);
  assert.equal(dispatched.length, 1);
  assert.equal(typeof dispatched[0].data.quantity, "number");
  assert.equal(dispatched[0].data.quantity, 2);
  assert.equal(typeof dispatched[0].data.unit_price, "number");
  assert.equal(dispatched[0].data.unit_price, 6000);
});
