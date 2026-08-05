"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { PDFDocument } = require("pdf-lib");

const { DOCUMENT_EVENTS, createDocumentDomain } = require("../kadiV1DocumentDomain");
const { createInMemoryV1DocumentRepository } = require("../kadiV1DocumentRepository");
const { createInMemoryV1PreviewRepository } = require("../kadiV1PreviewRepository");
const { createPreviewService } = require("../kadiV1PreviewService");
const {
  createExistingPdfTemporaryRenderer,
  createInMemoryPrivateTemporaryStorage,
  createPdfLibPageCountInspector,
  createTemporaryRenderService,
} = require("../kadiV1TemporaryRenderService");
const { createGenerationPricingPolicy } = require("../kadiV1GenerationPricingPolicy");
const { createGenerationQuoteService } = require("../kadiV1GenerationQuoteService");

const OWNER = "22670000001";

function fixture() {
  let tick = 0;
  let id = 0;
  let currentMs = Date.UTC(2026, 7, 2, 12, 0, 0);
  const domainClock = () => new Date(Date.UTC(2026, 7, 2, 12, 0, tick++)).toISOString();
  const clock = () => new Date(currentMs).toISOString();
  const domain = createDocumentDomain({ clock: domainClock });
  const documentRepository = createInMemoryV1DocumentRepository();
  const previewRepository = createInMemoryV1PreviewRepository();
  const storage = createInMemoryPrivateTemporaryStorage();
  const idFactory = (kind) => `${kind}:${++id}`;
  const previewService = createPreviewService({ documentRepository, previewRepository, domain, clock, idFactory });
  return {
    advance(ms) { currentMs += ms; },
    clock,
    domain,
    documentRepository,
    idFactory,
    previewRepository,
    previewService,
    storage,
  };
}

function input(type, suffix = type.toLowerCase()) {
  const common = {
    document_id: `document:${suffix}`,
    document_type: type,
    issuer_profile_id: "issuer:1",
    currency: "XOF",
  };
  if (["FACTURE", "DEVIS"].includes(type)) return {
    ...common,
    client: { name: "Client fictif" },
    items: [{ item_id: "item:1", description: "Prestation", quantity_millis: 2000, unit: "unité", unit_price: 25000 }],
    tax_rate_basis_points: 1000,
    discount_amount: 5000,
    notes: "Note fictive",
  };
  if (type === "RECU") return {
    ...common,
    receipt: { payer: "Moussa Test", beneficiary: "Entreprise Test", amount: 50000, reason: "Paiement reçu" },
    options: { receipt_format: "A4" },
    notes: "Paiement comptant",
  };
  return {
    ...common,
    issuer_profile_id: null,
    discharge: {
      giver: "Entreprise Test",
      receiver: "Awa Test",
      subject: { type: "GOODS", description: "Clés du magasin", amount: null },
      quantity: 2,
      reason: "Remise convenue",
      observations: "Bon état",
    },
  };
}

async function persistVerified(f, type, suffix = type.toLowerCase()) {
  let document = f.domain.createDocument(input(type, suffix)).value;
  document = (await f.documentRepository.createDocument({
    document,
    ownerWaId: OWNER,
    idempotencyKey: `create:${suffix}`,
  })).value;
  let transitioned = f.domain.transitionDocument(document, DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW);
  assert.equal(transitioned.ok, true, transitioned.error);
  document = (await f.documentRepository.persistTransition({
    document: transitioned.value,
    ownerWaId: OWNER,
    expectedVersion: document.version,
    fromState: "COLLECTING",
    eventType: "MARK_READY_FOR_REVIEW",
    idempotencyKey: `ready:${suffix}`,
  })).value;
  transitioned = f.domain.transitionDocument(document, DOCUMENT_EVENTS.VERIFY);
  document = (await f.documentRepository.persistTransition({
    document: transitioned.value,
    ownerWaId: OWNER,
    expectedVersion: document.version,
    fromState: "READY_FOR_REVIEW",
    eventType: "DOCUMENT_VERIFIED",
    idempotencyKey: `verify:${suffix}`,
  })).value;
  return document;
}

