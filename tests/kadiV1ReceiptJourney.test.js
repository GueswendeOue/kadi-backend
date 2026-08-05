"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { validateActionPayload } = require("../kadiV1FlowReplyRuntime");
const { createKadiV1FlowCommandRuntime } = require("../kadiV1FlowCommandRuntime");
const { createInMemoryV1DocumentRepository } = require("../kadiV1DocumentRepository");
const { createSharedDocumentPipeline } = require("../kadiV1SharedDocumentPipeline");
const { createKadiV1DocumentRuntimeAdapter } = require("../kadiV1RuntimeAdapters");
const { buildPreviewData } = require("../kadiV1PreviewService");
const { previewToDocData, resolveReceiptFormat } = require("../kadiV1TemporaryRenderService");
const { resolveRenderer } = require("../pdf/kadiPdfRouter");
const { createKadiV1IssuerLogoLoader } = require("../kadiV1ProductionInfrastructure");

const OWNER = "22670000000";

// --- Category: reply-runtime validation (mission items 5, 6, 7, 8, 9) ---

function validPayload(overrides = {}) {
  return {
    payer: "Client Test",
    beneficiary: "Entreprise Test",
    amount: "75000",
    reason: "Paiement prestation",
    payment_method: "Espèces",
    reference: "REF-1",
    receipt_format: "A4",
    ...overrides,
  };
}

test("SAVE_RECEIPT_DETAILS accepts a valid payload and normalizes amount to a safe positive integer", () => {
  const result = validateActionPayload("RECEIPT_DETAILS", "SAVE_RECEIPT_DETAILS", validPayload());
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.amount, 75000);
  assert.equal(typeof result.value.amount, "number");
});

