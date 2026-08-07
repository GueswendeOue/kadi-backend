"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { DOCUMENT_EVENTS, createDocumentDomain } = require("../kadiV1DocumentDomain");
const { createInMemoryV1DocumentRepository } = require("../kadiV1DocumentRepository");
const { createSharedDocumentPipeline } = require("../kadiV1SharedDocumentPipeline");
const { createSharedDocumentPolicies } = require("../kadiV1SharedDocumentPolicies");

const OWNER = "22670000001";
const TIMES = Array.from({ length: 100 }, (_, index) => `2026-08-02T12:00:${String(index).padStart(2, "0")}.000Z`);

function generatedFile(document) {
  return { final_file_id: `final:${document.document_id}`, document_id: document.document_id, document_version: document.version, page_count: 1, checksum: "a".repeat(64), immutable: true };
}

function fixture({ quoteValidityRequired = false } = {}) {
  let timeIndex = 0;
  let idIndex = 0;
  const domain = createDocumentDomain({ clock: () => TIMES[timeIndex++] || TIMES.at(-1) });
  const repository = createInMemoryV1DocumentRepository();
  const policies = createSharedDocumentPolicies({ quoteValidityRequired });
  const pipeline = createSharedDocumentPipeline({
    repository,
    domain,
    policies,
    idFactory: (kind) => `${kind}:${++idIndex}`,
  });
  return { domain, repository, policies, pipeline };
}

function command(document, operation, suffix = "1", extra = {}) {
  const prefixes = {
    setIssuer: "set_issuer",
    setInvoiceKind: "set_invoice_kind",
    setReceiptFormat: "set_receipt_format",
    setClientOrPayer: "set_party",
    addContent: "add_content",
    updateContent: "update_content",
    removeContent: "remove_content",
    setOptions: "set_options",
    changeDocumentType: "change_document_type",
    applyBrainExtraction: "brain_extraction",
    markReadyForReview: "mark_ready",
    verifyDocument: "verify",
    reopenForCorrection: "reopen",
    cancelDocument: "cancel",
  };
  return {
    documentId: document.document_id,
    ownerWaId: OWNER,
    expectedVersion: document.version,
    idempotencyKey: `${prefixes[operation]}:${document.document_id}:${suffix}`,
    ...extra,
  };
}

async function createDraft(f, type, suffix = type.toLowerCase()) {
  const result = await f.pipeline.createDraft({
    ownerWaId: OWNER,
    documentType: type,
    idempotencyKey: `create_draft:${suffix}`,
  });
  assert.equal(result.ok, true, result.error);
  return result.value;
}

async function fillLineDocument(f, type = "FACTURE") {
  let document = await createDraft(f, type);
  let result = await f.pipeline.setIssuer(command(document, "setIssuer", "issuer", { issuerProfileId: "issuer:1" }));
  assert.equal(result.ok, true, result.error);
  document = result.value;
  result = await f.pipeline.setClientOrPayer(command(document, "setClientOrPayer", "client", {
    party: { name: "Client fictif", phone: "00000000" },
  }));
  assert.equal(result.ok, true, result.error);
  document = result.value;
  result = await f.pipeline.addContent(command(document, "addContent", "item-1", {
    content: { description: "Ordinateur", quantity: 1, unit: "unité", unit_price: 150000 },
  }));
  assert.equal(result.ok, true, result.error);
  return result.value;
}

async function persistTransition(f, document, event, payload = {}, suffix = event) {
  const transitioned = f.domain.transitionDocument(document, event, payload);
  assert.equal(transitioned.ok, true, transitioned.error);
  const persisted = await f.repository.persistTransition({
    document: transitioned.value,
    ownerWaId: OWNER,
    expectedVersion: document.version,
    fromState: document.status,
    eventType: event,
    idempotencyKey: `advance:${document.document_id}:${suffix}`,
  });
  assert.equal(persisted.ok, true, persisted.error);
  return persisted.value;
}

function brainResult(overrides = {}) {
  return {
    intent: "CREATE_DOCUMENT",
    document_type: "FACTURE",
    extracted_fields: {},
    missing_fields: [],
    uncertainties: [],
    confidence: 0.95,
    suggested_next_action: "REVIEW_EXTRACTED_DATA",
    user_facing_message_draft: null,
    provider_metadata: { provider: "synthetic", request_ref: "request-1", latency_ms: 1 },
    ...overrides,
  };
}

function candidate(value, status = "CONFIRMED", confidence = 0.95) {
  return { value, status, confidence, source_reference: "synthetic-input" };
}

test("creates an incomplete shared draft without inventing issuer, client or content", async () => {
  const f = fixture();
  const document = await createDraft(f, "FACTURE");
  assert.equal(document.status, "COLLECTING");
  assert.equal(document.version, 1);
  assert.equal(document.issuer_profile_id, null);
  assert.equal(document.client, null);
  assert.deepEqual(document.items, []);
  assert.deepEqual(document.missing_fields, ["issuer", "client", "items"]);
  assert.equal(document.issued_at, null);
});