async function persistedPreview(f, type = "FACTURE", suffix = type.toLowerCase()) {
  const document = await persistVerified(f, type, suffix);
  const result = await f.previewService.persistPreview({
    documentId: document.document_id,
    ownerWaId: OWNER,
    expectedVersion: document.version,
    idempotencyKey: `preview:${suffix}`,
  });
  assert.equal(result.ok, true, result.error);
  return result;
}

async function pdfBuffer(pageCount) {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) pdf.addPage();
  return Buffer.from(await pdf.save());
}

function rendererForPages(pageCount) {
  return { render: async () => ({ ok: true, value: { buffer: await pdfBuffer(pageCount), mime_type: "application/pdf", renderer: "TEST_RENDERER" } }) };
}

function renderService(f, pageCount = 1, overrides = {}) {
  return createTemporaryRenderService({
    previewRepository: f.previewRepository,
    storage: f.storage,
    renderer: rendererForPages(pageCount),
    pageCountInspector: createPdfLibPageCountInspector({ clock: f.clock }),
    clock: f.clock,
    idFactory: f.idFactory,
    lifetimeSeconds: 600,
    ...overrides,
  });
}

async function inspectedRender(f, preview, pageCount = 1, suffix = "default") {
  const service = renderService(f, pageCount);
  const created = await service.createTemporaryRender({
    ownerWaId: OWNER,
    previewId: preview.preview_id,
    documentId: preview.document_id,
    documentVersion: preview.document_version,
    idempotencyKey: `render:${suffix}`,
  });
  assert.equal(created.ok, true, created.error);
  const inspected = await service.inspectTemporaryRender({ renderId: created.value.render_id, ownerWaId: OWNER });
  assert.equal(inspected.ok, true, inspected.error);
  return { record: inspected.value, service };
}

function pricing(f, version = "test-v1") {
  return createGenerationPricingPolicy({
    pricingVersion: version,
    validitySeconds: 600,
    documentTypes: Object.fromEntries(["FACTURE", "DEVIS", "RECU", "DECHARGE"].map((type) => [type, { baseCost: 1, perPageCost: 2 }])),
    modalityCosts: { TEXT: 0, TRANSCRIPTION: 1, IMAGE: 1, DOCUMENT: 1 },
    optionCosts: { PRIORITY_TEST: 1 },
  }, { clock: f.clock });
}

test("builds faithful structured previews for FACTURE, DEVIS, RECU and DECHARGE", async () => {
  for (const type of ["FACTURE", "DEVIS", "RECU", "DECHARGE"]) {
    const f = fixture();
    const document = await persistVerified(f, type);
    const result = await f.previewService.buildStructuredPreview({ documentId: document.document_id, ownerWaId: OWNER });
    assert.equal(result.ok, true, `${type}:${result.error}`);
    assert.equal(result.value.document_type, type);
    assert.equal(result.value.version, document.version);
    assert.equal(result.value.issued_at, null);
    assert.equal(result.value.document_number, null);
    if (["FACTURE", "DEVIS"].includes(type)) assert.equal(result.value.items[0].item_id, "item:1");
    if (type === "RECU") assert.equal(result.value.payer, "Moussa Test");
    if (type === "DECHARGE") assert.equal(result.value.content.description, "Clés du magasin");
  }
});

test("refuses incomplete documents and persists a version-bound PREVIEW_READY transition", async () => {
  const f = fixture();
  const incomplete = f.domain.createDocument({ document_id: "document:incomplete", document_type: "FACTURE" }).value;
  await f.documentRepository.createDocument({ document: incomplete, ownerWaId: OWNER, idempotencyKey: "create:incomplete" });
  assert.deepEqual(
    await f.previewService.buildStructuredPreview({ documentId: incomplete.document_id, ownerWaId: OWNER }),
    { ok: false, error: "DOCUMENT_PREVIEW_STATE_INVALID" }
  );
  const persisted = await persistedPreview(f);
  assert.equal(persisted.value.status, "ACTIVE");
  assert.equal(persisted.value.document_version, 1);
  assert.equal(persisted.document.status, "PREVIEW_READY");
  assert.equal(persisted.document.preview.preview_id, persisted.value.preview_id);
});

