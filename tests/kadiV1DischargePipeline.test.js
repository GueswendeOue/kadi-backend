"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { DOCUMENT_EVENTS, createDocumentDomain } = require("../kadiV1DocumentDomain");
const { createInMemoryV1DocumentRepository } = require("../kadiV1DocumentRepository");
const { createDischargePipeline } = require("../kadiV1DischargePipeline");

const OWNER = "22670000001";

function generatedFile(document) {
  return { final_file_id: `final:${document.document_id}`, document_id: document.document_id, document_version: document.version, page_count: 1, checksum: "a".repeat(64), immutable: true };
}

function fixture() {
  let tick = 0;
  let id = 0;
  const domain = createDocumentDomain({
    clock: () => new Date(Date.UTC(2026, 7, 2, 12, 0, tick++)).toISOString(),
  });
  const repository = createInMemoryV1DocumentRepository();
  const pipeline = createDischargePipeline({
    repository,
    domain,
    idFactory: (kind) => `${kind}:${++id}`,
  });
  return { domain, repository, pipeline };
}

function command(document, operation, extra = {}) {
  return {
    documentId: document.document_id,
    ownerWaId: OWNER,
    expectedVersion: document.version,
    idempotencyKey: `${operation}:${document.document_id}:${document.version}`,
    ...extra,
  };
}

async function createDraft(f, suffix = "default") {
  const result = await f.pipeline.createDischargeDraft({
    ownerWaId: OWNER,
    idempotencyKey: `create_discharge:${suffix}`,
  });
  assert.equal(result.ok, true, result.error);
  return result.value;
}

