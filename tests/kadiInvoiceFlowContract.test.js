"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  ALLOWED_RESPONSE_FIELDS,
  MAX_RESPONSE_JSON_BYTES,
  isInvoiceFlowReply,
  normalizeInvoiceFlowSubmission,
  parseInvoiceFlowReply,
  parseInvoiceFlowResponseJson,
} = require("../kadiInvoiceFlowContract");

const flowPath = path.join(__dirname, "..", "flows", "kadi_facture_v1.json");

function baseSubmission(overrides = {}) {
  return {
    flow_token: "opaque-test-token",
    client_type: "individual",
    client_name: "Awa",
    client_phone: "",
    client_address: "",
    client_ifu: "",
    client_registry_number: "",
    invoice_subject: "Vente de fournitures",
    transaction_date: "2026-07-31",
    item_1_designation: "Sac de ciment",
    item_1_quantity: "2",
    item_1_unit: "unit",
    item_1_unit_price: "7500",
    tax_status: "not_applicable",
    tax_rate: "",
    discount_amount: "0",
    amount_paid: "0",
    due_date: "",
    payment_method: "cash",
    payment_terms: "",
    invoice_note: "Merci",
    add_stamp: "no",
    ...overrides,
  };
}

function makeReply(payload) {
  return {
    type: "interactive",
    interactive: {
      type: "nfm_reply",
      nfm_reply: { response_json: JSON.stringify(payload) },
    },
  };
}

function fieldComponents(flow) {
  return flow.screens.flatMap((screen) =>
    screen.layout.children.flatMap((child) => child.children || [])
  ).filter((component) => typeof component.name === "string" && component.name !== "form");
}

test("KADI_FACTURE_V1 is parseable Flow JSON 7.3 with four ordered screens", () => {
  const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
  assert.equal(flow.version, "7.3");
  assert.deepEqual(flow.screens.map((screen) => screen.id), [
    "CLIENT",
    "ARTICLES_UN_TROIS",
    "ARTICLES_QUATRE_SIX",
    "OPTIONS",
  ]);
  assert.deepEqual(flow.routing_model, {
    CLIENT: ["ARTICLES_UN_TROIS"],
    ARTICLES_UN_TROIS: ["ARTICLES_QUATRE_SIX", "OPTIONS"],
    ARTICLES_QUATRE_SIX: ["OPTIONS"],
    OPTIONS: [],
  });
  assert.equal(flow.screens.at(-1).terminal, true);
});

test("screen ids and routing use only Meta-compatible letters and underscores", () => {
  const source = fs.readFileSync(flowPath, "utf8");
  const flow = JSON.parse(source);
  const idPattern = /^[A-Za-z_]+$/;
  const screenIds = new Set(flow.screens.map((screen) => screen.id));

  for (const screen of flow.screens) assert.match(screen.id, idPattern);
  for (const [sourceId, destinations] of Object.entries(flow.routing_model)) {
    assert.match(sourceId, idPattern);
    assert.ok(screenIds.has(sourceId));
    for (const destination of destinations) {
      assert.match(destination, idPattern);
      assert.ok(screenIds.has(destination));
    }
  }

  assert.doesNotMatch(source, /ARTICLES_1_3|ARTICLES_4_6/);
});

test("every declared screen data property has a type-compatible synthetic example", () => {
  const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
  let declarationCount = 0;

  for (const screen of flow.screens) {
    for (const definition of Object.values(screen.data || {})) {
      declarationCount += 1;
      assert.ok(Object.hasOwn(definition, "__example__"));
      const example = definition.__example__;
      switch (definition.type) {
        case "string":
          assert.equal(typeof example, "string");
          break;
        case "number":
          assert.equal(typeof example, "number");
          assert.equal(Number.isFinite(example), true);
          break;
        case "boolean":
          assert.equal(typeof example, "boolean");
          break;
        case "array":
          assert.equal(Array.isArray(example), true);
          break;
        case "object":
          assert.equal(example !== null && typeof example === "object", true);
          assert.equal(Array.isArray(example), false);
          break;
        default:
          assert.fail(`Unsupported test schema type: ${definition.type}`);
      }
    }
  }

  assert.equal(declarationCount, 62);
});

test("propagated quantities and unit prices use numeric Meta data models", () => {
  const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
  const numericFields = new Set(
    Array.from({ length: 6 }, (_, index) => [
      `item_${index + 1}_quantity`,
      `item_${index + 1}_unit_price`,
    ]).flat()
  );
  let numericDeclarations = 0;

  for (const screen of flow.screens) {
    for (const [field, definition] of Object.entries(screen.data || {})) {
      if (numericFields.has(field)) {
        numericDeclarations += 1;
        assert.equal(definition.type, "number", `${screen.id}.${field}`);
        assert.equal(typeof definition.__example__, "number", `${screen.id}.${field}`);
        assert.equal(Number.isFinite(definition.__example__), true);
        assert.ok(definition.__example__ >= 0);
      } else {
        assert.equal(definition.type, "string", `${screen.id}.${field}`);
        assert.equal(typeof definition.__example__, "string", `${screen.id}.${field}`);
      }
    }
  }

  assert.equal(numericDeclarations, 18);
});

