"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MAX_RESPONSE_JSON_BYTES, isInvoiceFlowReply, normalizeInvoiceFlowSubmission, parseInvoiceFlowReply, parseInvoiceFlowResponseJson } = require("../kadiInvoiceFlowContract");

const flowPath = path.join(__dirname, "..", "flows", "kadi_facture_v1.json");
const loadFlow = () => JSON.parse(fs.readFileSync(flowPath, "utf8"));
const ENTRY_SCREENS = ["CLIENT", "ARTICLE_ENTRY", "OPTIONS", "REVIEW_INVOICE_DRAFT", "EDIT_CLIENT", "EDIT_ITEMS", "EDIT_OPTIONS"];

function flatten(values) {
  return values.flatMap((value) => [
    value,
    ...flatten(value.children || []),
    ...flatten(value.then || []),
    ...flatten(value.else || []),
    ...flatten((value.cases || []).flatMap((entry) => entry.children || entry.then || [])),
  ]);
}

function components(flow) {
  return flow.screens.flatMap((screen) => flatten(screen.layout.children));
}

function validateRoutingGraph(flow, expectedEntries = ENTRY_SCREENS) {
  const ids = new Set(flow.screens.map(({ id }) => id));
  const routes = flow.routing_model || {};
  if ([...ids].some((id) => !Object.hasOwn(routes, id))) return { ok: false, error: "ROUTE_MISSING" };
  const inbound = new Map([...ids].map((id) => [id, 0]));
  for (const [from, targets] of Object.entries(routes)) {
    if (!ids.has(from)) return { ok: false, error: "ROUTE_SOURCE_UNKNOWN" };
    for (const target of targets) {
      if (!ids.has(target)) return { ok: false, error: "ROUTE_TARGET_UNKNOWN" };
      if (target === from) return { ok: false, error: "ROUTE_SELF_CYCLE" };
      inbound.set(target, inbound.get(target) + 1);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const target of routes[id]) if (!visit(target)) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  }
  if ([...ids].some((id) => !visit(id))) return { ok: false, error: "ROUTE_CYCLE" };
  const entries = [...inbound].filter(([, count]) => count === 0).map(([id]) => id).sort();
  if (!expectedEntries || entries.join("\0") !== [...expectedEntries].sort().join("\0")) return { ok: false, error: "ENTRY_SCREENS_INVALID" };
  return { ok: true, entries };
}

function formsInConditionalBranches(values) {
  return flatten(values).flatMap((component) => {
    const branches = component.type === "If"
      ? [...(component.then || []), ...(component.else || [])]
      : component.type === "Switch"
        ? (component.cases || []).flatMap((entry) => entry.children || entry.then || [])
        : [];
    return flatten(branches).filter(({ type }) => type === "Form");
  });
}

test("KADI_FACTURE_V1 exposes only independent short-session entry screens", () => {
  const flow = loadFlow();
  assert.equal(flow.version, "7.3");
  assert.equal(flow.data_api_version, "3.0");
  assert.deepEqual(flow.screens.map(({ id }) => id), ENTRY_SCREENS);
  assert.deepEqual(validateRoutingGraph(flow), { ok: true, entries: [...ENTRY_SCREENS].sort() });
  assert.equal(Object.values(flow.routing_model).every((targets) => targets.length === 0), true);
  assert.equal(flow.routing_model.ARTICLE_ENTRY.includes("ARTICLE_ENTRY"), false);
  assert.deepEqual(flow.routing_model.REVIEW_INVOICE_DRAFT, []);
});

test("routing validator rejects unknown screens, self-routes, cycles and unexpected entries", () => {
  const synthetic = (routing) => ({ screens: Object.keys(routing).map((id) => ({ id })), routing_model: routing });
  assert.equal(validateRoutingGraph({ screens: [{ id: "A" }], routing_model: { A: ["MISSING"] } }, ["A"]).error, "ROUTE_TARGET_UNKNOWN");
  assert.equal(validateRoutingGraph(synthetic({ A: ["A"] }), []).error, "ROUTE_SELF_CYCLE");
  assert.equal(validateRoutingGraph(synthetic({ A: ["B"], B: ["A"] }), []).error, "ROUTE_CYCLE");
  assert.equal(validateRoutingGraph(synthetic({ A: [], B: [] }), ["A"]).error, "ENTRY_SCREENS_INVALID");
});

