"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const {
  FLOW_MONITORING_EVENTS,
  createWhatsAppWebhookReceiver,
  dispatchWhatsAppWebhook,
  handleFlowMonitoringChange,
} = require("../kadiFlowMonitoringWebhook");

function flowBody(event, message = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-123",
      changes: [{ field: "flows", value: { event, message } }],
    }],
  };
}

function dependencies(overrides = {}) {
  const calls = { statuses: 0, messages: 0, logs: [], errors: [] };
  return {
    calls,
    value: {
      extractStatusesFromWebhookValue: () => { calls.statuses += 1; return []; },
      handleIncomingStatuses: async () => { calls.statuses += 1; },
      handleIncomingMessage: async () => { calls.messages += 1; },
      invoiceFlowTrigger: { marker: "trigger" },
      invoiceFlowCompletion: { marker: "completion" },
      kadiV1WebhookHandler: null,
      logger: {
        log: (label, record) => calls.logs.push({ label, record }),
        error: (...args) => calls.errors.push(args),
      },
      ...overrides,
    },
  };
}

async function postJson(app, body) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    return await new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body));
      const request = http.request({
        host: "127.0.0.1",
        port: address.port,
        path: "/webhook",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": payload.length },
      }, (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { responseBody += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body: responseBody }));
      });
      request.on("error", reject);
      request.end(payload);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("flows monitoring webhook returns HTTP 200 and never enters conversational routing", async () => {
  const fake = dependencies();
  const app = express();
  app.post("/webhook", express.json(), createWhatsAppWebhookReceiver(fake.value));
  const response = await postJson(app, flowBody("ENDPOINT_AVAILABILITY", {
    flow_id: "flow-456",
    alert_state: "ACTIVATED",
    threshold: 95,
    phone: "22670000000",
    invoice: "sensitive",
  }));

  assert.equal(response.status, 200);
  assert.equal(response.body, "EVENT_RECEIVED");
  assert.equal(fake.calls.statuses, 0);
  assert.equal(fake.calls.messages, 0);
  assert.equal(fake.calls.errors.length, 0);
  assert.equal(fake.calls.logs.length, 1);
  assert.deepEqual(fake.calls.logs[0], {
    label: "KADI_FLOW_MONITORING_WEBHOOK",
    record: {
      waba_ref: "waba-123",
      flow_ref: "flow-456",
      event: "ENDPOINT_AVAILABILITY",
      alert_state: "ACTIVATED",
      new_status: null,
      threshold: 95,
      error_type: null,
      handled: true,
    },
  });
  assert.doesNotMatch(JSON.stringify(fake.calls.logs), /22670000000|sensitive/);
});

test("known Flow monitoring events and an unknown event are acknowledged safely", () => {
  assert.deepEqual([...FLOW_MONITORING_EVENTS], [
    "FLOW_STATUS_CHANGE",
    "CLIENT_ERROR_RATE",
    "ENDPOINT_ERROR_RATE",
    "ENDPOINT_LATENCY",
    "ENDPOINT_AVAILABILITY",
    "FLOW_VERSION_EXPIRY_WARNING",
  ]);

  for (const [event, known] of [
    ["FLOW_STATUS_CHANGE", true],
    ["ENDPOINT_AVAILABILITY", true],
    ["FUTURE_FLOW_EVENT", false],
  ]) {
    const fake = dependencies();
    const body = flowBody(event, { flow_id: "flow-456", new_status: "PUBLISHED", error_type: "NONE" });
    const result = handleFlowMonitoringChange({ entry: body.entry[0], change: body.entry[0].changes[0], logger: fake.value.logger });
    assert.deepEqual(result, { handled: true, known_event: known });
    assert.equal(fake.calls.logs[0].record.event, event);
  }
});