test("FACTURE manages multiple server-id items and recalculates deterministic totals", async () => {
  const f = fixture();
  let document = await fillLineDocument(f);
  const firstId = document.items[0].item_id;
  let result = await f.pipeline.addContent(command(document, "addContent", "item-2", {
    content: { description: "Installation", quantity: 2, unit: "heure", unit_price: 25000 },
  }));
  document = result.value;
  assert.equal(document.items.length, 2);
  assert.equal(document.subtotal, 200000);
  assert.notEqual(document.items[1].item_id, firstId);

  result = await f.pipeline.updateContent(command(document, "updateContent", "fix-item", {
    itemId: firstId,
    content: { unit_price: 140000 },
  }));
  document = result.value;
  assert.equal(document.items.find((item) => item.item_id === firstId).unit_price, 140000);
  assert.equal(document.subtotal, 190000);

  result = await f.pipeline.removeContent(command(document, "removeContent", "remove-item", {
    itemId: document.items[1].item_id,
  }));
  assert.equal(result.value.items.length, 1);
  assert.equal(result.value.subtotal, 140000);
});

test("shared line policy rejects non-integer quantities and unknown client fields", async () => {
  const f = fixture();
  let document = await createDraft(f, "FACTURE", "policy");
  let result = await f.pipeline.setClientOrPayer(command(document, "setClientOrPayer", "unknown-client-field", {
    party: { name: "Client fictif", hidden_internal_value: "forbidden" },
  }));
  assert.deepEqual(result, { ok: false, error: "DOCUMENT_CLIENT_FIELD_UNKNOWN" });
  result = await f.pipeline.addContent(command(document, "addContent", "fractional", {
    content: { description: "Service", quantity: 1.5, unit_price: 1000 },
  }));
  assert.deepEqual(result, { ok: false, error: "DOCUMENT_ITEM_QUANTITY_INVALID" });
});

test("FACTURE preserves tax and discount sources across later content corrections", async () => {
  const f = fixture();
  let document = await fillLineDocument(f);
  document = (await f.pipeline.setOptions(command(document, "setOptions", "taxes", {
    options: { discount_amount: 10000, tax_rate_basis_points: 1800 },
  }))).value;
  assert.equal(document.discount, 10000);
  assert.equal(document.taxes, 25200);
  assert.equal(document.total, 165200);
  document = (await f.pipeline.updateContent(command(document, "updateContent", "taxed-correction", {
    itemId: document.items[0].item_id,
    content: { unit_price: 200000 },
  }))).value;
  assert.equal(document.discount_amount, 10000);
  assert.equal(document.tax_rate_basis_points, 1800);
  assert.equal(document.discount, 10000);
  assert.equal(document.taxes, 34200);
  assert.equal(document.total, 224200);
});

test("18% tax on a 500 000 FCFA subtotal computes exactly 90 000, total 590 000 — the canonical mission example", async () => {
  const f = fixture();
  let document = await createDraft(f, "FACTURE", "tax-example");
  document = (await f.pipeline.setIssuer(command(document, "setIssuer", "tax-example-issuer", { issuerProfileId: "issuer:1" }))).value;
  document = (await f.pipeline.setClientOrPayer(command(document, "setClientOrPayer", "tax-example-client", {
    party: { name: "Client fictif" },
  }))).value;
  document = (await f.pipeline.addContent(command(document, "addContent", "tax-example-item", {
    content: { description: "Prestation", quantity: 1, unit_price: 500000 },
  }))).value;
  assert.equal(document.subtotal, 500000);
  document = (await f.pipeline.setOptions(command(document, "setOptions", "tax-example-options", {
    options: { tax_rate_basis_points: 1800 },
  }))).value;
  assert.equal(document.taxes, 90000);
  assert.equal(document.discount, 0);
  assert.equal(document.total, 590000);
});

test("setOptions rejects a tax_rate_basis_points above 10000 (over 100%), zero mutation", async () => {
  const f = fixture();
  const document = await fillLineDocument(f);
  const result = await f.pipeline.setOptions(command(document, "setOptions", "over-100", {
    options: { tax_rate_basis_points: 10001 },
  }));
  assert.deepEqual(result, { ok: false, error: "DOCUMENT_OPTIONS_AMOUNT_INVALID" });
});

