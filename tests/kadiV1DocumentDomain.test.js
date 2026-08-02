"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DOCUMENT_EVENTS,
  DOCUMENT_PURPOSES,
  DOCUMENT_STATES,
  DOCUMENT_TYPES,
  createDocumentDomain,
} = require("../kadiV1DocumentDomain");

const TIMES = [
  "2026-08-02T10:00:00.123Z",
  "2026-08-02T10:00:01.123Z",
  "2026-08-02T10:00:02.123Z",
  "2026-08-02T10:00:03.123Z",
  "2026-08-02T10:00:04.123Z",
  "2026-08-02T10:00:05.123Z",
  "2026-08-02T10:00:06.123Z",
  "2026-08-02T10:00:07.123Z",
  "2026-08-02T10:00:08.123Z",
  "2026-08-02T10:00:09.123Z",
  "2026-08-02T10:00:10.123Z",
  "2026-08-02T10:00:11.123Z",
];

function fixture() {
  let index = 0;
  return createDocumentDomain({ clock: () => TIMES[index++] || TIMES.at(-1) });
}

function item(overrides = {}) {
  return {
    item_id: "item-1",
    description: "Service",
    quantity_millis: 2000,
    unit: "unité",
    unit_price: 5000,
    ...overrides,
  };
}

function commonInput(type = "FACTURE", overrides = {}) {
  return {
    document_id: `doc-${type.toLowerCase()}`,
    document_type: type,
    issuer_profile_id: "issuer-1",
    currency: "XOF",
    client: { name: "Client fictif" },
    items: [item()],
    discount_amount: 1000,
    tax_rate_basis_points: 0,
    ...overrides,
  };
}

function must(result) {
  assert.equal(result.ok, true, result.error);
  return result.value;
}

function advanceToPreview(domain, document) {
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.VERIFY));
  return must(domain.transitionDocument(document, DOCUMENT_EVENTS.PREPARE_PREVIEW, {
    preview: { title: "Aperçu" },
  }));
}

test("exports the four document types and the thirteen canonical states", () => {
  assert.deepEqual(DOCUMENT_TYPES, ["FACTURE", "DEVIS", "RECU", "DECHARGE"]);
  assert.deepEqual(DOCUMENT_STATES, [
    "COLLECTING", "INCOMPLETE", "READY_FOR_REVIEW", "VERIFIED", "PREVIEW_READY",
    "COST_CALCULATED", "AWAITING_GENERATION_CONFIRMATION", "RECHARGE_REQUIRED",
    "GENERATION_IN_PROGRESS", "GENERATED", "DELIVERED", "RECOVERABLE_FAILURE", "CANCELLED",
  ]);
  assert.deepEqual(DOCUMENT_PURPOSES, {
    FACTURE: "PAYMENT_DUE",
    DEVIS: "COMMERCIAL_PROPOSAL",
    RECU: "PAYMENT_RECEIVED",
    DECHARGE: "HANDOVER_ACKNOWLEDGEMENT",
  });
});

test("creates an immutable deterministic COLLECTING invoice draft", () => {
  const domain = fixture();
  const document = must(domain.createDocument(commonInput()));
  assert.equal(document.status, "COLLECTING");
  assert.equal(document.version, 1);
  assert.equal(document.aggregate_kind, "COMMON_DOCUMENT");
  assert.equal(document.subtotal, 10000);
  assert.equal(document.discount, 1000);
  assert.equal(document.total, 9000);
  assert.equal(document.issued_at, null);
  assert.equal(Object.isFrozen(document), true);
  assert.equal(Object.isFrozen(document.items), true);
});

test("recalculates subtotal, discount, taxes and total with integer arithmetic", () => {
  const domain = fixture();
  const document = must(domain.createDocument(commonInput("FACTURE", {
    discount_amount: 1000,
    tax_rate_basis_points: 1800,
  })));
  assert.equal(document.subtotal, 10000);
  assert.equal(document.discount, 1000);
  assert.equal(document.taxes, 1620);
  assert.equal(document.total, 10620);
});

test("supports COLLECTING to INCOMPLETE and back to collection", () => {
  const domain = fixture();
  let document = must(domain.createDocument(commonInput("FACTURE", {
    client: null,
    items: [],
    discount_amount: 0,
  })));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.MARK_INCOMPLETE));
  assert.equal(document.status, "INCOMPLETE");
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.CONTINUE_COLLECTING));
  assert.equal(document.status, "COLLECTING");
});

test("requires deterministic minimum data before READY_FOR_REVIEW", () => {
  const domain = fixture();
  const incomplete = must(domain.createDocument(commonInput("FACTURE", {
    client: null,
    items: [],
    discount_amount: 0,
  })));
  assert.deepEqual(domain.transitionDocument(incomplete, DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW), {
    ok: false,
    error: "DOCUMENT_CLIENT_REQUIRED",
  });
  const ready = must(domain.transitionDocument(
    must(domain.createDocument(commonInput())),
    DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW
  ));
  assert.equal(ready.status, "READY_FOR_REVIEW");
});

