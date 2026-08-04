"use strict";

const OWNER_PATTERN = /^\d{8,20}$/;
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const IDEMPOTENCY_PATTERN = /^flow_command:[A-Za-z0-9:_.-]{1,187}$/;
const DOCUMENT_TYPES = Object.freeze(["FACTURE", "DEVIS", "RECU", "DECHARGE"]);
const FLOW_KEYS = Object.freeze([
  "ONBOARDING", "MENU", "DOCUMENT_TYPE", "DOCUMENT_CLIENT", "DOCUMENT_CONTENT",
  "DOCUMENT_OPTIONS", "DOCUMENT_REVIEW", "EDIT_CLIENT", "EDIT_CONTENT", "EDIT_OPTIONS",
  "DOCUMENT_PREVIEW", "GENERATION_CONFIRMATION", "RECHARGE", "HISTORY_SEARCH", "DISCHARGE_DETAILS",
]);
const ACTIONS = Object.freeze([
  "START", "PREPARE_DOCUMENT", "HISTORY_SEARCH", "BALANCE", "HELP", "SELECT_DOCUMENT_TYPE",
  "SAVE_CLIENT", "ADD_CONTENT", "UPDATE_CONTENT", "REMOVE_CONTENT", "SAVE_OPTIONS", "VERIFY",
  "EDIT_CLIENT", "EDIT_CONTENT", "EDIT_OPTIONS", "CANCEL", "EDIT", "PREPARE_PDF",
  "SAVE_FOR_LATER", "CONFIRM_GENERATION", "SELECT_PACK", "CHECK_PAYMENT", "SEARCH",
  "OPEN_DOCUMENT", "SAVE_DETAILS",
]);

function ok(value) { return { ok: true, value }; }
function fail(error) { return { ok: false, error }; }
function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function assertPort(target, methods, name) {
  if (!target || typeof target !== "object") throw new TypeError(`${name}_REQUIRED`);
  for (const method of methods) if (typeof target[method] !== "function") throw new TypeError(`${name}_METHOD_REQUIRED:${method}`);
  return target;
}
function normalizeResult(result, error) {
  return result && typeof result === "object" && typeof result.ok === "boolean" ? result : fail(error);
}
function validateDocumentContext(context) {
  if (!isPlainObject(context)) return fail("KADI_V1_FLOW_COMMAND_DOCUMENT_REQUIRED");
  if (!ID_PATTERN.test(context.document_id || "")) return fail("KADI_V1_FLOW_COMMAND_DOCUMENT_ID_INVALID");
  if (!Number.isSafeInteger(context.document_version) || context.document_version < 1) return fail("KADI_V1_FLOW_COMMAND_DOCUMENT_VERSION_INVALID");
  if (!DOCUMENT_TYPES.includes(context.document_type)) return fail("KADI_V1_FLOW_COMMAND_DOCUMENT_TYPE_INVALID");
  if (typeof context.document_state !== "string" || !context.document_state) return fail("KADI_V1_FLOW_COMMAND_DOCUMENT_STATE_INVALID");
  return ok(Object.freeze(structuredClone(context)));
}
function validateCommand(command) {
  if (!isPlainObject(command)) return fail("KADI_V1_FLOW_COMMAND_INVALID");
  if (!OWNER_PATTERN.test(command.ownerWaId || "")) return fail("KADI_V1_FLOW_COMMAND_OWNER_INVALID");
  if (!FLOW_KEYS.includes(command.flowKey)) return fail("KADI_V1_FLOW_COMMAND_FLOW_KEY_INVALID");
  if (!ACTIONS.includes(command.action)) return fail("KADI_V1_FLOW_COMMAND_ACTION_INVALID");
  if (!isPlainObject(command.data)) return fail("KADI_V1_FLOW_COMMAND_DATA_INVALID");
  if (!IDEMPOTENCY_PATTERN.test(command.idempotencyKey || "")) return fail("KADI_V1_FLOW_COMMAND_IDEMPOTENCY_INVALID");
  return ok(true);
}