test("FACTURE exposes missing data then moves through review, verification and correction", async () => {
  const f = fixture();
  let document = await fillLineDocument(f);
  const missing = await f.pipeline.getMissingFields({ documentId: document.document_id, ownerWaId: OWNER });
  assert.deepEqual(missing.value, []);
  let result = await f.pipeline.markReadyForReview(command(document, "markReadyForReview"));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.status, "READY_FOR_REVIEW");
  document = result.value;
  result = await f.pipeline.verifyDocument(command(document, "verifyDocument"));
  assert.equal(result.value.status, "VERIFIED");
  document = result.value;
  result = await f.pipeline.reopenForCorrection(command(document, "reopenForCorrection"));
  assert.equal(result.value.status, "COLLECTING");
  assert.equal(result.value.version, document.version + 1);
  assert.equal((await f.repository.listVersions({ documentId: document.document_id, ownerWaId: OWNER })).value.length, 5);
});

test("DEVIS reuses line calculations and applies configurable validity without recognizing payment", async () => {
  const f = fixture({ quoteValidityRequired: true });
  let document = await fillLineDocument(f, "DEVIS");
  let missing = await f.pipeline.getMissingFields({ documentId: document.document_id, ownerWaId: OWNER });
  assert.deepEqual(missing.value, ["validity"]);
  const result = await f.pipeline.setOptions(command(document, "setOptions", "validity", {
    options: { options: { validity_days: 30 }, payment_terms: "Proposition valable trente jours" },
  }));
  document = result.value;
  missing = await f.pipeline.getMissingFields({ documentId: document.document_id, ownerWaId: OWNER });
  assert.deepEqual(missing.value, []);
  assert.equal(document.subtotal, 150000);
  assert.equal(f.policies.DEVIS.allowsPaymentRecognition, false);
  assert.equal(Object.hasOwn(document, "payment_confirmed"), false);
});

// OPTIONS-001: kadi_document_options_v1.json / kadi_edit_options_v1.json's
// real single Footer always submits discount_amount/notes/payment_terms/
// validity_days/payment_method/reference together (Meta submits every
// declared form field on every submission), alongside either
// tax_rate_percent or tax_rate_basis_points. Before this fix, every real
// FACTURE/DEVIS SAVE_OPTIONS submission failed outright with
// DOCUMENT_OPTIONS_FIELD_UNKNOWN — no FACTURE or DEVIS document could ever
// reach DOCUMENT_REVIEW via the real Flow.

test("OPTIONS-001: the real full FACTURE Flow shape (every field, most left blank) is accepted, never DOCUMENT_OPTIONS_FIELD_UNKNOWN", async () => {
  const f = fixture();
  let document = await fillLineDocument(f);
  const result = await f.pipeline.setOptions(command(document, "setOptions", "real-shape", {
    options: { discount_amount: "", notes: "", payment_terms: "", validity_days: "", payment_method: "", reference: "", tax_rate_basis_points: 1800 },
  }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.tax_rate_basis_points, 1800);
});

test("OPTIONS-001: DEVIS validity_days submitted as the real flat field genuinely persists and is retrievable afterward", async () => {
  const f = fixture({ quoteValidityRequired: true });
  let document = await fillLineDocument(f, "DEVIS");
  const result = await f.pipeline.setOptions(command(document, "setOptions", "flat-validity", {
    options: { discount_amount: "", notes: "", payment_terms: "", validity_days: 30, payment_method: "", reference: "" },
  }));
  assert.equal(result.ok, true, result.error);
  document = result.value;
  assert.equal(document.options.validity_days, 30, "must persist at the same canonical location as the nested form (document.options.validity_days)");
  const missing = await f.pipeline.getMissingFields({ documentId: document.document_id, ownerWaId: OWNER });
  assert.deepEqual(missing.value, [], "validity_days must genuinely satisfy the DEVIS validity requirement, not just be silently accepted");
  const reloaded = await f.repository.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER });
  assert.equal(reloaded.value.options.validity_days, 30, "retrievable on a fresh read, not merely present on the in-memory return value");
});

test("OPTIONS-001: a flat validity_days conflicting with an already-nested value fails closed, never silently picks one", async () => {
  const f = fixture();
  const document = await fillLineDocument(f, "DEVIS");
  const result = await f.pipeline.setOptions(command(document, "setOptions", "validity-conflict", {
    options: { options: { validity_days: 45 }, validity_days: 30 },
  }));
  assert.deepEqual(result, { ok: false, error: "DOCUMENT_VALIDITY_CONFLICT" });
});

test("OPTIONS-001: blank optional fields (discount_amount, validity_days) never corrupt persisted state — treated as 'not provided', never zero", async () => {
  const f = fixture();
  let document = await fillLineDocument(f);
  const before = { discount: document.discount, taxes: document.taxes, total: document.total };
  const result = await f.pipeline.setOptions(command(document, "setOptions", "all-blank", {
    options: { discount_amount: "", notes: "", payment_terms: "", validity_days: "", payment_method: "", reference: "" },
  }));
  assert.equal(result.ok, true, result.error);
  document = result.value;
  assert.equal(document.discount, before.discount, "blank discount_amount must not zero out or otherwise change the existing discount");
  assert.equal(document.taxes, before.taxes);
  assert.equal(document.total, before.total);
  assert.equal(Object.hasOwn(document, "validity_days"), false, "a blank validity_days must never be persisted as a top-level field");
});