test("a document correction makes its persisted preview stale and unusable", async () => {
  const f = fixture();
  const preview = await persistedPreview(f);
  const current = await f.documentRepository.getDocumentById({ documentId: preview.value.document_id, ownerWaId: OWNER });
  const modified = f.domain.modifyDocument(current.value, { notes: "Correction" });
  const saved = await f.documentRepository.saveNewVersion({
    document: modified.value,
    ownerWaId: OWNER,
    expectedVersion: current.value.version,
    fromState: current.value.status,
    eventType: "DOCUMENT_CORRECTED",
    idempotencyKey: "correction:preview",
  });
  assert.equal(saved.value.preview, null);
  assert.deepEqual(
    await f.previewService.getPreview({ previewId: preview.value.preview_id, ownerWaId: OWNER }),
    { ok: false, error: "PREVIEW_DOCUMENT_VERSION_STALE" }
  );
  assert.equal((await f.previewRepository.getPreview({ previewId: preview.value.preview_id })).value.status, "INVALIDATED");
});

test("creates an actual temporary PDF only in a private non-deliverable zone", async () => {
  const f = fixture();
  const preview = (await persistedPreview(f)).value;
  const service = renderService(f, 1);
  const created = await service.createTemporaryRender({
    ownerWaId: OWNER,
    previewId: preview.preview_id,
    documentId: preview.document_id,
    documentVersion: preview.document_version,
    idempotencyKey: "render:private",
  });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.value.storage_zone, "TEMPORARY_PRIVATE");
  assert.doesNotMatch(created.value.storage_ref, /^https?:/i);
  assert.equal(Object.hasOwn(created.value, "public_url"), false);
  assert.equal(Object.hasOwn(created.value, "delivered"), false);
  assert.equal(Object.hasOwn(created.value, "debit"), false);
});

test("counts one and multiple pages from the actual PDF page tree", async () => {
  for (const pages of [1, 4]) {
    const f = fixture();
    const preview = (await persistedPreview(f, "FACTURE", `pages-${pages}`)).value;
    const inspected = await inspectedRender(f, preview, pages, `pages-${pages}`);
    assert.equal(inspected.record.page_count, pages);
    assert.equal(inspected.record.inspection_method, "PDF_LIB_PAGE_TREE");
    assert.equal(inspected.record.validation_status, "VALID");
  }
});

test("temporary render boundary rejects an inspector reporting zero pages", async () => {
  const f = fixture();
  const preview = (await persistedPreview(f)).value;
  const service = renderService(f, 1, {
    pageCountInspector: {
      inspect: async ({ renderId, documentVersion }) => ({
        ok: true,
        value: { page_count: 0, render_id: renderId, document_version: documentVersion, validation_status: "VALID" },
      }),
    },
  });
  const created = await service.createTemporaryRender({
    ownerWaId: OWNER,
    previewId: preview.preview_id,
    documentId: preview.document_id,
    documentVersion: 1,
    idempotencyKey: "render:zero-count",
  });
  assert.deepEqual(await service.inspectTemporaryRender({ renderId: created.value.render_id, ownerWaId: OWNER }), {
    ok: false,
    error: "PAGE_COUNT_INVALID",
  });
});

