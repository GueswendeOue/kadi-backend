"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  validateActionPayload,
} = require("../kadiV1FlowReplyRuntime");
const { RECOVERABLE_TEXT } = require("../kadiV1WebhookRuntime");

// ── Identifiants historiques conservés ───────────────────────────────────────

test("identifiant historique 'unité' est toujours accepté sans unit_custom", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Ciment",
    quantity: 2,
    unit: "unité",
    unit_price: 5000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.unit, "unité");
  assert.equal(Object.hasOwn(result.value, "unit_custom"), false);
});

test("identifiant 'heure' est accepté", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Prestation",
    quantity: 4,
    unit: "heure",
    unit_price: 15000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.unit, "heure");
});

test("identifiant 'forfait' est accepté", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Installation",
    quantity: 1,
    unit: "forfait",
    unit_price: 50000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.unit, "forfait");
});

// ── unit === "autre" : unit_custom devient l'unité ───────────────────────────

test("unit 'autre' + unit_custom 'bobine' → unit devient 'bobine'", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Fil électrique",
    quantity: 3,
    unit: "autre",
    unit_custom: "bobine",
    unit_price: 8000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.unit, "bobine");
  assert.equal(Object.hasOwn(result.value, "unit_custom"), false, "unit_custom ne doit pas atteindre le domaine");
});

test("unit 'autre' + unit_custom avec espaces est nettoyé", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Produit",
    quantity: 1,
    unit: "autre",
    unit_custom: "  seau  ",
    unit_price: 500,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.unit, "seau");
  assert.equal(Object.hasOwn(result.value, "unit_custom"), false);
});

test("unit 'autre' + unit_custom trop long (>50) est refusé avant session", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Produit",
    quantity: 1,
    unit: "autre",
    unit_custom: "a".repeat(51),
    unit_price: 500,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_FLOW_REPLY_UNIT_CUSTOM_INVALID");
});

test("unit 'autre' + unit_custom vide (chaîne vide) est refusé avant session", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Produit",
    quantity: 1,
    unit: "autre",
    unit_custom: "",
    unit_price: 500,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_FLOW_REPLY_UNIT_CUSTOM_INVALID");
});

test("unit 'autre' + unit_custom espaces uniquement est refusé avant session", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Produit",
    quantity: 1,
    unit: "autre",
    unit_custom: "   ",
    unit_price: 500,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_FLOW_REPLY_UNIT_CUSTOM_INVALID");
});

test("unit 'autre' sans unit_custom est refusé", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Produit",
    quantity: 1,
    unit: "autre",
    unit_price: 500,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_FLOW_REPLY_UNIT_CUSTOM_REQUIRED");
});

test("unit_custom présent sans unit 'autre' est silencieusement supprimé", () => {
  const result = validateActionPayload("DOCUMENT_CONTENT", "ADD_CONTENT", {
    description: "Ciment",
    quantity: 2,
    unit: "sac",
    unit_custom: "ignoré",
    unit_price: 5000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.unit, "sac");
  assert.equal(Object.hasOwn(result.value, "unit_custom"), false);
});

// ── UPDATE_CONTENT : même logique ────────────────────────────────────────────

test("UPDATE_CONTENT avec unit 'autre' et unit_custom valide est accepté", () => {
  const result = validateActionPayload("EDIT_CONTENT", "UPDATE_CONTENT", {
    item_id: "item:1",
    unit: "autre",
    unit_custom: "rouleau",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.unit, "rouleau");
  assert.equal(Object.hasOwn(result.value, "unit_custom"), false);
});

// ── unit_custom ne passe jamais dans les données transmises ──────────────────

test("unit_custom n'atteint jamais le command runtime", async () => {
  const {
    createKadiV1FlowReplyRuntime,
  } = require("../kadiV1FlowReplyRuntime");
  const {
    createConversationSessionService,
    createMemoryConversationSessionRepository,
  } = require("../kadiV1ConversationSession");

  let tick = 0;
  const sessions = createConversationSessionService({
    repository: createMemoryConversationSessionRepository(),
    clock: () => new Date(Date.parse("2026-08-04T10:00:00.000Z") + tick++ * 1000).toISOString(),
    idFactory: () => "kadi_session:unit:custom:1",
  });
  await sessions.open({
    ownerWaId: "22670626055",
    document: { document_id: "document:1", version: 1, document_type: "FACTURE", status: "COLLECTING" },
    expectedFlowKey: "DOCUMENT_CONTENT",
    returnState: "COLLECTING",
    idempotencyKey: "open:unit:custom:1",
  });

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
    ownerWaId: "22670626055",
    sessionId: "kadi_session:unit:custom:1",
    flowKey: "DOCUMENT_CONTENT",
    action: "ADD_CONTENT",
    data: {
      description: "Câble",
      quantity: "2",
      unit: "autre",
      unit_custom: "bobine",
      unit_price: "8000",
    },
    idempotencyKey: "reply:unit:custom:1",
  });

  assert.equal(result.ok, true);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].data.unit, "bobine");
  assert.equal(Object.hasOwn(dispatched[0].data, "unit_custom"), false, "unit_custom ne doit pas atteindre le command runtime");
});

// ── Flow JSON : unités étendues dans DOCUMENT_CONTENT ────────────────────────

test("ARTICLE_FORM (écran d'article de DOCUMENT_CONTENT) contient 'unité', 'heure', 'forfait' et 'autre' dans unit_options", () => {
  const raw = fs.readFileSync(
    path.join(__dirname, "..", "flows", "v1_draft", "kadi_document_content_v1.json"),
    "utf8"
  );
  const flow = JSON.parse(raw);
  const screen = flow.screens.find((candidate) => candidate.id === "ARTICLE_FORM");
  assert.ok(screen, "l'écran ARTICLE_FORM doit exister dans kadi_document_content_v1.json");
  const units = screen.data.unit_options.__example__;
  const ids = units.map((u) => u.id);
  assert.equal(ids.includes("unité"), true, "'unité' manquant");
  assert.equal(ids.includes("heure"), true, "'heure' manquant");
  assert.equal(ids.includes("forfait"), true, "'forfait' manquant");
  assert.equal(ids.includes("autre"), true, "'autre' manquant");
  assert.ok(ids.length >= 10, `Trop peu d'options : ${ids.length}`);
});

test("EDIT_CONTENT contient 'unité', 'heure', 'forfait' et 'autre' dans unit_options", () => {
  const raw = fs.readFileSync(
    path.join(__dirname, "..", "flows", "v1_draft", "kadi_edit_content_v1.json"),
    "utf8"
  );
  const flow = JSON.parse(raw);
  const screen = flow.screens[0];
  const units = screen.data.unit_options.__example__;
  const ids = units.map((u) => u.id);
  assert.equal(ids.includes("unité"), true, "'unité' manquant");
  assert.equal(ids.includes("heure"), true, "'heure' manquant");
  assert.equal(ids.includes("forfait"), true, "'forfait' manquant");
  assert.equal(ids.includes("autre"), true, "'autre' manquant");
  assert.ok(ids.length >= 10, `Trop peu d'options : ${ids.length}`);
});

// ── Message d'erreur ─────────────────────────────────────────────────────────

test("le message d'erreur ne contient pas 'informations conservées'", () => {
  assert.doesNotMatch(RECOVERABLE_TEXT, /conserv/i);
  assert.match(RECOVERABLE_TEXT, /terminer cette étape/);
});