test("OPTIONS-001: discount_amount submitted as a numeric string (an alternate real Meta serialization) is accepted like a genuine number", async () => {
  const f = fixture();
  let document = await fillLineDocument(f);
  const result = await f.pipeline.setOptions(command(document, "setOptions", "string-discount", {
    options: { discount_amount: "5000" },
  }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.discount, 5000);
});

test("OPTIONS-001: payment_method/reference are accepted (never DOCUMENT_OPTIONS_FIELD_UNKNOWN) but never persisted for FACTURE/DEVIS — no invoice-level meaning exists for them", async () => {
  const f = fixture();
  let document = await fillLineDocument(f);
  const result = await f.pipeline.setOptions(command(document, "setOptions", "payment-fields-dropped", {
    options: { payment_method: "ESPECES", reference: "REF-123", notes: "Merci" },
  }));
  assert.equal(result.ok, true, result.error);
  document = result.value;
  assert.equal(document.notes, "Merci");
  assert.equal(Object.hasOwn(document, "payment_method"), false, "payment_method has no FACTURE-level home and must never be persisted there");
  assert.equal(Object.hasOwn(document, "reference"), false, "reference has no FACTURE-level home and must never be persisted there");
});

test("OPTIONS-001: an arbitrary unrelated field is still rejected — the fix does not weaken the allowlist generally", async () => {
  const f = fixture();
  const document = await fillLineDocument(f);
  const result = await f.pipeline.setOptions(command(document, "setOptions", "unrelated-field", {
    options: { discount_amount: 0, not_a_real_option: "x" },
  }));
  assert.deepEqual(result, { ok: false, error: "DOCUMENT_OPTIONS_FIELD_UNKNOWN" });
});

test("OPTIONS-001: RECU's own, separate PAYMENT_OPTION_FIELDS allowlist is unaffected — still rejects discount_amount/validity_days", async () => {
  const f = fixture();
  let document = await createDraft(f, "RECU");
  document = (await f.pipeline.setIssuer(command(document, "setIssuer", "issuer-unaffected", { issuerProfileId: "issuer:receipt" }))).value;
  const result = await f.pipeline.setOptions(command(document, "setOptions", "recu-rejects-discount", {
    options: { discount_amount: 100 },
  }));
  assert.deepEqual(result, { ok: false, error: "DOCUMENT_OPTIONS_FIELD_UNKNOWN" });
});

test("OPTIONS-001: a real Flow submission with every optional field left blank succeeds as a harmless no-op, never DOCUMENT_OPTIONS_EMPTY", async () => {
  const f = fixture();
  let document = await fillLineDocument(f);
  const before = { version: document.version, discount: document.discount, taxes: document.taxes };
  const result = await f.pipeline.setOptions(command(document, "setOptions", "harmless-no-op", {
    options: { discount_amount: "", notes: "", payment_terms: "", validity_days: "", payment_method: "", reference: "" },
  }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.discount, before.discount);
  assert.equal(result.value.taxes, before.taxes);
  assert.equal(result.value.version, before.version, "a genuine no-op must never bump the document version");
});

// EDIT_OPTIONS-001 (independent review finding on the OPTIONS-001 fix,
// MEDIUM/merge blocker): unlike ARTICLE_FORM/EDIT_CLIENT, the real
// EDIT_OPTIONS Flow never prefills notes/payment_terms with the document's
// current values — its single combined form always submits them blank when
// the owner leaves them untouched. Before this fix, normalizeOptions still
// copied that blank straight into the persisted patch, which
// kadiV1SharedDocumentPipeline.js's setOptions shallow-merges onto the
// document — so a correction that only touched tax could silently erase a
// real, previously-saved note/payment term.

test("EDIT_OPTIONS-001: a real correction that only changes tax preserves previously persisted notes and payment_terms untouched", async () => {
  const f = fixture();
  let document = await fillLineDocument(f);
  const withNotes = await f.pipeline.setOptions(command(document, "setOptions", "seed-notes", {
    options: { notes: "Merci pour votre confiance", payment_terms: "Paiement sous 30 jours" },
  }));
  assert.equal(withNotes.ok, true, withNotes.error);
  document = withNotes.value;
  assert.equal(document.notes, "Merci pour votre confiance");
  assert.equal(document.payment_terms, "Paiement sous 30 jours");

  // The real EDIT_OPTIONS combined-form submission: only tax was actually
  // typed by the owner, every other field (including notes/payment_terms,
  // which the Flow never prefilled) comes back blank.
  const taxOnly = await f.pipeline.setOptions(command(document, "setOptions", "tax-only-correction", {
    options: { tax_rate_basis_points: 1800, discount_amount: "", notes: "", payment_terms: "", validity_days: "", payment_method: "", reference: "" },
  }));
  assert.equal(taxOnly.ok, true, taxOnly.error);
  document = taxOnly.value;
  assert.equal(document.tax_rate_basis_points, 1800, "the actually-changed field must still update");
  assert.equal(document.notes, "Merci pour votre confiance", "an untouched, never-prefilled note must survive a correction to an unrelated field");
  assert.equal(document.payment_terms, "Paiement sous 30 jours", "an untouched, never-prefilled payment term must survive a correction to an unrelated field");

  const reloaded = await f.repository.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER });
  assert.equal(reloaded.value.notes, "Merci pour votre confiance", "retrievable on a fresh read, not merely present on the in-memory return value");
  assert.equal(reloaded.value.payment_terms, "Paiement sous 30 jours");
});