test("rejects empty, corrupt, unexpected MIME and mismatched-version renders", async () => {
  const f = fixture();
  const preview = (await persistedPreview(f)).value;
  for (const [name, output] of [
    ["empty", { buffer: Buffer.alloc(0), mime_type: "application/pdf" }],
    ["mime", { buffer: Buffer.from("data"), mime_type: "text/plain" }],
  ]) {
    const service = renderService(f, 1, { renderer: { render: async () => ({ ok: true, value: output }) } });
    assert.equal((await service.createTemporaryRender({
      ownerWaId: OWNER,
      previewId: preview.preview_id, documentId: preview.document_id, documentVersion: 1, idempotencyKey: `render:${name}`,
    })).ok, false);
  }
  const corruptService = renderService(f, 1, {
    renderer: { render: async () => ({ ok: true, value: { buffer: Buffer.from("%PDF-corrupt"), mime_type: "application/pdf" } }) },
  });
  const corrupt = await corruptService.createTemporaryRender({
    ownerWaId: OWNER,
    previewId: preview.preview_id, documentId: preview.document_id, documentVersion: 1, idempotencyKey: "render:corrupt",
  });
  assert.equal(corrupt.ok, true);
  assert.deepEqual(await corruptService.inspectTemporaryRender({ renderId: corrupt.value.render_id, ownerWaId: OWNER }), { ok: false, error: "TEMPORARY_RENDER_CORRUPT" });
  assert.deepEqual(await renderService(f).createTemporaryRender({
    ownerWaId: OWNER,
    previewId: preview.preview_id, documentId: preview.document_id, documentVersion: 2, idempotencyKey: "render:stale",
  }), { ok: false, error: "TEMPORARY_RENDER_VERSION_MISMATCH" });
});

test("invalidates and expires temporary renders while deleting private bytes", async () => {
  const f = fixture();
  const preview = (await persistedPreview(f)).value;
  const first = await inspectedRender(f, preview, 1, "invalidate");
  const ref = first.record.storage_ref;
  assert.equal((await first.service.invalidateTemporaryRender({ renderId: first.record.render_id, ownerWaId: OWNER })).value.status, "INVALIDATED");
  assert.equal((await f.storage.isPrivate(ref)).value, false);
  const second = await inspectedRender(f, preview, 1, "expire");
  f.advance(601_000);
  assert.equal((await second.service.expireTemporaryRender({ renderId: second.record.render_id, ownerWaId: OWNER })).value.status, "EXPIRED");
  assert.equal((await f.storage.isPrivate(second.record.storage_ref)).value, false);
});

test("pricing is explicitly injected, integer, page-based and stamp-free", () => {
  const f = fixture();
  const policy = pricing(f);
  const result = policy.calculate({ documentType: "FACTURE", pageCount: 3, inputModality: "IMAGE", options: { PRIORITY_TEST: true } });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.base_cost, 1);
  assert.equal(result.value.page_cost, 6);
  assert.equal(result.value.total_credits, 9);
  assert.equal(Number.isSafeInteger(result.value.total_credits), true);
  assert.equal(policy.calculate({ documentType: "FACTURE", pageCount: 0 }).ok, false);
  assert.equal(policy.calculate({ documentType: "FACTURE", pageCount: 1, options: { stamp: true } }).ok, false);
});

async function quoteFixture({ pages = 2, pricingVersion = "test-v1" } = {}) {
  const f = fixture();
  const previewResult = await persistedPreview(f);
  const rendered = await inspectedRender(f, previewResult.value, pages, "quote");
  const policy = pricing(f, pricingVersion);
  const service = createGenerationQuoteService({
    documentRepository: f.documentRepository,
    previewRepository: f.previewRepository,
    pricingPolicy: policy,
    domain: f.domain,
    clock: f.clock,
    idFactory: f.idFactory,
    defaultLifetimeSeconds: 600,
  });
  return { ...f, policy, preview: previewResult.value, render: rendered.record, service };
}

test("creates a version-bound quote then requests generation confirmation without debit or generation", async () => {
  const f = await quoteFixture({ pages: 2 });
  const result = await f.service.createGenerationQuote({
    ownerWaId: OWNER,
    documentId: f.preview.document_id,
    documentVersion: f.preview.document_version,
    previewId: f.preview.preview_id,
    renderId: f.render.render_id,
    idempotencyKey: "quote:create",
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.page_count, 2);
  assert.equal(result.value.total_credits, 5);
  assert.equal(result.document.status, "AWAITING_GENERATION_CONFIRMATION");
  assert.equal(result.document.generation_cost, 5);
  assert.equal(result.document.issued_at, null);
  assert.equal(Object.hasOwn(result.value, "wallet_reservation"), false);
  assert.equal(Object.hasOwn(result.value, "debit"), false);
  assert.equal(Object.hasOwn(result.value, "final_file"), false);
});

test("quote creation is idempotent without duplicate records", async () => {
  const f = await quoteFixture();
  const command = {
    ownerWaId: OWNER, documentId: f.preview.document_id, documentVersion: 1,
    previewId: f.preview.preview_id, renderId: f.render.render_id, idempotencyKey: "quote:idempotent",
  };
  const first = await f.service.createGenerationQuote(command);
  const replay = await f.service.createGenerationQuote(command);
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.value.quote_id, first.value.quote_id);
});

