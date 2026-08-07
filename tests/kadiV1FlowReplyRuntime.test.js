"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createKadiV1FlowReplyRuntime,
  validateActionPayload,
  validateReplyEnvelope,
  FLOW_ACTIONS,
} = require("../kadiV1FlowReplyRuntime");
const {
  createConversationSessionService,
  createMemoryConversationSessionRepository,
} = require("../kadiV1ConversationSession");

function makeSessionService(overrides = {}) {
  let tick = 0;
  return createConversationSessionService({
    repository: createMemoryConversationSessionRepository(),
    clock: () => new Date(Date.parse("2026-08-02T20:00:00.000Z") + tick++ * 1000).toISOString(),
    idFactory: () => overrides.sessionId || "kadi_session:reply1",
  });
}

async function openSession(service, overrides = {}) {
  const opened = await service.open({
    ownerWaId: "22670000000",
    document: {
      document_id: "document:1",
      version: 3,
      document_type: "FACTURE",
      status: "COLLECTING",
    },
    expectedFlowKey: "ARTICLE_FORM",
    returnState: "COLLECTING",
    idempotencyKey: "open:reply1",
    ...overrides,
  });
  assert.equal(opened.ok, true);
  return opened.value;
}

function reply(overrides = {}) {
  return {
    ownerWaId: "22670000000",
    sessionId: "kadi_session:reply1",
    flowKey: "ARTICLE_FORM",
    action: "ADD_CONTENT",
    data: { description: "Ciment", quantity: 2, unit: "sac", unit_price: 6500 },
    idempotencyKey: "reply:1",
    ...overrides,
  };
}

test("closed action map rejects an action from another screen", () => {
  const checked = validateActionPayload("DOCUMENT_CONTENT", "CONFIRM_GENERATION", {});
  assert.deepEqual(checked, { ok: false, error: "KADI_V1_FLOW_REPLY_ACTION_FORBIDDEN" });
});

test("server-authoritative fields are rejected before session consumption", () => {
  const checked = validateReplyEnvelope(reply({ data: { description: "Ciment", total: 13000 } }));
  assert.deepEqual(checked, { ok: false, error: "KADI_V1_FLOW_REPLY_AUTHORITY_FIELD_FORBIDDEN" });
});

test("unknown top-level fields are rejected", () => {
  const checked = validateActionPayload("ARTICLE_FORM", "ADD_CONTENT", { description: "Ciment", hidden: "x" });
  assert.deepEqual(checked, { ok: false, error: "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN" });
});

test("nested forbidden authority fields are rejected", () => {
  const checked = validateActionPayload("ARTICLE_FORM", "ADD_CONTENT", { description: { label: "Ciment", issued_at: "2026-08-02" } });
  assert.deepEqual(checked, { ok: false, error: "KADI_V1_FLOW_REPLY_AUTHORITY_FIELD_FORBIDDEN" });
});

test("valid reply dispatches only server-bound document context", async () => {
  const sessions = makeSessionService();
  await openSession(sessions);
  const calls = [];
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: {
      execute: async (command) => {
        calls.push(command);
        return { ok: true, value: { status: "COLLECTING" } };
      },
    },
  });
  const result = await runtime.handle(reply());
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].documentContext, {
    document_id: "document:1",
    document_version: 3,
    document_type: "FACTURE",
    document_state: "COLLECTING",
    return_state: "COLLECTING",
  });
  assert.equal(calls[0].flowKey, "ARTICLE_FORM");
  assert.equal(calls[0].idempotencyKey, "flow_command:reply:1");
  assert.equal(Object.hasOwn(calls[0].data, "document_id"), false);
});

// INV-001/INV-002 (exploratory audit): the presenter needs to know which
// screen a reply actually came from to tell an initial-creation SAVE_CLIENT/
// FINISH_CONTENT apart from a correction one — this is the session-verified
// signal it relies on (never a client-supplied flag; unexpected_logical
// screen above already proves a mismatched flowKey cannot reach this far).
test("a successful reply's result carries the session-verified originating flow_key, never a client-supplied one", async () => {
  const sessions = makeSessionService();
  await openSession(sessions);
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: { execute: async () => ({ ok: true, value: { status: "COLLECTING" } }) },
  });
  const result = await runtime.handle(reply());
  assert.equal(result.ok, true);
  assert.equal(result.value.flow_key, "ARTICLE_FORM");
});

test("EDIT_CONTENT now accepts FINISH_CONTENT so a content correction can signal it is done and return to review", () => {
  assert.ok(FLOW_ACTIONS.EDIT_CONTENT.includes("FINISH_CONTENT"));
  const checked = validateActionPayload("EDIT_CONTENT", "FINISH_CONTENT", {});
  assert.equal(checked.ok, true);
});

// CLIENT-001: both real client Flows (kadi_document_client_v1.json,
// kadi_edit_client_v1.json) submit a "tax_id" field labelled "Identifiant
// fiscal" on every real submission — Meta submits every declared field,
// even blank ones. The document domain only ever recognizes "ifu" for the
// same concept. Before this fix, any real SAVE_CLIENT reply — initial or
// edited — failed with DOCUMENT_CLIENT_FIELD_UNKNOWN.

test("A. SAVE_CLIENT from the real initial DOCUMENT_CLIENT payload shape (tax_id present but blank) is accepted, and no tax_id/ifu key survives when blank", () => {
  const checked = validateActionPayload("DOCUMENT_CLIENT", "SAVE_CLIENT", {
    name: "Awa Traoré", phone: "", email: "", address: "", tax_id: "",
  });
  assert.equal(checked.ok, true, checked.error);
  assert.equal(Object.hasOwn(checked.value, "tax_id"), false);
  assert.equal(Object.hasOwn(checked.value, "ifu"), false);
});

