"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { INVOICE_FLOW_TARGET_SCREENS } = require("../kadiInvoiceFlowSession");
const {
  INVOICE_FLOW_ID_ENV_BY_SCREEN,
  buildInvoiceFlowIdMap,
  resolveInvoiceFlowId,
  validateInvoiceFlowIdMap,
} = require("../kadiInvoiceFlowIds");
const { buildDraftInvoiceFlowMessage } = require("../kadiWhatsAppFlowPayload");

function configuredEnv() {
  return Object.fromEntries(INVOICE_FLOW_TARGET_SCREENS.map((screen, index) => [
    INVOICE_FLOW_ID_ENV_BY_SCREEN[screen],
    String(300000000000001 + index),
  ]));
}

test("seven target screens have distinct explicit environment variables and Flow IDs", () => {
  assert.deepEqual(Object.keys(INVOICE_FLOW_ID_ENV_BY_SCREEN), INVOICE_FLOW_TARGET_SCREENS);
  assert.equal(new Set(Object.values(INVOICE_FLOW_ID_ENV_BY_SCREEN)).size, 7);
  const flowIds = buildInvoiceFlowIdMap(configuredEnv());
  assert.equal(validateInvoiceFlowIdMap(flowIds), true);
  assert.equal(new Set(Object.values(flowIds)).size, 7);
  for (const screen of INVOICE_FLOW_TARGET_SCREENS) {
    assert.equal(resolveInvoiceFlowId(flowIds, screen), flowIds[screen]);
    const payload = buildDraftInvoiceFlowMessage({
      to: "22670000000",
      flowIds,
      targetScreen: screen,
      flowToken: "kadi_invoice_v1:0123456789abcdef0123456789abcdef:1785528000",
    });
    const parameters = payload.interactive.action.parameters;
    assert.equal(parameters.flow_id, flowIds[screen]);
    assert.equal(parameters.flow_action, "data_exchange");
    assert.equal(Object.hasOwn(parameters, "flow_action_payload"), false);
  }
});

test("missing, duplicate and unknown target configuration fails closed", () => {
  const env = configuredEnv();
  delete env[INVOICE_FLOW_ID_ENV_BY_SCREEN.EDIT_OPTIONS];
  const incomplete = buildInvoiceFlowIdMap(env);
  assert.equal(validateInvoiceFlowIdMap(incomplete), false);
  assert.throws(() => resolveInvoiceFlowId(incomplete, "EDIT_OPTIONS"), /FLOW_ID_NOT_CONFIGURED/);

  const duplicate = { ...buildInvoiceFlowIdMap(configuredEnv()), EDIT_OPTIONS: "300000000000001" };
  assert.equal(validateInvoiceFlowIdMap(duplicate), false);
  assert.throws(() => resolveInvoiceFlowId(duplicate, "CLIENT"), /FLOW_ID_MAP_INVALID/);
  assert.equal(validateInvoiceFlowIdMap({ ...buildInvoiceFlowIdMap(configuredEnv()), UNKNOWN: "999" }), false);
  assert.throws(() => resolveInvoiceFlowId(duplicate, "UNKNOWN"), /FLOW_TARGET_SCREEN_INVALID/);
  assert.equal(Object.values(INVOICE_FLOW_ID_ENV_BY_SCREEN).includes("KADI_INVOICE_FLOW_ID"), false);
});