test("amount given as an integer (not a string) is also accepted", () => {
  const result = validateActionPayload("RECEIPT_DETAILS", "SAVE_RECEIPT_DETAILS", validPayload({ amount: 12000 }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.amount, 12000);
});

test("invalid amounts fail closed: zero, negative, decimal, malformed, missing", () => {
  for (const amount of ["0", "-5", "12.5", "abc", "", null]) {
    const result = validateActionPayload("RECEIPT_DETAILS", "SAVE_RECEIPT_DETAILS", validPayload({ amount }));
    assert.equal(result.ok, false, `amount=${JSON.stringify(amount)} should be rejected`);
    assert.equal(result.error, "KADI_V1_FLOW_REPLY_RECEIPT_AMOUNT_INVALID");
  }
  const missing = validPayload();
  delete missing.amount;
  const result = validateActionPayload("RECEIPT_DETAILS", "SAVE_RECEIPT_DETAILS", missing);
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_FLOW_REPLY_RECEIPT_AMOUNT_INVALID");
});

test("receipt_format accepts only A4 or TICKET_80", () => {
  for (const receipt_format of ["A4", "TICKET_80"]) {
    const result = validateActionPayload("RECEIPT_DETAILS", "SAVE_RECEIPT_DETAILS", validPayload({ receipt_format }));
    assert.equal(result.ok, true, result.error);
  }
});

test("invalid, empty, lowercase and free-text receipt_format values fail closed", () => {
  for (const receipt_format of ["", "a4", "ticket_80", "TICKET80", "Ticket 80mm", "PDF"]) {
    const result = validateActionPayload("RECEIPT_DETAILS", "SAVE_RECEIPT_DETAILS", validPayload({ receipt_format }));
    assert.equal(result.ok, false, `receipt_format=${JSON.stringify(receipt_format)} should be rejected`);
    assert.equal(result.error, "KADI_V1_FLOW_REPLY_RECEIPT_FORMAT_INVALID");
  }
});

test("payer, beneficiary and reason are required and non-empty", () => {
  for (const field of ["payer", "beneficiary", "reason"]) {
    const payload = validPayload({ [field]: "" });
    const result = validateActionPayload("RECEIPT_DETAILS", "SAVE_RECEIPT_DETAILS", payload);
    assert.equal(result.ok, false, `${field} empty should be rejected`);
  }
});

test("unknown fields on SAVE_RECEIPT_DETAILS are rejected, including the old generic-form field names", () => {
  const result = validateActionPayload("RECEIPT_DETAILS", "SAVE_RECEIPT_DETAILS", { ...validPayload(), name: "Should not exist" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN");
});

// --- Category: routing (mission items 1, 2, 3, 4) ---

test("RECU never routes to DOCUMENT_CLIENT, ARTICLE_FORM or DOCUMENT_CONTENT flow_key/action combinations", () => {
  assert.equal(validateActionPayload("DOCUMENT_CLIENT", "SAVE_CLIENT", { name: "x" }).ok, true);
  // RECEIPT_DETAILS is a distinct, independent flow_key: ARTICLE_FORM and
  // DOCUMENT_CONTENT actions are not part of its allowed action set.
  assert.deepEqual(
    validateActionPayload("RECEIPT_DETAILS", "ADD_CONTENT", {}),
    { ok: false, error: "KADI_V1_FLOW_REPLY_ACTION_FORBIDDEN" }
  );
  assert.deepEqual(
    validateActionPayload("RECEIPT_DETAILS", "START_ADD_CONTENT", {}),
    { ok: false, error: "KADI_V1_FLOW_REPLY_ACTION_FORBIDDEN" }
  );
});

// --- Category: command runtime dispatch ---

function documentRuntimeStub(calls) {
  const record = (name) => async (payload) => { calls.push({ name, payload }); return { ok: true, value: { name } }; };
  return {
    start: record("start"), setInvoiceKind: record("setInvoiceKind"), setReceiptDetails: record("setReceiptDetails"),
    setClient: record("setClient"), startAddContent: record("startAddContent"), addContent: record("addContent"),
    updateContent: record("updateContent"), removeContent: record("removeContent"), finishContent: record("finishContent"),
    setOptions: record("setOptions"), verify: record("verify"), beginEdit: record("beginEdit"),
    saveForLater: record("saveForLater"), saveDischargeDetails: record("saveDischargeDetails"), cancel: record("cancel"),
  };
}

test("SAVE_RECEIPT_DETAILS command is routed to the document adapter's setReceiptDetails with server-bound identity", async () => {
  const calls = [];
  const runtime = createKadiV1FlowCommandRuntime({
    onboardingRuntime: { continueOnboarding: async () => ({ ok: true, value: null }) },
    documentRuntime: documentRuntimeStub(calls),
    previewRuntime: { prepare: async () => ({ ok: true, value: null }) },
    generationRuntime: { confirm: async () => ({ ok: true, value: null }) },
    rechargeRuntime: { selectPack: async () => ({}), checkPayment: async () => ({}), cancel: async () => ({}) },
    historyRuntime: { search: async () => ({}), open: async () => ({}) },
    walletRuntime: { getBalance: async () => ({ ok: true, value: { credits: 0 } }) },
  });
  await runtime.execute({
    ownerWaId: OWNER,
    flowKey: "RECEIPT_DETAILS",
    action: "SAVE_RECEIPT_DETAILS",
    data: { payer: "Client", beneficiary: "Entreprise", amount: 5000, reason: "Test", receipt_format: "A4" },
    idempotencyKey: "flow_command:reply:1",
    documentContext: {
      document_id: "document:1", document_version: 2, document_type: "RECU",
      document_state: "COLLECTING", return_state: "COLLECTING",
    },
  });
  assert.equal(calls[0].name, "setReceiptDetails");
  assert.equal(calls[0].payload.documentId, "document:1");
  assert.equal(calls[0].payload.expectedVersion, 2);
  assert.deepEqual(calls[0].payload.details, {
    payer: "Client", beneficiary: "Entreprise", amount: 5000, reason: "Test", receipt_format: "A4",
  });
});

// --- Category: pipeline persistence (mission items 10, 11, 12) ---

function fixture() {
  let idIndex = 0;
  const repository = createInMemoryV1DocumentRepository();
  const pipeline = createSharedDocumentPipeline({ repository, idFactory: (kind) => `${kind}:${++idIndex}` });
  return { repository, pipeline };
}

async function createDraft(f, type) {
  const result = await f.pipeline.createDraft({ ownerWaId: OWNER, documentType: type, idempotencyKey: `create_draft:${type.toLowerCase()}` });
  assert.equal(result.ok, true, result.error);
  return result.value;
}

test("a receipt without receipt_format cannot become READY_FOR_REVIEW even with all other fields present", async () => {
  const f = fixture();
  let document = await createDraft(f, "RECU");
  document = (await f.pipeline.setIssuer({
    ownerWaId: OWNER, documentId: document.document_id, expectedVersion: document.version,
    issuerProfileId: "issuer:1", idempotencyKey: "set_issuer:document:1:1",
  })).value;
  document = (await f.pipeline.addContent({
    ownerWaId: OWNER, documentId: document.document_id, expectedVersion: document.version,
    content: { payer: "Client", beneficiary: "Entreprise", amount: 5000, reason: "Test" },
    idempotencyKey: "add_content:document:1:1",
  })).value;
  const missing = await f.pipeline.getMissingFields({ documentId: document.document_id, ownerWaId: OWNER });
  assert.ok(missing.value.includes("receipt_format"), "receipt_format must remain listed as missing");
  const readied = await f.pipeline.markReadyForReview({
    ownerWaId: OWNER, documentId: document.document_id, expectedVersion: document.version,
    idempotencyKey: "mark_ready:document:1:1",
  });
  assert.equal(readied.ok, false);
  // The pipeline's own missing-fields gate (kadiV1SharedDocumentPolicies)
  // catches this first and reports it generically; the domain-level hard
  // gate (DOCUMENT_RECEIPT_FORMAT_REQUIRED) is a redundant backstop
  // exercised directly against the domain in kadiV1DocumentDomain.test.js.
  assert.equal(readied.error, "DOCUMENT_INFORMATION_MISSING");
});

test("the domain-level hard gate independently refuses MARK_READY_FOR_REVIEW without a valid receipt_format", () => {
  const { createDocumentDomain, DOCUMENT_EVENTS } = require("../kadiV1DocumentDomain");
  const domain = createDocumentDomain({ clock: () => "2026-08-05T00:00:00.000Z" });
  const created = domain.createDocument({
    document_id: "document:hard-gate", document_type: "RECU", issuer_profile_id: "issuer:1", currency: "XOF",
    receipt: { payer: "Client", beneficiary: "Entreprise", amount: 5000, reason: "Test" },
  });
  assert.equal(created.ok, true, created.error);
  const transitioned = domain.transitionDocument(created.value, DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW);
  assert.equal(transitioned.ok, false);
  assert.equal(transitioned.error, "DOCUMENT_RECEIPT_FORMAT_REQUIRED");
});

test("receipt_format is persisted in document.options and unblocks READY_FOR_REVIEW", async () => {
  const f = fixture();
  let document = await createDraft(f, "RECU");
  document = (await f.pipeline.setIssuer({
    ownerWaId: OWNER, documentId: document.document_id, expectedVersion: document.version,
    issuerProfileId: "issuer:1", idempotencyKey: "set_issuer:document:2:1",
  })).value;
  document = (await f.pipeline.addContent({
    ownerWaId: OWNER, documentId: document.document_id, expectedVersion: document.version,
    content: { payer: "Client", beneficiary: "Entreprise", amount: 5000, reason: "Test" },
    idempotencyKey: "add_content:document:2:1",
  })).value;
  document = (await f.pipeline.setReceiptFormat({
    ownerWaId: OWNER, documentId: document.document_id, expectedVersion: document.version,
    receiptFormat: "TICKET_80", idempotencyKey: "set_receipt_format:document:2:1",
  })).value;
  assert.equal(document.options.receipt_format, "TICKET_80");
  const readied = await f.pipeline.markReadyForReview({
    ownerWaId: OWNER, documentId: document.document_id, expectedVersion: document.version,
    idempotencyKey: "mark_ready:document:2:1",
  });
  assert.equal(readied.ok, true, readied.error);
  assert.equal(readied.value.status, "READY_FOR_REVIEW");
});

test("preview data (buildPreviewData) exposes receipt_format for RECU", () => {
  const document = {
    document_type: "RECU", version: 1, issuer_profile_id: "issuer:1",
    receipt: { payer: "Client", beneficiary: "Entreprise", amount: 5000, reason: "Test", payment_method: null, reference: null },
    options: { receipt_format: "TICKET_80" },
    notes: null, issued_at: null, document_number: null, missing_fields: [], uncertainties: [],
  };
  const preview = buildPreviewData(document);
  assert.equal(preview.receipt_format, "TICKET_80");
});

// --- Category: PDF renderer resolution (mission items 13, 14) ---

test("A4 selects the A4 renderer through the real router chain", () => {
  const preview = { structured_preview: {
    document_type: "RECU", document_number: null, issued_at: null,
    payer: "Client", reason: "Test", total: 5000, receipt_format: "A4",
  } };
  const docData = previewToDocData(preview);
  assert.equal(docData.receiptFormat, "a4");
  const { buildRecuA4Pdf } = require("../pdf/kadiPdfRecuA4");
  assert.equal(resolveRenderer(docData), buildRecuA4Pdf);
});

test("TICKET_80 selects the compact renderer through the real router chain, never falling back to A4", () => {
  const preview = { structured_preview: {
    document_type: "RECU", document_number: null, issued_at: null,
    payer: "Client", reason: "Test", total: 5000, receipt_format: "TICKET_80",
  } };
  const docData = previewToDocData(preview);
  assert.equal(docData.receiptFormat, "compact");
  const { buildRecuCompactPdf } = require("../pdf/kadiPdfRecuCompact");
  assert.equal(resolveRenderer(docData), buildRecuCompactPdf);
});

test("resolveReceiptFormat fails closed on a missing or invalid persisted format, never defaulting to A4", () => {
  for (const invalid of [null, undefined, "", "compact", "ticket", "a4", "unknown"]) {
    assert.throws(() => resolveReceiptFormat(invalid), /RECEIPT_FORMAT_INVALID/);
  }
});

// --- Category: logo loading for the compact receipt (mission items 15, 16, 17) ---

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function fakeSupabaseWithStorage(downloadImpl) {
  return {
    from() { throw new Error("TABLE_ACCESS_FORBIDDEN"); },
    rpc() { throw new Error("RPC_FORBIDDEN"); },
    storage: { from: (bucket) => ({ bucket, download: downloadImpl }) },
  };
}

test("a valid logo is downloaded, validated and returned as a buffer", async () => {
  const client = fakeSupabaseWithStorage(async (path) => {
    assert.equal(path, "profiles/issuer1/logo.png");
    return { data: { arrayBuffer: async () => PNG_MAGIC.buffer.slice(PNG_MAGIC.byteOffset, PNG_MAGIC.byteOffset + PNG_MAGIC.byteLength) }, error: null };
  });
  const loader = createKadiV1IssuerLogoLoader({ client, bucket: "logos" });
  const result = await loader.getLogoBuffer({ issuerProfile: { logo_path: "profiles/issuer1/logo.png", no_logo: false } });
  assert.equal(result.ok, true);
  assert.ok(Buffer.isBuffer(result.value));
  assert.ok(result.value.length > 0);
});

test("no logo configured (no_logo=true or missing logo_path) resolves to null without error", async () => {
  const client = fakeSupabaseWithStorage(async () => { throw new Error("MUST_NOT_BE_CALLED"); });
  const loader = createKadiV1IssuerLogoLoader({ client, bucket: "logos" });
  const noLogoFlag = await loader.getLogoBuffer({ issuerProfile: { logo_path: "profiles/x/logo.png", no_logo: true } });
  assert.deepEqual(noLogoFlag, { ok: true, value: null });
  const noPath = await loader.getLogoBuffer({ issuerProfile: { logo_path: null, no_logo: false } });
  assert.deepEqual(noPath, { ok: true, value: null });
});

test("logo download failure, decode failure, oversized or unsupported-type buffers are all non-blocking (resolve to null)", async () => {
  const failingDownload = fakeSupabaseWithStorage(async () => ({ data: null, error: { message: "not found" } }));
  const loaderA = createKadiV1IssuerLogoLoader({ client: failingDownload, bucket: "logos" });
  assert.deepEqual(await loaderA.getLogoBuffer({ issuerProfile: { logo_path: "a.png", no_logo: false } }), { ok: true, value: null });

  const throwingDownload = fakeSupabaseWithStorage(async () => { throw new Error("network down"); });
  const loaderB = createKadiV1IssuerLogoLoader({ client: throwingDownload, bucket: "logos" });
  assert.deepEqual(await loaderB.getLogoBuffer({ issuerProfile: { logo_path: "b.png", no_logo: false } }), { ok: true, value: null });

  const wrongType = fakeSupabaseWithStorage(async () => ({ data: { arrayBuffer: async () => Buffer.from("not an image").buffer }, error: null }));
  const loaderC = createKadiV1IssuerLogoLoader({ client: wrongType, bucket: "logos" });
  assert.deepEqual(await loaderC.getLogoBuffer({ issuerProfile: { logo_path: "c.png", no_logo: false } }), { ok: true, value: null });

  const oversized = Buffer.concat([PNG_MAGIC, Buffer.alloc(3 * 1024 * 1024)]);
  const tooBig = fakeSupabaseWithStorage(async () => ({ data: { arrayBuffer: async () => oversized.buffer }, error: null }));
  const loaderD = createKadiV1IssuerLogoLoader({ client: tooBig, bucket: "logos" });
  assert.deepEqual(await loaderD.getLogoBuffer({ issuerProfile: { logo_path: "d.png", no_logo: false } }), { ok: true, value: null });
});

test("logo loader never logs the storage path, a token or a raw error payload", async () => {
  const events = [];
  const logger = { log: (scope, details) => events.push({ scope, details }) };
  const failingDownload = fakeSupabaseWithStorage(async () => ({ data: null, error: { message: "SECRET_DETAIL_should_not_leak" } }));
  const loader = createKadiV1IssuerLogoLoader({ client: failingDownload, bucket: "logos", logger });
  await loader.getLogoBuffer({ issuerProfile: { logo_path: "private/issuer42/logo.png", no_logo: false } });
  assert.ok(events.length > 0);
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /private\/issuer42/);
  assert.doesNotMatch(serialized, /SECRET_DETAIL_should_not_leak/);
});

test("createExistingPdfTemporaryRenderer only attempts a logo for RECU + TICKET_80, never for A4 or other document types", async () => {
  const { createExistingPdfTemporaryRenderer } = require("../kadiV1TemporaryRenderService");
  const logoCalls = [];
  const logoLoader = { getLogoBuffer: async (args) => { logoCalls.push(args); return { ok: true, value: PNG_MAGIC }; } };
  const issuerProfileReader = { getIssuerProfileById: async () => ({ ok: true, value: { business_name: "Kadi Boutique" } }) };
  const renderer = createExistingPdfTemporaryRenderer({
    issuerProfileReader,
    logoLoader,
    rendererResolver: () => async ({ logoBuffer }) => Buffer.from(logoBuffer ? "with-logo" : "no-logo"),
  });

  const a4Preview = { structured_preview: { document_type: "RECU", issuer: { profile_id: "issuer:1" }, document_number: null, issued_at: null, payer: "x", reason: "y", total: 1, receipt_format: "A4" } };
  const a4Result = await renderer.render({ preview: a4Preview });
  assert.equal(a4Result.ok, true, a4Result.error);
  assert.equal(logoCalls.length, 0, "A4 must never trigger a logo lookup");

  const compactPreview = { structured_preview: { document_type: "RECU", issuer: { profile_id: "issuer:1" }, document_number: null, issued_at: null, payer: "x", reason: "y", total: 1, receipt_format: "TICKET_80" } };
  const compactResult = await renderer.render({ preview: compactPreview });
  assert.equal(compactResult.ok, true, compactResult.error);
  assert.equal(logoCalls.length, 1, "TICKET_80 must trigger exactly one logo lookup");
});

test("a rendering PDF is still produced when the logo loader itself throws", async () => {
  const { createExistingPdfTemporaryRenderer } = require("../kadiV1TemporaryRenderService");
  const logoLoader = { getLogoBuffer: async () => { throw new Error("boom"); } };
  const issuerProfileReader = { getIssuerProfileById: async () => ({ ok: true, value: { business_name: "Kadi Boutique" } }) };
  const renderer = createExistingPdfTemporaryRenderer({
    issuerProfileReader,
    logoLoader,
    rendererResolver: () => async ({ logoBuffer }) => Buffer.from(logoBuffer ? "with-logo" : "no-logo"),
  });
  const preview = { structured_preview: { document_type: "RECU", issuer: { profile_id: "issuer:1" }, document_number: null, issued_at: null, payer: "x", reason: "y", total: 1, receipt_format: "TICKET_80" } };
  const result = await renderer.render({ preview });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.buffer.toString(), "no-logo");
});

// --- Category: presenter messages never mention client/article (mission item 19) ---

test("receipt-related canonical messages never mention client or article vocabulary", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "kadiV1ProductionPresenter.js"), "utf8");
  const match = /SAVE_RECEIPT_DETAILS:\s*"([^"]+)"/.exec(source);
  assert.ok(match, "SAVE_RECEIPT_DETAILS must have its own canonical message");
  assert.doesNotMatch(match[1], /client|article/i);
  assert.match(match[1], /reçu/i);
});
