"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildBrainRealShadowFlowContext,
  isBrainShadowDeterministicStep,
} = require("../kadiBrainFlowContext");

test("builds only the six bounded canonical context fields", () => {
  const session = Object.freeze({
    step: "doc_client",
    mode: "facture",
    lastDocDraft: Object.freeze({
      type: "facture",
      clientName: "PRIVATE_CLIENT",
      items: Object.freeze([{ price: 25000 }]),
    }),
    waId: "PRIVATE_WA_ID",
  });
  const before = JSON.stringify(session);
  const context = buildBrainRealShadowFlowContext(session, "voice");
  assert.deepEqual(context, {
    stepCategory: "DOCUMENT_COLLECTION",
    activeFlow: "INVOICE",
    activeDocumentType: "invoice",
    hasActiveDraft: true,
    expectedFieldNames: ["clientName"],
    messageType: "voice",
  });
  assert.equal(JSON.stringify(session), before);
  assert.equal(JSON.stringify(context).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(context).includes("25000"), false);
});

test("maps only canonical document and flow categories", () => {
  const cases = [
    [{ step: "idle" }, ["NONE", "NONE", null]],
    [{ step: "history_search" }, ["OTHER", "HISTORY", null]],
    [{ step: "profile" }, ["ONBOARDING", "PROFILE", null]],
    [{ step: "item_price", mode: "devis" }, [
      "DOCUMENT_COLLECTION", "QUOTE", "quote",
    ]],
    [{ step: "decharge_motif", mode: "decharge" }, [
      "DOCUMENT_COLLECTION", "DISCHARGE", "discharge",
    ]],
    [{ step: "unknown", mode: "PRIVATE_MODE" }, ["OTHER", "OTHER", null]],
  ];
  for (const [session, expected] of cases) {
    const context = buildBrainRealShadowFlowContext(session, "text");
    assert.deepEqual([
      context.stepCategory,
      context.activeFlow,
      context.activeDocumentType,
    ], expected);
  }
});

test("identifies only locally protected deterministic steps", () => {
  for (const step of [
    "recharge_proof", "pispi_pending", "doc_review",
    "doc_after_item_choice", "doc_subject_choice",
    "doc_client_phone_choice", "doc_already_generated",
    "smartblock_warning",
  ]) assert.equal(isBrainShadowDeterministicStep(step), true, step);
  for (const step of [
    null, "idle", "doc_client", "item_price", "decharge_motif", "history",
  ]) assert.equal(isBrainShadowDeterministicStep(step), false, String(step));
});
