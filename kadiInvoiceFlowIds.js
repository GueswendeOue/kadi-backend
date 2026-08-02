"use strict";

const { INVOICE_FLOW_TARGET_SCREENS, validTargetScreen } = require("./kadiInvoiceFlowSession");

const INVOICE_FLOW_ID_ENV_BY_SCREEN = Object.freeze({
  CLIENT: "KADI_INVOICE_CLIENT_FLOW_ID",
  ARTICLE_ENTRY: "KADI_INVOICE_ARTICLE_ENTRY_FLOW_ID",
  OPTIONS: "KADI_INVOICE_OPTIONS_FLOW_ID",
  REVIEW_INVOICE_DRAFT: "KADI_INVOICE_REVIEW_FLOW_ID",
  EDIT_CLIENT: "KADI_INVOICE_EDIT_CLIENT_FLOW_ID",
  EDIT_ITEMS: "KADI_INVOICE_EDIT_ITEMS_FLOW_ID",
  EDIT_OPTIONS: "KADI_INVOICE_EDIT_OPTIONS_FLOW_ID",
});

function buildInvoiceFlowIdMap(env = {}) {
  return Object.freeze(Object.fromEntries(
    INVOICE_FLOW_TARGET_SCREENS.map((screen) => {
      const value = env[INVOICE_FLOW_ID_ENV_BY_SCREEN[screen]];
      return [screen, typeof value === "string" ? value.trim() : ""];
    })
  ));
}

function validateInvoiceFlowIdMap(flowIds) {
  if (!flowIds || typeof flowIds !== "object" || Array.isArray(flowIds)) return false;
  const keys = Object.keys(flowIds);
  if (keys.length !== INVOICE_FLOW_TARGET_SCREENS.length || keys.some((screen) => !validTargetScreen(screen))) return false;
  const ids = INVOICE_FLOW_TARGET_SCREENS.map((screen) => flowIds[screen]);
  return ids.every((id) => typeof id === "string" && /^\d{1,40}$/.test(id))
    && new Set(ids).size === INVOICE_FLOW_TARGET_SCREENS.length;
}

function resolveInvoiceFlowId(flowIds, targetScreen) {
  if (!validTargetScreen(targetScreen)) throw new TypeError("FLOW_TARGET_SCREEN_INVALID");
  const flowId = flowIds?.[targetScreen];
  if (typeof flowId !== "string" || !/^\d{1,40}$/.test(flowId)) {
    throw new TypeError("FLOW_ID_NOT_CONFIGURED");
  }
  if (!validateInvoiceFlowIdMap(flowIds)) throw new TypeError("FLOW_ID_MAP_INVALID");
  return flowId;
}

module.exports = {
  INVOICE_FLOW_ID_ENV_BY_SCREEN,
  buildInvoiceFlowIdMap,
  resolveInvoiceFlowId,
  validateInvoiceFlowIdMap,
};