test("B. SAVE_CLIENT from the real EDIT_CLIENT payload shape (tax_id present but blank) is accepted the same way as the initial screen", () => {
  const checked = validateActionPayload("EDIT_CLIENT", "SAVE_CLIENT", {
    name: "Awa Traoré (corrigée)", phone: "", email: "", address: "", tax_id: "",
  });
  assert.equal(checked.ok, true, checked.error);
  assert.equal(Object.hasOwn(checked.value, "tax_id"), false);
});

test("C. a legitimate tax_id value is normalized once to the canonical ifu field, never persisted as a second, contradictory representation", () => {
  const checked = validateActionPayload("DOCUMENT_CLIENT", "SAVE_CLIENT", {
    name: "Boutique Awa", phone: "", email: "", address: "", tax_id: "  00123456A  ",
  });
  assert.equal(checked.ok, true, checked.error);
  assert.equal(checked.value.ifu, "00123456A");
  assert.equal(Object.hasOwn(checked.value, "tax_id"), false);
});

test("C2: tax_id and ifu both supplied with the same value normalize cleanly, no conflict", () => {
  const checked = validateActionPayload("DOCUMENT_CLIENT", "SAVE_CLIENT", {
    name: "Boutique Awa", tax_id: "00123456A", ifu: "00123456A",
  });
  assert.equal(checked.ok, true, checked.error);
  assert.equal(checked.value.ifu, "00123456A");
});

test("C3: tax_id and ifu supplied with conflicting non-empty values fail safely instead of silently choosing one", () => {
  const checked = validateActionPayload("DOCUMENT_CLIENT", "SAVE_CLIENT", {
    name: "Boutique Awa", tax_id: "00123456A", ifu: "99999999Z",
  });
  assert.deepEqual(checked, { ok: false, error: "KADI_V1_FLOW_REPLY_CLIENT_TAX_IDENTIFIER_CONFLICT" });
});

test("D. an arbitrary unknown client field remains rejected exactly as before — the fix does not weaken the allowlist", () => {
  const checked = validateActionPayload("DOCUMENT_CLIENT", "SAVE_CLIENT", {
    name: "Boutique Awa", not_a_real_field: "x",
  });
  assert.deepEqual(checked, { ok: false, error: "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN" });
});

// Flow/backend field-parity guard: every field either real client Flow
// contract actually submits must have an explicit backend policy, so a
// future Flow change can never silently reintroduce CLIENT-001's class of
// defect.
test("Flow/backend parity: submitting every field the real kadi_document_client_v1.json and kadi_edit_client_v1.json contracts declare — exactly as Meta really submits a Flow form, blank fields included — is accepted by SAVE_CLIENT's backend policy", () => {
  const documentClientFlow = require("../flows/v1_draft/kadi_document_client_v1.json");
  const editClientFlow = require("../flows/v1_draft/kadi_edit_client_v1.json");
  for (const flow of [documentClientFlow, editClientFlow]) {
    const payload = flow.screens[0].layout.children.find((child) => child.type === "Form")
      .children.find((child) => child.type === "Footer")["on-click-action"].payload;
    const submittedFields = Object.keys(payload.data);
    assert.ok(submittedFields.includes("tax_id"), `${flow.screens[0].id} must still declare tax_id — this test must keep reproducing the real contract, not a hand-picked subset`);
    const realSubmission = { name: "Boutique Awa" };
    for (const field of submittedFields) {
      if (field === "name") continue;
      realSubmission[field] = "";
    }
    const checked = validateActionPayload(flow.screens[0].id, "SAVE_CLIENT", realSubmission);
    assert.equal(checked.ok, true, `${flow.screens[0].id}'s real full submission shape must be accepted (got ${checked.error})`);
  }
});

// EDIT-CONTENT-001 (found during the PR #15 merge-gate review's flow
// contract drift sweep — the same class of defect as CLIENT-001):
// kadi_edit_content_v1.json is one combined form whose single Footer
// always submits item_id/description/quantity/unit/unit_custom/unit_price
// together, regardless of which action radio button (ADD_CONTENT/
// UPDATE_CONTENT/REMOVE_CONTENT/FINISH_CONTENT) was chosen — Meta submits
// every declared field on every submission. Before this fix, only
// UPDATE_CONTENT's allowlist happened to include every field the real
// form sends; the other three rejected the real submission outright
// (ADD_CONTENT and FINISH_CONTENT on item_id, REMOVE_CONTENT and
// FINISH_CONTENT on the description/quantity/unit/unit_custom/unit_price
// group) with KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN — silently reproduced by
// this PR's own INV-002 fix, which made EDIT_CONTENT genuinely reachable
// for the first time.

test("EDIT-CONTENT-001: ADD_CONTENT from the real EDIT_CONTENT form (item_id present but irrelevant) is accepted, and item_id never reaches the persisted content", () => {
  const checked = validateActionPayload("EDIT_CONTENT", "ADD_CONTENT", {
    item_id: "", description: "Fer à béton", quantity: 5, unit: "unité", unit_custom: "", unit_price: 3000,
  });
  assert.equal(checked.ok, true, checked.error);
  assert.equal(Object.hasOwn(checked.value, "item_id"), false);
});

test("EDIT-CONTENT-001: REMOVE_CONTENT from the real EDIT_CONTENT form (the other five fields present but irrelevant) is accepted", () => {
  const checked = validateActionPayload("EDIT_CONTENT", "REMOVE_CONTENT", {
    item_id: "item:1", description: "", quantity: "", unit: "", unit_custom: "", unit_price: "",
  });
  assert.equal(checked.ok, true, checked.error);
  assert.equal(checked.value.item_id, "item:1");
});

