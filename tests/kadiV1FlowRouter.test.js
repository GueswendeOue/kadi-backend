"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FLOW_KEYS,
  resolveConfiguredFlow,
  resolveFlowKey,
} = require("../kadiV1FlowRouter");

test("le routeur expose toutes les clés logiques V1 attendues", () => {
  assert.deepEqual(FLOW_KEYS, [
    "ONBOARDING", "MENU", "DOCUMENT_TYPE", "DOCUMENT_CLIENT", "DOCUMENT_CONTENT",
    "ARTICLE_FORM", "DOCUMENT_OPTIONS", "DOCUMENT_REVIEW", "EDIT_CLIENT", "EDIT_CONTENT", "EDIT_OPTIONS",
    "DOCUMENT_PREVIEW", "GENERATION_CONFIRMATION", "RECHARGE", "HISTORY_SEARCH", "DISCHARGE_DETAILS",
  ]);
});

test("les routes générales ne nécessitent aucun document", () => {
  assert.equal(resolveFlowKey({ intent: "ONBOARDING" }).value, "ONBOARDING");
  assert.equal(resolveFlowKey({ intent: "MENU" }).value, "MENU");
  assert.equal(resolveFlowKey({ intent: "PREPARE_DOCUMENT" }).value, "DOCUMENT_TYPE");
  assert.equal(resolveFlowKey({ intent: "HISTORY_SEARCH" }).value, "HISTORY_SEARCH");
  assert.equal(resolveFlowKey({ intent: "RECHARGE" }).value, "RECHARGE");
});

test("facture, devis et reçu utilisent les Flows documentaires partagés", () => {
  for (const documentType of ["FACTURE", "DEVIS", "RECU"]) {
    assert.equal(resolveFlowKey({ intent: "COLLECT_CLIENT", documentType, documentState: "COLLECTING" }).value, "DOCUMENT_CLIENT");
    assert.equal(resolveFlowKey({ intent: "COLLECT_CONTENT", documentType, documentState: "INCOMPLETE" }).value, "DOCUMENT_CONTENT");
    assert.equal(resolveFlowKey({ intent: "COLLECT_OPTIONS", documentType, documentState: "COLLECTING" }).value, "DOCUMENT_OPTIONS");
    assert.equal(resolveFlowKey({ intent: "REVIEW", documentType, documentState: "READY_FOR_REVIEW" }).value, "DOCUMENT_REVIEW");
  }
});

test("la décharge conserve son Flow métier propre", () => {
  for (const intent of ["COLLECT_CLIENT", "COLLECT_CONTENT", "COLLECT_OPTIONS", "EDIT_CLIENT", "EDIT_CONTENT", "EDIT_OPTIONS", "DISCHARGE_DETAILS"]) {
    const state = intent.startsWith("EDIT_") ? "VERIFIED" : "COLLECTING";
    assert.equal(resolveFlowKey({ intent, documentType: "DECHARGE", documentState: state }).value, "DISCHARGE_DETAILS");
  }
});

test("aperçu, confirmation et recharge respectent l'état métier", () => {
  assert.equal(resolveFlowKey({ intent: "PREVIEW", documentType: "FACTURE", documentState: "VERIFIED" }).value, "DOCUMENT_PREVIEW");
  assert.equal(resolveFlowKey({ intent: "CONFIRM_GENERATION", documentType: "FACTURE", documentState: "COST_CALCULATED" }).value, "GENERATION_CONFIRMATION");
  assert.equal(resolveFlowKey({ intent: "RECHARGE", documentType: "FACTURE", documentState: "RECHARGE_REQUIRED" }).value, "RECHARGE");
  assert.equal(resolveFlowKey({ intent: "PREVIEW", documentType: "FACTURE", documentState: "COLLECTING" }).error, "KADI_V1_FLOW_STATE_INCOMPATIBLE");
  assert.equal(resolveFlowKey({ intent: "CONFIRM_GENERATION", documentType: "FACTURE", documentState: "VERIFIED" }).error, "KADI_V1_FLOW_STATE_INCOMPATIBLE");
});

test("les documents livrés ne peuvent pas être modifiés", () => {
  for (const intent of ["EDIT_CLIENT", "EDIT_CONTENT", "EDIT_OPTIONS"]) {
    assert.equal(resolveFlowKey({ intent, documentType: "FACTURE", documentState: "DELIVERED" }).error, "KADI_V1_FLOW_STATE_INCOMPATIBLE");
  }
});

test("le routeur échoue fermé sur propriétaire, type, état ou intention invalides", () => {
  assert.equal(resolveFlowKey({ intent: "MENU", ownerMatched: false }).error, "KADI_V1_OWNER_MISMATCH");
  assert.equal(resolveFlowKey({ intent: "COLLECT_CLIENT", documentType: "PROFORMA", documentState: "COLLECTING" }).error, "KADI_V1_DOCUMENT_TYPE_INVALID");
  assert.equal(resolveFlowKey({ intent: "COLLECT_CLIENT", documentType: "FACTURE", documentState: "UNKNOWN" }).error, "KADI_V1_DOCUMENT_STATE_INVALID");
  assert.equal(resolveFlowKey({ intent: "UNKNOWN" }).error, "KADI_V1_FLOW_INTENT_UNKNOWN");
});

test("la résolution Meta exige une clé logique valide et un ID configuré", () => {
  const route = resolveFlowKey({ intent: "MENU" });
  assert.deepEqual(resolveConfiguredFlow({ route, flowIds: {} }), { ok: false, error: "KADI_V1_FLOW_ID_MISSING" });
  assert.deepEqual(resolveConfiguredFlow({ route, flowIds: { MENU: "123456789" } }), {
    ok: true,
    value: { flow_key: "MENU", flow_id: "123456789" },
  });
});
