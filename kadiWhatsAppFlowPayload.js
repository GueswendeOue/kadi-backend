"use strict";

const FLOW_MESSAGE_VERSION = "3";
const INVOICE_FLOW_TOKEN_PATTERN = /^kadi_invoice_v1:[a-f0-9]{32}:[0-9]{10,13}$/;
const INVOICE_FLOW_TOKEN_CONTRACT = Object.freeze({
  prefix: "kadi_invoice_v1",
  subject: "pseudonymous_128_bit_hex",
  document_type: "invoice",
  expires_at: "unix_timestamp",
  single_use: true,
  grants_authorization: false,
});

function requireString(value, pattern, error) {
  if (typeof value !== "string") throw new TypeError(error);
  const trimmed = value.trim();
  if (!trimmed || !pattern.test(trimmed)) throw new TypeError(error);
  return trimmed;
}

function buildDraftInvoiceFlowMessage(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new TypeError("FLOW_ARGS_INVALID");
  }
  const to = requireString(args.to, /^\d{6,20}$/, "FLOW_RECIPIENT_INVALID");
  const flowId = requireString(args.flowId, /^\d{1,40}$/, "FLOW_ID_INVALID");
  const flowToken = requireString(
    args.flowToken,
    INVOICE_FLOW_TOKEN_PATTERN,
    "FLOW_TOKEN_INVALID"
  );

  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "flow",
      body: { text: "Renseignez les informations de votre facture." },
      action: {
        name: "flow",
        parameters: {
          mode: "draft",
          flow_message_version: FLOW_MESSAGE_VERSION,
          flow_token: flowToken,
          flow_id: flowId,
          flow_cta: "Ouvrir le formulaire",
          flow_action: "navigate",
          flow_action_payload: { screen: "CLIENT" },
        },
      },
    },
  };
}

module.exports = {
  FLOW_MESSAGE_VERSION,
  INVOICE_FLOW_TOKEN_CONTRACT,
  INVOICE_FLOW_TOKEN_PATTERN,
  buildDraftInvoiceFlowMessage,
};