test("ARTICLE_ENTRY has one direct Form and fresh standalone input defaults", () => {
  const flow = loadFlow();
  const screen = flow.screens.find(({ id }) => id === "ARTICLE_ENTRY");
  assert.equal(screen.layout.children.filter(({ type }) => type === "Form").length, 1);
  const form = screen.layout.children.find(({ type }) => type === "Form");
  assert.equal(form.name, "article_form");
  assert.equal(form["init-values"], "${data.article_form_init_values}");
  assert.deepEqual(Object.keys(screen.data.article_form_init_values.properties), ["designation", "quantity", "unit_price"]);
  assert.deepEqual(screen.data.article_form_init_values.__example__, { designation: "", quantity: "1", unit_price: "" });
  assert.deepEqual(form.children.filter(({ name }) => name).map(({ name }) => name), ["designation", "quantity", "unit", "unit_price", "article_decision"]);
  assert.equal(form.children.find(({ name }) => name === "unit").type, "Dropdown");
  assert.equal(form.children.find(({ name }) => name === "article_decision").type, "RadioButtonsGroup");
  assert.deepEqual(form.children.find(({ name }) => name === "article_decision")["data-source"].map(({ id }) => id), ["add_another_item", "items_finished"]);
});

test("no Form is nested under If or Switch and no component uses init-value", () => {
  const flow = loadFlow();
  assert.deepEqual(formsInConditionalBranches(flow.screens.flatMap((screen) => screen.layout.children)), []);
  assert.equal(formsInConditionalBranches([{ type: "If", then: [{ type: "Form" }] }]).length, 1);
  assert.equal(formsInConditionalBranches([{ type: "If", else: [{ type: "Form" }] }]).length, 1);
  assert.equal(formsInConditionalBranches([{ type: "Switch", cases: [{ children: [{ type: "Form" }] }] }]).length, 1);
  assert.equal(components(flow).some((component) => Object.hasOwn(component, "init-value")), false);
  assert.equal(components(flow).some((component) => component.type !== "Form" && Object.hasOwn(component, "init-values")), false);
});

test("every screen terminates its short session with complete and safe payload identity", () => {
  const flow = loadFlow();
  for (const screen of flow.screens) {
    assert.equal(screen.terminal, true, screen.id);
    assert.equal(screen.success, true, screen.id);
    const footers = flatten(screen.layout.children).filter(({ type }) => type === "Footer");
    assert.equal(footers.length, 1, screen.id);
    assert.equal(footers[0]["on-click-action"].name, "complete", screen.id);
    assert.equal(footers[0]["on-click-action"].payload.flow_token, "${data.flow_token}", screen.id);
    assert.equal(footers[0]["on-click-action"].payload.draft_id, "${data.draft_id}", screen.id);
  }
  assert.equal(components(flow).some((component) => component["on-click-action"]?.name === "data_exchange"), false);
});

test("article screen uses human copy and returns complete add/finish outcomes", () => {
  const screen = loadFlow().screens.find(({ id }) => id === "ARTICLE_ENTRY");
  const all = flatten(screen.layout.children);
  assert.equal(screen.title, "Articles et services");
  assert.ok(all.some(({ text }) => text === "${data.item_number_text}"));
  assert.ok(all.some(({ text }) => text === "Qu’avez-vous vendu ou réalisé ?"));
  assert.equal(all.find(({ type }) => type === "Footer").label, "Ajouter cet article");
  assert.equal(all.find(({ type }) => type === "Footer")["on-click-action"].payload.outcome, "${form.article_decision}");
});

test("screen data examples and dynamic bindings are type-safe and declared", () => {
  const flow = loadFlow();
  const dynamic = /\$\{data\.([A-Za-z_][A-Za-z0-9_]*)\}/g;
  for (const screen of flow.screens) {
    for (const [key, definition] of Object.entries(screen.data || {})) {
      assert.ok(Object.hasOwn(definition, "__example__"), `${screen.id}.${key}`);
      const exampleType = Array.isArray(definition.__example__) ? "array" : typeof definition.__example__;
      assert.equal(exampleType, definition.type, `${screen.id}.${key}`);
    }
    for (const component of flatten(screen.layout.children)) {
      for (const value of Object.values(component)) {
        if (typeof value !== "string") continue;
        for (const match of value.matchAll(dynamic)) assert.ok(Object.hasOwn(screen.data, match[1]), `${screen.id}.${match[1]}`);
      }
    }
  }
});

