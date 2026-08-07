"use strict";

// Production-composition regression for the destination-lookup schema fix
// (DELIVERY_DESTINATION_LOOKUP_FAILED / PostgreSQL 42703 root cause). Unlike
// every other delivery-retry test in this repo, this one uses the REAL
// kadiV1ProductionInfrastructure.js delivery provider — not a faked
// `provider` object standing in for it — which is exactly the gap that let
// the real production bug (a raw query selecting a nonexistent "options"
// column) ship undetected: every other test faked the delivery provider
// interface away entirely. Only the raw Supabase `client` (for the owner/
// destination read) and the WhatsApp API are faked; the document
// repository, generation lifecycle service, delivery service and the real
// delivery provider are all wired exactly as kadiV1ProductionBootstrap.js
// wires them.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { PDFDocument } = require("pdf-lib");
const { createDocumentDomain, DOCUMENT_EVENTS } = require("../kadiV1DocumentDomain");
const { createInMemoryV1DocumentRepository } = require("../kadiV1DocumentRepository");
const { createInMemoryV1PreviewRepository } = require("../kadiV1PreviewRepository");
const { createInMemoryGenerationLifecycleRepository } = require("../kadiV1GenerationLifecycleRepository");
const { createWalletReservationService } = require("../kadiV1WalletReservationService");
const { createFinalGenerationService, createInMemoryFinalFileStorage } = require("../kadiV1FinalGenerationService");
const { createDeliveryService } = require("../kadiV1DeliveryService");
const { createGenerationLifecycleService } = require("../kadiV1GenerationLifecycleService");
const { createKadiV1WhatsAppDeliveryProvider } = require("../kadiV1ProductionInfrastructure");

const OWNER = "22670626055";
const NOW = "2026-08-07T12:00:00.000Z";

function digest(value) {
  return crypto.createHash("sha256").update(String(value || "missing"), "utf8").digest("hex");
}

async function pdf() {
  const document = await PDFDocument.create();
  document.addPage();
  return Buffer.from(await document.save());
}

// The real production Supabase client shape, scoped to only what
// lookupDestinationOwner actually needs — a minimal, faithful stand-in
// asserting the exact real (fixed) query shape, never the nonexistent
// "options" column that caused the real production incident.
function fakeSupabaseOwnerOnly(ownerWaId) {
  return {
    from(table) {
      assert.equal(table, "kadi_v1_documents");
      return {
        select(columns) {
          assert.equal(columns, "owner_wa_id");
          return {
            eq(column) {
              assert.equal(column, "document_id");
              return { async maybeSingle() { return { data: { owner_wa_id: ownerWaId }, error: null }; } };
            },
          };
        },
      };
    },
    async rpc() { return { data: null, error: null }; },
    storage: { from() { return {}; } },
  };
}