test("EDIT_OPTIONS-001: explicitly supplied non-blank notes/payment_terms still update normally", async () => {
  const f = fixture();
  let document = await fillLineDocument(f);
  document = (await f.pipeline.setOptions(command(document, "setOptions", "seed-notes-2", {
    options: { notes: "Ancienne note", payment_terms: "Ancienne condition" },
  }))).value;

  const corrected = await f.pipeline.setOptions(command(document, "setOptions", "explicit-update", {
    options: { notes: "Nouvelle note", payment_terms: "Nouvelle condition" },
  }));
  assert.equal(corrected.ok, true, corrected.error);
  assert.equal(corrected.value.notes, "Nouvelle note", "an explicitly resubmitted non-blank value must genuinely overwrite the old one");
  assert.equal(corrected.value.payment_terms, "Nouvelle condition");
});

test("EDIT_OPTIONS-001: the initial DOCUMENT_OPTIONS submission with blank notes/payment_terms still works and leaves notes/payment_terms exactly as they were", async () => {
  const f = fixture();
  let document = await fillLineDocument(f);
  const before = { notes: document.notes, payment_terms: document.payment_terms };
  const result = await f.pipeline.setOptions(command(document, "setOptions", "initial-blank-notes", {
    options: { tax_rate_basis_points: 1800, discount_amount: "", notes: "", payment_terms: "", validity_days: "", payment_method: "", reference: "" },
  }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.tax_rate_basis_points, 1800, "the actually-supplied field must still update");
  assert.equal(result.value.notes, before.notes, "a blank note on first submission must never overwrite whatever the field already was");
  assert.equal(result.value.payment_terms, before.payment_terms);
});

test("RECU keeps payer, beneficiary and payment facts without artificial items", async () => {
  const f = fixture();
  let document = await createDraft(f, "RECU");
  document = (await f.pipeline.setIssuer(command(document, "setIssuer", "issuer", { issuerProfileId: "issuer:receipt" }))).value;
  document = (await f.pipeline.setClientOrPayer(command(document, "setClientOrPayer", "parties", {
    party: { payer: "Payeur fictif", beneficiary: "Entreprise fictive" },
  }))).value;
  document = (await f.pipeline.addContent(command(document, "addContent", "payment", {
    content: { amount: 75000, reason: "Règlement prestation" },
  }))).value;
  document = (await f.pipeline.setOptions(command(document, "setOptions", "payment-options", {
    options: { payment_method: "Espèces", reference: "REF-FICTIVE" },
  }))).value;
  document = (await f.pipeline.setReceiptFormat(command(document, "setReceiptFormat", "format", { receiptFormat: "A4" }))).value;
  assert.deepEqual(document.items, []);
  assert.equal(document.receipt.amount, 75000);
  assert.equal(document.total, 75000);
  assert.equal(document.receipt.payment_method, "Espèces");
  assert.equal(f.policies.RECU.allowsPaymentRecognition, false);
  assert.equal(Object.hasOwn(document, "payment_confirmed"), false);
  assert.deepEqual((await f.pipeline.getMissingFields({ documentId: document.document_id, ownerWaId: OWNER })).value, []);
});

test("applies only confirmed fields from a validated BrainResult and assigns server item ids", async () => {
  const f = fixture();
  let document = await createDraft(f, "FACTURE", "brain");
  document = (await f.pipeline.setIssuer(command(document, "setIssuer", "issuer", { issuerProfileId: "issuer:brain" }))).value;
  const result = await f.pipeline.applyBrainExtraction(command(document, "applyBrainExtraction", "extract", {
    brainResult: brainResult({
      extracted_fields: {
        client: candidate({ name: "Client extrait" }),
        items: candidate([{ description: "Service extrait", quantity: 2, unit: "unité", unit_price: 10000 }]),
        taxes: candidate({ rate: 18 }),
      },
    }),
  }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.client.name, "Client extrait");
  assert.match(result.value.items[0].item_id, /^item:/);
  assert.equal(result.value.subtotal, 20000);
  assert.equal(result.value.taxes, 3600);
  assert.equal(result.value.total, 23600);
  assert.equal(result.ready_for_review, false);
});

test("keeps uncertain extraction unconfirmed and recommends one targeted question", async () => {
  const f = fixture();
  const document = await createDraft(f, "FACTURE", "uncertain");
  const result = await f.pipeline.applyBrainExtraction(command(document, "applyBrainExtraction", "uncertain", {
    brainResult: brainResult({
      extracted_fields: { client: candidate({ name: "Nom possible" }, "UNCERTAIN", 0.4) },
      missing_fields: ["client"],
      uncertainties: [{
        field: "client",
        reason: "Nom difficile à lire",
        candidate_value: { name: "Nom possible" },
        confidence: 0.4,
        source_reference: "synthetic-input",
      }],
      confidence: 0.4,
      suggested_next_action: "ASK_TARGETED_QUESTION",
      user_facing_message_draft: "Quel est le nom exact du client ?",
    }),
  }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.client, null);
  assert.equal(result.value.uncertainties.length, 1);
  assert.equal(result.question, "Quel est le nom exact du client ?");
  assert.equal((await f.pipeline.markReadyForReview(command(result.value, "markReadyForReview", "blocked"))).ok, false);
});

test("rejects AI-provided totals, dates and document numbers before persistence", async () => {
  const f = fixture();
  const document = await createDraft(f, "FACTURE", "reserved");
  for (const field of ["total_read", "date_read", "document_number_read"]) {
    const result = await f.pipeline.applyBrainExtraction(command(document, "applyBrainExtraction", field, {
      brainResult: brainResult({ extracted_fields: { [field]: candidate(field === "total_read" ? 1000 : "value") } }),
    }));
    assert.deepEqual(result, { ok: false, error: "BRAIN_AUTHORITY_FIELD_FORBIDDEN" });
  }
  const current = await f.repository.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER });
  assert.equal(current.value.version, 1);
  assert.equal(current.value.total, 0);
});

test("rejects stale versions and replays an idempotent content command without duplication", async () => {
  const f = fixture();
  let document = await fillLineDocument(f);
  const add = command(document, "addContent", "idempotent", {
    content: { description: "Clavier", quantity: 1, unit: "unité", unit_price: 12000 },
  });
  const first = await f.pipeline.addContent(add);
  const replay = await f.pipeline.addContent(add);
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.value.items.length, 2);
  const stale = await f.pipeline.setOptions(command(document, "setOptions", "stale", {
    options: { notes: "Note obsolète" },
  }));
  assert.deepEqual(stale, { ok: false, error: "DOCUMENT_VERSION_CONFLICT" });
});