test("verifies and prepares a version-bound preview", () => {
  const domain = fixture();
  let document = must(domain.createDocument(commonInput()));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.VERIFY));
  assert.equal(document.status, "VERIFIED");
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.PREPARE_PREVIEW, {
    preview: { title: "Facture" },
  }));
  assert.equal(document.status, "PREVIEW_READY");
  assert.equal(document.preview.document_version, 1);
});

test("calculates a version-bound cost and invalidates preview and quote after modification", () => {
  const domain = fixture();
  let document = advanceToPreview(domain, must(domain.createDocument(commonInput())));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.CALCULATE_COST, {
    generation_quote: { quote_id: "quote-1", document_version: 1, page_count: 2, credit_cost: 2 },
  }));
  assert.equal(document.status, "COST_CALCULATED");
  assert.equal(document.generation_cost, 2);
  document = must(domain.modifyDocument(document, { notes: "Correction" }));
  assert.equal(document.status, "COLLECTING");
  assert.equal(document.version, 2);
  assert.equal(document.preview, null);
  assert.equal(document.generation_quote, null);
  assert.equal(document.generation_cost, null);
});

test("rejects a stale generation quote", () => {
  const domain = fixture();
  const preview = advanceToPreview(domain, must(domain.createDocument(commonInput())));
  assert.equal(domain.transitionDocument(preview, DOCUMENT_EVENTS.CALCULATE_COST, {
    generation_quote: { quote_id: "quote-1", document_version: 0, page_count: 1, credit_cost: 1 },
  }).error, "DOCUMENT_GENERATION_QUOTE_INVALID");
});

test("records and resumes a recoverable failure at the exact safe state", () => {
  const domain = fixture();
  let document = must(domain.createDocument(commonInput()));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.RECORD_RECOVERABLE_FAILURE, {
    code: "TEMPORARY_FAILURE",
  }));
  assert.equal(document.status, "RECOVERABLE_FAILURE");
  assert.equal(document.recoverable_failure.resume_state, "COLLECTING");
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.RESUME));
  assert.equal(document.status, "COLLECTING");
  assert.equal(document.recoverable_failure, null);
});

test("cancels an active document without deleting its content", () => {
  const domain = fixture();
  let document = must(domain.createDocument(commonInput()));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.CANCEL));
  assert.equal(document.status, "CANCELLED");
  assert.equal(document.items.length, 1);
  assert.equal(document.cancelled_at, "2026-08-02T10:00:01.123Z");
  assert.equal(domain.transitionDocument(document, DOCUMENT_EVENTS.CONTINUE_COLLECTING).error, "DOCUMENT_TRANSITION_FORBIDDEN");
});

test("rejects forbidden shortcuts and modifications of terminal documents", () => {
  const domain = fixture();
  let document = must(domain.createDocument(commonInput()));
  assert.equal(domain.transitionDocument(document, DOCUMENT_EVENTS.START_GENERATION).error, "DOCUMENT_TRANSITION_FORBIDDEN");
  document = advanceToPreview(domain, document);
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.CALCULATE_COST, {
    generation_quote: { quote_id: "quote-1", document_version: 1, page_count: 1, credit_cost: 1 },
  }));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.REQUEST_GENERATION_CONFIRMATION));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.START_GENERATION));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.MARK_GENERATED));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.MARK_DELIVERED));
  assert.equal(document.status, "DELIVERED");
  assert.equal(domain.modifyDocument(document, { notes: "Mutation interdite" }).error, "DOCUMENT_MODIFICATION_FORBIDDEN");
  assert.equal(domain.transitionDocument(document, DOCUMENT_EVENTS.CONTINUE_COLLECTING).error, "DOCUMENT_TRANSITION_FORBIDDEN");
});

test("creates FACTURE and DEVIS as line-based documents with distinct type semantics", () => {
  const domain = fixture();
  const invoice = must(domain.createDocument(commonInput("FACTURE")));
  const quote = must(domain.createDocument(commonInput("DEVIS")));
  assert.equal(invoice.document_type, "FACTURE");
  assert.equal(quote.document_type, "DEVIS");
  assert.equal(invoice.document_purpose, "PAYMENT_DUE");
  assert.equal(quote.document_purpose, "COMMERCIAL_PROPOSAL");
  assert.equal(invoice.aggregate_kind, "COMMON_DOCUMENT");
  assert.equal(quote.aggregate_kind, "COMMON_DOCUMENT");
  assert.equal(invoice.total, quote.total);
});

