"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PDFDocument } = require("pdf-lib");
const { createDocumentDomain, DOCUMENT_EVENTS } = require("../kadiV1DocumentDomain");
const { createInMemoryV1DocumentRepository } = require("../kadiV1DocumentRepository");
const { createInMemoryV1PreviewRepository } = require("../kadiV1PreviewRepository");
const { createInMemoryGenerationLifecycleRepository } = require("../kadiV1GenerationLifecycleRepository");
const { createWalletReservationService } = require("../kadiV1WalletReservationService");
const { createFinalGenerationService, createInMemoryFinalFileStorage } = require("../kadiV1FinalGenerationService");
const { createDeliveryService } = require("../kadiV1DeliveryService");
const { createGenerationLifecycleService } = require("../kadiV1GenerationLifecycleService");
const { createSupabaseGenerationLifecycleRepository } = require("../kadiV1SupabaseGenerationLifecycleRepository");

const OWNER = "22670000000";
const NOW = "2026-08-02T12:00:00.123Z";

async function pdf(pages = 1) {
  const document = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) document.addPage();
  return Buffer.from(await document.save());
}

async function fixture({ balance = 20, pages = 2, deliveryResults = [{ ok: true, value: { reference: "synthetic-delivery" } }], rendererResult = null, rendererResults = null, storage = null, observer = () => {} } = {}) {
  const clock = () => NOW;
  const domain = createDocumentDomain({ clock });
  const documents = createInMemoryV1DocumentRepository();
  const artifacts = createInMemoryV1PreviewRepository();
  let document = domain.createDocument({
    document_id: "doc:lifecycle", document_type: "FACTURE", issuer_profile_id: "issuer:1", currency: "XOF",
    client: { name: "Client fictif" }, items: [{ item_id: "item:1", description: "Service", quantity_millis: 1000, unit_price: 5000 }],
  }).value;
  await documents.createDocument({ document, ownerWaId: OWNER, idempotencyKey: "doc:lifecycle:create" });
  for (const [event, payload, key] of [
    [DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW, {}, "ready"], [DOCUMENT_EVENTS.VERIFY, {}, "verify"],
    [DOCUMENT_EVENTS.PREPARE_PREVIEW, { preview: { preview_id: "preview:lifecycle" } }, "preview"],
    [DOCUMENT_EVENTS.CALCULATE_COST, { generation_quote: { quote_id: "quote:lifecycle", document_version: 1, page_count: pages, credit_cost: 4 } }, "cost"],
    [DOCUMENT_EVENTS.REQUEST_GENERATION_CONFIRMATION, {}, "await"],
  ]) {
    const next = domain.transitionDocument(document, event, payload).value;
    document = (await documents.persistTransition({ document: next, ownerWaId: OWNER, expectedVersion: 1, fromState: document.status, eventType: `TEST_${key.toUpperCase()}`, idempotencyKey: `doc:lifecycle:${key}` })).value;
  }
  const preview = { preview_id: "preview:lifecycle", document_id: document.document_id, document_version: 1, owner_wa_id: OWNER, status: "ACTIVE", structured_preview: { document_type: "FACTURE", items: [], total: 5000 } };
  await artifacts.createPreview({ preview, idempotencyKey: "preview:lifecycle:create" });
  const render = { render_id: "render:lifecycle", preview_id: preview.preview_id, document_id: document.document_id, document_version: 1, owner_wa_id: OWNER, status: "INSPECTED", page_count: pages };
  await artifacts.createTemporaryRender({ render, idempotencyKey: "render:lifecycle:create" });
  const quote = { quote_id: "quote:lifecycle", document_id: document.document_id, document_version: 1, owner_wa_id: OWNER, preview_id: preview.preview_id, temporary_render_id: render.render_id, page_count: pages, total_credits: 4, pricing_version: "test-v1", status: "ACTIVE", expires_at: "2026-08-02T13:00:00.000Z" };
  await artifacts.createGenerationQuote({ quote, idempotencyKey: "quote:lifecycle:create" });
  const repository = createInMemoryGenerationLifecycleRepository({ balances: { [OWNER]: balance } });
  const wallet = createWalletReservationService({ repository, clock });
  const finalStorage = storage || createInMemoryFinalFileStorage();
  const calls = { delivery: 0, render: 0, renderPreviews: [] };
  const renderer = { render: async ({ preview: renderedPreview }) => {
    const attemptResult = rendererResults ? rendererResults[Math.min(calls.render, rendererResults.length - 1)] : rendererResult;
    calls.render += 1;
    calls.renderPreviews.push(renderedPreview);
    return attemptResult || ({ ok: true, value: { buffer: await pdf(pages), mime_type: "application/pdf" } });
  } };
  const finalGeneration = createFinalGenerationService({ repository, storage: finalStorage, renderer, clock });
  const provider = {
    async deliverDocument() { const result = deliveryResults[Math.min(calls.delivery, deliveryResults.length - 1)]; calls.delivery += 1; return result; },
    async getDeliveryStatus() { return { ok: true, value: null }; },
  };
  const delivery = createDeliveryService({ repository, provider, clock });
  const quoteService = { async validateGenerationQuote({ quoteId, ownerWaId }) {
    const result = await artifacts.getGenerationQuote({ quoteId });
    if (!result.ok || result.value.owner_wa_id !== ownerWaId || result.value.status !== "ACTIVE") return { ok: false, error: result.value?.status === "EXPIRED" ? "GENERATION_QUOTE_EXPIRED" : "GENERATION_QUOTE_NOT_ACTIVE" };
    return result;
  } };
  const service = createGenerationLifecycleService({ documentRepository: documents, previewRepository: artifacts, generationRepository: repository, quoteService, walletReservationService: wallet, finalGenerationService: finalGeneration, deliveryService: delivery, domain, clock, observer });
  return { service, repository, documents, artifacts, wallet, finalGeneration, delivery, calls, document, quote, domain };
}