test("EDIT_ITEMS targets a declared server-stable item without a client index", () => {
  const screen = loadFlow().screens.find(({ id }) => id === "EDIT_ITEMS");
  const all = flatten(screen.layout.children);
  const selector = all.find(({ name }) => name === "edit_item_id");
  const footer = all.find(({ type }) => type === "Footer");
  assert.equal(screen.data.editable_items.type, "array");
  assert.deepEqual(Object.keys(screen.data.editable_items.items.properties), ["id", "title"]);
  assert.equal(selector.type, "Dropdown");
  assert.equal(selector["data-source"], "${data.editable_items}");
  assert.equal(all.find(({ name }) => name === "edit_quantity").type, "TextInput");
  assert.equal(all.find(({ name }) => name === "edit_unit_price").type, "TextInput");
  assert.equal(footer["on-click-action"].payload.outcome, "item_corrected");
  assert.equal(footer["on-click-action"].payload.edit_item_id, "${form.edit_item_id}");
  assert.equal(Object.hasOwn(footer["on-click-action"].payload, "item_index"), false);
});

test("every TextBody has safe text and user copy excludes technical routing language", () => {
  const flow = loadFlow();
  const visibleCopy = [];
  for (const component of components(flow)) {
    for (const key of ["text", "label", "title"]) {
      if (typeof component[key] === "string") visibleCopy.push(component[key]);
    }
    for (const choice of component["data-source"] || []) {
      if (typeof choice.title === "string") visibleCopy.push(choice.title);
    }
  }
  for (const component of components(flow).filter(({ type }) => type === "TextBody")) {
    assert.equal(typeof component.text, "string");
    assert.ok(component.text.length > 0);
  }
  assert.doesNotMatch(visibleCopy.join("\n"), /tapez MENU|payload|nouvelle session|traitement terminé|commande invalide|sélectionner une option|\bFlow\b|\bécran\b/i);
  assert.equal(flow.screens.some(({ id }) => /DOCUMENT_ESTIMATE|ARTICLE_CART_A|ARTICLE_CART_B|DRAFT_SAVED/.test(id)), false);
});

test("review offers human corrections and final draft recording", () => {
  const source = fs.readFileSync(flowPath, "utf8");
  const review = loadFlow().screens.find(({ id }) => id === "REVIEW_INVOICE_DRAFT");
  const all = flatten(review.layout.children);
  assert.equal(all.find(({ type }) => type === "TextHeading").text, "Tout est bon ?");
  assert.deepEqual(all.find(({ name }) => name === "review_action")["data-source"].map(({ id }) => id), ["modify_client", "modify_items", "modify_options", "finalize_draft"]);
  assert.equal(loadFlow().screens.find(({ id }) => id === "EDIT_CLIENT").data.client_form_init_values.type, "object");
  assert.equal(loadFlow().screens.find(({ id }) => id === "EDIT_OPTIONS").data.options_form_init_values.type, "object");
  assert.doesNotMatch(source, /add_stamp|transaction_date|generate_pdf|pdf définitif/i);
});

test("nfm_reply parser accepts orchestration payloads and remains fail-closed", () => {
  const payload = { outcome: "add_another_item", flow_token: "token", draft_id: "draft", current_item_id: "item", submission_id: "submission", designation: "Ordinateur", quantity: "1", unit: "unit", unit_price: "50000", return_to_review: "false" };
  assert.deepEqual({ ...parseInvoiceFlowResponseJson(payload).value }, payload);
  assert.equal(parseInvoiceFlowResponseJson("{").error, "RESPONSE_JSON_INVALID");
  assert.equal(parseInvoiceFlowResponseJson("null").error, "RESPONSE_ROOT_INVALID");
  assert.equal(parseInvoiceFlowResponseJson("[]").error, "RESPONSE_ROOT_INVALID");
  assert.equal(parseInvoiceFlowResponseJson('{"__proto__":{"polluted":true}}').error, "FORBIDDEN_FIELD");
  assert.equal(parseInvoiceFlowResponseJson('{"unknown":"x"}').error, "UNKNOWN_FIELD");
  assert.equal(parseInvoiceFlowResponseJson(`{"client_name":"${"x".repeat(MAX_RESPONSE_JSON_BYTES)}"}`).error, "RESPONSE_JSON_TOO_LARGE");
  const legacy = { client_type: "individual", client_name: "Awa", item_1_designation: "Service", item_1_quantity: 1, item_1_unit: "service", item_1_unit_price: 1000, tax_status: "not_applicable", discount_amount: 0, amount_paid: 0, add_stamp: "no" };
  const message = { type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { response_json: JSON.stringify(legacy) } } };
  assert.equal(isInvoiceFlowReply(message), true);
  assert.equal(parseInvoiceFlowReply(message).ok, true);
  assert.equal(normalizeInvoiceFlowSubmission(legacy).ok, true);
});
