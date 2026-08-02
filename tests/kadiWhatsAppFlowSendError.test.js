"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.WHATSAPP_TOKEN ||= "synthetic-token";
process.env.PHONE_NUMBER_ID ||= "123456";

const axios = require("axios");
const { buildMetaApiError, redactFlowDiagnosticValue, safeFlowSendErrorLog, sendFlow } = require("../whatsappApi");

test("Flow send diagnostics retain Meta fields and redact secrets", () => {
  const error = buildMetaApiError({
    response: {
      status: 400,
      data: {
        error: {
          type: "OAuthException",
          code: 131009,
          error_subcode: 2494010,
          message: "Parameter value is not valid for 22670000012",
          error_data: { details: "flow_token=kadi_invoice_v1:abcdef0123456789abcdef0123456789:1785637860000 draft_id=draft-secret" },
          error_user_title: "Invalid flow parameter",
          error_user_msg: "Bearer secret-value cannot be used",
          fbtrace_id: "trace-safe-123",
        },
      },
    },
  });
  const safe = safeFlowSendErrorLog(error, {
    flow_id: "1972040430119125",
    target_screen: "CLIENT",
    mode: "draft",
  });

  assert.deepEqual({ status: safe.status, type: safe.type, code: safe.code, error_subcode: safe.error_subcode }, {
    status: 400, type: "OAuthException", code: 131009, error_subcode: 2494010,
  });
  assert.equal(safe.flow_id, "1972040430119125");
  assert.equal(safe.target_screen, "CLIENT");
  assert.equal(safe.mode, "draft");
  assert.equal(safe.fbtrace_id, "trace-safe-123");
  assert.match(safe.details, /flow_token=\[REDACTED\]/);
  assert.match(safe.details, /draft_id=\[REDACTED\]/);
  assert.match(safe.error_user_msg, /Bearer \[REDACTED\]/);
  assert.match(safe.message, /REDACTED_NUMBER/);
  assert.doesNotMatch(JSON.stringify(safe), /22670000012|abcdef0123456789abcdef0123456789|draft-secret|secret-value/);
});

test("sendFlow logs only safe metadata while preserving the human caller error path", async () => {
  const originalPost = axios.post;
  const originalError = console.error;
  const logs = [];
  axios.post = async () => {
    const error = new Error("request failed");
    error.response = { status: 400, data: { error: {
      type: "OAuthException", code: 131009, message: "Parameter value is not valid",
      error_data: { details: "flow_token=kadi_invoice_v1:abcdef0123456789abcdef0123456789:1785637860000" },
      fbtrace_id: "trace-safe-456",
    } } };
    throw error;
  };
  console.error = (...args) => logs.push(args);
  try {
    await assert.rejects(sendFlow({
      messaging_product: "whatsapp", to: "22670000012", type: "interactive",
      interactive: { type: "flow", action: { name: "flow", parameters: {
        flow_id: "1972040430119125", mode: "draft", flow_token: "not-logged",
        flow_action_payload: { screen: "CLIENT", data: { draft_id: "not-logged" } },
      } } },
    }), /131009/);
  } finally {
    axios.post = originalPost;
    console.error = originalError;
  }

  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], "[WA/ERROR/sendFlow]");
  assert.equal(logs[0][2].code, 131009);
  assert.equal(logs[0][2].target_screen, "CLIENT");
  assert.equal(logs[0][2].mode, "draft");
  assert.doesNotMatch(JSON.stringify(logs), /22670000012|not-logged|abcdef0123456789abcdef0123456789/);
});

test("Flow diagnostic redaction is bounded, recursive and fail-closed", () => {
  const circular = { details: "safe" };
  circular.self = circular;
  const hostile = Object.create(null);
  Object.defineProperty(hostile, "unsafe", { get() { throw new Error("must not execute"); } });
  const nested = {
    public: "kept",
    private: {
      authorization: "Bearer nested-secret",
      headers: { authorization: "Bearer header-secret" },
      payload: { to: "22670000012", client: "Issa", address: "Ouagadougou", email: "issa@example.test", articles: ["secret item"] },
      values: ["flow_token=kadi_invoice_v1:abcdef0123456789abcdef0123456789:1785637860000", "draft_id=draft-secret"],
    },
  };
  const combined = redactFlowDiagnosticValue(nested);
  const bounded = redactFlowDiagnosticValue("x".repeat(10_000));
  const controls = redactFlowDiagnosticValue("line1\r\nline2\u0000Bearer secret-value");
  const circularResult = redactFlowDiagnosticValue(circular);
  const hostileResult = redactFlowDiagnosticValue(hostile);

  assert.equal(combined.includes("nested-secret"), false);
  assert.equal(combined.includes("header-secret"), false);
  assert.equal(combined.includes("22670000012"), false);
  assert.equal(combined.includes("Issa"), false);
  assert.equal(combined.includes("Ouagadougou"), false);
  assert.equal(combined.includes("issa@example.test"), false);
  assert.equal(combined.includes("secret item"), false);
  assert.equal(combined.includes("abcdef0123456789abcdef0123456789"), false);
  assert.equal(combined.includes("draft-secret"), false);
  assert.ok(bounded.length <= 500);
  assert.doesNotMatch(controls, /[\u0000-\u001f\u007f-\u009f]/);
  assert.doesNotMatch(controls, /secret-value/);
  assert.match(circularResult, /REDACTED_CIRCULAR/);
  assert.match(hostileResult, /REDACTED_ACCESSOR/);
});

test("partial, network and non-JSON Meta errors stay controlled", () => {
  const partial = safeFlowSendErrorLog(buildMetaApiError({ response: { status: 400, data: { error: { code: 131009, message: "Invalid" } } } }));
  assert.equal(partial.status, 400);
  assert.equal(partial.code, 131009);
  assert.equal(partial.details, null);
  assert.equal(partial.error_subcode, null);

  const network = safeFlowSendErrorLog(buildMetaApiError(new Error("network failure\nAuthorization: Bearer network-secret")));
  assert.equal(network.status, 500);
  assert.doesNotMatch(network.message, /network-secret|\n/);

  const nonJson = safeFlowSendErrorLog(buildMetaApiError({ message: "bad gateway", response: { status: 502, data: "not-json" } }));
  assert.equal(nonJson.status, 502);
  assert.equal(nonJson.code, null);
  assert.equal(nonJson.message, "bad gateway");

  const hostileError = {};
  Object.defineProperty(hostileError, "meta", { get() { throw new Error("must not execute"); } });
  assert.doesNotThrow(() => safeFlowSendErrorLog(hostileError));
  assert.equal(safeFlowSendErrorLog(hostileError).message, "META_SEND_FAILED");
});