const command = { documentId: "doc:lifecycle", documentVersion: 1, quoteId: "quote:lifecycle", ownerWaId: OWNER, idempotencyKey: "confirm:lifecycle" };

test("valid confirmation reserves, captures, promotes and delivers exactly once", async () => {
  const events = [];
  const f = await fixture({ observer: (event) => events.push(event) });
  const result = await f.service.confirmGeneration(command);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.document.status, "DELIVERED");
  const state = f.repository.inspect();
  assert.equal(state.reservations[0].amount, 4);
  assert.equal(state.reservations[0].status, "CAPTURED");
  assert.equal(state.ledger.length, 1);
  assert.equal(state.finalFiles.length, 1);
  assert.equal(state.finalFiles[0].immutable, true);
  assert.equal(state.deliveries[0].status, "DELIVERED");
  assert.equal((await f.artifacts.getGenerationQuote({ quoteId: command.quoteId })).value.status, "CONSUMED");
  assert.deepEqual(events.map((entry) => entry.event), [
    "generation_confirmation_received", "credits_reserved", "generation_started", "final_pdf_validated",
    "credits_captured", "final_file_promoted", "delivery_started", "delivery_succeeded",
  ]);
  assert.equal(JSON.stringify(events).includes(OWNER), false);
});

test("the renderer receives the finalized issued_at/document_number, never the stale pre-finalization placeholder", async () => {
  const f = await fixture();
  // The stored preview (built at VERIFIED time, before finalization) never
  // carries issued_at/document_number — confirm the fixture reproduces that.
  const storedPreview = (await f.artifacts.getPreview({ previewId: "preview:lifecycle" })).value;
  assert.equal(storedPreview.structured_preview.issued_at, undefined);
  assert.equal(storedPreview.structured_preview.document_number, undefined);

  const result = await f.service.confirmGeneration(command);
  assert.equal(result.ok, true, result.error);
  const finalDocument = result.value.document;
  assert.equal(typeof finalDocument.issued_at, "string");
  assert.notEqual(finalDocument.issued_at, null);
  assert.match(finalDocument.document_number, /^FA-\d{14}-[A-Z0-9]{8}$/);

  assert.equal(f.calls.renderPreviews.length, 1);
  const rendered = f.calls.renderPreviews[0].structured_preview;
  assert.equal(rendered.issued_at, finalDocument.issued_at, "renderer must see the exact same issued_at as the persisted final document");
  assert.equal(rendered.document_number, finalDocument.document_number, "renderer must see the exact same document_number as the persisted final document");
  assert.notEqual(rendered.document_number, "BROUILLON");
});

test("expired and invalidated quotes are rejected before reservation", async () => {
  for (const status of ["EXPIRED", "INVALIDATED"]) {
    const f = await fixture();
    await f.artifacts.setGenerationQuoteStatus({ quoteId: command.quoteId, status });
    assert.equal((await f.service.confirmGeneration({ ...command, idempotencyKey: `confirm:${status}` })).ok, false);
    assert.equal(f.repository.inspect().reservations.length, 0);
  }
});

test("stale document version and user supplied amount fail closed", async () => {
  const f = await fixture();
  assert.deepEqual(await f.service.confirmGeneration({ ...command, documentVersion: 2 }), { ok: false, error: "DOCUMENT_VERSION_CONFLICT" });
  assert.deepEqual(await f.service.confirmGeneration({ ...command, amount: 1 }), { ok: false, error: "GENERATION_CONFIRMATION_INVALID" });
});

test("insufficient balance creates no reservation or final file and requires recharge", async () => {
  const f = await fixture({ balance: 3 });
  assert.deepEqual(await f.service.confirmGeneration(command), { ok: false, error: "INSUFFICIENT_CREDITS" });
  assert.equal(f.repository.inspect().reservations.length, 0);
  assert.equal(f.repository.inspect().finalFiles.length, 0);
  assert.equal((await f.documents.getDocumentById({ documentId: command.documentId, ownerWaId: OWNER })).value.status, "RECHARGE_REQUIRED");
});

test("duplicate and concurrent confirmations never double reserve or capture", async () => {
  const f = await fixture();
  const results = await Promise.all([f.service.confirmGeneration(command), f.service.confirmGeneration(command)]);
  assert.equal(results.some((entry) => entry.ok), true);
  const state = f.repository.inspect();
  assert.equal(state.reservations.length, 1);
  assert.equal(state.ledger.length, 1);
  assert.equal(state.finalFiles.length, 1);
});

