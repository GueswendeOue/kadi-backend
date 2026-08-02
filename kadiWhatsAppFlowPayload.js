"use strict";

const FLOW_MESSAGE_VERSION = "3";
const INVOICE_FLOW_ENTRY_SCREENS = Object.freeze([
  "CLIENT",
  "ARTICLE_ENTRY",
  "OPTIONS",
  "REVIEW_INVOICE_DRAFT",
  "EDIT_CLIENT",
  "EDIT_ITEMS",
  "EDIT_OPTIONS",
]);
const INVOICE_FLOW_ENTRY_SCREEN_SET = new Set(INVOICE_FLOW_ENTRY_SCREENS);
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
  const screen = args.screen == null ? "CLIENT" : requireString(args.screen, /^[A-Z][A-Z0-9_]{1,63}$/, "FLOW_SCREEN_INVALID");
  if (!INVOICE_FLOW_ENTRY_SCREEN_SET.has(screen)) throw new TypeError("FLOW_SCREEN_INVALID");
  const data = args.data == null ? {} : structuredClone(args.data);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new TypeError("FLOW_DATA_INVALID");
  const bodyText = args.bodyText == null ? "Préparez votre facture avec le formulaire guidé Kadi." : requireString(args.bodyText, /^.{1,1024}$/s, "FLOW_BODY_INVALID");
  const cta = args.cta == null ? "Ouvrir le formulaire" : requireString(args.cta, /^.{1,30}$/s, "FLOW_CTA_INVALID");

  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "flow",
      body: { text: bodyText },
      action: {
        name: "flow",
        parameters: {
          mode: "draft",
          flow_message_version: FLOW_MESSAGE_VERSION,
          flow_token: flowToken,
          flow_id: flowId,
          flow_cta: cta,
          flow_action: "navigate",
          flow_action_payload: { screen, data },
        },
      },
    },
  };
}

module.exports = {
  FLOW_MESSAGE_VERSION,
  INVOICE_FLOW_ENTRY_SCREENS,
  INVOICE_FLOW_TOKEN_CONTRACT,
  INVOICE_FLOW_TOKEN_PATTERN,
  buildDraftInvoiceFlowMessage,
};
