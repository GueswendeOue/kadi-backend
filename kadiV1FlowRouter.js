"use strict";

const { DOCUMENT_STATES } = require("./kadiV1DocumentStateMachine");

const DOCUMENT_TYPES = Object.freeze(["FACTURE", "DEVIS", "RECU", "DECHARGE"]);
const FLOW_KEYS = Object.freeze([
  "ONBOARDING",
  "MENU",
  "DOCUMENT_TYPE",
  "DOCUMENT_CLIENT",
  "DOCUMENT_CONTENT",
  "ARTICLE_FORM",
  "DOCUMENT_OPTIONS",
  "DOCUMENT_REVIEW",
  "EDIT_CLIENT",
  "EDIT_CONTENT",
  "EDIT_OPTIONS",
  "DOCUMENT_PREVIEW",
  "GENERATION_CONFIRMATION",
  "RECHARGE",
  "HISTORY_SEARCH",
  "DISCHARGE_DETAILS",
]);
const FLOW_INTENTS = Object.freeze([
  "ONBOARDING",
  "MENU",
  "PREPARE_DOCUMENT",
  "COLLECT_CLIENT",
  "COLLECT_CONTENT",
  "COLLECT_OPTIONS",
  "REVIEW",
  "EDIT_CLIENT",
  "EDIT_CONTENT",
  "EDIT_OPTIONS",
  "PREVIEW",
  "CONFIRM_GENERATION",
  "RECHARGE",
  "HISTORY_SEARCH",
  "DISCHARGE_DETAILS",
]);

const COLLECTION_STATES = new Set(["COLLECTING", "INCOMPLETE"]);
const REVIEW_STATES = new Set(["READY_FOR_REVIEW", "VERIFIED"]);
const EDITABLE_STATES = new Set([
  "COLLECTING",
  "INCOMPLETE",
  "READY_FOR_REVIEW",
  "VERIFIED",
  "PREVIEW_READY",
  "COST_CALCULATED",
  "AWAITING_GENERATION_CONFIRMATION",
  "RECHARGE_REQUIRED",
]);
const PREVIEW_STATES = new Set([
  "VERIFIED",
  "PREVIEW_READY",
  "COST_CALCULATED",
  "AWAITING_GENERATION_CONFIRMATION",
]);
const GENERATION_CONFIRMATION_STATES = new Set([
  "COST_CALCULATED",
  "AWAITING_GENERATION_CONFIRMATION",
]);

function fail(error) {
  return { ok: false, error };
}

function success(value) {
  return { ok: true, value };
}

function validateDocumentContext({ documentType, documentState }) {
  if (!DOCUMENT_TYPES.includes(documentType)) return fail("KADI_V1_DOCUMENT_TYPE_INVALID");
  if (!DOCUMENT_STATES.includes(documentState)) return fail("KADI_V1_DOCUMENT_STATE_INVALID");
  return success(true);
}

function resolveFlowKey({ intent, documentType = null, documentState = null, ownerMatched = true } = {}) {
  if (ownerMatched !== true) return fail("KADI_V1_OWNER_MISMATCH");
  if (!FLOW_INTENTS.includes(intent)) return fail("KADI_V1_FLOW_INTENT_UNKNOWN");

  if (intent === "ONBOARDING") return success("ONBOARDING");
  if (intent === "MENU") return success("MENU");
  if (intent === "PREPARE_DOCUMENT") return success("DOCUMENT_TYPE");
  if (intent === "HISTORY_SEARCH") return success("HISTORY_SEARCH");
  if (intent === "RECHARGE" && documentType == null && documentState == null) return success("RECHARGE");

  const context = validateDocumentContext({ documentType, documentState });
  if (!context.ok) return context;

  if (intent === "DISCHARGE_DETAILS") {
    return documentType === "DECHARGE" && EDITABLE_STATES.has(documentState)
      ? success("DISCHARGE_DETAILS")
      : fail("KADI_V1_FLOW_STATE_INCOMPATIBLE");
  }

  if (intent === "COLLECT_CLIENT") {
    if (!COLLECTION_STATES.has(documentState)) return fail("KADI_V1_FLOW_STATE_INCOMPATIBLE");
    return documentType === "DECHARGE" ? success("DISCHARGE_DETAILS") : success("DOCUMENT_CLIENT");
  }

  if (intent === "COLLECT_CONTENT") {
    if (!COLLECTION_STATES.has(documentState)) return fail("KADI_V1_FLOW_STATE_INCOMPATIBLE");
    return documentType === "DECHARGE" ? success("DISCHARGE_DETAILS") : success("DOCUMENT_CONTENT");
  }

  if (intent === "COLLECT_OPTIONS") {
    if (!COLLECTION_STATES.has(documentState)) return fail("KADI_V1_FLOW_STATE_INCOMPATIBLE");
    return documentType === "DECHARGE" ? success("DISCHARGE_DETAILS") : success("DOCUMENT_OPTIONS");
  }

  if (intent === "REVIEW") {
    return REVIEW_STATES.has(documentState)
      ? success("DOCUMENT_REVIEW")
      : fail("KADI_V1_FLOW_STATE_INCOMPATIBLE");
  }

  if (["EDIT_CLIENT", "EDIT_CONTENT", "EDIT_OPTIONS"].includes(intent)) {
    if (!EDITABLE_STATES.has(documentState)) return fail("KADI_V1_FLOW_STATE_INCOMPATIBLE");
    if (documentType === "DECHARGE") return success("DISCHARGE_DETAILS");
    return success(intent);
  }

  if (intent === "PREVIEW") {
    return PREVIEW_STATES.has(documentState)
      ? success("DOCUMENT_PREVIEW")
      : fail("KADI_V1_FLOW_STATE_INCOMPATIBLE");
  }

  if (intent === "CONFIRM_GENERATION") {
    return GENERATION_CONFIRMATION_STATES.has(documentState)
      ? success("GENERATION_CONFIRMATION")
      : fail("KADI_V1_FLOW_STATE_INCOMPATIBLE");
  }

  if (intent === "RECHARGE") {
    return documentState === "RECHARGE_REQUIRED"
      ? success("RECHARGE")
      : fail("KADI_V1_FLOW_STATE_INCOMPATIBLE");
  }

  return fail("KADI_V1_FLOW_ROUTE_UNRESOLVED");
}

function resolveConfiguredFlow({ route, flowIds } = {}) {
  if (!route?.ok || !FLOW_KEYS.includes(route.value)) return fail("KADI_V1_FLOW_ROUTE_INVALID");
  const flowId = flowIds?.[route.value];
  if (typeof flowId !== "string" || !/^\d{5,30}$/.test(flowId)) return fail("KADI_V1_FLOW_ID_MISSING");
  return success(Object.freeze({ flow_key: route.value, flow_id: flowId }));
}

module.exports = {
  DOCUMENT_TYPES,
  FLOW_INTENTS,
  FLOW_KEYS,
  resolveConfiguredFlow,
  resolveFlowKey,
};
