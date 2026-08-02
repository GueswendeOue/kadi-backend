"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  FLOW_MESSAGE_VERSION,
  INVOICE_FLOW_ENTRY_SCREENS,
  INVOICE_FLOW_TOKEN_CONTRACT,
  buildDraftInvoiceFlowMessage,
} = require("../kadiWhatsAppFlowPayload");
const {
  articleEntryData,
  editClientData,
  editItemsData,
  editOptionsData,
  optionsData,
  reviewData,
} = require("../kadiInvoiceFlowScreens");

const validArgs = {
  to: "22670000000",
  flowId: "123456789012345",
  flowToken: "kadi_invoice_v1:0123456789abcdef0123456789abcdef:1785528000",
};

test("draft payload follows the current interactive Flow message contract", () => {
  const payload = buildDraftInvoiceFlowMessage(validArgs);
  assert.equal(FLOW_MESSAGE_VERSION, "3");
  assert.equal(payload.messaging_product, "whatsapp");
  assert.equal(payload.recipient_type, "individual");
  assert.equal(payload.to, validArgs.to);
  assert.equal(payload.type, "interactive");
  assert.equal(payload.interactive.type, "flow");
  assert.equal(payload.interactive.action.name, "flow");

  const parameters = payload.interactive.action.parameters;
  assert.equal(parameters.flow_message_version, "3");
  assert.equal(parameters.mode, "draft");
  assert.equal(parameters.flow_action, "navigate");
  assert.equal(parameters.flow_action_payload.screen, "CLIENT");
  assert.deepEqual(parameters.flow_action_payload.data, {});
  assert.equal(parameters.flow_cta, "Ouvrir le formulaire");
  assert.equal(parameters.flow_id, validArgs.flowId);
  assert.equal(parameters.flow_token, validArgs.flowToken);
});

test("payload opens each supported short-session screen with isolated data", () => {
  const draft = {
    draft_id: "draft-1",
    client: { type: "individual", name: "Ben", phone: "", address: "" },
    items: [{ item_id: "draft-1:item:1", description: "Ordinateur", quantity: 1, quantity_millis: 1000, unit: "unit", unit_price: 150000 }],
    options: { tax_status: "not_applicable", discount_amount: 0, amount_paid: 0, payment_terms: "Comptant" },
  };
  const dataByScreen = {
    CLIENT: { flow_token: validArgs.flowToken, draft_id: draft.draft_id },
    ARTICLE_ENTRY: articleEntryData(draft, validArgs.flowToken),
    OPTIONS: optionsData(draft, validArgs.flowToken),
    REVIEW_INVOICE_DRAFT: reviewData(draft, validArgs.flowToken),
    EDIT_CLIENT: editClientData(draft, validArgs.flowToken),
    EDIT_ITEMS: editItemsData(draft, validArgs.flowToken),
    EDIT_OPTIONS: editOptionsData(draft, validArgs.flowToken),
  };
  const flow = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "flows", "kadi_facture_v1.json"), "utf8"));
  for (const screen of INVOICE_FLOW_ENTRY_SCREENS) {
    const data = dataByScreen[screen];
    const payload = buildDraftInvoiceFlowMessage({ ...validArgs, screen, data, bodyText: "C’est noté.", cta: "Continuer" });
    const parameters = payload.interactive.action.parameters;
    const declaration = flow.screens.find(({ id }) => id === screen).data;
    assert.equal(payload.interactive.type, "flow");
    assert.equal(payload.interactive.action.name, "flow");
    assert.equal(parameters.mode, "draft");
    assert.equal(parameters.flow_action, "navigate");
    assert.equal(parameters.flow_id, validArgs.flowId);
    assert.equal(parameters.flow_token, validArgs.flowToken);
    assert.equal(parameters.flow_action_payload.screen, screen);
    assert.deepEqual(parameters.flow_action_payload.data, data);
    assert.notEqual(parameters.flow_action_payload.data, data);
    assert.deepEqual(Object.keys(data).sort(), Object.keys(declaration).sort(), screen);
    assert.equal(data.flow_token, parameters.flow_token, screen);
    for (const [key, value] of Object.entries(data)) {
      const actualType = Array.isArray(value) ? "array" : typeof value;
      assert.equal(actualType, declaration[key].type, `${screen}.${key}`);
      assert.notEqual(value, null, `${screen}.${key}`);
    }
    assert.equal(parameters.flow_cta, "Continuer");
  }
  assert.equal(typeof dataByScreen.ARTICLE_ENTRY.return_to_review, "string");
  assert.equal(dataByScreen.ARTICLE_ENTRY.return_to_review, "false");
  assert.throws(() => buildDraftInvoiceFlowMessage({ ...validArgs, screen: "UNKNOWN" }), /FLOW_SCREEN_INVALID/);
});

test("payload contains no embedded credential or hard-coded recipient", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "kadiWhatsAppFlowPayload.js"),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /process\.env|WHATSAPP_TOKEN|APP_SECRET|VERIFY_TOKEN|OPENAI_API_KEY|SUPABASE_SERVICE_ROLE_KEY/
  );
  const payload = buildDraftInvoiceFlowMessage(validArgs);
  assert.equal(payload.to, validArgs.to);
});

test("flow token contract accepts only an opaque pseudonymized invoice token", () => {
  assert.deepEqual(INVOICE_FLOW_TOKEN_CONTRACT, {
    prefix: "kadi_invoice_v1",
    subject: "pseudonymous_128_bit_hex",
    document_type: "invoice",
    expires_at: "unix_timestamp",
    single_use: true,
    grants_authorization: false,
  });
  for (const flowToken of [
    "",
    "22670000000",
    "raw-whatsapp-user",
    "kadi_invoice_v1:too-short:1785528000",
    null,
  ]) {
    assert.throws(
      () => buildDraftInvoiceFlowMessage({ ...validArgs, flowToken }),
      /FLOW_TOKEN_INVALID/
    );
  }
});

test("flow id and recipient are supplied, validated and never defaulted", () => {
  assert.throws(
    () => buildDraftInvoiceFlowMessage({ ...validArgs, to: undefined }),
    /FLOW_RECIPIENT_INVALID/
  );
  assert.throws(
    () => buildDraftInvoiceFlowMessage({ ...validArgs, flowId: "not-an-id" }),
    /FLOW_ID_INVALID/
  );
  assert.throws(() => buildDraftInvoiceFlowMessage(null), /FLOW_ARGS_INVALID/);
});