function createKadiV1FlowCommandRuntime({
  onboardingRuntime,
  documentRuntime,
  previewRuntime,
  generationRuntime,
  rechargeRuntime,
  historyRuntime,
  walletRuntime,
} = {}) {
  const onboarding = assertPort(onboardingRuntime, ["continueOnboarding"], "KADI_V1_ONBOARDING_COMMAND_RUNTIME");
  const documents = assertPort(documentRuntime, [
    "start", "setClient", "addContent", "updateContent", "removeContent", "setOptions",
    "verify", "beginEdit", "saveForLater", "saveDischargeDetails", "cancel",
  ], "KADI_V1_DOCUMENT_COMMAND_RUNTIME");
  const previews = assertPort(previewRuntime, ["prepare"], "KADI_V1_PREVIEW_COMMAND_RUNTIME");
  const generation = assertPort(generationRuntime, ["confirm"], "KADI_V1_GENERATION_COMMAND_RUNTIME");
  const recharge = assertPort(rechargeRuntime, ["selectPack", "checkPayment", "cancel"], "KADI_V1_RECHARGE_COMMAND_RUNTIME");
  const history = assertPort(historyRuntime, ["search", "open"], "KADI_V1_HISTORY_COMMAND_RUNTIME");
  const wallet = assertPort(walletRuntime, ["getBalance"], "KADI_V1_WALLET_COMMAND_RUNTIME");

  async function call(port, method, payload, error) {
    try { return normalizeResult(await port[method](payload), error); }
    catch { return fail(error); }
  }

  async function execute(command) {
    const checked = validateCommand(command);
    if (!checked.ok) return checked;
    const base = Object.freeze({ ownerWaId: command.ownerWaId, idempotencyKey: command.idempotencyKey });
    const data = command.data;

    if (command.action === "START") {
      return call(onboarding, "continueOnboarding", {
        ...base,
        profileData: structuredClone(data),
      }, "KADI_V1_ONBOARDING_CONTINUE_FAILED");
    }
    if (command.action === "HELP") return ok(Object.freeze({ business_action: "SHOW_HELP" }));
    if (command.action === "HISTORY_SEARCH") return ok(Object.freeze({ business_action: "OPEN_HISTORY", next_flow_key: "HISTORY_SEARCH" }));
    if (command.action === "BALANCE") {
      return call(wallet, "getBalance", { ownerWaId: command.ownerWaId }, "KADI_V1_BALANCE_READ_FAILED");
    }
    if (command.action === "PREPARE_DOCUMENT" && data.document_type == null) {
      return ok(Object.freeze({ business_action: "SELECT_DOCUMENT_TYPE", next_flow_key: "DOCUMENT_TYPE" }));
    }
    if (["PREPARE_DOCUMENT", "SELECT_DOCUMENT_TYPE"].includes(command.action)) {
      if (!DOCUMENT_TYPES.includes(data.document_type)) return fail("KADI_V1_FLOW_COMMAND_DOCUMENT_TYPE_INVALID");
      return call(documents, "start", { ...base, documentType: data.document_type }, "KADI_V1_DOCUMENT_START_FAILED");
    }
    if (command.action === "SEARCH") {
      return call(history, "search", { ownerWaId: command.ownerWaId, criteria: structuredClone(data) }, "KADI_V1_HISTORY_SEARCH_FAILED");
    }
    if (command.action === "OPEN_DOCUMENT") {
      if (!ID_PATTERN.test(data.document_id || "")) return fail("KADI_V1_HISTORY_DOCUMENT_ID_INVALID");
      return call(history, "open", { ownerWaId: command.ownerWaId, documentId: data.document_id }, "KADI_V1_HISTORY_OPEN_FAILED");
    }
    if (command.action === "SELECT_PACK") {
      if (!ID_PATTERN.test(data.pack_id || "")) return fail("KADI_V1_RECHARGE_PACK_ID_INVALID");
      return call(recharge, "selectPack", { ...base, packId: data.pack_id }, "KADI_V1_RECHARGE_PACK_FAILED");
    }
    if (command.action === "CHECK_PAYMENT") {
      if (!ID_PATTERN.test(data.payment_reference || "")) return fail("KADI_V1_PAYMENT_REFERENCE_INVALID");
      return call(recharge, "checkPayment", { ...base, paymentReference: data.payment_reference }, "KADI_V1_PAYMENT_CHECK_FAILED");
    }
    if (command.action === "CANCEL" && command.flowKey === "RECHARGE") {
      return call(recharge, "cancel", base, "KADI_V1_RECHARGE_CANCEL_FAILED");
    }

    const document = validateDocumentContext(command.documentContext);
    if (!document.ok) return document;
    const documentBase = Object.freeze({
      ...base,
      documentId: document.value.document_id,
      expectedVersion: document.value.document_version,
      documentType: document.value.document_type,
      documentState: document.value.document_state,
    });

    const operations = {
      SAVE_CLIENT: [documents, "setClient", { ...documentBase, client: structuredClone(data) }, "KADI_V1_DOCUMENT_CLIENT_FAILED"],
      ADD_CONTENT: [documents, "addContent", { ...documentBase, content: structuredClone(data) }, "KADI_V1_DOCUMENT_CONTENT_ADD_FAILED"],
      UPDATE_CONTENT: [documents, "updateContent", { ...documentBase, itemId: data.item_id, content: Object.fromEntries(Object.entries(data).filter(([key]) => key !== "item_id")) }, "KADI_V1_DOCUMENT_CONTENT_UPDATE_FAILED"],
      REMOVE_CONTENT: [documents, "removeContent", { ...documentBase, itemId: data.item_id }, "KADI_V1_DOCUMENT_CONTENT_REMOVE_FAILED"],
      SAVE_OPTIONS: [documents, "setOptions", { ...documentBase, options: structuredClone(data) }, "KADI_V1_DOCUMENT_OPTIONS_FAILED"],
      VERIFY: [documents, "verify", documentBase, "KADI_V1_DOCUMENT_VERIFY_FAILED"],
      EDIT_CLIENT: [documents, "beginEdit", { ...documentBase, section: "CLIENT" }, "KADI_V1_DOCUMENT_EDIT_FAILED"],
      EDIT_CONTENT: [documents, "beginEdit", { ...documentBase, section: "CONTENT" }, "KADI_V1_DOCUMENT_EDIT_FAILED"],
      EDIT_OPTIONS: [documents, "beginEdit", { ...documentBase, section: "OPTIONS" }, "KADI_V1_DOCUMENT_EDIT_FAILED"],
      EDIT: [documents, "beginEdit", { ...documentBase, section: data.section || "ALL" }, "KADI_V1_DOCUMENT_EDIT_FAILED"],
      SAVE_FOR_LATER: [documents, "saveForLater", documentBase, "KADI_V1_DOCUMENT_SAVE_LATER_FAILED"],
      SAVE_DETAILS: [documents, "saveDischargeDetails", { ...documentBase, details: structuredClone(data) }, "KADI_V1_DISCHARGE_DETAILS_FAILED"],
      PREPARE_PDF: [previews, "prepare", documentBase, "KADI_V1_PREVIEW_PREPARE_FAILED"],
      CONFIRM_GENERATION: [generation, "confirm", { ...documentBase, quoteId: data.quote_id }, "KADI_V1_GENERATION_CONFIRM_FAILED"],
      CANCEL: [documents, "cancel", documentBase, "KADI_V1_DOCUMENT_CANCEL_FAILED"],
    };
    const operation = operations[command.action];
    if (!operation) return fail("KADI_V1_FLOW_COMMAND_ROUTE_UNRESOLVED");
    return call(...operation);
  }

  return Object.freeze({ execute });
}

module.exports = {
  ACTIONS,
  DOCUMENT_TYPES,
  FLOW_KEYS,
  createKadiV1FlowCommandRuntime,
  validateCommand,
  validateDocumentContext,
};