test("corrupt and page-mismatched PDFs release reservations without capture", async () => {
  for (const rendererResult of [
    { ok: true, value: { buffer: Buffer.from("not-pdf"), mime_type: "application/pdf" } },
    { ok: true, value: { buffer: await pdf(1), mime_type: "application/pdf" } },
  ]) {
    const f = await fixture({ pages: 2, rendererResult });
    assert.equal((await f.service.confirmGeneration({ ...command, idempotencyKey: `confirm:bad:${rendererResult.value.buffer.length}` })).ok, false);
    const state = f.repository.inspect();
    assert.equal(state.reservations[0].status, "RELEASED");
    assert.equal(state.ledger.length, 0);
    assert.equal(state.finalFiles.length, 0);
  }
});

test("private storage failure releases the reservation before capture", async () => {
  const backing = createInMemoryFinalFileStorage();
  const storage = { ...backing, async putStaging() { return { ok: false, error: "PRIVATE_STORAGE_FAILED" }; } };
  const f = await fixture({ storage });
  assert.deepEqual(await f.service.confirmGeneration({ ...command, idempotencyKey: "confirm:storage-failure" }), { ok: false, error: "FINAL_STORAGE_NOT_PRIVATE" });
  assert.equal(f.repository.inspect().reservations[0].status, "RELEASED");
  assert.equal(f.repository.inspect().ledger.length, 0);
});

test("renderer exception fails closed, releases the reservation, and leaves a reserved identity with no delivered artifact", async () => {
  const f = await fixture({ rendererResult: { ok: false, error: "FINAL_RENDER_FAILED" } });
  assert.deepEqual(await f.service.confirmGeneration({ ...command, idempotencyKey: "confirm:render-exception" }), { ok: false, error: "FINAL_RENDER_FAILED" });
  assert.equal(f.repository.inspect().reservations[0].status, "RELEASED");
  assert.equal(f.repository.inspect().ledger.length, 0);
  assert.equal(f.repository.inspect().finalFiles.length, 0);
  // START_GENERATION already assigned issued_at/document_number before the
  // render attempt — a failed render does not (and must not) unassign that
  // reserved identity, even though this specific document was never
  // delivered and no credit was ever captured for it. See
  // docs/KADI_ENGINEERING_MEMORY.md fiche P.
  const document = await f.documents.getDocumentById({ documentId: command.documentId, ownerWaId: OWNER });
  assert.equal(document.ok, true);
  assert.equal(document.value.status, "RECOVERABLE_FAILURE");
  assert.equal(typeof document.value.issued_at, "string");
  assert.match(document.value.document_number, /^FA-\d{14}-[A-Z0-9]{8}$/);
});

test("resumeGeneration rejects a RECOVERABLE_FAILURE attempt without mutating anything — it must never absorb a render-stage failure", async () => {
  const f = await fixture({ rendererResult: { ok: false, error: "FINAL_RENDER_FAILED" } });
  await f.service.confirmGeneration({ ...command, idempotencyKey: "confirm:resume-order-render-failure" });
  const before = await f.documents.getDocumentById({ documentId: command.documentId, ownerWaId: OWNER });
  assert.equal(before.value.status, "RECOVERABLE_FAILURE");
  const resumeStateBefore = before.value.recoverable_failure?.resume_state;
  assert.equal(resumeStateBefore, "GENERATION_IN_PROGRESS");
  const versionBefore = before.value.version;
  const attemptBefore = await f.repository.findByQuoteId({ quoteId: command.quoteId });
  assert.equal(attemptBefore.value.status, "RECOVERABLE_FAILURE");

  const resumed = await f.service.resumeGeneration({
    quoteId: command.quoteId, ownerWaId: OWNER, idempotencyKey: "resume:render-failure-attempt",
  });
  assert.deepEqual(resumed, { ok: false, error: "GENERATION_RECONFIRMATION_REQUIRED" });

  const after = await f.documents.getDocumentById({ documentId: command.documentId, ownerWaId: OWNER });
  assert.equal(after.value.status, "RECOVERABLE_FAILURE", "must remain RECOVERABLE_FAILURE, never silently moved to GENERATION_IN_PROGRESS");
  assert.equal(after.value.recoverable_failure?.resume_state, resumeStateBefore, "resume_state must be unchanged");
  assert.equal(after.value.version, versionBefore, "document version must be unchanged");
  const attemptAfter = await f.repository.findByQuoteId({ quoteId: command.quoteId });
  assert.equal(attemptAfter.value.status, "RECOVERABLE_FAILURE", "attempt status must be unchanged");
  const state = f.repository.inspect();
  assert.equal(state.reservations.filter((r) => r.status === "RESERVED").length, 0);
  assert.equal(state.ledger.length, 0);
  assert.equal(state.finalFiles.length, 0);
  assert.equal(state.deliveries.length, 0);
});

