"use strict";

const OWNER_PATTERN = /^\d{8,20}$/;
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const IDEMPOTENCY_PATTERN = /^flow_command:[A-Za-z0-9:_.-]{1,187}$/;
const DOCUMENT_TYPES = Object.freeze(["FACTURE", "DEVIS", "RECU", "DECHARGE"]);
// GENERATION_CONFIRMATION-001 R1: the only document state a
// GENERATION_CONFIRMATION Flow may ever legitimately be opened for. Never
// derived from anything client-supplied — see the CANCEL branch below.
const GENERATION_CONFIRMATION_CANCEL_EXPECTED_STATE = "AWAITING_GENERATION_CONFIRMATION";
// T4.5 (DOCUMENT_CANCEL_STATE_AUTHORITY_GATE): the legitimate document
// state(s) each Flow's session may ever have been genuinely opened
// against, traced directly from production routing
// (kadiV1ProductionPresenter.js's routeDocument and
// kadiV1ConversationOrchestrator.js's routeForDocument, which agree) —
// never guessed from the state machine's connectivity alone. Sessions are
// never auto-revoked when a new Flow opens (kadiV1ConversationSession.js's
// open() only ever creates a new row; revoke() has no production caller),
// so more than one OPEN session for the same owner can genuinely coexist,
// making a stale submission an always-possible, not merely theoretical,
// scenario. DOCUMENT_REVIEW is routed to from exactly one state
// (READY_FOR_REVIEW); DOCUMENT_PREVIEW from two (VERIFIED — the normal
// case after VERIFY — and PREVIEW_READY, a real, durable resting state
// whenever kadiV1PreviewService.js's persistPreview succeeds but a later
// step in the same prepare() call, e.g. quote creation, fails first).
const DOCUMENT_REVIEW_CANCEL_EXPECTED_STATES = Object.freeze(["READY_FOR_REVIEW"]);
const DOCUMENT_PREVIEW_CANCEL_EXPECTED_STATES = Object.freeze(["VERIFIED", "PREVIEW_READY"]);
const FLOW_KEYS = Object.freeze([
  "ONBOARDING", "MENU", "DOCUMENT_TYPE", "INVOICE_TYPE", "RECEIPT_DETAILS", "DOCUMENT_CLIENT", "DOCUMENT_CONTENT", "ARTICLE_FORM",
  "DOCUMENT_OPTIONS", "DOCUMENT_REVIEW", "EDIT_CLIENT", "EDIT_CONTENT", "EDIT_OPTIONS",
  "DOCUMENT_PREVIEW", "GENERATION_CONFIRMATION", "RECHARGE", "HISTORY_SEARCH", "DISCHARGE_DETAILS",
]);
const ACTIONS = Object.freeze([
  "START", "PREPARE_DOCUMENT", "HISTORY_SEARCH", "BALANCE", "HELP", "SELECT_DOCUMENT_TYPE",
  "SAVE_INVOICE_TYPE", "SAVE_RECEIPT_DETAILS", "SAVE_CLIENT", "START_ADD_CONTENT", "ADD_CONTENT", "UPDATE_CONTENT", "REMOVE_CONTENT", "FINISH_CONTENT", "SAVE_OPTIONS", "VERIFY",
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
    "start", "setInvoiceKind", "setReceiptDetails", "setClient", "startAddContent", "addContent", "updateContent", "removeContent", "finishContent", "setOptions",
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
      // RECHARGE-CONTRACT-001 (R1 independent review, HIGH/P0): the real
      // RECHARGE Flow carries no recharge_session_id of its own — cancel()
      // must be bound to the trusted server-side moment this exact Flow
      // session was opened (sessionOpenedAt, set only by
      // kadiV1FlowReplyRuntime.js from the session record, never
      // client-supplied), so a stale or replayed CANCEL submission can
      // never affect a recharge session created after that session was
      // opened. See kadiV1ProductionInfrastructure.js's cancel().
      if (!Number.isFinite(Date.parse(command.sessionOpenedAt || ""))) return fail("KADI_V1_FLOW_COMMAND_SESSION_CONTEXT_INVALID");
      return call(recharge, "cancel", { ...base, sessionOpenedAt: command.sessionOpenedAt }, "KADI_V1_RECHARGE_CANCEL_FAILED");
    }
    if (command.action === "CANCEL" && command.flowKey === "GENERATION_CONFIRMATION") {
      // GENERATION_CONFIRMATION-001 (R1 independent review, HIGH/P0): a
      // GENERATION_CONFIRMATION Flow session is only ever legitimately
      // opened while the document is AWAITING_GENERATION_CONFIRMATION.
      // Pure document state transitions never bump document.version (see
      // kadiV1DocumentDomain.js's transitionDocument), so a stale session's
      // expectedVersion can still match the document's CURRENT version even
      // after it has genuinely moved on to RECHARGE_REQUIRED or
      // GENERATION_IN_PROGRESS — both of which the state machine still
      // allows CANCEL from. Failing closed here on the trusted session's
      // OWN captured document_state (never client-supplied) catches a
      // session that was never opened in the right state to begin with;
      // the real protection against the document having moved on SINCE
      // that session opened is expectedState below, verified against the
      // document's real, current, persisted status inside the same durable
      // mutation as the cancellation itself (see
      // kadiV1RuntimeAdapters.js's cancel() and
      // kadiV1SharedDocumentPipeline.js's persistStateTransition).
      const document = validateDocumentContext(command.documentContext);
      if (!document.ok) return document;
      if (document.value.document_state !== GENERATION_CONFIRMATION_CANCEL_EXPECTED_STATE) {
        return fail("KADI_V1_FLOW_COMMAND_GENERATION_CONFIRMATION_STATE_INVALID");
      }
      const documentBase = Object.freeze({
        ...base,
        documentId: document.value.document_id,
        expectedVersion: document.value.document_version,
        documentType: document.value.document_type,
        documentState: document.value.document_state,
        expectedState: GENERATION_CONFIRMATION_CANCEL_EXPECTED_STATE,
      });
      return call(documents, "cancel", documentBase, "KADI_V1_DOCUMENT_CANCEL_FAILED");
    }
    if (command.action === "CANCEL" && (command.flowKey === "DOCUMENT_REVIEW" || command.flowKey === "DOCUMENT_PREVIEW")) {
      // T4.5 (independent T4 merge review, HIGH/P0): the same stale-session
      // state-authority gap T4 closed for GENERATION_CONFIRMATION/CANCEL
      // also existed here — DOCUMENT_REVIEW/CANCEL and DOCUMENT_PREVIEW/
      // CANCEL both routed through the fully generic document branch
      // below, which never passed expectedState at all, so a stale
      // DOCUMENT_REVIEW or DOCUMENT_PREVIEW session could still terminally
      // CANCEL a document that had since legitimately moved to a later
      // business phase (VERIFIED, AWAITING_GENERATION_CONFIRMATION,
      // RECHARGE_REQUIRED, even GENERATION_IN_PROGRESS), since pure state
      // transitions never bump document.version. Fixed the same way as
      // GENERATION_CONFIRMATION/CANCEL: fail closed if the trusted
      // session's own captured document_state is not one of this Flow's
      // real, routing-traced legitimate states (see
      // DOCUMENT_REVIEW_CANCEL_EXPECTED_STATES /
      // DOCUMENT_PREVIEW_CANCEL_EXPECTED_STATES above), then forward that
      // exact, already-validated state as expectedState — reusing the same
      // durable, atomic mutation-contract check T4 introduced
      // (kadiV1RuntimeAdapters.js's cancel(),
      // kadiV1SharedDocumentPipeline.js's persistStateTransition,
      // kadiV1DischargePipeline.js's persistTransition), unmodified.
      // DOCUMENT_PREVIEW has two legitimate states, so expectedState here
      // is the session's own verified value, not a single hardcoded
      // constant like GENERATION_CONFIRMATION's.
      const document = validateDocumentContext(command.documentContext);
      if (!document.ok) return document;
      const legitimateStates = command.flowKey === "DOCUMENT_REVIEW"
        ? DOCUMENT_REVIEW_CANCEL_EXPECTED_STATES
        : DOCUMENT_PREVIEW_CANCEL_EXPECTED_STATES;
      if (!legitimateStates.includes(document.value.document_state)) {
        return fail("KADI_V1_FLOW_COMMAND_DOCUMENT_CANCEL_STATE_INVALID");
      }
      const documentBase = Object.freeze({
        ...base,
        documentId: document.value.document_id,
        expectedVersion: document.value.document_version,
        documentType: document.value.document_type,
        documentState: document.value.document_state,
        expectedState: document.value.document_state,
      });
      return call(documents, "cancel", documentBase, "KADI_V1_DOCUMENT_CANCEL_FAILED");
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
      SAVE_INVOICE_TYPE: [documents, "setInvoiceKind", { ...documentBase, invoiceKind: data.invoice_kind }, "KADI_V1_DOCUMENT_INVOICE_KIND_FAILED"],
      SAVE_RECEIPT_DETAILS: [documents, "setReceiptDetails", { ...documentBase, details: structuredClone(data) }, "KADI_V1_DOCUMENT_RECEIPT_DETAILS_FAILED"],
      SAVE_CLIENT: [documents, "setClient", { ...documentBase, client: structuredClone(data) }, "KADI_V1_DOCUMENT_CLIENT_FAILED"],
      START_ADD_CONTENT: [documents, "startAddContent", documentBase, "KADI_V1_DOCUMENT_CONTENT_START_FAILED"],
      ADD_CONTENT: [documents, "addContent", { ...documentBase, content: structuredClone(data) }, "KADI_V1_DOCUMENT_CONTENT_ADD_FAILED"],
      UPDATE_CONTENT: [documents, "updateContent", { ...documentBase, itemId: data.item_id, content: Object.fromEntries(Object.entries(data).filter(([key]) => key !== "item_id")) }, "KADI_V1_DOCUMENT_CONTENT_UPDATE_FAILED"],
      REMOVE_CONTENT: [documents, "removeContent", { ...documentBase, itemId: data.item_id }, "KADI_V1_DOCUMENT_CONTENT_REMOVE_FAILED"],
      FINISH_CONTENT: [documents, "finishContent", documentBase, "KADI_V1_DOCUMENT_CONTENT_FINISH_FAILED"],
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
