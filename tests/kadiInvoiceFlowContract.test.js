"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MAX_RESPONSE_JSON_BYTES, isInvoiceFlowReply, normalizeInvoiceFlowSubmission, parseInvoiceFlowReply, parseInvoiceFlowResponseJson } = require("../kadiInvoiceFlowContract");

const flowPath = path.join(__dirname, "..", "flows", "kadi_facture_v1.json");
const loadFlow = () => JSON.parse(fs.readFileSync(flowPath, "utf8"));

function flatten(values) {
  return values.flatMap((value) => [value, ...flatten(value.children || []), ...flatten(value.then || []), ...flatten(value.else || [])]);
}

function components(flow) {
  return flow.screens.flatMap((screen) => flatten(screen.layout.children));
}

test("dynamic KADI_FACTURE_V1 uses current project Flow contract and five screens", () => {
  const flow = loadFlow();
  assert.equal(flow.version, "7.3");
  assert.equal(flow.data_api_version, "3.0");
  assert.deepEqual(flow.screens.map(({ id }) => id), ["CLIENT", "ARTICLE", "ARTICLE_DECISION", "OPTIONS", "DOCUMENT_ESTIMATE"]);
  assert.deepEqual(flow.routing_model, {
    CLIENT: ["ARTICLE"], ARTICLE: ["ARTICLE_DECISION"], ARTICLE_DECISION: ["ARTICLE", "OPTIONS"], OPTIONS: ["DOCUMENT_ESTIMATE"], DOCUMENT_ESTIMATE: [],
  });
});

test("Flow UI uses supported selectors, unique fields and visible footers", () => {
  const flow = loadFlow();
  const all = components(flow);
  const named = all.filter((component) => typeof component.name === "string");
  assert.equal(new Set(named.map(({ name }) => name)).size, named.length);
  assert.equal(named.find(({ name }) => name === "client_type").type, "RadioButtonsGroup");
  const unit = named.find(({ name }) => name === "item_unit");
  assert.equal(unit.type, "Dropdown");
  assert.equal(Object.hasOwn(unit, "on-select-action"), false);
  for (const screen of flow.screens) {
    assert.ok(flatten(screen.layout.children).some(({ type }) => type === "Footer"), screen.id);
  }
  for (const component of all) {
    assert.equal(Object.hasOwn(component, "init-value"), false);
    assert.equal(Object.hasOwn(component, "placeholder"), false);
  }
});

test("all dynamic navigation is data_exchange and contains no phone-side totals", () => {
  const flow = loadFlow();
  const source = fs.readFileSync(flowPath, "utf8");
  const footers = components(flow).filter(({ type }) => type === "Footer");
  assert.deepEqual(footers.slice(0, -1).map((footer) => footer["on-click-action"].name), ["data_exchange", "data_exchange", "data_exchange", "data_exchange"]);
  assert.equal(footers.at(-1)["on-click-action"].name, "complete");
  assert.doesNotMatch(source, /endpoint_uri|WHATSAPP_TOKEN|APP_SECRET|OPENAI_API_KEY|SUPABASE_SERVICE/i);
  for (const footer of footers) {
    assert.ok(Object.keys(footer["on-click-action"].payload || {}).every((key) => !/subtotal|grand_total|tax_total|balance_due|line_total/.test(key)));
  }
});

test("screen data declarations have type-compatible examples", () => {
  for (const screen of loadFlow().screens) {
    for (const [key, definition] of Object.entries(screen.data || {})) {
      assert.ok(Object.hasOwn(definition, "__example__"), `${screen.id}.${key}`);
      assert.equal(typeof definition.__example__, definition.type, `${screen.id}.${key}`);
      if (definition.type === "number") assert.equal(Number.isFinite(definition.__example__), true);
    }
  }
});

test("nfm_reply legacy parser remains available in parallel", () => {
  const payload = { client_type: "individual", client_name: "Awa", item_1_designation: "Service", item_1_quantity: 1, item_1_unit: "service", item_1_unit_price: 1000, tax_status: "not_applicable", discount_amount: 0, amount_paid: 0, add_stamp: "no" };
  const message = { type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { response_json: JSON.stringify(payload) } } };
  assert.equal(isInvoiceFlowReply(message), true);
  assert.equal(parseInvoiceFlowReply(message).ok, true);
  assert.equal(normalizeInvoiceFlowSubmission(payload).ok, true);
});

test("legacy response parser remains fail-closed", () => {
  assert.equal(parseInvoiceFlowResponseJson("{").error, "RESPONSE_JSON_INVALID");
  assert.equal(parseInvoiceFlowResponseJson("null").error, "RESPONSE_ROOT_INVALID");
  assert.equal(parseInvoiceFlowResponseJson("[]").error, "RESPONSE_ROOT_INVALID");
  assert.equal(parseInvoiceFlowResponseJson('{"__proto__":{"polluted":true}}').error, "FORBIDDEN_FIELD");
  assert.equal(parseInvoiceFlowResponseJson('{"unknown":"x"}').error, "UNKNOWN_FIELD");
  assert.equal(parseInvoiceFlowResponseJson('{"prototype":true}').error, "FORBIDDEN_FIELD");
  assert.equal(parseInvoiceFlowResponseJson('{"constructor":true}').error, "FORBIDDEN_FIELD");
  assert.equal(parseInvoiceFlowResponseJson(`{"client_name":"${"x".repeat(MAX_RESPONSE_JSON_BYTES)}"}`).error, "RESPONSE_JSON_TOO_LARGE");
  assert.equal(isInvoiceFlowReply({ type: "interactive", interactive: { type: "nfm_reply" } }), false);
});