test("resumeGeneration rejects an unrelated attempt status (STARTED) without mutating anything", async () => {
  const f = await fixture();
  const reservation = await f.wallet.reserveCredits({ ownerWaId: OWNER, quoteId: command.quoteId, amount: 4, idempotencyKey: "resume-order:unrelated:reserve" });
  const started = f.domain.transitionDocument(f.document, DOCUMENT_EVENTS.START_GENERATION).value;
  await f.documents.persistTransition({ document: started, ownerWaId: OWNER, expectedVersion: 1, fromState: f.document.status, eventType: "TEST_STARTED", idempotencyKey: "resume-order:unrelated:start" });
  await f.repository.createGenerationAttempt({
    attempt: { generation_attempt_id: "generation:unrelated", document_id: command.documentId, owner_wa_id: OWNER, document_version: 1, quote_id: command.quoteId, reservation_id: reservation.value.reservation_id, confirmation_key: "resume-order:unrelated:confirm", status: "STARTED", started_at: NOW },
    idempotencyKey: "resume-order:unrelated:attempt",
  });
  const before = await f.documents.getDocumentById({ documentId: command.documentId, ownerWaId: OWNER });
  assert.equal(before.value.status, "GENERATION_IN_PROGRESS");

  const resumed = await f.service.resumeGeneration({ quoteId: command.quoteId, ownerWaId: OWNER, idempotencyKey: "resume:unrelated-attempt" });
  // Attempt eligibility (step 3 of the required order) is checked before
  // the document is even loaded — a STARTED attempt is rejected here,
  // never reaching the "document must be RECOVERABLE_FAILURE" check.
  assert.deepEqual(resumed, { ok: false, error: "GENERATION_RECONFIRMATION_REQUIRED" });

  const after = await f.documents.getDocumentById({ documentId: command.documentId, ownerWaId: OWNER });
  assert.equal(after.value.status, "GENERATION_IN_PROGRESS", "must be unchanged — resumeGeneration never reached a mutating step");
  const attemptAfter = await f.repository.findByQuoteId({ quoteId: command.quoteId });
  assert.equal(attemptAfter.value.status, "STARTED");
  const state = f.repository.inspect();
  assert.equal(state.ledger.length, 0);
  assert.equal(state.finalFiles.length, 0);
});

test("renderer failure then retryFailedGeneration: same identity reused, exactly one capture/promotion/delivery, replay of the successful retry is a no-op", async () => {
  const events = [];
  const f = await fixture({
    rendererResults: [
      { ok: false, error: "FINAL_RENDER_FAILED" },
      null, // null falls back to the fixture's default successful render
    ],
    observer: (event) => events.push(event),
  });

  // 1-4: create/confirm/START_GENERATION already happened inside fixture()
  // up to AWAITING_GENERATION_CONFIRMATION; confirmGeneration below drives
  // START_GENERATION (identity assignment) then the renderer throws before
  // capture.
  const first = await f.service.confirmGeneration({ ...command, idempotencyKey: "confirm:retry-flow" });
  assert.deepEqual(first, { ok: false, error: "FINAL_RENDER_FAILED" });

  // 5-9: recoverable state, reservation released, zero capture, zero final
  // artifact, zero delivery.
  let state = f.repository.inspect();
  assert.equal(state.reservations[0].status, "RELEASED");
  assert.equal(state.ledger.length, 0);
  assert.equal(state.finalFiles.length, 0);
  assert.equal(state.deliveries.length, 0);
  const beforeRetry = await f.documents.getDocumentById({ documentId: command.documentId, ownerWaId: OWNER });
  assert.equal(beforeRetry.value.status, "RECOVERABLE_FAILURE");

  // 10: record the assigned issued_at/document_number.
  const reservedIssuedAt = beforeRetry.value.issued_at;
  const reservedDocumentNumber = beforeRetry.value.document_number;
  assert.equal(typeof reservedIssuedAt, "string");
  assert.match(reservedDocumentNumber, /^FA-\d{14}-[A-Z0-9]{8}$/);

  // 11-12: retry generation; renderer succeeds this time.
  const retried = await f.service.retryFailedGeneration({
    quoteId: command.quoteId, ownerWaId: OWNER, documentVersion: command.documentVersion, idempotencyKey: "retry:1",
  });
  assert.equal(retried.ok, true, retried.error);

  // 13-14: exact same issued_at/document_number reused, nothing new minted.
  assert.equal(retried.value.document.issued_at, reservedIssuedAt);
  assert.equal(retried.value.document.document_number, reservedDocumentNumber);

  // 15-18: exactly one capture, one final artifact, one delivery, DELIVERED.
  state = f.repository.inspect();
  assert.equal(state.ledger.length, 1);
  assert.equal(state.finalFiles.length, 1);
  assert.equal(state.deliveries.length, 1);
  assert.equal(state.deliveries[0].status, "DELIVERED");
  assert.equal(retried.value.document.status, "DELIVERED");
  assert.equal(f.calls.render, 2, "one failed attempt, one successful retry — never a third render");

  // 19: replaying the successful retry (same or a fresh idempotency key)
  // performs no second debit, render, promotion or delivery — the attempt
  // is no longer STARTED, so it fails safely instead of reprocessing.
  const replayed = await f.service.retryFailedGeneration({
    quoteId: command.quoteId, ownerWaId: OWNER, documentVersion: command.documentVersion, idempotencyKey: "retry:1",
  });
  assert.deepEqual(replayed, { ok: false, error: "GENERATION_RETRY_NOT_ELIGIBLE" });
  const afterReplay = f.repository.inspect();
  assert.equal(afterReplay.ledger.length, 1);
  assert.equal(afterReplay.finalFiles.length, 1);
  assert.equal(afterReplay.deliveries.length, 1);
  assert.equal(f.calls.render, 2);

  assert.deepEqual(events.map((entry) => entry.event).filter((name) => name.startsWith("generation_retry")), [
    "generation_retry_received", "generation_retry_resumed", "generation_retry_started",
    "generation_retry_received", // the replay — rejected immediately after, before resuming/reserving/rendering again
  ]);
});

