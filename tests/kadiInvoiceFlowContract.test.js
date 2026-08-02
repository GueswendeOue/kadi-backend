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

function hasRoutingCycle(routingModel) {
  const visiting = new Set();
  const visited = new Set();
  function visit(screen) {
    if (visiting.has(screen)) return true;
    if (visited.has(screen)) return false;
    visiting.add(screen);
    if ((routingModel[screen] || []).some(visit)) return true;
    visiting.delete(screen);
    visited.add(screen);
    return false;
  }
  return Object.keys(routingModel).some(visit);
}

test("dynamic KADI_FACTURE_V1 declares the editable review screen", () => {
  const flow = loadFlow();
  assert.equal(flow.version, "7.3");
  assert.equal(flow.data_api_version, "3.0");
  assert.deepEqual(flow.screens.map(({ id }) => id), ["CLIENT", "ARTICLE_CART", "OPTIONS", "REVIEW_INVOICE_DRAFT", "DRAFT_SAVED"]);
  assert.deepEqual(flow.routing_model, {
    CLIENT: ["ARTICLE_CART"], ARTICLE_CART: ["OPTIONS"], OPTIONS: ["REVIEW_INVOICE_DRAFT"], REVIEW_INVOICE_DRAFT: ["DRAFT_SAVED"], DRAFT_SAVED: [],
  });
  assert.equal(hasRoutingCycle(flow.routing_model), false);
  assert.equal(Object.hasOwn(flow.routing_model, "ARTICLE_DECISION"), false);
  assert.equal(flow.screens.some(({ id }) => id === "ARTICLE_DECISION"), false);
  assert.equal(flow.routing_model.ARTICLE_CART.includes("ARTICLE_CART"), false);
});

test("Flow UI uses supported selectors, unique fields and visible footers", () => {
  const flow = loadFlow();
  const all = components(flow);
  const named = all.filter((component) => typeof component.name === "string");
  assert.equal(new Set(named.map(({ name }) => name)).size, named.length);
  assert.equal(named.find(({ name }) => name === "client_type").type, "RadioButtonsGroup");
  const units = named.filter(({ name }) => /^item_unit_[ab]$/.test(name));
  assert.equal(units.length, 2);
  assert.equal(units.every(({ type }) => type === "Dropdown"), true);
  assert.equal(units.every((unit) => !Object.hasOwn(unit, "on-select-action")), true);
  for (const screen of flow.screens) {
    assert.ok(flatten(screen.layout.children).some(({ type }) => type === "Footer"), screen.id);
  }
  const cart = flow.screens.find(({ id }) => id === "ARTICLE_CART");
  const cartComponents = flatten(cart.layout.children);
  const cartFooters = cartComponents.filter(({ type }) => type === "Footer");
  assert.equal(cartFooters.length, 2);
  assert.equal(cartFooters.every(({ label }) => label === "Ajouter cet article"), true);
  assert.equal(cartFooters.every((footer) => footer["on-click-action"].name === "data_exchange"), true);
  const decisions = cartComponents.filter(({ name }) => /^article_decision_[ab]$/.test(name));
  assert.equal(decisions.length, 2);
  assert.equal(decisions.every(({ required }) => required === true), true);
  for (const decision of decisions) {
    assert.deepEqual(decision["data-source"].map(({ id }) => id), ["add_another", "finish_items"]);
    assert.deepEqual(decision["data-source"].map(({ title }) => title), ["Ajouter un autre article", "C’est tout"]);
  }
  assert.equal(all.some((component) => Object.hasOwn(component, "init-value")), false);
  assert.equal(all.some((component) => component.type === "TextInput" && Object.hasOwn(component, "init-value")), false);
  assert.equal(all.some((component) => component.type === "Dropdown" && Object.hasOwn(component, "init-value")), false);
  assert.equal(all.some((component) => component.type === "RadioButtonsGroup" && Object.hasOwn(component, "init-value")), false);

  const formsWithInitValues = all.filter((component) => Object.hasOwn(component, "init-values"));
  assert.equal(formsWithInitValues.length, 2);
  assert.equal(formsWithInitValues.every(({ type }) => type === "Form"), true);
  assert.deepEqual(formsWithInitValues.map(({ name }) => name).sort(), ["item_form_a", "item_form_b"]);
  assert.deepEqual(formsWithInitValues.map((form) => form["init-values"]).sort(), ["${data.article_form_a_init_values}", "${data.article_form_b_init_values}"]);
  assert.equal(all.some((component) => component.type !== "Form" && Object.hasOwn(component, "init-values")), false);

  for (const suffix of ["a", "b"]) {
    const initDefinition = cart.data[`article_form_${suffix}_init_values`];
    assert.equal(initDefinition.type, "object");
    assert.deepEqual(Object.keys(initDefinition.properties), [`item_description_${suffix}`, `item_quantity_${suffix}`, `item_unit_price_${suffix}`]);
    assert.deepEqual(initDefinition.__example__, { [`item_description_${suffix}`]: "", [`item_quantity_${suffix}`]: "1", [`item_unit_price_${suffix}`]: "" });
    assert.equal(Object.values(initDefinition.__example__).every((value) => typeof value === "string"), true);
  }
  const condition = cartComponents.find(({ type }) => type === "If");
  assert.equal(condition.condition, "${data.use_alternate_form}");
});