test("every dynamic numeric payload targets a number declaration on the next screen", () => {
  const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
  const screens = new Map(flow.screens.map((screen) => [screen.id, screen]));
  const numericFieldPattern = /^item_[1-6]_(quantity|unit_price)$/;
  let propagatedNumericFields = 0;

  for (const screen of flow.screens) {
    const components = screen.layout.children.flatMap((child) => child.children || []);
    const footer = components.find(
      (component) => component.type === "Footer" && component["on-click-action"]?.name === "navigate"
    );
    if (!footer) continue;
    for (const [field, expression] of Object.entries(
      footer["on-click-action"].payload || {}
    )) {
      if (!numericFieldPattern.test(field)) continue;
      propagatedNumericFields += 1;
      assert.match(expression, /^\$\{(?:form|data)\.[A-Za-z0-9_]+\}$/);
      for (const targetId of flow.routing_model[screen.id]) {
        const target = screens.get(targetId);
        assert.ok(target);
        assert.equal(target.data[field].type, "number", `${screen.id} -> ${target.id}.${field}`);
      }
    }
  }

  assert.equal(propagatedNumericFields, 18);
});

test("Dropdown and TextArea components exclude Meta-rejected properties", () => {
  const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
  const components = flow.screens.flatMap((screen) =>
    screen.layout.children.flatMap((child) => child.children || [])
  );
  const dropdowns = components.filter((component) => component.type === "Dropdown");
  const textAreas = components.filter((component) => component.type === "TextArea");

  assert.ok(dropdowns.length > 0);
  assert.ok(textAreas.length > 0);
  assert.ok(dropdowns.every((component) => !Object.hasOwn(component, "init-value")));
  assert.ok(textAreas.every((component) => !Object.hasOwn(component, "max-chars")));
});

test("short choices use radio controls and inputs have no initial-value overlays", () => {
  const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
  const components = flow.screens.flatMap((screen) =>
    screen.layout.children.flatMap((child) => child.children || [])
  );
  const named = new Map(
    components
      .filter((component) => typeof component.name === "string")
      .map((component) => [component.name, component])
  );

  assert.equal(named.get("client_type").type, "RadioButtonsGroup");
  assert.equal(named.get("has_more_items").type, "RadioButtonsGroup");
  assert.equal(named.get("tax_status").type, "RadioButtonsGroup");
  assert.equal(named.get("add_stamp").type, "RadioButtonsGroup");
  assert.equal(named.get("payment_method").type, "Dropdown");

  for (const component of components) {
    if (!["TextInput", "TextArea", "Dropdown", "RadioButtonsGroup", "DatePicker"].includes(component.type)) {
      continue;
    }
    assert.equal(Object.hasOwn(component, "init-value"), false, component.name);
    assert.equal(Object.hasOwn(component, "placeholder"), false, component.name);
  }
});

test("article routing choice reaches only destinations authorized by the routing model", () => {
  const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
  const screen = flow.screens.find(({ id }) => id === "ARTICLES_UN_TROIS");
  const components = screen.layout.children[0].children;
  const choice = components.find(({ name }) => name === "has_more_items");
  const footer = components.find(({ type }) => type === "Footer");

  assert.deepEqual(choice["data-source"], [
    { id: "no", title: "Non" },
    { id: "yes", title: "Oui" },
  ]);
  assert.equal(choice.required, true);
  assert.equal(
    footer["on-click-action"].next.name,
    "${(form.has_more_items == 'yes') ? 'ARTICLES_QUATRE_SIX' : 'OPTIONS'}"
  );
  assert.deepEqual(
    new Set(flow.routing_model.ARTICLES_UN_TROIS),
    new Set(["ARTICLES_QUATRE_SIX", "OPTIONS"])
  );
  assert.equal(footer["on-click-action"].payload.has_more_items, "${form.has_more_items}");
});

test("Flow fields are unique and article requirements are exact", () => {
  const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
  const fields = fieldComponents(flow);
  const names = fields.map((field) => field.name);
  assert.equal(new Set(names).size, names.length);

  for (let index = 1; index <= 6; index += 1) {
    const itemFields = fields.filter((field) => field.name.startsWith(`item_${index}_`));
    assert.equal(itemFields.length, 4);
    assert.ok(itemFields.every((field) => field.required === (index === 1 || index === 4)));
  }
  assert.equal(names.filter((name) => /^item_\d+_designation$/.test(name)).length, 6);
});