test("concurrent retries for the same quote never double-render, double-capture or double-deliver", async () => {
  const f = await fixture({ rendererResults: [{ ok: false, error: "FINAL_RENDER_FAILED" }, null] });
  const first = await f.service.confirmGeneration({ ...command, idempotencyKey: "confirm:retry-concurrent" });
  assert.equal(first.ok, false);

  const [a, b] = await Promise.all([
    f.service.retryFailedGeneration({ quoteId: command.quoteId, ownerWaId: OWNER, documentVersion: command.documentVersion, idempotencyKey: "retry:concurrent:a" }),
    f.service.retryFailedGeneration({ quoteId: command.quoteId, ownerWaId: OWNER, documentVersion: command.documentVersion, idempotencyKey: "retry:concurrent:b" }),
  ]);
  const results = [a, b];
  const succeeded = results.filter((r) => r.ok);
  const rejected = results.filter((r) => !r.ok);
  assert.equal(succeeded.length, 1, "exactly one concurrent retry succeeds");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].error, "GENERATION_RETRY_NOT_ELIGIBLE");

  const state = f.repository.inspect();
  assert.equal(state.ledger.length, 1, "exactly one capture across both concurrent retries");
  assert.equal(state.finalFiles.length, 1);
  assert.equal(state.deliveries.length, 1);
  assert.equal(f.calls.render, 2, "one failed original attempt, one successful retry — the second concurrent retry never renders");
});

test("retryFailedGeneration fails closed on a partial finalization identity", async () => {
  const f = await fixture({ rendererResult: { ok: false, error: "FINAL_RENDER_FAILED" } });
  await f.service.confirmGeneration({ ...command, idempotencyKey: "confirm:retry-partial" });
  const loaded = await f.documents.getDocumentById({ documentId: command.documentId, ownerWaId: OWNER });
  assert.equal(loaded.value.status, "RECOVERABLE_FAILURE");
  assert.equal(typeof loaded.value.issued_at, "string");
  assert.equal(typeof loaded.value.document_number, "string");

  // The repository refuses to ever unset an already-assigned identity field
  // (deliberately — see kadiV1DocumentRepository.js), so a real corrupted
  // row can't be produced through the normal write path. Wrap the
  // repository read for this one test to simulate exactly that structurally
  // impossible-in-practice, but still defended-against, shape.
  const corruptingDocuments = {
    ...f.documents,
    async getDocumentById(args) {
      const result = await f.documents.getDocumentById(args);
      return result.ok ? { ...result, value: { ...result.value, document_number: null } } : result;
    },
  };
  const quoteServiceForTest = { async validateGenerationQuote({ quoteId, ownerWaId }) {
    const result = await f.artifacts.getGenerationQuote({ quoteId });
    if (!result.ok || result.value.owner_wa_id !== ownerWaId || result.value.status !== "ACTIVE") return { ok: false, error: "GENERATION_QUOTE_NOT_ACTIVE" };
    return result;
  } };
  const { createGenerationLifecycleService } = require("../kadiV1GenerationLifecycleService");
  const serviceWithCorruptRead = createGenerationLifecycleService({
    documentRepository: corruptingDocuments, previewRepository: f.artifacts, generationRepository: f.repository,
    quoteService: quoteServiceForTest, walletReservationService: f.wallet, finalGenerationService: f.finalGeneration,
    deliveryService: f.delivery, domain: f.domain, clock: () => NOW,
  });

  const retried = await serviceWithCorruptRead.retryFailedGeneration({
    quoteId: command.quoteId, ownerWaId: OWNER, documentVersion: command.documentVersion, idempotencyKey: "retry:partial",
  });
  assert.deepEqual(retried, { ok: false, error: "GENERATION_RETRY_NOT_ELIGIBLE" });
  assert.equal(f.repository.inspect().ledger.length, 0);
});

test("retryFailedGeneration accepts the correct resume_state (GENERATION_IN_PROGRESS) — proven by the render-failure-then-retry flow succeeding", async () => {
  const f = await fixture({ rendererResults: [{ ok: false, error: "FINAL_RENDER_FAILED" }, null] });
  await f.service.confirmGeneration({ ...command, idempotencyKey: "confirm:retry-correct-resume-state" });
  const before = await f.documents.getDocumentById({ documentId: command.documentId, ownerWaId: OWNER });
  assert.equal(before.value.recoverable_failure?.resume_state, "GENERATION_IN_PROGRESS");
  const retried = await f.service.retryFailedGeneration({
    quoteId: command.quoteId, ownerWaId: OWNER, documentVersion: command.documentVersion, idempotencyKey: "retry:correct-resume-state",
  });
  assert.equal(retried.ok, true, retried.error);
  assert.equal(retried.value.document.status, "DELIVERED");
});