test("a correction after cost calculation creates a version and invalidates preview and quote", async () => {
  const f = fixture();
  let document = await fillLineDocument(f);
  document = (await f.pipeline.markReadyForReview(command(document, "markReadyForReview"))).value;
  document = (await f.pipeline.verifyDocument(command(document, "verifyDocument"))).value;
  document = await persistTransition(f, document, DOCUMENT_EVENTS.PREPARE_PREVIEW, { preview: { title: "Aperçu" } });
  document = await persistTransition(f, document, DOCUMENT_EVENTS.CALCULATE_COST, {
    generation_quote: { quote_id: "quote:1", document_version: document.version, page_count: 1, credit_cost: 1 },
  });
  const priorVersion = document.version;
  const result = await f.pipeline.updateContent(command(document, "updateContent", "after-cost", {
    itemId: document.items[0].item_id,
    content: { unit_price: 160000 },
  }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.status, "COLLECTING");
  assert.equal(result.value.version, priorVersion + 1);
  assert.equal(result.value.preview, null);
  assert.equal(result.value.generation_quote, null);
  assert.equal(result.value.generation_cost, null);
});

test("DELIVERED remains immutable through every pipeline correction operation", async () => {
  const f = fixture();
  let document = await fillLineDocument(f);
  document = (await f.pipeline.markReadyForReview(command(document, "markReadyForReview"))).value;
  document = (await f.pipeline.verifyDocument(command(document, "verifyDocument"))).value;
  document = await persistTransition(f, document, DOCUMENT_EVENTS.PREPARE_PREVIEW, { preview: { title: "Aperçu" } }, "preview");
  document = await persistTransition(f, document, DOCUMENT_EVENTS.CALCULATE_COST, {
    generation_quote: { quote_id: "quote:2", document_version: document.version, page_count: 1, credit_cost: 1 },
  }, "cost");
  document = await persistTransition(f, document, DOCUMENT_EVENTS.REQUEST_GENERATION_CONFIRMATION, {}, "confirm");
  document = await persistTransition(f, document, DOCUMENT_EVENTS.START_GENERATION, {}, "generate");
  document = await persistTransition(f, document, DOCUMENT_EVENTS.MARK_GENERATED, { generated_file: generatedFile(document) }, "generated");
  document = await persistTransition(f, document, DOCUMENT_EVENTS.MARK_DELIVERED, {}, "delivered");
  const result = await f.pipeline.updateContent(command(document, "updateContent", "immutable", {
    itemId: document.items[0].item_id,
    content: { unit_price: 1 },
  }));
  assert.deepEqual(result, { ok: false, error: "DOCUMENT_MODIFICATION_FORBIDDEN" });
});

test("review model is provider-independent, human-readable and has no generation side effect", async () => {
  const f = fixture();
  const document = await fillLineDocument(f);
  const result = await f.pipeline.buildReviewModel({ documentId: document.document_id, ownerWaId: OWNER });
  assert.equal(result.ok, true);
  assert.equal(result.value.document_type, "FACTURE");
  assert.equal(result.value.total, 150000);
  assert.deepEqual(result.value.actions, ["Modifier", "Continuer", "Annuler"]);
  assert.doesNotMatch(JSON.stringify(result.value), /flow|payload|session|endpoint|openai|gemini|ocr/i);
  assert.equal(Object.hasOwn(result.value, "generation_cost"), false);
  assert.equal(Object.hasOwn(result.value, "pdf"), false);
});

test("cancelDocument persists an atomic terminal transition", async () => {
  const f = fixture();
  const document = await createDraft(f, "FACTURE", "cancel");
  const result = await f.pipeline.cancelDocument(command(document, "cancelDocument"));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.status, "CANCELLED");
  assert.equal((await f.repository.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER })).value.status, "CANCELLED");
});