test("Flow is static, completes locally and contains no endpoint or secret material", () => {
  const source = fs.readFileSync(flowPath, "utf8");
  const flow = JSON.parse(source);
  const footer = flow.screens.at(-1).layout.children[0].children.at(-1);
  assert.equal(footer.type, "Footer");
  assert.equal(footer.label, "Envoyer à Kadi");
  assert.equal(footer["on-click-action"].name, "complete");
  const submittedFields = Object.keys(footer["on-click-action"].payload).sort();
  assert.deepEqual(
    submittedFields,
    ALLOWED_RESPONSE_FIELDS.filter((field) => field !== "flow_token").sort()
  );
  assert.ok(
    submittedFields.every(
      (field) => !/subtotal|total|balance|line_amount|document_number/.test(field)
    )
  );
  assert.doesNotMatch(source, /endpoint_uri|WHATSAPP_TOKEN|APP_SECRET|OPENAI|SUPABASE|phone_number_id/i);
});

test("nfm_reply recognition and parsing accept only the exact message shape", () => {
  const message = makeReply(baseSubmission());
  assert.equal(isInvoiceFlowReply(message), true);
  assert.equal(parseInvoiceFlowReply(message).ok, true);

  for (const invalid of [
    null,
    {},
    { type: "text" },
    { type: "interactive", interactive: { type: "button" } },
    { type: "interactive", interactive: { type: "nfm_reply" } },
  ]) {
    assert.equal(isInvoiceFlowReply(invalid), false);
    assert.equal(parseInvoiceFlowReply(invalid).error, "NOT_INVOICE_FLOW_REPLY");
  }
});

test("response parser rejects invalid, oversized, null and array roots", () => {
  assert.equal(parseInvoiceFlowResponseJson(null).error, "RESPONSE_JSON_TYPE");
  assert.equal(parseInvoiceFlowResponseJson("{").error, "RESPONSE_JSON_INVALID");
  assert.equal(parseInvoiceFlowResponseJson("null").error, "RESPONSE_ROOT_INVALID");
  assert.equal(parseInvoiceFlowResponseJson("[]").error, "RESPONSE_ROOT_INVALID");
  assert.equal(
    parseInvoiceFlowResponseJson(`{"client_name":"${"x".repeat(MAX_RESPONSE_JSON_BYTES)}"}`).error,
    "RESPONSE_JSON_TOO_LARGE"
  );
});

test("response parser rejects forbidden and unknown properties", () => {
  assert.equal(
    parseInvoiceFlowResponseJson('{"__proto__":{"polluted":true}}').error,
    "FORBIDDEN_FIELD"
  );
  assert.equal(
    parseInvoiceFlowResponseJson('{"constructor":"blocked"}').error,
    "FORBIDDEN_FIELD"
  );
  assert.equal(
    parseInvoiceFlowResponseJson('{"unknown_field":"blocked"}').error,
    "UNKNOWN_FIELD"
  );
  assert.equal(({}).polluted, undefined);
});

test("response parser rebuilds only allowlisted primitive data", () => {
  const parsed = parseInvoiceFlowResponseJson(JSON.stringify(baseSubmission()));
  assert.equal(parsed.ok, true);
  assert.equal(Object.getPrototypeOf(parsed.value), null);
  assert.ok(Object.keys(parsed.value).every((key) => ALLOWED_RESPONSE_FIELDS.includes(key)));
  assert.equal(
    parseInvoiceFlowResponseJson('{"client_name":{"nested":true}}').error,
    "FIELD_VALUE_INVALID"
  );
});

test("normalization trims text, preserves accents and removes control characters", () => {
  const result = normalizeInvoiceFlowSubmission(
    baseSubmission({ client_name: "  Awa\u0000 Ouédraogo  ", invoice_note: "  Réglé  " })
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.client.name, "Awa Ouédraogo");
  assert.equal(result.value.note, "Réglé");
});

test("empty optional item is ignored and a partial optional item is rejected", () => {
  const empty = normalizeInvoiceFlowSubmission(
    baseSubmission({
      item_2_designation: "",
      item_2_quantity: "",
      item_2_unit: "",
      item_2_unit_price: "",
    })
  );
  assert.equal(empty.ok, true);
  assert.equal(empty.value.items.length, 1);

  const partial = normalizeInvoiceFlowSubmission(
    baseSubmission({ item_2_designation: "Transport" })
  );
  assert.equal(partial.error, "ITEM_2_PARTIAL");
});