test("all dynamic navigation is data_exchange and contains no phone-side totals", () => {
  const flow = loadFlow();
  const source = fs.readFileSync(flowPath, "utf8");
  const footers = components(flow).filter(({ type }) => type === "Footer");
  assert.equal(footers.filter((footer) => footer["on-click-action"].name === "data_exchange").length, 5);
  assert.equal(footers.filter((footer) => footer["on-click-action"].name === "complete").length, 1);
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

test("Flow item_count data is string-typed with a string zero example", () => {
  const flow = loadFlow();
  for (const screenId of ["ARTICLE_CART", "OPTIONS"]) {
    const definition = flow.screens.find(({ id }) => id === screenId).data.item_count;
    assert.equal(definition.type, "string");
    assert.equal(definition.__example__, "0");
  }
});

test("Flow visible article titles use the updated French UX copy", () => {
  const cart = loadFlow().screens.find(({ id }) => id === "ARTICLE_CART");
  assert.equal(cart.title, "Articles et services");
  const texts = flatten(cart.layout.children).map((component) => component.text).filter(Boolean);
  assert.ok(texts.includes("Ajoutez un produit ou un service à la fois."));
  assert.ok(texts.includes("Ce que vous avez déjà ajouté"));
  assert.ok(texts.includes("Total pour le moment"));
});

test("dynamic data bindings are declared and use standalone references", () => {
  const flow = loadFlow();
  const declarations = new Map(flow.screens.map((screen) => [screen.id, new Set(Object.keys(screen.data || {}))]));
  const reference = /^\$\{data\.([A-Za-z_][A-Za-z0-9_]*)\}$/;
  const dynamic = /\$\{data\.([A-Za-z_][A-Za-z0-9_]*)\}/g;
  for (const screen of flow.screens) {
    for (const component of flatten(screen.layout.children)) {
      for (const value of Object.values(component)) {
        if (typeof value !== "string") continue;
        for (const match of value.matchAll(dynamic)) {
          assert.ok(reference.test(value), `${screen.id} mixes static text with ${match[0]}`);
          assert.ok(declarations.get(screen.id).has(match[1]), `${screen.id}.${match[1]}`);
        }
      }
    }
  }
});

test("Flow labels and safe option defaults satisfy WhatsApp validation", () => {
  const flow = loadFlow();
  const components = flow.screens.flatMap((screen) => flatten(screen.layout.children));
  for (const component of components.filter(({ type }) => type === "TextInput")) {
    assert.ok(component.label.length <= 20, component.name);
  }
  const options = flow.screens.find(({ id }) => id === "OPTIONS");
  const optionComponents = flatten(options.layout.children);
  assert.equal(optionComponents.find(({ name }) => name === "payment_terms").label, "Conditions paiement");
  assert.equal(Object.hasOwn(optionComponents.find(({ name }) => name === "tax_status"), "init-value"), false);
  assert.equal(optionComponents.some(({ name }) => name === "add_stamp"), false);
  assert.equal(optionComponents.find(({ name }) => name === "tax_status").required, false);
});

test("every TextBody has an explicit text binding or safe literal", () => {
  for (const component of components(loadFlow()).filter(({ type }) => type === "TextBody")) {
    assert.equal(typeof component.text, "string");
    assert.ok(component.text.length > 0);
  }
});

test("technical estimate screen is replaced by a minimal human draft confirmation", () => {
  const flow = loadFlow();
  assert.equal(flow.screens.some(({ id }) => id === "DOCUMENT_ESTIMATE"), false);
  const terminal = flow.screens.find(({ id }) => id === "DRAFT_SAVED");
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.success, true);
  assert.equal(terminal.title, "C’est bien enregistré");
  const terminalComponents = flatten(terminal.layout.children);
  assert.deepEqual(terminalComponents.filter(({ type }) => type === "TextBody").map(({ text }) => text), [
    "Votre brouillon de facture a bien été enregistré. Aucun crédit n’a été débité.",
  ]);
  const footer = terminalComponents.find(({ type }) => type === "Footer");
  assert.equal(footer.label, "Retourner dans WhatsApp");
  assert.deepEqual(footer["on-click-action"].payload, {
    status: "draft_saved",
    flow_token: "${data.flow_token}",
    draft_id: "${data.draft_id}",
  });
  assert.doesNotMatch(JSON.stringify(terminal), /Pages|Source|Renderer|Crédits proposés|Montant|PDF/);
});

test("review screen uses human draft language without technical estimate fields", () => {
  const review = loadFlow().screens.find(({ id }) => id === "REVIEW_INVOICE_DRAFT");
  const all = flatten(review.layout.children);
  assert.equal(all.find(({ type }) => type === "TextHeading").text, "Tout est bon ?");
  const choices = all.find(({ name }) => name === "review_action")["data-source"].map(({ title }) => title);
  assert.deepEqual(choices, [
    "Corriger le client",
    "Corriger les produits et services",
    "Corriger les autres détails",
    "Oui, enregistrer le brouillon",
  ]);
  assert.deepEqual(Object.keys(review.data).filter((key) => /page|source|credit|estimate/.test(key)), []);
});

test("Flow MVP has no stamp or client-selectable issue date", () => {
  const source = fs.readFileSync(flowPath, "utf8");
  assert.doesNotMatch(source, /add_stamp|Ajouter le tampon|transaction_date|invoice_date|document_date|issued_at/);
  assert.equal(loadFlow().screens.find(({ id }) => id === "REVIEW_INVOICE_DRAFT").title, "Vérifiez les informations");
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
  assert.deepEqual({ ...parseInvoiceFlowResponseJson({ flowToken: "token", draftId: "draft", status: "draft_saved" }).value }, {
    flow_token: "token", draft_id: "draft", status: "draft_saved",
  });
  assert.equal(isInvoiceFlowReply({ type: "interactive", interactive: { type: "nfm_reply" } }), false);
});