test("retryFailedGeneration rejects a RECOVERABLE_FAILURE document whose resume_state is not GENERATION_IN_PROGRESS, without mutating anything", async () => {
  const f = await fixture({ rendererResult: { ok: false, error: "FINAL_RENDER_FAILED" } });
  await f.service.confirmGeneration({ ...command, idempotencyKey: "confirm:retry-wrong-resume-state" });
  const loaded = await f.documents.getDocumentById({ documentId: command.documentId, ownerWaId: OWNER });
  assert.equal(loaded.value.status, "RECOVERABLE_FAILURE");
  // Simulate a document that failed for an unrelated reason recorded at a
  // different lifecycle stage (e.g. still COLLECTING) — attempt.status
  // alone is not enough to prove eligibility, resume_state must also match.
  const wrongResumeStateDocuments = {
    ...f.documents,
    async getDocumentById(args) {
      const result = await f.documents.getDocumentById(args);
      if (!result.ok) return result;
      return { ...result, value: { ...result.value, recoverable_failure: { ...result.value.recoverable_failure, resume_state: "COLLECTING" } } };
    },
  };
  const quoteServiceForTest = { async validateGenerationQuote({ quoteId, ownerWaId }) {
    const result = await f.artifacts.getGenerationQuote({ quoteId });
    if (!result.ok || result.value.owner_wa_id !== ownerWaId || result.value.status !== "ACTIVE") return { ok: false, error: "GENERATION_QUOTE_NOT_ACTIVE" };
    return result;
  } };
  const { createGenerationLifecycleService } = require("../kadiV1GenerationLifecycleService");
  const serviceWithWrongResumeState = createGenerationLifecycleService({
    documentRepository: wrongResumeStateDocuments, previewRepository: f.artifacts, generationRepository: f.repository,
    quoteService: quoteServiceForTest, walletReservationService: f.wallet, finalGenerationService: f.finalGeneration,
    deliveryService: f.delivery, domain: f.domain, clock: () => NOW,
  });
  const retried = await serviceWithWrongResumeState.retryFailedGeneration({
    quoteId: command.quoteId, ownerWaId: OWNER, documentVersion: command.documentVersion, idempotencyKey: "retry:wrong-resume-state",
  });
  assert.deepEqual(retried, { ok: false, error: "GENERATION_RETRY_NOT_ELIGIBLE" });
  assert.equal(f.repository.inspect().ledger.length, 0);
  assert.equal(f.repository.inspect().reservations.filter((r) => r.status === "RESERVED").length, 0);
});

test("retryFailedGeneration rejects a RECOVERABLE_FAILURE document with no recoverable_failure record at all, without mutating anything", async () => {
  const f = await fixture({ rendererResult: { ok: false, error: "FINAL_RENDER_FAILED" } });
  await f.service.confirmGeneration({ ...command, idempotencyKey: "confirm:retry-absent-resume-state" });
  const absentResumeStateDocuments = {
    ...f.documents,
    async getDocumentById(args) {
      const result = await f.documents.getDocumentById(args);
      return result.ok ? { ...result, value: { ...result.value, recoverable_failure: null } } : result;
    },
  };
  const quoteServiceForTest = { async validateGenerationQuote({ quoteId, ownerWaId }) {
    const result = await f.artifacts.getGenerationQuote({ quoteId });
    if (!result.ok || result.value.owner_wa_id !== ownerWaId || result.value.status !== "ACTIVE") return { ok: false, error: "GENERATION_QUOTE_NOT_ACTIVE" };
    return result;
  } };
  const { createGenerationLifecycleService } = require("../kadiV1GenerationLifecycleService");
  const serviceWithAbsentResumeState = createGenerationLifecycleService({
    documentRepository: absentResumeStateDocuments, previewRepository: f.artifacts, generationRepository: f.repository,
    quoteService: quoteServiceForTest, walletReservationService: f.wallet, finalGenerationService: f.finalGeneration,
    deliveryService: f.delivery, domain: f.domain, clock: () => NOW,
  });
  const retried = await serviceWithAbsentResumeState.retryFailedGeneration({
    quoteId: command.quoteId, ownerWaId: OWNER, documentVersion: command.documentVersion, idempotencyKey: "retry:absent-resume-state",
  });
  assert.deepEqual(retried, { ok: false, error: "GENERATION_RETRY_NOT_ELIGIBLE" });
  assert.equal(f.repository.inspect().ledger.length, 0);
});

test("retryFailedGeneration fails closed when the document is not in the eligible recoverable state", async () => {
  const f = await fixture();
  // Never confirmed at all — no generation attempt exists for this quote.
  const retried = await f.service.retryFailedGeneration({
    quoteId: command.quoteId, ownerWaId: OWNER, documentVersion: command.documentVersion, idempotencyKey: "retry:unrelated",
  });
  assert.deepEqual(retried, { ok: false, error: "GENERATION_ATTEMPT_NOT_FOUND" });
});

test("retryFailedGeneration fails closed after credit capture (promotion-failure territory, not renderer-failure territory)", async () => {
  const backing = createInMemoryFinalFileStorage();
  let failPromotion = true;
  const storage = { ...backing, async promote(args) { if (failPromotion) { failPromotion = false; return { ok: false, error: "PROMOTION_TEMPORARY" }; } return backing.promote(args); } };
  const f = await fixture({ storage });
  await f.service.confirmGeneration({ ...command, idempotencyKey: "confirm:retry-after-capture" });
  const retried = await f.service.retryFailedGeneration({
    quoteId: command.quoteId, ownerWaId: OWNER, documentVersion: command.documentVersion, idempotencyKey: "retry:after-capture",
  });
  assert.deepEqual(retried, { ok: false, error: "GENERATION_RETRY_NOT_ELIGIBLE" });
  assert.equal(f.repository.inspect().ledger.length, 1, "still exactly the one original capture");
});