test("EDIT-CONTENT-001: FINISH_CONTENT from the real EDIT_CONTENT form (all six fields present but unused downstream) is accepted", () => {
  const checked = validateActionPayload("EDIT_CONTENT", "FINISH_CONTENT", {
    item_id: "", description: "", quantity: "", unit: "", unit_custom: "", unit_price: "",
  });
  assert.equal(checked.ok, true, checked.error);
});

test("EDIT-CONTENT-001: ARTICLE_FORM's own ADD_CONTENT (no item_id — the real initial-creation shape) is unaffected by this fix", () => {
  const checked = validateActionPayload("ARTICLE_FORM", "ADD_CONTENT", {
    description: "Ciment", quantity: 2, unit: "sac", unit_custom: "", unit_price: 6000,
  });
  assert.equal(checked.ok, true, checked.error);
});

test("Flow/backend parity: every action kadi_edit_content_v1.json's real edit_actions contract declares, submitted with the real full combined-form field set, is accepted", () => {
  const editContentFlow = require("../flows/v1_draft/kadi_edit_content_v1.json");
  const form = editContentFlow.screens[0].layout.children.find((child) => child.type === "Form");
  // "action"'s own data-source is the runtime template "${data.edit_actions}"
  // (server-populated, per kadiV1ProductionPresenter.js's suggestedDataForFlow
  // EDIT_CONTENT branch) — the screen's declared data schema for
  // edit_actions is the closed contract of which action ids this screen
  // can ever actually submit.
  const declaredActionIds = editContentFlow.screens[0].data.edit_actions.__example__.map((entry) => entry.id);
  assert.deepEqual(declaredActionIds.sort(), ["ADD_CONTENT", "FINISH_CONTENT", "REMOVE_CONTENT", "UPDATE_CONTENT"].sort());
  const footerPayload = form.children.find((child) => child.type === "Footer")["on-click-action"].payload;
  const submittedFields = Object.keys(footerPayload.data);
  // ADD_CONTENT/UPDATE_CONTENT separately require real, non-blank content
  // (a genuine, pre-existing, unrelated validation rule) — this test's
  // purpose is the field-allowlist contract, not content validation, so
  // each action gets realistic values where it needs them.
  const realValues = { item_id: "item:1", description: "Ciment", quantity: 2, unit: "sac", unit_custom: "", unit_price: 6000 };
  for (const action of declaredActionIds) {
    const realSubmission = Object.fromEntries(submittedFields.map((field) => [field, realValues[field] ?? ""]));
    const checked = validateActionPayload("EDIT_CONTENT", action, realSubmission);
    assert.equal(checked.ok, true, `EDIT_CONTENT's real combined-form submission for declared action "${action}" must be accepted (got ${checked.error})`);
  }
});

test("owner mismatch is absorbed before command execution", async () => {
  const sessions = makeSessionService();
  await openSession(sessions);
  let executed = false;
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: { execute: async () => { executed = true; return { ok: true, value: null }; } },
  });
  const result = await runtime.handle(reply({ ownerWaId: "22671111111" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_SESSION_OWNER_MISMATCH");
  assert.equal(executed, false);
});

test("unexpected logical screen is rejected", async () => {
  const sessions = makeSessionService();
  await openSession(sessions);
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: { execute: async () => ({ ok: true, value: null }) },
  });
  const result = await runtime.handle(reply({ flowKey: "DOCUMENT_OPTIONS", action: "SAVE_OPTIONS", data: {} }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_SESSION_UNEXPECTED_FLOW");
});

test("ADD_CONTENT is rejected when the open session was opened for DOCUMENT_CONTENT, not ARTICLE_FORM", async () => {
  const sessions = makeSessionService();
  await openSession(sessions, { expectedFlowKey: "DOCUMENT_CONTENT" });
  let executed = false;
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: { execute: async () => { executed = true; return { ok: true, value: null }; } },
  });
  const result = await runtime.handle(reply({ flowKey: "ARTICLE_FORM", action: "ADD_CONTENT" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_SESSION_UNEXPECTED_FLOW");
  assert.equal(executed, false);
});

test("duplicate webhook reuses the same command idempotency key", async () => {
  const sessions = makeSessionService();
  await openSession(sessions);
  const seen = new Map();
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: {
      execute: async (command) => {
        if (seen.has(command.idempotencyKey)) return { ok: true, value: seen.get(command.idempotencyKey), duplicate: true };
        const value = { item_id: "item:1" };
        seen.set(command.idempotencyKey, value);
        return { ok: true, value };
      },
    },
  });
  const first = await runtime.handle(reply());
  const second = await runtime.handle(reply());
  assert.equal(first.ok, true);
  assert.equal(first.value.duplicate, false);
  assert.equal(second.ok, true);
  assert.equal(second.value.duplicate, true);
  assert.deepEqual(second.value.result, { item_id: "item:1" });
});

// RECHARGE-CONTRACT-001 (R2 independent review, HIGH/P0): an exact
// duplicate of an already-consumed RECHARGE/CANCEL reply must execute
// ZERO second business mutation — commands.execute() must never be
// called at all on the replay, unlike the generic behavior proven above
// (and reproven below for an unrelated Flow/action) where the command
// layer's own idempotency key is what makes a second execution safe.
test("R2: an exact duplicate RECHARGE/CANCEL reply never calls commands.execute a second time", async () => {
  const sessions = makeSessionService();
  await openSession(sessions, { expectedFlowKey: "RECHARGE", document: null });
  let calls = 0;
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: { execute: async () => { calls += 1; return { ok: true, value: { status: "CANCELLED" } }; } },
  });
  const cancelReply = reply({ flowKey: "RECHARGE", action: "CANCEL", data: { pack_id: "", payment_reference: "" } });
  const first = await runtime.handle(cancelReply);
  assert.equal(first.ok, true, first.error);
  assert.equal(first.value.duplicate, false);
  assert.equal(calls, 1);

  const second = await runtime.handle(cancelReply);
  assert.equal(second.ok, true, second.error);
  assert.equal(second.value.duplicate, true);
  assert.equal(second.value.result, null, "the short-circuit never replays or invents an old business result");
  assert.equal(calls, 1, "commands.execute must never be called a second time for an exact RECHARGE/CANCEL duplicate");
});

