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

async function fixture({ balance = 20, pages = 2, deliveryResults = [{ ok: true, value: { reference: "synthetic-delivery" } }], rendererResult = null, storage = null, observer = () => {} } = {}) {
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
  const calls = { delivery: 0, render: 0 };
  const renderer = { render: async () => { calls.render += 1; return rendererResult || ({ ok: true, value: { buffer: await pdf(pages), mime_type: "application/pdf" } }); } };
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

test("renderer exception fails closed and releases the reservation", async () => {
  const f = await fixture({ rendererResult: { ok: false, error: "FINAL_RENDER_FAILED" } });
  assert.deepEqual(await f.service.confirmGeneration({ ...command, idempotencyKey: "confirm:render-exception" }), { ok: false, error: "FINAL_RENDER_FAILED" });
  assert.equal(f.repository.inspect().reservations[0].status, "RELEASED");
  assert.equal(f.repository.inspect().ledger.length, 0);
});

test("promotion failure after capture resumes with the same PDF and no second debit", async () => {
  const backing = createInMemoryFinalFileStorage();
  let failPromotion = true;
  const storage = { ...backing, async promote(args) { if (failPromotion) { failPromotion = false; return { ok: false, error: "PROMOTION_TEMPORARY" }; } return backing.promote(args); } };
  const f = await fixture({ storage });
  assert.deepEqual(await f.service.confirmGeneration({ ...command, idempotencyKey: "confirm:promotion-failure" }), { ok: false, error: "FINAL_PROMOTION_RECOVERABLE_FAILURE" });
  assert.equal(f.repository.inspect().ledger.length, 1);
  const resumed = await f.service.resumeGeneration({ quoteId: command.quoteId, ownerWaId: OWNER, idempotencyKey: "generation:resume-promotion" });
  assert.equal(resumed.ok, true, resumed.error);
  assert.equal(resumed.value.document.status, "DELIVERED");
  assert.equal(f.repository.inspect().ledger.length, 1);
  assert.equal(f.repository.inspect().finalFiles.length, 1);
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