async function buildFixture({ documentType = "FACTURE", invoiceKind = null, whatsappFailsOnce = true } = {}) {
  const clock = () => NOW;
  const domain = createDocumentDomain({ clock });
  const documents = createInMemoryV1DocumentRepository();
  const artifacts = createInMemoryV1PreviewRepository();

  const createInput = { document_id: "doc:schema-fix", document_type: documentType, issuer_profile_id: "issuer:1", currency: "XOF" };
  if (documentType !== "DECHARGE") createInput.client = { name: "Client fictif" };
  if (["FACTURE", "DEVIS"].includes(documentType)) createInput.items = [{ item_id: "item:1", description: "Service", quantity_millis: 1000, unit_price: 5000 }];
  if (documentType === "RECU") createInput.receipt = { payer: "Moussa", beneficiary: "Boutique Awa", amount: 15000, reason: "Achat", payment_method: null, reference: null };
  if (documentType === "DECHARGE") createInput.discharge = { giver: "Ibrahim", receiver: "Fatou", subject: { type: "MONEY", amount: 25000, description: null }, reason: "Prêt" };
  if (invoiceKind) createInput.options = { invoice_kind: invoiceKind };
  if (documentType === "RECU") createInput.options = { ...(createInput.options || {}), receipt_format: "A4" };
  let document = domain.createDocument(createInput).value;
  await documents.createDocument({ document, ownerWaId: OWNER, idempotencyKey: "doc:schema-fix:create" });
  for (const [event, payload, key] of [
    [DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW, {}, "ready"], [DOCUMENT_EVENTS.VERIFY, {}, "verify"],
    [DOCUMENT_EVENTS.PREPARE_PREVIEW, { preview: { preview_id: "preview:schema-fix" } }, "preview"],
    [DOCUMENT_EVENTS.CALCULATE_COST, { generation_quote: { quote_id: "quote:schema-fix", document_version: 1, page_count: 1, credit_cost: 4 } }, "cost"],
    [DOCUMENT_EVENTS.REQUEST_GENERATION_CONFIRMATION, {}, "await"],
  ]) {
    const next = domain.transitionDocument(document, event, payload).value;
    document = (await documents.persistTransition({ document: next, ownerWaId: OWNER, expectedVersion: 1, fromState: document.status, eventType: `TEST_${key.toUpperCase()}`, idempotencyKey: `doc:schema-fix:${key}` })).value;
  }
  const preview = { preview_id: "preview:schema-fix", document_id: document.document_id, document_version: 1, owner_wa_id: OWNER, status: "ACTIVE", structured_preview: { document_type: documentType, items: [], total: 5000 } };
  await artifacts.createPreview({ preview, idempotencyKey: "preview:schema-fix:create" });
  const render = { render_id: "render:schema-fix", preview_id: preview.preview_id, document_id: document.document_id, document_version: 1, owner_wa_id: OWNER, status: "INSPECTED", page_count: 1 };
  await artifacts.createTemporaryRender({ render, idempotencyKey: "render:schema-fix:create" });
  const quote = { quote_id: "quote:schema-fix", document_id: document.document_id, document_version: 1, owner_wa_id: OWNER, preview_id: preview.preview_id, temporary_render_id: render.render_id, page_count: 1, total_credits: 4, pricing_version: "test-v1", status: "ACTIVE", expires_at: "2026-08-07T13:00:00.000Z" };
  await artifacts.createGenerationQuote({ quote, idempotencyKey: "quote:schema-fix:create" });

  const repository = createInMemoryGenerationLifecycleRepository({ balances: { [OWNER]: 20 } });
  const wallet = createWalletReservationService({ repository, clock });
  const finalStorage = createInMemoryFinalFileStorage();
  const renderCalls = { count: 0 };
  const renderer = { render: async () => { renderCalls.count += 1; return { ok: true, value: { buffer: await pdf(), mime_type: "application/pdf" } }; } };
  const finalGeneration = createFinalGenerationService({ repository, storage: finalStorage, renderer, clock });

  const uploadedFilenames = [];
  const sentFilenames = [];
  const metaCalls = { count: 0 };
  let whatsappCallIndex = 0;
  const whatsappApi = {
    async uploadMediaBuffer({ filename }) {
      metaCalls.count += 1;
      whatsappCallIndex += 1;
      if (whatsappFailsOnce && whatsappCallIndex === 1) throw new Error("simulated transient Meta failure");
      uploadedFilenames.push(filename);
      return { id: "media:1" };
    },
    async sendDocument({ filename }) {
      sentFilenames.push(filename);
      return { messages: [{ id: "wamid:delivered" }] };
    },
  };

  // The REAL delivery provider, wired exactly as production wires it:
  // a minimal owner-only raw Supabase read for destination verification,
  // and the SAME document repository instance already used for everything
  // else for filename metadata (document_type/options.invoice_kind/
  // document_number) — never a second hand-written raw query.
  const deliveryProvider = createKadiV1WhatsAppDeliveryProvider({
    client: fakeSupabaseOwnerOnly(OWNER),
    documentRepository: documents,
    storage: finalStorage,
    whatsappApi,
  });
  const deliveryService = createDeliveryService({ repository, provider: deliveryProvider, clock });
  const quoteService = { async validateGenerationQuote({ quoteId, ownerWaId }) {
    const result = await artifacts.getGenerationQuote({ quoteId });
    if (!result.ok || result.value.owner_wa_id !== ownerWaId || result.value.status !== "ACTIVE") return { ok: false, error: "GENERATION_QUOTE_NOT_ACTIVE" };
    return result;
  } };
  const service = createGenerationLifecycleService({
    documentRepository: documents, previewRepository: artifacts, generationRepository: repository,
    quoteService, walletReservationService: wallet, finalGenerationService: finalGeneration, deliveryService, domain, clock,
  });

  return { service, repository, documents, wallet, renderCalls, metaCalls, uploadedFilenames, sentFilenames };
}