// The short-circuit above must be scoped to exactly (RECHARGE, CANCEL) —
// every other Flow/action's existing generic duplicate-execution
// behavior (relying on the command layer's own idempotency key, exactly
// like the pre-existing "duplicate webhook reuses the same command
// idempotency key" test above) must remain completely unaffected,
// including CANCEL on every other Flow.
test("R2: the RECHARGE/CANCEL short-circuit does not affect DOCUMENT_REVIEW/CANCEL — commands.execute is still called on an exact duplicate", async () => {
  const sessions = makeSessionService();
  await openSession(sessions, { expectedFlowKey: "DOCUMENT_REVIEW" });
  let calls = 0;
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: { execute: async () => { calls += 1; return { ok: true, value: { status: "CANCELLED" } }; } },
  });
  const cancelReply = reply({ flowKey: "DOCUMENT_REVIEW", action: "CANCEL", data: {} });
  await runtime.handle(cancelReply);
  assert.equal(calls, 1);
  const second = await runtime.handle(cancelReply);
  assert.equal(second.value.duplicate, true);
  assert.equal(calls, 2, "DOCUMENT_REVIEW/CANCEL must keep the pre-existing generic behavior — commands.execute is still called on a duplicate");
});

test("R2: the RECHARGE/CANCEL short-circuit does not affect DOCUMENT_PREVIEW/CANCEL — commands.execute is still called on an exact duplicate", async () => {
  const sessions = makeSessionService();
  await openSession(sessions, { expectedFlowKey: "DOCUMENT_PREVIEW" });
  let calls = 0;
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: { execute: async () => { calls += 1; return { ok: true, value: { status: "CANCELLED" } }; } },
  });
  const cancelReply = reply({ flowKey: "DOCUMENT_PREVIEW", action: "CANCEL", data: {} });
  await runtime.handle(cancelReply);
  assert.equal(calls, 1);
  const second = await runtime.handle(cancelReply);
  assert.equal(second.value.duplicate, true);
  assert.equal(calls, 2, "DOCUMENT_PREVIEW/CANCEL must keep the pre-existing generic behavior — commands.execute is still called on a duplicate");
});

// GENERATION_CONFIRMATION/CANCEL remains T4 (still rejected outright by
// the field allowlist — see the GENERATION_CONFIRMATION-001 test above)
// — this only proves the R2 short-circuit itself would not additionally
// alter its (separately still-broken) duplicate behavior if that field
// contract were ever fixed later, keeping this fix strictly scoped to
// (RECHARGE, CANCEL) at the duplicate-execution level too.
test("R2: the RECHARGE/CANCEL short-circuit does not affect GENERATION_CONFIRMATION/CANCEL — commands.execute is still called on an exact duplicate", async () => {
  const sessions = makeSessionService();
  await openSession(sessions, { expectedFlowKey: "GENERATION_CONFIRMATION" });
  let calls = 0;
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: { execute: async () => { calls += 1; return { ok: true, value: { status: "CANCELLED" } }; } },
  });
  const cancelReply = reply({ flowKey: "GENERATION_CONFIRMATION", action: "CANCEL", data: {} });
  await runtime.handle(cancelReply);
  assert.equal(calls, 1);
  const second = await runtime.handle(cancelReply);
  assert.equal(second.value.duplicate, true);
  assert.equal(calls, 2, "GENERATION_CONFIRMATION/CANCEL must keep the pre-existing generic behavior — commands.execute is still called on a duplicate");
});

test("recoverable command failure can be retried through consumed-session replay", async () => {
  const sessions = makeSessionService();
  await openSession(sessions);
  let attempts = 0;
  const runtime = createKadiV1FlowReplyRuntime({
    sessionService: sessions,
    commandRuntime: {
      execute: async () => {
        attempts += 1;
        return attempts === 1
          ? { ok: false, error: "TEMPORARY_UNAVAILABLE" }
          : { ok: true, value: { saved: true } };
      },
    },
  });
  const first = await runtime.handle(reply());
  const second = await runtime.handle(reply());
  assert.deepEqual(first, { ok: false, error: "TEMPORARY_UNAVAILABLE" });
  assert.equal(second.ok, true);
  assert.equal(second.value.duplicate, true);
  assert.equal(attempts, 2);
});

test("SAVE_INVOICE_TYPE accepts only the exact FINAL or PROFORMA values", () => {
  assert.equal(validateActionPayload("INVOICE_TYPE", "SAVE_INVOICE_TYPE", { invoice_kind: "FINAL" }).ok, true);
  assert.equal(validateActionPayload("INVOICE_TYPE", "SAVE_INVOICE_TYPE", { invoice_kind: "PROFORMA" }).ok, true);
});

