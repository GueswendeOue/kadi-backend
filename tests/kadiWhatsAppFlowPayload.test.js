"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  FLOW_MESSAGE_VERSION,
  INVOICE_FLOW_TOKEN_CONTRACT,
  buildDraftInvoiceFlowMessage,
} = require("../kadiWhatsAppFlowPayload");

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
  assert.equal(parameters.flow_cta, "Remplir la facture");
  assert.equal(parameters.flow_id, validArgs.flowId);
  assert.equal(parameters.flow_token, validArgs.flowToken);
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