test("models RECU as received payment data rather than an amount-due item basket", () => {
  const domain = fixture();
  const receipt = must(domain.createDocument(commonInput("RECU", {
    client: undefined,
    items: undefined,
    discount_amount: undefined,
    tax_rate_basis_points: undefined,
    receipt: {
      payer: "Payeur fictif",
      beneficiary: "Bénéficiaire fictif",
      amount: 25000,
      reason: "Paiement reçu",
    },
  })));
  assert.equal(receipt.total, 25000);
  assert.equal(receipt.document_purpose, "PAYMENT_RECEIVED");
  assert.equal(receipt.items.length, 0);
  assert.equal(must(domain.transitionDocument(receipt, DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW)).status, "READY_FOR_REVIEW");
  assert.equal(domain.createDocument(commonInput("RECU", {
    receipt: { payer: "A", beneficiary: "B", amount: 1000, reason: "Paiement" },
  })).error, "DOCUMENT_RECEIPT_ITEMS_FORBIDDEN");
  assert.equal(domain.createDocument(commonInput("RECU", {
    items: undefined,
    discount_amount: 1,
    tax_rate_basis_points: 0,
    receipt: { payer: "A", beneficiary: "B", amount: 1000, reason: "Paiement" },
  })).error, "DOCUMENT_RECEIPT_CALCULATION_FIELDS_FORBIDDEN");
});

test("models DECHARGE with giver, receiver and typed subject instead of client/items", () => {
  const domain = fixture();
  const discharge = must(domain.createDocument({
    document_id: "doc-discharge",
    document_type: "DECHARGE",
    issuer_profile_id: "issuer-1",
    currency: "XOF",
    discharge: {
      giver: "Remettant fictif",
      receiver: "Receveur fictif",
      subject: { type: "MONEY", description: "Somme remise", amount: 30000 },
      reason: "Remise",
    },
  }));
  assert.equal(discharge.aggregate_kind, "DISCHARGE_DOCUMENT");
  assert.equal(discharge.document_purpose, "HANDOVER_ACKNOWLEDGEMENT");
  assert.equal(discharge.total, 30000);
  assert.equal(Object.hasOwn(discharge, "items"), false);
  assert.equal(must(domain.transitionDocument(discharge, DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW)).status, "READY_FOR_REVIEW");
});

test("issued_at comes only from the injected server clock when generation succeeds", () => {
  const domain = fixture();
  assert.equal(domain.createDocument({ ...commonInput(), issued_at: "2000-01-01T00:00:00.000Z" }).error, "DOCUMENT_SERVER_FIELD_FORBIDDEN");
  let document = advanceToPreview(domain, must(domain.createDocument(commonInput())));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.CALCULATE_COST, {
    generation_quote: { quote_id: "quote-1", document_version: 1, page_count: 1, credit_cost: 1 },
  }));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.REQUEST_GENERATION_CONFIRMATION));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.START_GENERATION));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.MARK_GENERATED, {
    issued_at: "2000-01-01T00:00:00.000Z",
  }));
  assert.equal(document.issued_at, "2026-08-02T10:00:07.123Z");
});

test("contains no stamp field or stamp command in creation and modification", () => {
  const domain = fixture();
  assert.equal(domain.createDocument({ ...commonInput(), add_stamp: false }).error, "DOCUMENT_SERVER_FIELD_FORBIDDEN");
  const document = must(domain.createDocument(commonInput()));
  assert.equal(domain.modifyDocument(document, { stamp: true }).error, "DOCUMENT_SERVER_FIELD_FORBIDDEN");
  assert.equal(Object.keys(document).some((key) => /stamp/i.test(key)), false);
});

test("round-trips through recharge without treating recharge as generation confirmation", () => {
  const domain = fixture();
  let document = advanceToPreview(domain, must(domain.createDocument(commonInput())));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.CALCULATE_COST, {
    generation_quote: { quote_id: "quote-1", document_version: 1, page_count: 1, credit_cost: 2 },
  }));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.REQUEST_GENERATION_CONFIRMATION));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.REQUIRE_RECHARGE));
  assert.equal(document.status, "RECHARGE_REQUIRED");
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.RECHARGE_CONFIRMED));
  assert.equal(document.status, "AWAITING_GENERATION_CONFIRMATION");
  assert.equal(domain.transitionDocument(document, DOCUMENT_EVENTS.MARK_GENERATED).error, "DOCUMENT_TRANSITION_FORBIDDEN");
});

test("resumes generation failure without changing the version or duplicating content", () => {
  const domain = fixture();
  let document = advanceToPreview(domain, must(domain.createDocument(commonInput())));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.CALCULATE_COST, {
    generation_quote: { quote_id: "quote-1", document_version: 1, page_count: 1, credit_cost: 1 },
  }));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.REQUEST_GENERATION_CONFIRMATION));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.START_GENERATION));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.RECORD_RECOVERABLE_FAILURE, {
    code: "GENERATION_TEMPORARY_FAILURE",
  }));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.RESUME));
  assert.equal(document.status, "GENERATION_IN_PROGRESS");
  assert.equal(document.version, 1);
  assert.equal(document.items.length, 1);
});