async function fillDischarge(f, content = { type: "MONEY", amount: 50000, currency: "XOF" }) {
  let document = await createDraft(f, content.type.toLowerCase());
  document = (await f.pipeline.setIssuerOrGiver(command(document, "giver", { giver: "Entreprise Kadi Test" }))).value;
  document = (await f.pipeline.setRecipient(command(document, "recipient", { recipient: "Moussa Test" }))).value;
  document = (await f.pipeline.setTransferredContent(command(document, "content", { content }))).value;
  document = (await f.pipeline.setReason(command(document, "reason", { reason: "Remise convenue entre les parties" }))).value;
  return document;
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

function candidate(value, status = "CONFIRMED", confidence = 0.95) {
  return { value, status, confidence, source_reference: "synthetic-input" };
}

function brainResult(overrides = {}) {
  return {
    intent: "CREATE_DOCUMENT",
    document_type: "DECHARGE",
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

test("creates a DECHARGE draft without fake invoice content", async () => {
  const f = fixture();
  const document = await createDraft(f);
  assert.equal(document.document_type, "DECHARGE");
  assert.equal(document.status, "COLLECTING");
  assert.equal(document.issuer_profile_id, null);
  assert.equal(document.issued_at, null);
  assert.equal(Object.hasOwn(document, "items"), false);
  assert.deepEqual(document.missing_fields, ["giver", "recipient", "transferred_content_type", "reason"]);
});

test("MONEY requires a positive integer amount and a currency", async () => {
  const f = fixture();
  const document = await createDraft(f, "money-policy");
  for (const content of [
    { type: "MONEY", amount: 0, currency: "XOF" },
    { type: "MONEY", amount: 1.5, currency: "XOF" },
    { type: "MONEY", amount: 50000 },
  ]) {
    assert.equal((await f.pipeline.setTransferredContent(command(document, `bad-money-${String(content.amount)}`, { content }))).ok, false);
  }
  const result = await f.pipeline.setTransferredContent(command(document, "valid-money", {
    content: { type: "MONEY", amount: 50000, currency: "XOF" },
  }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.discharge.subject.amount, 50000);
  assert.equal(result.value.currency, "XOF");
});

test("GOODS requires a description, permits quantity and forbids artificial money", async () => {
  const f = fixture();
  let document = await fillDischarge(f, { type: "GOODS", description: "Clés du magasin", quantity: 2 });
  assert.equal(document.discharge.subject.type, "GOODS");
  assert.equal(document.discharge.quantity, 2);
  assert.equal(document.discharge.subject.amount, null);
  assert.equal(document.total, null);
  const invalid = await f.pipeline.setTransferredContent(command(document, "goods-with-money", {
    content: { type: "GOODS", description: "Clés", amount: 1000 },
  }));
  assert.deepEqual(invalid, { ok: false, error: "DISCHARGE_NON_MONEY_AMOUNT_FORBIDDEN" });
});

test("DOCUMENT and OTHER require descriptions without monetary value", async () => {
  for (const type of ["DOCUMENT", "OTHER"]) {
    const f = fixture();
    const document = await fillDischarge(f, { type, description: type === "DOCUMENT" ? "Contrat original" : "Accès au local" });
    assert.equal(document.discharge.subject.type, type);
    assert.equal(document.discharge.subject.amount, null);
    assert.equal((await f.pipeline.getMissingFields({ documentId: document.document_id, ownerWaId: OWNER })).value.length, 0);
  }
});

test("readiness requires distinct parties, a coherent content and a reason", async () => {
  const f = fixture();
  let document = await createDraft(f, "missing");
  document = (await f.pipeline.setIssuerOrGiver(command(document, "same-giver", { giver: "Awa" }))).value;
  document = (await f.pipeline.setRecipient(command(document, "same-recipient", { recipient: "awa" }))).value;
  document = (await f.pipeline.setTransferredContent(command(document, "same-content", {
    content: { type: "DOCUMENT", description: "Attestation" },
  }))).value;
  assert.deepEqual((await f.pipeline.getMissingFields({ documentId: document.document_id, ownerWaId: OWNER })).value, ["reason"]);
  document = (await f.pipeline.setReason(command(document, "same-reason", { reason: "Transmission" }))).value;
  assert.deepEqual(
    await f.pipeline.markReadyForReview(command(document, "same-ready")),
    { ok: false, error: "DISCHARGE_PARTIES_MUST_DIFFER" }
  );
});

test("moves a complete discharge through readiness, verification and versioned correction", async () => {
  const f = fixture();
  let document = await fillDischarge(f);
  document = (await f.pipeline.markReadyForReview(command(document, "ready"))).value;
  assert.equal(document.status, "READY_FOR_REVIEW");
  document = (await f.pipeline.verifyDischarge(command(document, "verify"))).value;
  assert.equal(document.status, "VERIFIED");
  const verifiedVersion = document.version;
  const versionsBeforeCorrection = (await f.repository.listVersions({
    documentId: document.document_id,
    ownerWaId: OWNER,
  })).value.length;
  document = (await f.pipeline.reopenForCorrection(command(document, "reopen"))).value;
  assert.equal(document.status, "COLLECTING");
  assert.equal(document.version, verifiedVersion + 1);
  assert.equal(
    (await f.repository.listVersions({ documentId: document.document_id, ownerWaId: OWNER })).value.length,
    versionsBeforeCorrection + 1
  );
});

test("applies only certain DECHARGE fields from a validated BrainResult", async () => {
  const f = fixture();
  const document = await createDraft(f, "brain-certain");
  const result = await f.pipeline.applyBrainExtraction(command(document, "brain-certain", {
    brainResult: brainResult({
      extracted_fields: {
        giver: candidate("Entreprise Test"),
        receiver: candidate("Moussa"),
        subject: candidate({ type: "MONEY", label: "Somme remise" }),
        amount: candidate(50000),
        currency: candidate("XOF"),
        reason: candidate("Achat de ciment"),
      },
    }),
  }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.discharge.receiver, "Moussa");
  assert.equal(result.value.discharge.subject.amount, 50000);
  assert.equal(result.value.discharge.reason, "Achat de ciment");
  assert.deepEqual(result.value.missing_fields, []);
});

test("keeps an ambiguous number uncertain and recommends one targeted question", async () => {
  const f = fixture();
  const document = await createDraft(f, "brain-uncertain");
  const result = await f.pipeline.applyBrainExtraction(command(document, "brain-uncertain", {
    brainResult: brainResult({
      extracted_fields: {
        giver: candidate("Entreprise Test"),
        receiver: candidate("Moussa"),
        subject: candidate({ type: "MONEY", label: "Somme remise" }),
        amount: candidate(50000, "UNCERTAIN", 0.4),
        currency: candidate("XOF"),
        reason: candidate("Achat de ciment"),
      },
      missing_fields: ["amount"],
      uncertainties: [{
        field: "amount",
        reason: "Nombre ambigu",
        candidate_value: 50000,
        confidence: 0.4,
        source_reference: "synthetic-input",
      }],
      confidence: 0.4,
      suggested_next_action: "ASK_TARGETED_QUESTION",
      user_facing_message_draft: "Quel est le montant exact remis ?",
    }),
  }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.discharge.subject.amount, null);
  assert.equal(result.value.uncertainties.length, 1);
  assert.equal(result.question, "Quel est le montant exact remis ?");
  assert.equal((await f.pipeline.markReadyForReview(command(result.value, "uncertain-ready"))).ok, false);
});

test("recommends one deterministic question when a validated extraction remains incomplete", async () => {
  const f = fixture();
  const document = await createDraft(f, "brain-partial");
  const result = await f.pipeline.applyBrainExtraction(command(document, "brain-partial", {
    brainResult: brainResult({
      extracted_fields: { giver: candidate("Entreprise Test") },
      missing_fields: ["receiver", "subject", "reason"],
      suggested_next_action: "CONTINUE_COLLECTION",
    }),
  }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.question, "Qui reçoit la somme, le bien ou le document ?");
  assert.equal(result.question.split("?").length - 1, 1);
});

test("rejects AI authority and inapplicable fields without persisting them", async () => {
  const f = fixture();
  const document = await createDraft(f, "brain-forbidden");
  const date = await f.pipeline.applyBrainExtraction(command(document, "brain-date", {
    brainResult: brainResult({ extracted_fields: { date_read: candidate("2026-08-02") } }),
  }));
  assert.deepEqual(date, { ok: false, error: "BRAIN_AUTHORITY_FIELD_FORBIDDEN" });
  const payment = await f.pipeline.applyBrainExtraction(command(document, "brain-payment", {
    brainResult: brainResult({ extracted_fields: { payment_method: candidate("Espèces") } }),
  }));
  assert.deepEqual(payment, { ok: false, error: "BRAIN_FIELD_NOT_APPLICABLE" });
  assert.equal((await f.repository.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER })).value.version, 1);
});

test("rejects stale versions and replays idempotency keys without duplication", async () => {
  const f = fixture();
  const document = await createDraft(f, "concurrency");
  const request = command(document, "giver-idempotent", { giver: "Entreprise Test" });
  const first = await f.pipeline.setIssuerOrGiver(request);
  const replay = await f.pipeline.setIssuerOrGiver(request);
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  const stale = await f.pipeline.setRecipient(command(document, "recipient-stale", { recipient: "Awa" }));
  assert.deepEqual(stale, { ok: false, error: "DOCUMENT_VERSION_CONFLICT" });
  assert.equal((await f.repository.listVersions({ documentId: document.document_id, ownerWaId: OWNER })).value.length, 2);
});

test("a correction after cost invalidates preview, quote and cost", async () => {
  const f = fixture();
  let document = await fillDischarge(f);
  document = (await f.pipeline.markReadyForReview(command(document, "cost-ready"))).value;
  document = (await f.pipeline.verifyDischarge(command(document, "cost-verify"))).value;
  document = await persistTransition(f, document, DOCUMENT_EVENTS.PREPARE_PREVIEW, { preview: { title: "Aperçu" } }, "preview");
  document = await persistTransition(f, document, DOCUMENT_EVENTS.CALCULATE_COST, {
    generation_quote: { quote_id: "quote:discharge", document_version: document.version, page_count: 1, credit_cost: 1 },
  }, "cost");
  const result = await f.pipeline.setReason(command(document, "cost-correction", { reason: "Motif corrigé" }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.status, "COLLECTING");
  assert.equal(result.value.preview, null);
  assert.equal(result.value.generation_quote, null);
  assert.equal(result.value.generation_cost, null);
});

test("DELIVERED remains immutable", async () => {
  const f = fixture();
  let document = await fillDischarge(f);
  document = (await f.pipeline.markReadyForReview(command(document, "delivered-ready"))).value;
  document = (await f.pipeline.verifyDischarge(command(document, "delivered-verify"))).value;
  document = await persistTransition(f, document, DOCUMENT_EVENTS.PREPARE_PREVIEW, { preview: { title: "Aperçu" } }, "delivered-preview");
  document = await persistTransition(f, document, DOCUMENT_EVENTS.CALCULATE_COST, {
    generation_quote: { quote_id: "quote:delivered", document_version: document.version, page_count: 1, credit_cost: 1 },
  }, "delivered-cost");
  document = await persistTransition(f, document, DOCUMENT_EVENTS.REQUEST_GENERATION_CONFIRMATION, {}, "confirm");
  document = await persistTransition(f, document, DOCUMENT_EVENTS.START_GENERATION, {}, "start");
  document = await persistTransition(f, document, DOCUMENT_EVENTS.MARK_GENERATED, { generated_file: generatedFile(document) }, "generated");
  document = await persistTransition(f, document, DOCUMENT_EVENTS.MARK_DELIVERED, {}, "delivered");
  assert.deepEqual(
    await f.pipeline.setReason(command(document, "delivered-edit", { reason: "Interdit" })),
    { ok: false, error: "DOCUMENT_MODIFICATION_FORBIDDEN" }
  );
});

test("review model is human-readable and has no generation side effect", async () => {
  const f = fixture();
  let document = await fillDischarge(f, { type: "GOODS", description: "Clés du magasin", quantity: 2 });
  document = (await f.pipeline.setOptions(command(document, "observations", {
    options: { observations: "Remise en bon état" },
  }))).value;
  const result = await f.pipeline.buildReviewModel({ documentId: document.document_id, ownerWaId: OWNER });
  assert.equal(result.ok, true);
  assert.equal(result.value.document_type, "DECHARGE");
  assert.equal(result.value.transferred_content.type, "GOODS");
  assert.equal(result.value.amount, null);
  assert.equal(result.value.quantity, 2);
  assert.equal(result.value.observations, "Remise en bon état");
  assert.doesNotMatch(JSON.stringify(result.value), /flow|payload|session|endpoint|openai|gemini|ocr/i);
  assert.equal(Object.hasOwn(result.value, "pdf"), false);
  assert.equal(Object.hasOwn(result.value, "generation_cost"), false);
});

test("cancels a discharge atomically", async () => {
  const f = fixture();
  const document = await createDraft(f, "cancel");
  const result = await f.pipeline.cancelDischarge(command(document, "cancel"));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.status, "CANCELLED");
  assert.equal((await f.repository.getDocumentById({ documentId: document.document_id, ownerWaId: OWNER })).value.status, "CANCELLED");
});

test("discharge pipeline has no Meta, provider, PDF, wallet or payment dependency", () => {
  for (const file of ["kadiV1DischargePipeline.js", "kadiV1DischargePolicy.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.doesNotMatch(source, /require\(["'][^"']*(?:whatsapp|flow|pdf|wallet|billing|payment|openai|gemini)/i, file);
    assert.doesNotMatch(source, /\/webhook|\/data_exchange|flow_id|phone_number_id|generatePDF|consumeCredit/i, file);
  }
});