test("concurrent quote commands retain only one ACTIVE quote for a document version", async () => {
  const f = await quoteFixture();
  const secondRender = await inspectedRender(f, f.preview, 2, "quote-concurrent-second");
  const base = {
    ownerWaId: OWNER,
    documentId: f.preview.document_id,
    documentVersion: 1,
    previewId: f.preview.preview_id,
  };
  const results = await Promise.all([
    f.service.createGenerationQuote({ ...base, renderId: f.render.render_id, idempotencyKey: "quote:concurrent-a" }),
    f.service.createGenerationQuote({ ...base, renderId: secondRender.record.render_id, idempotencyKey: "quote:concurrent-b" }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.error === "GENERATION_QUOTE_ACTIVE_VERSION_CONFLICT").length, 1);
});

test("an expired quote is rejected and marked EXPIRED", async () => {
  const f = await quoteFixture();
  const created = await f.service.createGenerationQuote({
    ownerWaId: OWNER, documentId: f.preview.document_id, documentVersion: 1,
    previewId: f.preview.preview_id, renderId: f.render.render_id, idempotencyKey: "quote:expires",
  });
  f.advance(601_000);
  assert.deepEqual(await f.service.validateGenerationQuote({ quoteId: created.value.quote_id, ownerWaId: OWNER }), {
    ok: false, error: "GENERATION_QUOTE_EXPIRED",
  });
  assert.equal((await f.service.getGenerationQuote({ quoteId: created.value.quote_id, ownerWaId: OWNER })).value.status, "EXPIRED");
});

test("a correction invalidates embedded preview and makes the quote unusable", async () => {
  const f = await quoteFixture();
  const created = await f.service.createGenerationQuote({
    ownerWaId: OWNER, documentId: f.preview.document_id, documentVersion: 1,
    previewId: f.preview.preview_id, renderId: f.render.render_id, idempotencyKey: "quote:correction",
  });
  const current = await f.documentRepository.getDocumentById({ documentId: f.preview.document_id, ownerWaId: OWNER });
  const modified = f.domain.modifyDocument(current.value, { notes: "Version corrigée" });
  await f.documentRepository.saveNewVersion({
    document: modified.value, ownerWaId: OWNER, expectedVersion: 1, fromState: current.value.status,
    eventType: "DOCUMENT_CORRECTED", idempotencyKey: "correction:quote",
  });
  assert.deepEqual(await f.service.validateGenerationQuote({ quoteId: created.value.quote_id, ownerWaId: OWNER }), {
    ok: false, error: "GENERATION_QUOTE_DOCUMENT_STALE",
  });
  assert.equal((await f.service.getGenerationQuote({ quoteId: created.value.quote_id, ownerWaId: OWNER })).value.status, "INVALIDATED");
  assert.equal((await f.previewRepository.getPreview({ previewId: f.preview.preview_id })).value.status, "INVALIDATED");
  assert.equal((await f.previewRepository.getTemporaryRender({ renderId: f.render.render_id })).value.status, "INVALIDATED");
});

test("a changed render or pricing version invalidates an existing quote", async () => {
  const renderCase = await quoteFixture();
  const renderQuote = await renderCase.service.createGenerationQuote({
    ownerWaId: OWNER, documentId: renderCase.preview.document_id, documentVersion: 1,
    previewId: renderCase.preview.preview_id, renderId: renderCase.render.render_id, idempotencyKey: "quote:render-stale",
  });
  await renderCase.previewRepository.updateTemporaryRender({
    renderId: renderCase.render.render_id,
    expectedStatus: "INSPECTED",
    changes: { status: "INVALIDATED" },
  });
  assert.deepEqual(await renderCase.service.validateGenerationQuote({ quoteId: renderQuote.value.quote_id, ownerWaId: OWNER }), {
    ok: false, error: "GENERATION_QUOTE_ARTIFACT_STALE",
  });

  const pricingCase = await quoteFixture();
  const pricingQuote = await pricingCase.service.createGenerationQuote({
    ownerWaId: OWNER, documentId: pricingCase.preview.document_id, documentVersion: 1,
    previewId: pricingCase.preview.preview_id, renderId: pricingCase.render.render_id, idempotencyKey: "quote:pricing-stale",
  });
  const changedPolicyService = createGenerationQuoteService({
    documentRepository: pricingCase.documentRepository,
    previewRepository: pricingCase.previewRepository,
    pricingPolicy: pricing(pricingCase, "test-v2"),
    domain: pricingCase.domain,
    clock: pricingCase.clock,
  });
  assert.deepEqual(await changedPolicyService.validateGenerationQuote({ quoteId: pricingQuote.value.quote_id, ownerWaId: OWNER }), {
    ok: false, error: "GENERATION_QUOTE_PRICING_STALE",
  });
});

function stubIssuerProfileReader(profilesById = { "issuer:1": { business_name: "Kadi Boutique", owner_name: "Awa Traoré", address: null, phone: null, email: null } }) {
  return {
    async getIssuerProfileById({ issuerProfileId }) {
      return Object.hasOwn(profilesById, issuerProfileId)
        ? { ok: true, value: profilesById[issuerProfileId] }
        : { ok: false, error: "ISSUER_PROFILE_NOT_FOUND" };
    },
  };
}

test("the existing Kadi renderer can produce a real temporary PDF", async () => {
  const f = fixture();
  const preview = (await persistedPreview(f)).value;
  const service = createTemporaryRenderService({
    previewRepository: f.previewRepository,
    storage: f.storage,
    renderer: createExistingPdfTemporaryRenderer({ issuerProfileReader: stubIssuerProfileReader() }),
    pageCountInspector: createPdfLibPageCountInspector({ clock: f.clock }),
    clock: f.clock,
    idFactory: f.idFactory,
  });
  const created = await service.createTemporaryRender({
    ownerWaId: OWNER,
    previewId: preview.preview_id, documentId: preview.document_id, documentVersion: 1, idempotencyKey: "render:existing",
  });
  assert.equal(created.ok, true, created.error);
  assert.ok((await service.inspectTemporaryRender({ renderId: created.value.render_id, ownerWaId: OWNER })).value.page_count >= 1);
});

test("migration is additive, private and constrains versions, statuses, costs and active quotes", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "20260802_add_kadi_v1_preview_generation.sql"), "utf8");
  for (const table of ["kadi_v1_document_previews", "kadi_v1_temporary_renders", "kadi_v1_generation_quotes"]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`));
  }
  assert.match(sql, /TEMPORARY_PRIVATE/);
  assert.match(sql, /storage_ref !~\* '\^https\?:\/\/'/);
  assert.match(sql, /where status = 'ACTIVE'/);
  assert.match(sql, /total_credits >= 1/);
  assert.match(sql, /create or replace function public\.kadi_v1_persist_transition/);
  assert.match(sql, /generation_quote = case when jsonb_typeof/);
  assert.doesNotMatch(sql, /\b(?:drop|truncate|delete|alter table .* drop)\b/i);
});

test("Lot 7 services have no Meta, wallet, payment or AI provider dependency", () => {
  for (const file of [
    "kadiV1PreviewService.js", "kadiV1PreviewRepository.js", "kadiV1TemporaryRenderService.js",
    "kadiV1GenerationPricingPolicy.js", "kadiV1GenerationQuoteService.js",
  ]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.doesNotMatch(source, /require\(["'][^"']*(?:whatsapp|wallet|payment|openai|gemini)/i, file);
    assert.doesNotMatch(source, /\/webhook|\/data_exchange|phone_number_id|consumeCredit|reserveCredit/i, file);
  }
});