test("ordinary messages and nfm_reply still reach the existing incoming-message boundary", async () => {
  const received = [];
  const fake = dependencies({
    handleIncomingMessage: async (value, options) => received.push({ value, options }),
  });
  const ordinary = { object: "whatsapp_business_account", entry: [{ id: "waba-123", changes: [{ field: "messages", value: { messages: [{ type: "text", text: { body: "Bonjour" } }] } }] }] };
  const completion = { object: "whatsapp_business_account", entry: [{ id: "waba-123", changes: [{ field: "messages", value: { messages: [{ type: "interactive", interactive: { type: "nfm_reply" } }] } }] }] };

  dispatchWhatsAppWebhook(ordinary, fake.value);
  dispatchWhatsAppWebhook(completion, fake.value);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(received.length, 2);
  assert.equal(received[0].value.messages[0].type, "text");
  assert.equal(received[1].value.messages[0].interactive.type, "nfm_reply");
  assert.equal(received[1].options.invoiceFlowCompletion, fake.value.invoiceFlowCompletion);
});


test("V1 webhook handling runs before legacy routing and returns immediately when handled", async () => {
  const order = [];
  const fake = dependencies({
    kadiV1WebhookHandler: async () => { order.push("v1"); return { handled: true }; },
    handleIncomingMessage: async () => { order.push("legacy"); },
  });
  const body = { object: "whatsapp_business_account", entry: [{ id: "waba-123", changes: [{ field: "messages", value: { messages: [{ type: "text", text: { body: "Bonjour" } }] } }] }] };
  dispatchWhatsAppWebhook(body, fake.value);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["v1"]);
});

test("disabled or non-applicable V1 routing falls through to the unchanged legacy handler", async () => {
  const order = [];
  const fake = dependencies({
    kadiV1WebhookHandler: async () => { order.push("v1"); return { handled: false }; },
    handleIncomingMessage: async () => { order.push("legacy"); },
  });
  const body = { object: "whatsapp_business_account", entry: [{ id: "waba-123", changes: [{ field: "messages", value: { messages: [{ type: "text", text: { body: "Bonjour" } }] } }] }] };
  dispatchWhatsAppWebhook(body, fake.value);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["v1", "legacy"]);
});

test("a terminal V1 block never falls through to the legacy engine", async () => {
  const order = [];
  const fake = dependencies({
    kadiV1WebhookHandler: async () => {
      order.push("v1");
      return {
        handled: false,
        terminal: true,
        reason: "KADI_V1_PRODUCTION_COMPOSITION_BLOCKED",
      };
    },
    handleIncomingMessage: async () => {
      order.push("legacy");
    },
  });
  const body = {
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-123",
      changes: [{
        field: "messages",
        value: {
          messages: [{
            id: "wamid.terminal.secret",
            from: "22670626055",
            type: "text",
            text: { body: "Bonjour Kadi" },
          }],
        },
      }],
    }],
  };

  dispatchWhatsAppWebhook(body, fake.value);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(order, ["v1"]);
  const decision = fake.calls.logs.find(
    (entry) => entry.label === "KADI_V1_WEBHOOK_DECISION"
  );
  assert.ok(decision);
  assert.equal(decision.record.handled, false);
  assert.equal(decision.record.terminal, true);
  assert.equal(
    decision.record.reason,
    "KADI_V1_PRODUCTION_COMPOSITION_BLOCKED"
  );
  assert.match(decision.record.message_ref, /^[a-f0-9]{12}$/);
  assert.doesNotMatch(
    JSON.stringify(decision),
    /wamid\.terminal\.secret|22670626055|Bonjour Kadi/
  );
});

test("V1 handler failure is absorbed and never triggers a second legacy response", async () => {
  const order = [];
  const fake = dependencies({
    kadiV1WebhookHandler: async () => { order.push("v1"); throw Object.assign(new Error("secret"), { code: "V1_FAILED" }); },
    handleIncomingMessage: async () => { order.push("legacy"); },
  });
  const body = { object: "whatsapp_business_account", entry: [{ id: "waba-123", changes: [{ field: "messages", value: { messages: [{ type: "interactive", interactive: { type: "nfm_reply" } }] } }] }] };
  dispatchWhatsAppWebhook(body, fake.value);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["v1"]);
  assert.equal(fake.calls.errors.length, 1);
  assert.deepEqual(fake.calls.errors[0], ["kadiV1WebhookHandler", { code: "V1_FAILED" }]);
  assert.doesNotMatch(JSON.stringify(fake.calls.errors), /secret/);
});
