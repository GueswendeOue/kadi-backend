"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FLOW_KEYS } = require("../kadiV1FlowRouter");
const { FLOW_ENV_KEYS } = require("../kadiV1RuntimeConfig");
const { FLOW_ACTIONS } = require("../kadiV1FlowReplyRuntime");
const { KADI_V1_DRAFT_FLOW_CATALOG } = require("../kadiV1DraftFlowCatalog");
const { loadFlowRegistry } = require("../kadiV1ProductionPresenter");

const ROOT = path.resolve(__dirname, "..");
// DOCUMENT_CONTENT is the only Flow allowed to relax the locked one-screen
// contract: it stays a single flow_key but opens either its decision screen
// or the ARTICLE_FORM item-entry screen, both terminal and complete-only.
const MULTI_SCREEN_FLOWS = Object.freeze({
  DOCUMENT_CONTENT: Object.freeze(["DOCUMENT_CONTENT", "ARTICLE_FORM"]),
});
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

function footerFor(screen) {
  const footers = [];
  walk(screen, (node) => { if (node?.type === "Footer") footers.push(node); });
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

test("all draft files except DOCUMENT_CONTENT use the locked one-screen Flow JSON contract", () => {
  for (const key of FLOW_KEYS) {
    if (Object.hasOwn(MULTI_SCREEN_FLOWS, key)) continue;
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

test("DOCUMENT_CONTENT uses its targeted two-screen contract: DOCUMENT_CONTENT and ARTICLE_FORM, both terminal and complete-only", () => {
  const { entry, absolute, json } = readFlow("DOCUMENT_CONTENT");
  const expectedScreenIds = MULTI_SCREEN_FLOWS.DOCUMENT_CONTENT;
  assert.ok(fs.existsSync(absolute), "DOCUMENT_CONTENT file missing");
  assert.equal(json.version, "7.3");
  assert.equal(Object.hasOwn(json, "data_api_version"), false);
  assert.deepEqual(Object.keys(json.routing_model).sort(), [...expectedScreenIds].sort());
  for (const screenId of expectedScreenIds) assert.deepEqual(json.routing_model[screenId], []);
  assert.equal(json.screens.length, expectedScreenIds.length);
  assert.deepEqual(json.screens.map((screen) => screen.id).sort(), [...expectedScreenIds].sort());
  for (const screenId of expectedScreenIds) {
    const screen = json.screens.find((candidate) => candidate.id === screenId);
    assert.ok(screen, `${screenId} screen missing`);
    assert.equal(screen.terminal, true, `${screenId} must be terminal`);
    assert.equal(screen.layout?.type, "SingleColumnLayout");
    assert.equal(screen.data?.session_id?.type, "string", `${screenId} must declare session_id`);
    const footer = footerFor(screen);
    assert.equal(footer["on-click-action"]?.name, "complete", `${screenId} must complete, never navigate`);
  }
  assert.equal(entry.environment_variable, FLOW_ENV_KEYS.DOCUMENT_CONTENT);

  // No EmbeddedLink and no navigate anywhere in this relaxed Flow.
  const encoded = JSON.stringify(json);
  assert.doesNotMatch(encoded, /EmbeddedLink/);
  assert.doesNotMatch(encoded, /"name"\s*:\s*"navigate"/);
});

test("DOCUMENT_CONTENT registry loading rejects a third screen, a wrong id, a non-terminal screen and a missing session_id", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kadi-v1-document-content-contract-"));
  for (const flowEntry of Object.values(KADI_V1_DRAFT_FLOW_CATALOG)) {
    const source = path.join(ROOT, flowEntry.file);
    const target = path.join(tempRoot, flowEntry.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  const targetFile = path.join(tempRoot, KADI_V1_DRAFT_FLOW_CATALOG.DOCUMENT_CONTENT.file);
  const base = JSON.parse(fs.readFileSync(targetFile, "utf8"));

  function writeAndExpectRejection(mutate, label) {
    const mutated = mutate(JSON.parse(JSON.stringify(base)));
    fs.writeFileSync(targetFile, JSON.stringify(mutated), "utf8");
    assert.throws(() => loadFlowRegistry(tempRoot), /KADI_V1_FLOW_ENTRY_CONTRACT_INVALID:DOCUMENT_CONTENT/, label);
  }

  writeAndExpectRejection((json) => {
    json.screens.push({ ...json.screens[1], id: "EXTRA_SCREEN" });
    json.routing_model.EXTRA_SCREEN = [];
    return json;
  }, "third screen must be rejected");

  writeAndExpectRejection((json) => {
    json.screens[1].id = "WRONG_ID";
    delete json.routing_model.ARTICLE_FORM;
    json.routing_model.WRONG_ID = [];
    return json;
  }, "unauthorized screen id must be rejected");

  writeAndExpectRejection((json) => {
    json.screens[1].terminal = false;
    return json;
  }, "non-terminal screen must be rejected");

  writeAndExpectRejection((json) => {
    delete json.screens[1].data.session_id;
    return json;
  }, "screen missing session_id must be rejected");

  fs.writeFileSync(targetFile, JSON.stringify(base), "utf8");
  assert.doesNotThrow(() => loadFlowRegistry(tempRoot), "unmodified fixture must still load");
});

test("each Flow completes with the secure webhook envelope and allowed actions", () => {
  for (const key of FLOW_KEYS) {
    const { json } = readFlow(key);
    for (const screen of json.screens) {
      const footer = footerFor(screen);
      assert.equal(footer["on-click-action"]?.name, "complete");
      const payload = footer["on-click-action"].payload;
      assert.deepEqual(Object.keys(payload), ["session_id", "flow_key", "action", "data"]);
      assert.equal(payload.session_id, "${data.session_id}");
      assert.equal(payload.flow_key, key, `${screen.id} must send flow_key=${key}`);
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
  }
});

test("forms are direct, simple and never collect server-authoritative fields", () => {
  for (const key of FLOW_KEYS) {
    const { json } = readFlow(key);
    for (const screen of json.screens) {
      const forms = [];
      walk(screen.layout, (node, parent) => {
        if (node?.type === "Form") forms.push({ node, parent });
        if (node && typeof node === "object" && !Array.isArray(node)) {
          assert.equal(Object.hasOwn(node, "init-value"), false, `${key}:${screen.id} contains init-value`);
          if (typeof node.name === "string") assert.equal(FORBIDDEN_INPUT_NAMES.has(node.name), false, `${key}:${screen.id}:${node.name}`);
        }
      });
      assert.ok(forms.length <= 1, `${key}:${screen.id} has multiple forms`);
      for (const { node } of forms) assert.ok(screen.layout.children.includes(node), `${key}:${screen.id} form must be a direct layout child`);
    }
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