test("retryFailedGeneration fails closed after a fully successful generation", async () => {
  const f = await fixture();
  const confirmed = await f.service.confirmGeneration({ ...command, idempotencyKey: "confirm:retry-after-success" });
  assert.equal(confirmed.ok, true, confirmed.error);
  assert.equal(confirmed.value.document.status, "DELIVERED");
  const retried = await f.service.retryFailedGeneration({
    quoteId: command.quoteId, ownerWaId: OWNER, documentVersion: command.documentVersion, idempotencyKey: "retry:after-success",
  });
  assert.deepEqual(retried, { ok: false, error: "GENERATION_RETRY_NOT_ELIGIBLE" });
  assert.equal(f.repository.inspect().ledger.length, 1);
  assert.equal(f.repository.inspect().deliveries.length, 1);
});

test("retryFailedGeneration rejects a stale documentVersion", async () => {
  const f = await fixture({ rendererResult: { ok: false, error: "FINAL_RENDER_FAILED" } });
  await f.service.confirmGeneration({ ...command, idempotencyKey: "confirm:retry-stale-version" });
  const retried = await f.service.retryFailedGeneration({
    quoteId: command.quoteId, ownerWaId: OWNER, documentVersion: 99, idempotencyKey: "retry:stale-version",
  });
  assert.deepEqual(retried, { ok: false, error: "DOCUMENT_VERSION_CONFLICT" });
  assert.equal(f.repository.inspect().ledger.length, 0);
});

test("promotion failure after capture resumes with the same PDF, no second debit, and the exact same issued_at/document_number", async () => {
  const backing = createInMemoryFinalFileStorage();
  let failPromotion = true;
  const storage = { ...backing, async promote(args) { if (failPromotion) { failPromotion = false; return { ok: false, error: "PROMOTION_TEMPORARY" }; } return backing.promote(args); } };
  const f = await fixture({ storage });
  assert.deepEqual(await f.service.confirmGeneration({ ...command, idempotencyKey: "confirm:promotion-failure" }), { ok: false, error: "FINAL_PROMOTION_RECOVERABLE_FAILURE" });
  assert.equal(f.repository.inspect().ledger.length, 1);
  const beforeRetry = await f.documents.getDocumentById({ documentId: command.documentId, ownerWaId: OWNER });
  assert.equal(beforeRetry.ok, true);
  assert.equal(beforeRetry.value.status, "RECOVERABLE_FAILURE");
  assert.equal(typeof beforeRetry.value.issued_at, "string");
  assert.match(beforeRetry.value.document_number, /^FA-\d{14}-[A-Z0-9]{8}$/);

  const resumed = await f.service.resumeGeneration({ quoteId: command.quoteId, ownerWaId: OWNER, idempotencyKey: "generation:resume-promotion" });
  assert.equal(resumed.ok, true, resumed.error);
  assert.equal(resumed.value.document.status, "DELIVERED");
  assert.equal(f.repository.inspect().ledger.length, 1);
  assert.equal(f.repository.inspect().finalFiles.length, 1);

  assert.equal(resumed.value.document.issued_at, beforeRetry.value.issued_at, "retry must reuse the exact same issued_at, not mint a new one");
  assert.equal(resumed.value.document.document_number, beforeRetry.value.document_number, "retry must reuse the exact same document_number, not mint a new one");
});

test("cancellation before capture releases credits and creates no final PDF", async () => {
  const f = await fixture();
  const reservation = await f.wallet.reserveCredits({ ownerWaId: OWNER, quoteId: command.quoteId, amount: 4, idempotencyKey: "cancel:reserve" });
  const started = f.domain.transitionDocument(f.document, DOCUMENT_EVENTS.START_GENERATION).value;
  await f.documents.persistTransition({ document: started, ownerWaId: OWNER, expectedVersion: 1, fromState: f.document.status, eventType: "GENERATION_STARTED", idempotencyKey: "cancel:start" });
  await f.repository.createGenerationAttempt({ attempt: { generation_attempt_id: "generation:cancel", document_id: command.documentId, document_version: 1, owner_wa_id: OWNER, quote_id: command.quoteId, reservation_id: reservation.value.reservation_id, confirmation_key: "confirm:cancel", status: "STARTED", started_at: NOW }, idempotencyKey: "cancel:attempt" });
  const cancelled = await f.service.cancelGeneration({ quoteId: command.quoteId, ownerWaId: OWNER, idempotencyKey: "cancel:command" });
  assert.equal(cancelled.ok, true, cancelled.error);
  assert.equal(cancelled.value.status, "CANCELLED");
  assert.equal(f.repository.inspect().reservations[0].status, "RELEASED");
  assert.equal(f.repository.inspect().ledger.length, 0);
});

