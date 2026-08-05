"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateActionPayload,
  FLOW_ACTIONS,
} = require("../kadiV1FlowReplyRuntime");
const {
  validateCommand,
  ACTIONS,
} = require("../kadiV1FlowCommandRuntime");

// ── FLOW_ACTIONS : FINISH_CONTENT reconnu depuis DOCUMENT_CONTENT ────────────

test("FINISH_CONTENT est dans FLOW_ACTIONS.DOCUMENT_CONTENT", () => {
  assert.equal(FLOW_ACTIONS.DOCUMENT_CONTENT.includes("FINISH_CONTENT"), true);
});

test("FINISH_CONTENT est dans ACTIONS du command runtime", () => {
  assert.equal(ACTIONS.includes("FINISH_CONTENT"), true);
});

// ── validateActionPayload : FINISH_CONTENT passe avec données vides ───────────

test("FINISH_CONTENT avec données vides est accepté", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "FINISH_CONTENT", {});
  assert.equal(result.ok, true);
});

test("FINISH_CONTENT avec champs de formulaire vides (retour du Flow) est accepté", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "FINISH_CONTENT", {
    description: "",
    quantity: "",
    unit: "",
    unit_price: "",
  });
  assert.equal(result.ok, true);
});

test("FINISH_CONTENT avec champs de formulaire remplis est accepté", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "FINISH_CONTENT", {
    description: "Ciment",
    quantity: "2",
    unit: "sac",
    unit_price: "5000",
  });
  assert.equal(result.ok, true);
});

// ── validateActionPayload : ADD_CONTENT strict sur les champs requis ──────────

test("ADD_CONTENT sans description est rejeté avant consommation de session", () => {
  const result = validateActionPayload("ARTICLE_FORM", "ADD_CONTENT", {
    description: "",
    quantity: "2",
    unit_price: "5000",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_FLOW_REPLY_DESCRIPTION_REQUIRED");
});

test("ADD_CONTENT avec description espaces uniquement est rejeté", () => {
  const result = validateActionPayload("ARTICLE_FORM", "ADD_CONTENT", {
    description: "   ",
    quantity: 1,
    unit_price: 1000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_FLOW_REPLY_DESCRIPTION_REQUIRED");
});

test("ADD_CONTENT sans quantity est rejeté avant consommation de session", () => {
  const result = validateActionPayload("ARTICLE_FORM", "ADD_CONTENT", {
    description: "Ciment",
    unit_price: "5000",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_FLOW_REPLY_QUANTITY_INVALID");
});

test("ADD_CONTENT sans unit_price est rejeté avant consommation de session", () => {
  const result = validateActionPayload("ARTICLE_FORM", "ADD_CONTENT", {
    description: "Ciment",
    quantity: "2",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_FLOW_REPLY_UNIT_PRICE_INVALID");
});

test("ADD_CONTENT valide est toujours accepté et normalisé", () => {
  const result = validateActionPayload("ARTICLE_FORM", "ADD_CONTENT", {
    description: "Ciment",
    quantity: "2",
    unit: "sac",
    unit_price: "5000",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.quantity, 2);
  assert.equal(result.value.unit_price, 5000);
});

// ── validateCommand : FINISH_CONTENT valide ───────────────────────────────────

test("validateCommand accepte FINISH_CONTENT depuis DOCUMENT_CONTENT", () => {
  const result = validateCommand({
    ownerWaId: "22670626055",
    flowKey: "DOCUMENT_CONTENT",
    action: "FINISH_CONTENT",
    data: { description: "", quantity: "", unit: "", unit_price: "" },
    idempotencyKey: "flow_command:reply:finish:1",
    documentContext: {
      document_id: "document:1",
      document_version: 2,
      document_type: "FACTURE",
      document_state: "COLLECTING",
      return_state: "COLLECTING",
    },
  });
  assert.equal(result.ok, true);
});

// ── Intégration reply runtime : session consommée uniquement si valide ────────

const {
  createKadiV1FlowReplyRuntime,
} = require("../kadiV1FlowReplyRuntime");
const {
  createConversationSessionService,
  createMemoryConversationSessionRepository,
} = require("../kadiV1ConversationSession");

const OWNER = "22670626055";
let tick = 0;

function makeSessionService(id = "kadi_session:content:finish:1") {
  tick = 0;
  return createConversationSessionService({
    repository: createMemoryConversationSessionRepository(),
    clock: () => new Date(Date.parse("2026-08-04T10:00:00.000Z") + tick++ * 1000).toISOString(),
    idFactory: () => id,
  });
}

async function openContentSession(service, sessionId = "kadi_session:content:finish:1", overrides = {}) {
  const opened = await service.open({
    ownerWaId: OWNER,
    document: {
      document_id: "document:1",
      version: 2,
      document_type: "FACTURE",
      status: "COLLECTING",
    },
    expectedFlowKey: "DOCUMENT_CONTENT",
    returnState: "COLLECTING",
    idempotencyKey: `open:content:${sessionId}`,
    ...overrides,
  });
  assert.equal(opened.ok, true);
  return opened.value;
}

test("FINISH_CONTENT avec articles transmet la commande au command runtime", async () => {
  const sessions = makeSessionService();
  await openContentSession(sessions);

  const dispatched = [];
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: {
      execute: async (command) => {
        dispatched.push(command);
        return {
          ok: true,
          value: {
            document_id: "document:1",
            version: 3,
            document_type: "FACTURE",
            status: "COLLECTING",
            items: [{ item_id: "item:1", description: "Ciment", quantity: 2, unit_price: 5000 }],
          },
        };
      },
    },
  });

  const result = await runtime.handle({
    ownerWaId: OWNER,
    sessionId: "kadi_session:content:finish:1",
    flowKey: "DOCUMENT_CONTENT",
    action: "FINISH_CONTENT",
    data: { description: "", quantity: "", unit: "", unit_price: "" },
    idempotencyKey: "reply:finish:1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.action, "FINISH_CONTENT");
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].action, "FINISH_CONTENT");
});

test("ADD_CONTENT vide ne consomme pas la session", async () => {
  const sessions = makeSessionService("kadi_session:content:empty:1");
  await openContentSession(sessions, "kadi_session:content:empty:1", { expectedFlowKey: "ARTICLE_FORM" });

  let commandCalled = false;
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: {
      execute: async () => {
        commandCalled = true;
        return { ok: true, value: {} };
      },
    },
  });

  const result = await runtime.handle({
    ownerWaId: OWNER,
    sessionId: "kadi_session:content:empty:1",
    flowKey: "ARTICLE_FORM",
    action: "ADD_CONTENT",
    data: { description: "", quantity: "2", unit_price: "5000" },
    idempotencyKey: "reply:add:empty:1",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_FLOW_REPLY_DESCRIPTION_REQUIRED");
  assert.equal(commandCalled, false, "command runtime ne doit pas être appelé");
});
