"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getSession,
  resetSession,
  clearCurrentFlowSession,
} = require("../kadiState");

test("clearCurrentFlowSession exits current flow without clearing pending topup ids", () => {
  const waId = "22670000000";
  resetSession(waId);

  const session = getSession(waId);
  session.step = "doc_client";
  session.mode = "devis";
  session.factureKind = "proforma";
  session.lastDocDraft = { type: "devis" };
  session.itemDraft = { label: "porte" };
  session.pendingSmartBlockText = "2 portes à 25000";
  session.pendingPdfAfterRecharge = true;
  session.pendingOcrMediaId = "media-id";
  session.intentPendingItemLabel = "porte";
  session.pendingImage = { mediaId: "image-id" };
  session.lastImagePurpose = "ocr";
  session.dechargeStep = "amount";
  session.dechargeDraft = { client: "Moussa" };
  session.subjectReturnTarget = "finish_preview";
  session.clientPhoneReturnTarget = "finish_preview";
  session.pendingTopupId = "topup-id";
  session.pendingTopupReference = "topup-ref";

  clearCurrentFlowSession(session);

  assert.equal(session.step, "idle");
  assert.equal(session.mode, null);
  assert.equal(session.factureKind, null);
  assert.equal(session.lastDocDraft, null);
  assert.equal(session.itemDraft, null);
  assert.equal(session.pendingSmartBlockText, null);
  assert.equal(session.pendingPdfAfterRecharge, null);
  assert.equal(session.pendingOcrMediaId, null);
  assert.equal(session.intentPendingItemLabel, null);
  assert.equal(session.pendingImage, null);
  assert.equal(session.lastImagePurpose, null);
  assert.equal(session.dechargeStep, null);
  assert.equal(session.dechargeDraft, null);
  assert.equal(session.subjectReturnTarget, null);
  assert.equal(session.clientPhoneReturnTarget, null);
  assert.equal(session.pendingTopupId, "topup-id");
  assert.equal(session.pendingTopupReference, "topup-ref");

  resetSession(waId);
});