test("delivery failure is recoverable and retry reuses final PDF without another capture", async () => {
  const f = await fixture({ deliveryResults: [{ ok: false, error: "CHANNEL_TEMPORARY" }, { ok: true, value: { reference: "retry-ok" } }] });
  assert.deepEqual(await f.service.confirmGeneration(command), { ok: false, error: "DELIVERY_RECOVERABLE_FAILURE" });
  let state = f.repository.inspect();
  assert.equal(state.ledger.length, 1);
  assert.equal(state.finalFiles.length, 1);
  const retried = await f.service.retryDelivery({ quoteId: command.quoteId, ownerWaId: OWNER, deliveryAttemptId: state.deliveries[0].delivery_attempt_id, idempotencyKey: "delivery:retry" });
  assert.equal(retried.ok, true, retried.error);
  assert.equal(retried.value.document.status, "DELIVERED");
  state = f.repository.inspect();
  assert.equal(state.ledger.length, 1);
  assert.equal(state.finalFiles.length, 1);
  assert.equal(state.deliveries[0].attempt_count, 2);
  assert.equal(state.reservations.length, 1);
  assert.equal(f.calls.render, 1);
});

test("capture is unique and cannot occur after release", async () => {
  const f = await fixture();
  const reserved = await f.wallet.reserveCredits({ ownerWaId: OWNER, quoteId: command.quoteId, amount: 4, idempotencyKey: "wallet:reserve" });
  await f.wallet.releaseReservation({ reservationId: reserved.value.reservation_id, idempotencyKey: "wallet:release" });
  assert.deepEqual(await f.wallet.captureReservation({ reservationId: reserved.value.reservation_id, idempotencyKey: "wallet:capture" }), { ok: false, error: "CREDIT_RESERVATION_NOT_CAPTURABLE" });
});

test("captured generation cannot be cancelled and immutable final file cannot be replaced", async () => {
  const f = await fixture();
  assert.equal((await f.service.confirmGeneration(command)).ok, true);
  assert.deepEqual(await f.service.cancelGeneration({ quoteId: command.quoteId, ownerWaId: OWNER, idempotencyKey: "cancel:after-capture" }), { ok: false, error: "GENERATION_CANCELLATION_FORBIDDEN" });
  const original = f.repository.inspect().finalFiles[0];
  const replacement = await f.repository.promoteFinalFile({ finalFile: { ...original, checksum: "f".repeat(64) }, idempotencyKey: "final:replacement" });
  assert.equal(replacement.ok, true);
  assert.equal(replacement.value.checksum, original.checksum);
  assert.equal(f.repository.inspect().finalFiles.length, 1);
});

test("migration is additive, financial operations are RPC-backed and final files immutable", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "20260802_add_kadi_v1_generation_lifecycle.sql"), "utf8");
  for (const table of ["kadi_v1_wallet_reservations", "kadi_v1_generation_attempts", "kadi_v1_final_files", "kadi_v1_delivery_attempts"]) assert.match(sql, new RegExp(`create table if not exists public\\.${table}`));
  assert.match(sql, /kadi_v1_reserve_generation_credits/);
  assert.match(sql, /kadi_v1_capture_generation_reservation/);
  assert.match(sql, /kadi_v1_persist_generated_transition/);
  assert.match(sql, /kadi_consume_credits_v2/);
  assert.match(sql, /kadi_v1_final_files_immutable/);
  assert.doesNotMatch(sql, /\b(?:drop\s+(?:table|column|constraint)|truncate\s+table|delete\s+from)\b/i);
  assert.doesNotMatch(sql, /WELCOME_CREDITS|\bstamp\b|\btampon\b/i);
});

test("Supabase lifecycle adapter delegates reservation and capture to atomic RPCs", async () => {
  const calls = [];
  const client = {
    rpc(name, parameters) { calls.push({ name, parameters }); return Promise.resolve({ data: { ok: true, reservation_id: "reservation:rpc", owner_wa_id: OWNER, quote_id: command.quoteId, amount: 4, status: name.includes("capture") ? "CAPTURED" : "RESERVED" }, error: null }); },
    from() { throw new Error("TABLE_ACCESS_NOT_EXPECTED"); },
  };
  const repository = createSupabaseGenerationLifecycleRepository(client);
  const reserved = await repository.reserveCredits({ reservation: { reservation_id: "reservation:rpc", owner_wa_id: OWNER, quote_id: command.quoteId, amount: 4 }, idempotencyKey: "rpc:reserve" });
  const captured = await repository.captureReservation({ reservationId: "reservation:rpc", idempotencyKey: "rpc:capture" });
  assert.equal(reserved.ok, true);
  assert.equal(captured.ok, true);
  assert.deepEqual(calls.map((entry) => entry.name), ["kadi_v1_reserve_generation_credits", "kadi_v1_capture_generation_reservation"]);
  assert.equal(JSON.stringify(calls).includes("token"), false);
});

test("Lot 8 core has no Meta, external AI or real delivery dependency", () => {
  for (const file of ["kadiV1GenerationLifecycleRepository.js", "kadiV1WalletReservationService.js", "kadiV1FinalGenerationService.js", "kadiV1DeliveryService.js", "kadiV1GenerationLifecycleService.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.doesNotMatch(source, /require\(["'][^"']*(?:whatsapp|openai|gemini|axios)/i, file);
    assert.doesNotMatch(source, /\/webhook|\/data_exchange|phone_number_id|flow_id/i, file);
  }
});
