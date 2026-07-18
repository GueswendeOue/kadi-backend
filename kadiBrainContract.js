"use strict";

const BRAIN_SCHEMA_VERSION = "kadi.brain.v1";
const BRAIN_REQUEST_SCHEMA_VERSION = "kadi.brain.request.v1";

const BRAIN_STATUSES = [
  "understood",
  "needs_clarification",
  "unsupported",
  "unsafe",
  "failed",
];

const BRAIN_INTENTS = [
  "create_document",
  "edit_document",
  "add_document_item",
  "remove_document_item",
  "replace_document_item",
  "change_document_type",
  "cancel_document",
  "confirm_document",
  "generate_pdf",
  "mark_paid",
  "mark_unpaid",
  "set_payment_method",
  "record_partial_payment",
  "list_documents",
  "search_documents",
  "open_document",
  "resend_document",
  "send_document_to_client",
  "duplicate_document",
  "configure_stamp",
  "generate_with_stamp",
  "generate_without_stamp",
  "request_support",
  "report_problem",
  "clarify",
  "unknown",
  "unsupported",
];

const nullableString = { type: ["string", "null"] };
const nullableNumber = { type: ["number", "null"] };

const KADI_BRAIN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "string", enum: [BRAIN_SCHEMA_VERSION] },
    requestId: { type: "string" },
    status: { type: "string", enum: BRAIN_STATUSES },
    intent: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", enum: BRAIN_INTENTS },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        requiresConfirmation: { type: "boolean" },
        risk: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["name", "confidence", "requiresConfirmation", "risk"],
    },
    document: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        operation: { type: ["string", "null"], enum: ["create", "edit", null] },
        documentId: nullableString,
        documentType: {
          type: ["string", "null"],
          enum: ["devis", "facture", "recu", "decharge", null],
        },
        clientName: nullableString,
        clientPhone: nullableString,
        subject: nullableString,
        notes: nullableString,
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              lineRef: nullableString,
              label: nullableString,
              quantity: nullableNumber,
              unit: nullableString,
              unitPrice: nullableNumber,
              lineTotal: nullableNumber,
            },
            required: ["lineRef", "label", "quantity", "unit", "unitPrice", "lineTotal"],
          },
        },
        subtotal: nullableNumber,
        grandTotal: nullableNumber,
        amountPaid: nullableNumber,
        paymentStatus: {
          type: ["string", "null"],
          enum: ["unknown", "unpaid", "partial", "paid", null],
        },
        paymentMethod: nullableString,
        paymentDate: nullableString,
        currency: nullableString,
      },
      required: [
        "operation", "documentId", "documentType", "clientName", "clientPhone",
        "subject", "notes", "items", "subtotal", "grandTotal", "amountPaid",
        "paymentStatus", "paymentMethod", "paymentDate", "currency"
      ],
    },
    historyTarget: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        selector: nullableString,
        documentId: nullableString,
        documentType: nullableString,
        documentNumber: nullableString,
        clientName: nullableString,
        dateHint: nullableString,
      },
      required: ["selector", "documentId", "documentType", "documentNumber", "clientName", "dateHint"],
    },
    patches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          op: { type: "string", enum: ["add", "replace", "remove"] },
          path: { type: "string" },
          valueText: nullableString,
          valueNumber: nullableNumber,
        },
        required: ["op", "path", "valueText", "valueNumber"],
      },
    },
    missingFields: { type: "array", items: { type: "string" } },
    ambiguities: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          field: { type: "string" },
          source: {
            type: "string",
            enum: ["user_explicit", "voice_transcript", "image_explicit", "session_existing", "history_candidate", "derived_arithmetic"],
          },
          valueText: nullableString,
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["field", "source", "valueText", "confidence"],
      },
    },
    diagnostics: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: { type: "string" },
        model: { type: "string" },
        fallbackUsed: { type: "boolean" },
      },
      required: ["provider", "model", "fallbackUsed"],
    },
  },
  required: [
    "schemaVersion", "requestId", "status", "intent", "document",
    "historyTarget", "patches", "missingFields", "ambiguities", "warnings",
    "evidence", "diagnostics"
  ],
};

module.exports = {
  BRAIN_SCHEMA_VERSION,
  BRAIN_REQUEST_SCHEMA_VERSION,
  BRAIN_STATUSES,
  BRAIN_INTENTS,
  KADI_BRAIN_OUTPUT_SCHEMA,
};