test("SAVE_INVOICE_TYPE fails closed on empty, unknown, lowercase or free-text values", () => {
  assert.deepEqual(validateActionPayload("INVOICE_TYPE", "SAVE_INVOICE_TYPE", { invoice_kind: "" }), { ok: false, error: "KADI_V1_FLOW_REPLY_INVOICE_KIND_INVALID" });
  assert.deepEqual(validateActionPayload("INVOICE_TYPE", "SAVE_INVOICE_TYPE", { invoice_kind: "final" }), { ok: false, error: "KADI_V1_FLOW_REPLY_INVOICE_KIND_INVALID" });
  assert.deepEqual(validateActionPayload("INVOICE_TYPE", "SAVE_INVOICE_TYPE", { invoice_kind: "AUTRE" }), { ok: false, error: "KADI_V1_FLOW_REPLY_INVOICE_KIND_INVALID" });
  assert.deepEqual(validateActionPayload("INVOICE_TYPE", "SAVE_INVOICE_TYPE", { invoice_kind: "Facture définitive" }), { ok: false, error: "KADI_V1_FLOW_REPLY_INVOICE_KIND_INVALID" });
  assert.deepEqual(validateActionPayload("INVOICE_TYPE", "SAVE_INVOICE_TYPE", {}), { ok: false, error: "KADI_V1_FLOW_REPLY_INVOICE_KIND_INVALID" });
});

test("SAVE_INVOICE_TYPE rejects any field other than invoice_kind and rejects a mismatched flow_key", () => {
  assert.deepEqual(validateActionPayload("INVOICE_TYPE", "SAVE_INVOICE_TYPE", { invoice_kind: "FINAL", document_type: "FACTURE" }), { ok: false, error: "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN" });
  assert.deepEqual(validateActionPayload("DOCUMENT_TYPE", "SAVE_INVOICE_TYPE", { invoice_kind: "FINAL" }), { ok: false, error: "KADI_V1_FLOW_REPLY_ACTION_FORBIDDEN" });
});

test("oversized and excessively deep payloads fail closed", () => {
  const oversized = validateActionPayload("HISTORY_SEARCH", "SEARCH", { query: "x".repeat(17000) });
  assert.equal(oversized.error, "KADI_V1_FLOW_REPLY_PAYLOAD_TOO_LARGE");
  const deep = { query: { a: { b: { c: { d: { e: { f: "x" } } } } } } };
  const tooDeep = validateActionPayload("HISTORY_SEARCH", "SEARCH", deep);
  assert.equal(tooDeep.error, "KADI_V1_FLOW_REPLY_PAYLOAD_TOO_DEEP");
});

// HISTORY-CONTRACT-001 (same class of defect as CLIENT-001/EDIT-CONTENT-001/
// OPTIONS-001): kadi_history_search_v1.json is one combined form whose
// single Footer always submits query/document_type/date_from/date_to/
// document_id together, regardless of which action radio button (SEARCH/
// OPEN_DOCUMENT) was chosen. Before this fix, SEARCH rejected the real
// shape because of the extra document_id field, and OPEN_DOCUMENT rejected
// it because of the extra query/document_type/date_from/date_to fields —
// both real actions failed with KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN on every
// genuine submission.

test("HISTORY-CONTRACT-001: SEARCH accepts the real full combined-form shape, document_id included but irrelevant", () => {
  const result = validateActionPayload("HISTORY_SEARCH", "SEARCH", {
    query: "", document_type: "", date_from: "", date_to: "", document_id: "",
  });
  assert.equal(result.ok, true, result.error);
});

test("HISTORY-CONTRACT-001: OPEN_DOCUMENT accepts the real full combined-form shape, stale query/type/dates included but irrelevant", () => {
  const result = validateActionPayload("HISTORY_SEARCH", "OPEN_DOCUMENT", {
    query: "Moussa", document_type: "FACTURE", date_from: "2026-01-01", date_to: "2026-08-01", document_id: "doc:1",
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.document_id, "doc:1");
});

test("HISTORY_SEARCH still rejects a field outside the real Flow contract for either action", () => {
  const search = validateActionPayload("HISTORY_SEARCH", "SEARCH", { query: "x", not_a_real_field: "y" });
  assert.deepEqual(search, { ok: false, error: "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN" });
  const open = validateActionPayload("HISTORY_SEARCH", "OPEN_DOCUMENT", { document_id: "doc:1", not_a_real_field: "y" });
  assert.deepEqual(open, { ok: false, error: "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN" });
});

test("Flow/backend parity: submitting every field the real kadi_history_search_v1.json contract declares — exactly as Meta really submits a Flow form, blank fields included — is accepted for both real declared actions", () => {
  const historySearchFlow = require("../flows/v1_draft/kadi_history_search_v1.json");
  const screen = historySearchFlow.screens[0];
  const footerPayload = screen.layout.children.find((child) => child.type === "Form")
    .children.find((child) => child.type === "Footer")["on-click-action"].payload;
  const submittedFields = Object.keys(footerPayload.data);
  assert.ok(submittedFields.includes("document_id"), "HISTORY_SEARCH must still declare document_id — this test must keep reproducing the real contract, not a hand-picked subset");
  const declaredActionIds = screen.data.history_actions.__example__.map((entry) => entry.id);
  assert.deepEqual(declaredActionIds.sort(), ["OPEN_DOCUMENT", "SEARCH"].sort());
  for (const action of declaredActionIds) {
    const realSubmission = Object.fromEntries(submittedFields.map((field) => [field, ""]));
    const checked = validateActionPayload(screen.id, action, realSubmission);
    assert.equal(checked.ok, true, `HISTORY_SEARCH's real full submission shape must be accepted for declared action "${action}" (got ${checked.error})`);
  }
});

// --- SAVE_OPTIONS tax rate: dual-field transition window (percent + legacy basis points) ---

test("old published Flow payload (tax_rate_basis_points only) is still accepted and persists unchanged", () => {
  const result = validateActionPayload("DOCUMENT_OPTIONS", "SAVE_OPTIONS", { tax_rate_basis_points: 1800 });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.tax_rate_basis_points, 1800);
  assert.equal(Object.hasOwn(result.value, "tax_rate_percent"), false);
});