test("setInvoiceKind persists FINAL or PROFORMA in the document's own options bag, not a new column", async () => {
  const f = fixture();
  for (const invoiceKind of ["FINAL", "PROFORMA"]) {
    const document = await createDraft(f, "FACTURE", `invoice-kind-${invoiceKind}`);
    const result = await f.pipeline.setInvoiceKind(command(document, "setInvoiceKind", invoiceKind, { invoiceKind }));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.value.options.invoice_kind, invoiceKind);
    const reloaded = await f.repository.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER });
    assert.equal(reloaded.value.options.invoice_kind, invoiceKind);
  }
});

test("setInvoiceKind rejects any value other than exactly FINAL or PROFORMA", async () => {
  const f = fixture();
  for (const invalid of ["", "final", "proforma", "AUTRE", null, undefined]) {
    const document = await createDraft(f, "FACTURE", `invoice-kind-invalid-${String(invalid)}`);
    const result = await f.pipeline.setInvoiceKind(command(document, "setInvoiceKind", String(invalid), { invoiceKind: invalid }));
    assert.deepEqual(result, { ok: false, error: "DOCUMENT_INVOICE_KIND_INVALID" });
  }
});

test("setInvoiceKind refuses to apply to a document type other than FACTURE", async () => {
  const f = fixture();
  const document = await createDraft(f, "DEVIS", "invoice-kind-devis");
  const result = await f.pipeline.setInvoiceKind(command(document, "setInvoiceKind", "1", { invoiceKind: "FINAL" }));
  assert.deepEqual(result, { ok: false, error: "DOCUMENT_INVOICE_KIND_NOT_APPLICABLE" });
});

test("setInvoiceKind is idempotent and preserves the rest of the options bag", async () => {
  const f = fixture();
  let document = await createDraft(f, "FACTURE", "invoice-kind-idempotent");
  const withOptions = await f.pipeline.setOptions(command(document, "setOptions", "1", { options: { options: { custom_note: "Merci" } } }));
  assert.equal(withOptions.ok, true, withOptions.error);
  document = withOptions.value;
  const setKind = command(document, "setInvoiceKind", "once", { invoiceKind: "FINAL" });
  const first = await f.pipeline.setInvoiceKind(setKind);
  assert.equal(first.ok, true, first.error);
  assert.equal(first.value.options.custom_note, "Merci");
  assert.equal(first.value.options.invoice_kind, "FINAL");
  const replay = await f.pipeline.setInvoiceKind(setKind);
  assert.equal(replay.ok, true, replay.error);
  assert.equal(replay.duplicate, true);
});

test("changeDocumentType converts an active FACTURE draft to DEVIS, preserving client and items, without a new draft", async () => {
  const f = fixture();
  const document = await fillLineDocument(f, "FACTURE");
  assert.equal(document.document_type, "FACTURE");
  const result = await f.pipeline.changeDocumentType(command(document, "changeDocumentType", "1", { targetDocumentType: "DEVIS" }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.document_type, "DEVIS");
  assert.equal(result.value.document_id, document.document_id, "same draft, not a new one");
  assert.deepEqual(result.value.client, document.client);
  assert.equal(result.value.items.length, 1);
  assert.equal(result.value.items[0].description, "Ordinateur");
  assert.equal(result.value.items[0].unit_price, 150000);
  assert.equal(result.value.subtotal, document.subtotal);
  assert.equal(result.value.total, document.total);
  assert.equal(result.value.version, document.version + 1);
  const reloaded = await f.repository.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER });
  assert.equal(reloaded.value.document_type, "DEVIS");
});

