"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { FLOW_KEYS } = require("../kadiV1FlowRouter");
const { FLOW_ENV_KEYS } = require("../kadiV1RuntimeConfig");
const { FLOW_ACTIONS } = require("../kadiV1FlowReplyRuntime");
const { KADI_V1_DRAFT_FLOW_CATALOG } = require("../kadiV1DraftFlowCatalog");

const ROOT = path.resolve(__dirname, "..");
const VISIBLE_KEYS = new Set(["title", "label", "text", "helper-text"]);
const FORBIDDEN_VISIBLE = /(?:créer guidé|vérifier le client|soumettre|tapez menu|\bflow\b|payload|session|openai|gemini|ocr|endpoint)/i;
const FORBIDDEN_INPUT_NAMES = new Set([
  "owner_wa_id", "ownerWaId", "document_version", "version", "status", "issued_at",
  "document_number", "subtotal", "total", "tax_amount", "page_count", "cost",
  "credits", "balance", "flow_id", "flow_token", "draft_id", "meta_flow_id",
]);

function readFlow(key) {
  const entry = KADI_V1_DRAFT_FLOW_CATALOG[key];
  const absolute = path.join(ROOT, entry.file);
  return { entry, absolute, json: JSON.parse(fs.readFileSync(absolute, "utf8")) };
}

function walk(value, visitor, parent = null) {
  if (!value || typeof value !== "object") return;
  visitor(value, parent);
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visitor, value);
    return;
  }
  for (const child of Object.values(value)) walk(child, visitor, value);
}

function collectVisibleStrings(value) {
  const strings = [];
  function visit(node) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    for (const [key, candidate] of Object.entries(node)) {
      if (VISIBLE_KEYS.has(key) && typeof candidate === "string" && !candidate.startsWith("${")) strings.push(candidate);
    }
  }
  walk(value, visit);
  return strings;
}

function footerFor(flow) {
  const footers = [];
  walk(flow, (node) => { if (node?.type === "Footer") footers.push(node); });
  assert.equal(footers.length, 1);
  return footers[0];
}

function dynamicActionIds(screen) {
  const actionControl = [];
  walk(screen.layout, (node) => {
    if (["RadioButtonsGroup", "Dropdown"].includes(node?.type) && node.name === "action") actionControl.push(node);
  });
  assert.equal(actionControl.length, 1);
  const binding = actionControl[0]["data-source"];
  const match = /^\$\{data\.([A-Za-z0-9_]+)\}$/.exec(binding || "");
  assert.ok(match, "dynamic action must use declared screen data");
  const examples = screen.data?.[match[1]]?.__example__;
  assert.ok(Array.isArray(examples));
  return examples.map((item) => item.id);
}

test("draft catalog covers every closed runtime flow key exactly once", () => {
  assert.deepEqual(Object.keys(KADI_V1_DRAFT_FLOW_CATALOG), FLOW_KEYS);
  assert.deepEqual(Object.keys(FLOW_ENV_KEYS), FLOW_KEYS);
  const files = Object.values(KADI_V1_DRAFT_FLOW_CATALOG).map((entry) => entry.file);
  assert.equal(new Set(files).size, FLOW_KEYS.length);
});

test("all draft files use the locked one-screen Flow JSON contract", () => {
  for (const key of FLOW_KEYS) {
    const { entry, absolute, json } = readFlow(key);
    assert.ok(fs.existsSync(absolute), `${key} file missing`);
    assert.equal(json.version, "7.3");
    assert.equal(Object.hasOwn(json, "data_api_version"), false);
    assert.deepEqual(Object.keys(json.routing_model), [key]);
    assert.deepEqual(json.routing_model[key], []);
    assert.equal(json.screens.length, 1);
    const screen = json.screens[0];
    assert.equal(screen.id, key);
    assert.equal(screen.terminal, true);
    assert.equal(screen.layout?.type, "SingleColumnLayout");
    assert.equal(screen.data?.session_id?.type, "string");
    assert.equal(entry.environment_variable, FLOW_ENV_KEYS[key]);
  }
});

test("each Flow completes with the secure webhook envelope and allowed actions", () => {
  for (const key of FLOW_KEYS) {
    const { json } = readFlow(key);
    const screen = json.screens[0];
    const footer = footerFor(json);
    assert.equal(footer["on-click-action"]?.name, "complete");
    const payload = footer["on-click-action"].payload;
    assert.deepEqual(Object.keys(payload), ["session_id", "flow_key", "action", "data"]);
    assert.equal(payload.session_id, "${data.session_id}");
    assert.equal(payload.flow_key, key);
    assert.equal(typeof payload.data, "object");
    assert.ok(!Array.isArray(payload.data));
    if (payload.action === "${form.action}") {
      const ids = dynamicActionIds(screen);
      assert.ok(ids.length > 0);
      for (const action of ids) assert.ok(FLOW_ACTIONS[key].includes(action), `${key}:${action}`);
    } else {
      assert.ok(FLOW_ACTIONS[key].includes(payload.action), `${key}:${payload.action}`);
    }
  }
});

test("forms are direct, simple and never collect server-authoritative fields", () => {
  for (const key of FLOW_KEYS) {
    const { json } = readFlow(key);
    const screen = json.screens[0];
    const forms = [];
    walk(screen.layout, (node, parent) => {
      if (node?.type === "Form") forms.push({ node, parent });
      if (node && typeof node === "object" && !Array.isArray(node)) {
        assert.equal(Object.hasOwn(node, "init-value"), false, `${key} contains init-value`);
        if (typeof node.name === "string") assert.equal(FORBIDDEN_INPUT_NAMES.has(node.name), false, `${key}:${node.name}`);
      }
    });
    assert.ok(forms.length <= 1, `${key} has multiple forms`);
    for (const { node } of forms) assert.ok(screen.layout.children.includes(node), `${key} form must be a direct layout child`);
  }
});

test("visible French copy stays natural and hides technical boundaries", () => {
  for (const key of FLOW_KEYS) {
    const { json, entry } = readFlow(key);
    for (const text of collectVisibleStrings(json)) assert.equal(FORBIDDEN_VISIBLE.test(text), false, `${key}: ${text}`);
    for (const text of Object.values(entry.card)) {
      assert.equal(typeof text, "string");
      assert.equal(FORBIDDEN_VISIBLE.test(text), false, `${key}: ${text}`);
    }
    assert.ok(entry.card.cta.length <= 30, `${key} CTA too long`);
  }
});

test("draft assets contain no Meta ids, stamps or manual issue dates", () => {
  for (const key of FLOW_KEYS) {
    const { json } = readFlow(key);
    const encoded = JSON.stringify(json);
    assert.equal(/\b\d{15,20}\b/.test(encoded), false, `${key} contains a Meta-like id`);
    assert.equal(/tampon|stamp|issued_at/i.test(encoded), false, `${key} contains a forbidden product field`);
  }
});