test("new Flow payload (tax_rate_percent only) converts to basis points for the shared pipeline", () => {
  const result = validateActionPayload("DOCUMENT_OPTIONS", "SAVE_OPTIONS", { tax_rate_percent: "18" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.tax_rate_basis_points, 1800);
  assert.equal(Object.hasOwn(result.value, "tax_rate_percent"), false);
});

test("SAVE_OPTIONS accepts a decimal percent down to basis-point granularity", () => {
  const result = validateActionPayload("DOCUMENT_OPTIONS", "SAVE_OPTIONS", { tax_rate_percent: "18.25" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.tax_rate_basis_points, 1825);
});

test("both fields present and agreeing on the same rate is accepted, single persisted value", () => {
  const result = validateActionPayload("DOCUMENT_OPTIONS", "SAVE_OPTIONS", {
    tax_rate_percent: "18", tax_rate_basis_points: 1800,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.tax_rate_basis_points, 1800);
  assert.equal(Object.hasOwn(result.value, "tax_rate_percent"), false);
});

test("both fields present but disagreeing on the rate fails closed with a specific conflict error, never silently prefers one", () => {
  const result = validateActionPayload("DOCUMENT_OPTIONS", "SAVE_OPTIONS", {
    tax_rate_percent: "18", tax_rate_basis_points: 1900,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_FLOW_REPLY_TAX_RATE_CONFLICT");
});

test("SAVE_OPTIONS with no tax field, or both blank, means no tax at all — not zero-as-a-value", () => {
  const omitted = validateActionPayload("DOCUMENT_OPTIONS", "SAVE_OPTIONS", { discount_amount: 1000 });
  assert.equal(omitted.ok, true, omitted.error);
  assert.equal(Object.hasOwn(omitted.value, "tax_rate_basis_points"), false);
  const blankPercent = validateActionPayload("DOCUMENT_OPTIONS", "SAVE_OPTIONS", { tax_rate_percent: "" });
  assert.equal(blankPercent.ok, true, blankPercent.error);
  assert.equal(Object.hasOwn(blankPercent.value, "tax_rate_basis_points"), false);
  const whitespacePercent = validateActionPayload("DOCUMENT_OPTIONS", "SAVE_OPTIONS", { tax_rate_percent: "   " });
  assert.equal(whitespacePercent.ok, true, whitespacePercent.error);
  assert.equal(Object.hasOwn(whitespacePercent.value, "tax_rate_basis_points"), false);
  const bothBlank = validateActionPayload("DOCUMENT_OPTIONS", "SAVE_OPTIONS", {
    tax_rate_percent: "", tax_rate_basis_points: "",
  });
  assert.equal(bothBlank.ok, true, bothBlank.error);
  assert.equal(Object.hasOwn(bothBlank.value, "tax_rate_basis_points"), false);
});

test("SAVE_OPTIONS rejects zero, negative, over-100 and malformed-decimal percents", () => {
  // a whitespace-only value is treated as blank ("no tax"), not malformed —
  // covered separately above, alongside "" and an omitted field.
  for (const invalid of ["0", "-5", "101", "100.001", "18.505", "abc", "18%", "1e2"]) {
    const result = validateActionPayload("DOCUMENT_OPTIONS", "SAVE_OPTIONS", { tax_rate_percent: invalid });
    assert.equal(result.ok, false, `expected ${JSON.stringify(invalid)} to be rejected`);
    assert.equal(result.error, "KADI_V1_FLOW_REPLY_TAX_RATE_INVALID");
  }
});

test("SAVE_OPTIONS accepts French comma decimals, normalized to a dot", () => {
  for (const [input, expectedBps] of [["18", 1800], ["18.5", 1850], ["18,5", 1850], ["18.25", 1825], ["18,25", 1825]]) {
    const result = validateActionPayload("DOCUMENT_OPTIONS", "SAVE_OPTIONS", { tax_rate_percent: input });
    assert.equal(result.ok, true, `${input}: ${result.error}`);
    assert.equal(result.value.tax_rate_basis_points, expectedBps, input);
  }
});

test("SAVE_OPTIONS rejects mixed/multiple separators, exponents and internal spaces in the percent", () => {
  for (const invalid of ["1,8.5", "18.5,", "18..5", "18,,5", "18, 5", "1 8", "1e2", "18,5,5"]) {
    const result = validateActionPayload("DOCUMENT_OPTIONS", "SAVE_OPTIONS", { tax_rate_percent: invalid });
    assert.equal(result.ok, false, `expected ${JSON.stringify(invalid)} to be rejected`);
    assert.equal(result.error, "KADI_V1_FLOW_REPLY_TAX_RATE_INVALID");
  }
});

test("SAVE_OPTIONS accepts exactly 100 as the upper bound for the percent field", () => {
  const result = validateActionPayload("DOCUMENT_OPTIONS", "SAVE_OPTIONS", { tax_rate_percent: "100" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.tax_rate_basis_points, 10000);
});

test("legacy tax_rate_basis_points rejects zero, negative, malformed and over-10000 (over 100%) values", () => {
  for (const invalid of [0, -1, 10001, "abc", "18.5", "1800%", "  "]) {
    const result = validateActionPayload("DOCUMENT_OPTIONS", "SAVE_OPTIONS", { tax_rate_basis_points: invalid });
    assert.equal(result.ok, false, `expected ${JSON.stringify(invalid)} to be rejected`);
    assert.equal(result.error, "KADI_V1_FLOW_REPLY_TAX_RATE_INVALID");
  }
});

test("legacy tax_rate_basis_points accepts exactly 10000 as the upper bound", () => {
  const result = validateActionPayload("DOCUMENT_OPTIONS", "SAVE_OPTIONS", { tax_rate_basis_points: 10000 });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.tax_rate_basis_points, 10000);
});

test("SAVE_OPTIONS never accepts a tax_amount, subtotal or total field from the Flow", () => {
  const amount = validateActionPayload("DOCUMENT_OPTIONS", "SAVE_OPTIONS", { tax_rate_percent: "18", tax_amount: 90000 });
  assert.equal(amount.ok, false);
  assert.equal(amount.error, "KADI_V1_FLOW_REPLY_AUTHORITY_FIELD_FORBIDDEN");
  const subtotal = validateActionPayload("DOCUMENT_OPTIONS", "SAVE_OPTIONS", { tax_rate_basis_points: 1800, subtotal: 500000 });
  assert.equal(subtotal.ok, false);
  assert.equal(subtotal.error, "KADI_V1_FLOW_REPLY_AUTHORITY_FIELD_FORBIDDEN");
});

test("SAVE_OPTIONS still rejects any field outside the known allowlist", () => {
  const result = validateActionPayload("DOCUMENT_OPTIONS", "SAVE_OPTIONS", { tax_rate_percent: "18", tax_currency: "XOF" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN");
});

test("RECU and DECHARGE Flow keys never accept a tax field — SAVE_OPTIONS is not in their action list", () => {
  assert.equal(FLOW_ACTIONS.RECEIPT_DETAILS.includes("SAVE_OPTIONS"), false);
  assert.equal(FLOW_ACTIONS.DISCHARGE_DETAILS.includes("SAVE_OPTIONS"), false);
  const onReceipt = validateActionPayload("RECEIPT_DETAILS", "SAVE_OPTIONS", { tax_rate_percent: "18" });
  assert.equal(onReceipt.ok, false);
  assert.equal(onReceipt.error, "KADI_V1_FLOW_REPLY_ACTION_FORBIDDEN");
  const onDischarge = validateActionPayload("DISCHARGE_DETAILS", "SAVE_OPTIONS", { tax_rate_percent: "18" });
  assert.equal(onDischarge.ok, false);
  assert.equal(onDischarge.error, "KADI_V1_FLOW_REPLY_ACTION_FORBIDDEN");
});

// OPTIONS-001 (same class of defect as CLIENT-001/EDIT-CONTENT-001): the
// real kadi_document_options_v1.json / kadi_edit_options_v1.json Footer
// always submits tax_rate_percent (or the legacy tax_rate_basis_points),
// discount_amount, notes, payment_terms, validity_days, payment_method and
// reference together, blank ones included. This layer's ACTION_FIELDS
// already declared the full shape; the downstream shared-document
// normalizeOptions allowlist did not — this test guards this layer so a
// future Flow change can never silently drift from it again.
test("Flow/backend parity: submitting every field the real kadi_document_options_v1.json and kadi_edit_options_v1.json contracts declare — exactly as Meta really submits a Flow form, blank fields included — is accepted by SAVE_OPTIONS's field allowlist", () => {
  const documentOptionsFlow = require("../flows/v1_draft/kadi_document_options_v1.json");
  const editOptionsFlow = require("../flows/v1_draft/kadi_edit_options_v1.json");
  for (const flow of [documentOptionsFlow, editOptionsFlow]) {
    const payload = flow.screens[0].layout.children.find((child) => child.type === "Form")
      .children.find((child) => child.type === "Footer")["on-click-action"].payload;
    const submittedFields = Object.keys(payload.data);
    assert.ok(
      submittedFields.includes("tax_rate_percent") || submittedFields.includes("tax_rate_basis_points"),
      `${flow.screens[0].id} must still declare a tax rate field — this test must keep reproducing the real contract, not a hand-picked subset`,
    );
    const realSubmission = {};
    for (const field of submittedFields) realSubmission[field] = "";
    const checked = validateActionPayload(flow.screens[0].id, "SAVE_OPTIONS", realSubmission);
    assert.equal(checked.ok, true, `${flow.screens[0].id}'s real full submission shape must be accepted at this layer (got ${checked.error})`);
  }
});

// RECHARGE-CONTRACT-001 (same class of defect as CLIENT-001/
// EDIT-CONTENT-001/OPTIONS-001/HISTORY-CONTRACT-001): kadi_recharge_v1.json
// is one combined form whose single Footer always submits pack_id/
// payment_reference together, regardless of which action (SELECT_PACK/
// CHECK_PAYMENT/CANCEL) was chosen. Before this fix, every real RECHARGE
// submission of any action failed with KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN.

test("RECHARGE-CONTRACT-001: SELECT_PACK accepts the real combined-form shape, a blank or stale payment_reference included but irrelevant", () => {
  const blank = validateActionPayload("RECHARGE", "SELECT_PACK", { pack_id: "PACK_1000", payment_reference: "" });
  assert.equal(blank.ok, true, blank.error);
  const stale = validateActionPayload("RECHARGE", "SELECT_PACK", { pack_id: "PACK_1000", payment_reference: "REF-FROM-A-PRIOR-CHECK" });
  assert.equal(stale.ok, true, stale.error);
  assert.equal(stale.value.pack_id, "PACK_1000");
});

test("RECHARGE-CONTRACT-001: CHECK_PAYMENT accepts the real combined-form shape, a blank or stale pack_id included but irrelevant", () => {
  const blank = validateActionPayload("RECHARGE", "CHECK_PAYMENT", { pack_id: "", payment_reference: "REF-1" });
  assert.equal(blank.ok, true, blank.error);
  const stale = validateActionPayload("RECHARGE", "CHECK_PAYMENT", { pack_id: "PACK_2000", payment_reference: "REF-1" });
  assert.equal(stale.ok, true, stale.error);
  assert.equal(stale.value.payment_reference, "REF-1");
});

test("RECHARGE-CONTRACT-001: RECHARGE/CANCEL accepts the real combined-form shape, both incidental fields included", () => {
  const result = validateActionPayload("RECHARGE", "CANCEL", { pack_id: "PACK_1000", payment_reference: "REF-1" });
  assert.equal(result.ok, true, result.error);
  const blank = validateActionPayload("RECHARGE", "CANCEL", { pack_id: "", payment_reference: "" });
  assert.equal(blank.ok, true, blank.error);
});

test("RECHARGE-CONTRACT-001: an unrelated field outside the real Flow contract is still rejected for every RECHARGE action, and a client-supplied credits/amount field is fail-closed as a forbidden authority field", () => {
  assert.deepEqual(validateActionPayload("RECHARGE", "SELECT_PACK", { pack_id: "PACK_1000", credits: 999 }), { ok: false, error: "KADI_V1_FLOW_REPLY_AUTHORITY_FIELD_FORBIDDEN" });
  assert.deepEqual(validateActionPayload("RECHARGE", "SELECT_PACK", { pack_id: "PACK_1000", amount: 1 }), { ok: false, error: "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN" });
  assert.deepEqual(validateActionPayload("RECHARGE", "CHECK_PAYMENT", { payment_reference: "REF-1", not_a_real_field: "x" }), { ok: false, error: "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN" });
  assert.deepEqual(validateActionPayload("RECHARGE", "CANCEL", { pack_id: "", payment_reference: "", not_a_real_field: "x" }), { ok: false, error: "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN" });
});

// Flow-aware CANCEL isolation: CANCEL is one action name shared globally by
// DOCUMENT_REVIEW/DOCUMENT_PREVIEW/GENERATION_CONFIRMATION/RECHARGE. The
// RECHARGE-only override that accepts pack_id/payment_reference for
// RECHARGE/CANCEL must never leak into any other Flow's CANCEL.
test("RECHARGE-CONTRACT-001: the RECHARGE/CANCEL field override never leaks into unrelated Flows' own CANCEL action", () => {
  const reviewEmpty = validateActionPayload("DOCUMENT_REVIEW", "CANCEL", {});
  assert.equal(reviewEmpty.ok, true, reviewEmpty.error);
  const reviewWithRechargeFields = validateActionPayload("DOCUMENT_REVIEW", "CANCEL", { pack_id: "PACK_1000", payment_reference: "REF-1" });
  assert.deepEqual(reviewWithRechargeFields, { ok: false, error: "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN" });

  const previewEmpty = validateActionPayload("DOCUMENT_PREVIEW", "CANCEL", {});
  assert.equal(previewEmpty.ok, true, previewEmpty.error);
  const previewWithRechargeFields = validateActionPayload("DOCUMENT_PREVIEW", "CANCEL", { pack_id: "PACK_1000", payment_reference: "REF-1" });
  assert.deepEqual(previewWithRechargeFields, { ok: false, error: "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN" });
});

// GENERATION_CONFIRMATION-001 (T4 candidate, NOT fixed in this mission):
// kadi_generation_confirmation_v1.json's single Footer always submits
// quote_id, regardless of whether the chosen action is CONFIRM_GENERATION
// or CANCEL — but ACTION_FIELDS.CANCEL is [], so a real
// GENERATION_CONFIRMATION/CANCEL submission fails with
// KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN today, same defect class as
// RECHARGE-CONTRACT-001. Recorded here only to document current, still
// broken behavior — deliberately left unfixed, per the explicit T3 scope
// boundary (see docs/KADI_ENGINEERING_MEMORY.md for the T4 backlog entry).
test("GENERATION_CONFIRMATION-001 (recorded, not fixed in T3): the real GENERATION_CONFIRMATION/CANCEL submission still fails — left broken on purpose, out of T3 scope", () => {
  const result = validateActionPayload("GENERATION_CONFIRMATION", "CANCEL", { quote_id: "quote:1" });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN" });
});

test("Flow/backend parity: submitting every field the real kadi_recharge_v1.json contract declares — exactly as Meta really submits a Flow form, blank fields included — is accepted for all three real declared actions", () => {
  const rechargeFlow = require("../flows/v1_draft/kadi_recharge_v1.json");
  const screen = rechargeFlow.screens[0];
  const footerPayload = screen.layout.children.find((child) => child.type === "Form")
    .children.find((child) => child.type === "Footer")["on-click-action"].payload;
  const submittedFields = Object.keys(footerPayload.data);
  assert.ok(submittedFields.includes("pack_id") && submittedFields.includes("payment_reference"), "kadi_recharge_v1.json must still declare pack_id and payment_reference — this test must keep reproducing the real contract, not a hand-picked subset");
  const declaredActionIds = screen.data.recharge_actions.__example__.map((entry) => entry.id);
  assert.deepEqual(declaredActionIds.sort(), ["CANCEL", "CHECK_PAYMENT", "SELECT_PACK"].sort());
  for (const action of declaredActionIds) {
    const realSubmission = Object.fromEntries(submittedFields.map((field) => [field, ""]));
    const checked = validateActionPayload(screen.id, action, realSubmission);
    assert.equal(checked.ok, true, `RECHARGE's real full submission shape must be accepted for declared action "${action}" (got ${checked.error})`);
  }
});