const command = { documentId: "doc:schema-fix", documentVersion: 1, quoteId: "quote:schema-fix", ownerWaId: OWNER, idempotencyKey: "confirm:schema-fix" };

test("production-composition: RECOVERABLE_FAILURE -> RETRY_DELIVERY -> real destination lookup (fixed schema) -> real delivery provider reached -> DELIVERED, exactly once, canonical filename, no duplicate billing/render/artifact", async () => {
  const f = await buildFixture({ whatsappFailsOnce: true });

  const confirmed = await f.service.confirmGeneration(command);
  assert.equal(confirmed.ok, false);
  assert.equal(confirmed.error, "DELIVERY_RECOVERABLE_FAILURE", "first Meta upload fails, first attempt ends recoverable — proves the real provider, including the real (fixed) destination lookup, is genuinely reached, not skipped");
  assert.equal(f.metaCalls.count, 1, "destination verification succeeded and Meta was reached exactly once on the failed first attempt — proves the schema fix, not a lookup failure, caused nothing here");

  const beforeRetry = await f.documents.getDocumentById({ documentId: command.documentId, ownerWaId: OWNER });
  assert.equal(beforeRetry.value.status, "RECOVERABLE_FAILURE");

  const retried = await f.service.retryDelivery({ documentId: command.documentId, ownerWaId: OWNER, idempotencyKey: "retry:schema-fix" });
  assert.equal(retried.ok, true, retried.error);

  const after = await f.documents.getDocumentById({ documentId: command.documentId, ownerWaId: OWNER });
  assert.equal(after.value.status, "DELIVERED");

  assert.equal(f.metaCalls.count, 2, "exactly one more real Meta call on retry — the real delivery provider, including its real destination lookup, was reached exactly once for the successful attempt");
  assert.equal(f.uploadedFilenames.length, 1, "only the successful attempt actually uploaded");
  assert.equal(f.uploadedFilenames[0], "facture_" + after.value.document_number + ".pdf", "canonical, reference-based filename — resolved via the real document repository, not a guessed column");
  assert.equal(f.sentFilenames[0], f.uploadedFilenames[0]);

  assert.equal(f.renderCalls.count, 1, "no new render on retry — the exact same already-generated final file is reused");
  const reservations = f.repository.inspect().reservations;
  assert.equal(reservations.filter((r) => r.status === "CAPTURED").length, 1, "exactly one captured reservation — no duplicate billing on retry");
  const finalFiles = f.repository.inspect().finalFiles;
  assert.equal(finalFiles.length, 1, "no new final file created by the retry");
});

test("production-composition: PROFORMA delivery survives the fix — invoice_kind resolved via the real document repository, canonical proforma filename", async () => {
  const f = await buildFixture({ invoiceKind: "PROFORMA", whatsappFailsOnce: false });
  const confirmed = await f.service.confirmGeneration(command);
  assert.equal(confirmed.ok, true, confirmed.error);
  assert.equal(confirmed.value.document.status, "DELIVERED");
  assert.equal(f.uploadedFilenames.length, 1);
  assert.match(f.uploadedFilenames[0], /^facture-proforma_/, "PROFORMA must never collapse into the plain 'facture' filename");
});

test("production-composition: DEVIS/RECU/DECHARGE all resolve their filename metadata through the real document repository", async () => {
  for (const [documentType, expectedPrefix] of [["DEVIS", "devis_"], ["RECU", "recu_"], ["DECHARGE", "decharge_"]]) {
    const f = await buildFixture({ documentType, whatsappFailsOnce: false });
    const confirmed = await f.service.confirmGeneration(command);
    assert.equal(confirmed.ok, true, `${documentType}: ${confirmed.error}`);
    assert.equal(f.uploadedFilenames.length, 1);
    assert.match(f.uploadedFilenames[0], new RegExp(`^${expectedPrefix}`), `${documentType} filename prefix`);
  }
});