test("changeDocumentType converts DEVIS back to FACTURE", async () => {
  const f = fixture();
  const document = await fillLineDocument(f, "DEVIS");
  const result = await f.pipeline.changeDocumentType(command(document, "changeDocumentType", "1", { targetDocumentType: "FACTURE" }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.document_type, "FACTURE");
});

test("changeDocumentType is a pure type flip: no debit, no generation, no document number, no issued_at, no final-state transition", async () => {
  const f = fixture();
  const document = await fillLineDocument(f, "FACTURE");
  const result = await f.pipeline.changeDocumentType(command(document, "changeDocumentType", "1", { targetDocumentType: "DEVIS" }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.status, "COLLECTING");
  assert.equal(result.value.issued_at, null);
  assert.equal(result.value.document_number, null);
  assert.equal(result.value.generation_quote, null);
  assert.equal(result.value.generated_file, null);
});

test("changeDocumentType recalculates missing_fields for the new type via the backend policy, not the provider", async () => {
  const f = fixture({ quoteValidityRequired: true });
  const document = await fillLineDocument(f, "FACTURE");
  assert.deepEqual(document.missing_fields, []);
  const result = await f.pipeline.changeDocumentType(command(document, "changeDocumentType", "1", { targetDocumentType: "DEVIS" }));
  assert.equal(result.ok, true, result.error);
  assert.ok(result.value.missing_fields.includes("validity"), "DEVIS policy requires validity when quoteValidityRequired is true");
});

test("a duplicate webhook replays the same changeDocumentType idempotency key without changing the type twice", async () => {
  const f = fixture();
  const document = await fillLineDocument(f, "FACTURE");
  const changeCommand = command(document, "changeDocumentType", "once", { targetDocumentType: "DEVIS" });
  const first = await f.pipeline.changeDocumentType(changeCommand);
  assert.equal(first.ok, true, first.error);
  assert.equal(first.value.document_type, "DEVIS");
  const replay = await f.pipeline.changeDocumentType(changeCommand);
  assert.equal(replay.ok, true, replay.error);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.value.document_type, "DEVIS");
  assert.equal(replay.value.version, first.value.version, "no second version was created by the replay");
});

test("changeDocumentType rejects RECU and unsupported targets, zero mutation", async () => {
  const f = fixture();
  let document = await createDraft(f, "RECU", "recu-1");
  document = (await f.pipeline.setIssuer(command(document, "setIssuer", "1", { issuerProfileId: "issuer:1" }))).value;
  const fromReceipt = await f.pipeline.changeDocumentType(command(document, "changeDocumentType", "1", { targetDocumentType: "FACTURE" }));
  assert.deepEqual(fromReceipt, { ok: false, error: "DOCUMENT_TYPE_CONVERSION_UNSUPPORTED" });
  const invoice = await fillLineDocument(f, "FACTURE");
  const toReceipt = await f.pipeline.changeDocumentType(command(invoice, "changeDocumentType", "2", { targetDocumentType: "RECU" }));
  assert.deepEqual(toReceipt, { ok: false, error: "DOCUMENT_TYPE_CONVERSION_TARGET_INVALID" });
  const reloaded = await f.repository.getDocumentById({ documentId: invoice.document_id, ownerWaId: OWNER });
  assert.equal(reloaded.value.version, invoice.version, "a rejected conversion must not create a new version");
});

test("changeDocumentType rejects a stale expectedVersion", async () => {
  const f = fixture();
  const document = await fillLineDocument(f, "FACTURE");
  const stale = { ...command(document, "changeDocumentType", "1", { targetDocumentType: "DEVIS" }), expectedVersion: document.version + 5 };
  const result = await f.pipeline.changeDocumentType(stale);
  assert.deepEqual(result, { ok: false, error: "DOCUMENT_VERSION_CONFLICT" });
});

test("shared pipeline has no Meta, PDF, wallet, payment or provider SDK dependency", () => {
  for (const file of ["kadiV1SharedDocumentPipeline.js", "kadiV1SharedDocumentPolicies.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.doesNotMatch(source, /require\(["'][^"']*(?:whatsapp|flow|pdf|wallet|billing|payment|openai|gemini)/i, file);
    assert.doesNotMatch(source, /\/webhook|\/data_exchange|flow_id|phone_number_id|generatePDF|consumeCredit/i, file);
  }
});
