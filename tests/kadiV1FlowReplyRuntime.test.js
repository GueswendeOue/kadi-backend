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