test("one, two or three articles can skip the second article screen", () => {
  for (let count = 1; count <= 3; count += 1) {
    const additions = { has_more_items: "no" };
    for (let index = 2; index <= count; index += 1) {
      additions[`item_${index}_designation`] = `Article ${index}`;
      additions[`item_${index}_quantity`] = index;
      additions[`item_${index}_unit`] = "piece";
      additions[`item_${index}_unit_price`] = index * 1000;
    }
    const result = normalizeInvoiceFlowSubmission(baseSubmission(additions));
    assert.equal(result.ok, true, `article count ${count}`);
    assert.equal(result.value.items.length, count);
  }
});

test("the more-items route requires a complete article four", () => {
  assert.equal(
    normalizeInvoiceFlowSubmission(baseSubmission({ has_more_items: "yes" })).error,
    "ITEM_4_REQUIRED"
  );
  assert.equal(
    normalizeInvoiceFlowSubmission(
      baseSubmission({ has_more_items: "yes", item_4_designation: "Transport" })
    ).error,
    "ITEM_4_PARTIAL"
  );

  const result = normalizeInvoiceFlowSubmission(
    baseSubmission({
      has_more_items: "yes",
      item_2_designation: "Article 2",
      item_2_quantity: 1,
      item_2_unit: "piece",
      item_2_unit_price: 2000,
      item_3_designation: "Article 3",
      item_3_quantity: 1,
      item_3_unit: "piece",
      item_3_unit_price: 3000,
      item_4_designation: "Transport",
      item_4_quantity: 1,
      item_4_unit: "service",
      item_4_unit_price: 5000,
    })
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.items.length, 4);
});

test("the no-more-items route ignores item four through six", () => {
  const result = normalizeInvoiceFlowSubmission(
    baseSubmission({
      has_more_items: "no",
      item_4_designation: "Valeur ignorée",
      item_4_quantity: 1,
      item_4_unit: "unit",
      item_4_unit_price: 1000,
    })
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.items.length, 1);
});

test("article one, quantity, unit and price are validated without coercion", () => {
  assert.equal(
    normalizeInvoiceFlowSubmission(baseSubmission({ item_1_designation: "" })).error,
    "ITEM_1_PARTIAL"
  );
  for (const quantity of ["0", "-1", "NaN", "1.2345", Infinity]) {
    assert.equal(
      normalizeInvoiceFlowSubmission(baseSubmission({ item_1_quantity: quantity })).error,
      "ITEM_1_QUANTITY_INVALID"
    );
  }
  assert.equal(
    normalizeInvoiceFlowSubmission(baseSubmission({ item_1_quantity: {} })).error,
    "FIELD_VALUE_INVALID"
  );
  for (const price of ["0", "-1", "1.5", Infinity]) {
    assert.equal(
      normalizeInvoiceFlowSubmission(baseSubmission({ item_1_unit_price: price })).error,
      "ITEM_1_UNIT_PRICE_INVALID"
    );
  }
  assert.equal(
    normalizeInvoiceFlowSubmission(baseSubmission({ item_1_unit_price: {} })).error,
    "FIELD_VALUE_INVALID"
  );
});

test("tax rate is required only for taxable submissions and no default is invented", () => {
  assert.equal(
    normalizeInvoiceFlowSubmission(baseSubmission({ tax_status: "taxable", tax_rate: "" })).error,
    "TAX_RATE_REQUIRED"
  );
  const exempt = normalizeInvoiceFlowSubmission(
    baseSubmission({ tax_status: "exempt", tax_rate: "95" })
  );
  assert.equal(exempt.ok, true);
  assert.equal(exempt.value.tax_rate_basis_points, 0);
});

test("normalization accepts exactly six complete articles", () => {
  const additions = { has_more_items: "yes" };
  for (let index = 2; index <= 6; index += 1) {
    additions[`item_${index}_designation`] = `Article ${index}`;
    additions[`item_${index}_quantity`] = "1";
    additions[`item_${index}_unit`] = "piece";
    additions[`item_${index}_unit_price`] = String(index * 100);
  }
  const result = normalizeInvoiceFlowSubmission(baseSubmission(additions));
  assert.equal(result.ok, true);
  assert.equal(result.value.items.length, 6);
});

test("normalization accepts finite JSON numbers for quantity and unit price", () => {
  const result = normalizeInvoiceFlowSubmission(
    baseSubmission({ item_1_quantity: 2.5, item_1_unit_price: 7500 })
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.items[0].quantity, 2.5);
  assert.equal(result.value.items[0].quantity_millis, 2500);
  assert.equal(result.value.items[0].unit_price, 7500);
});

test("normalization rejects hostile or invalid JSON numeric values", () => {
  for (const field of ["item_1_quantity", "item_1_unit_price"]) {
    for (const value of [NaN, Infinity, -1, {}, [], true, false, "not-a-number"]) {
      const result = normalizeInvoiceFlowSubmission(baseSubmission({ [field]: value }));
      assert.equal(result.ok, false, `${field}: ${typeof value}`);
    }
  }
});
