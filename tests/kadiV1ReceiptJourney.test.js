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
const { createKadiV1IssuerLogoLoader, APPROVED_LOGO_BUCKETS } = require("../kadiV1ProductionInfrastructure");

const OWNER = "22670000000";

// --- Category: reply-runtime validation (mission items 5, 6, 7, 8, 9) ---
// beneficiary is intentionally absent from the visible Flow payload — see
// the "beneficiary UX" category below.

function validPayload(overrides = {}) {
  return {
    payer: "Client Test",
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

test("payer and reason are required and non-empty", () => {
  for (const field of ["payer", "reason"]) {
    const payload = validPayload({ [field]: "" });
    const result = validateActionPayload("RECEIPT_DETAILS", "SAVE_RECEIPT_DETAILS", payload);
    assert.equal(result.ok, false, `${field} empty should be rejected`);
  }
});

test("unknown fields on SAVE_RECEIPT_DETAILS are rejected, including the old generic-form field names and beneficiary", () => {
  const result = validateActionPayload("RECEIPT_DETAILS", "SAVE_RECEIPT_DETAILS", { ...validPayload(), name: "Should not exist" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN");
  const withBeneficiary = validateActionPayload("RECEIPT_DETAILS", "SAVE_RECEIPT_DETAILS", { ...validPayload(), beneficiary: "Should not be user-supplied" });
  assert.equal(withBeneficiary.ok, false);
  assert.equal(withBeneficiary.error, "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN");
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

test("SAVE_RECEIPT_DETAILS command is routed to the document adapter's setReceiptDetails with server-bound identity, without a client-supplied beneficiary", async () => {
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
    data: { payer: "Client", amount: 5000, reason: "Test", receipt_format: "A4" },
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
    payer: "Client", amount: 5000, reason: "Test", receipt_format: "A4",
  });
  assert.equal(Object.hasOwn(calls[0].payload.details, "beneficiary"), false);
});

// --- Category: beneficiary UX (server-derived from the issuer profile) ---

test("the RECEIPT_DETAILS Flow JSON never asks the user to type a beneficiary", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const json = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "flows", "v1_draft", "kadi_receipt_details_v1.json"), "utf8"));
  const names = [];
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (typeof node.name === "string") names.push(node.name);
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const value of Object.values(node)) if (value && typeof value === "object") walk(value);
  }
  walk(json.screens[0].layout);
  assert.equal(names.includes("beneficiary"), false, "beneficiary must not be a visible form field");
  assert.equal(JSON.stringify(json).includes("beneficiary"), false, "beneficiary must not appear anywhere in the Flow payload");
});

function documentRuntimeFixture({ issuerProfileById } = {}) {
  let idIndex = 0;
  const repository = createInMemoryV1DocumentRepository();
  const sharedPipeline = createSharedDocumentPipeline({ repository, idFactory: (kind) => `${kind}:${++idIndex}` });
  const runtime = createKadiV1DocumentRuntimeAdapter({
    sharedPipeline,
    dischargePipeline: { // RECU never reaches the discharge pipeline; a
      // throwing stub proves that and satisfies the port contract.
      createDischargeDraft: async () => { throw new Error("unused"); },
      applyBrainExtraction: async () => { throw new Error("unused"); },
      setIssuerOrGiver: async () => { throw new Error("unused"); },
      setRecipient: async () => { throw new Error("unused"); },
      setTransferredContent: async () => { throw new Error("unused"); },
      setReason: async () => { throw new Error("unused"); },
      setOptions: async () => { throw new Error("unused"); },
      markReadyForReview: async () => { throw new Error("unused"); },
      verifyDischarge: async () => { throw new Error("unused"); },
      reopenForCorrection: async () => { throw new Error("unused"); },
      cancelDischarge: async () => { throw new Error("unused"); },
    },
    documentRepository: repository,
    issuerResolver: {
      getIssuerProfileId: async () => ({ ok: true, value: { issuerProfileId: "issuer:1" } }),
      getIssuerProfileById: issuerProfileById || (async () => ({ ok: true, value: { business_name: "Kadi Boutique", owner_name: "Awa Traoré" } })),
    },
  });
  return { repository, runtime };
}

test("beneficiary is derived from the issuer profile's business_name and persisted in receipt.beneficiary", async () => {
  const { runtime } = documentRuntimeFixture();
  const started = await runtime.start({ ownerWaId: OWNER, documentType: "RECU", idempotencyKey: "flow_command:start:1" });
  assert.equal(started.ok, true, started.error);
  const saved = await runtime.setReceiptDetails({
    ownerWaId: OWNER, documentId: started.value.document_id, expectedVersion: started.value.version,
    documentType: "RECU", idempotencyKey: "flow_command:save-receipt:1",
    details: { payer: "Client Test", amount: 5000, reason: "Test", receipt_format: "A4" },
  });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.value.receipt.beneficiary, "Kadi Boutique");
  assert.equal(saved.value.receipt.payer, "Client Test");
});

test("beneficiary falls back to owner_name when business_name is absent, per the required preference order", async () => {
  // Exercised through the real createKadiV1IssuerResolver (not a hand-rolled
  // mock): its business_name/owner_name fallback is the single source of
  // truth for this preference order (see also
  // kadiV1IssuerProfileResolution.test.js), and setReceiptDetails must
  // simply trust that contract rather than re-implementing the fallback.
  const { createKadiV1IssuerResolver } = require("../kadiV1ProductionInfrastructure");
  const fakeClient = {
    from(table) {
      assert.equal(table, "business_profiles");
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { id: "issuer:1", owner_name: "Awa Traoré", business_name: null }, error: null }),
          }),
        }),
      };
    },
    rpc() { throw new Error("RPC_FORBIDDEN"); },
    storage: { from() { throw new Error("STORAGE_FORBIDDEN"); } },
  };
  const realIssuerResolver = createKadiV1IssuerResolver({ client: fakeClient });
  let idIndex = 0;
  const repository = createInMemoryV1DocumentRepository();
  const sharedPipeline = createSharedDocumentPipeline({ repository, idFactory: (kind) => `${kind}:${++idIndex}` });
  const runtime = createKadiV1DocumentRuntimeAdapter({
    sharedPipeline,
    dischargePipeline: {
      createDischargeDraft: async () => { throw new Error("unused"); }, applyBrainExtraction: async () => { throw new Error("unused"); },
      setIssuerOrGiver: async () => { throw new Error("unused"); }, setRecipient: async () => { throw new Error("unused"); },
      setTransferredContent: async () => { throw new Error("unused"); }, setReason: async () => { throw new Error("unused"); },
      setOptions: async () => { throw new Error("unused"); }, markReadyForReview: async () => { throw new Error("unused"); },
      verifyDischarge: async () => { throw new Error("unused"); }, reopenForCorrection: async () => { throw new Error("unused"); },
      cancelDischarge: async () => { throw new Error("unused"); },
    },
    documentRepository: repository,
    issuerResolver: {
      getIssuerProfileId: async () => ({ ok: true, value: { issuerProfileId: "issuer:1" } }),
      getIssuerProfileById: realIssuerResolver.getIssuerProfileById,
    },
  });
  const started = await runtime.start({ ownerWaId: OWNER, documentType: "RECU", idempotencyKey: "flow_command:start:2" });
  const saved = await runtime.setReceiptDetails({
    ownerWaId: OWNER, documentId: started.value.document_id, expectedVersion: started.value.version,
    documentType: "RECU", idempotencyKey: "flow_command:save-receipt:2",
    details: { payer: "Client Test", amount: 5000, reason: "Test", receipt_format: "A4" },
  });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.value.receipt.beneficiary, "Awa Traoré");
});

async function assertUnresolvedBeneficiaryMutatesNothing(fixtureOptions, suffix) {
  const { runtime, repository } = documentRuntimeFixture(fixtureOptions);
  const started = await runtime.start({ ownerWaId: OWNER, documentType: "RECU", idempotencyKey: `flow_command:start:${suffix}` });
  assert.equal(started.ok, true, started.error);

  // Snapshot the real persisted state before the call, independently of
  // whatever setReceiptDetails is about to return.
  const before = await repository.getDocumentById({ documentId: started.value.document_id, ownerWaId: OWNER });
  assert.equal(before.ok, true, before.error);

  const result = await runtime.setReceiptDetails({
    ownerWaId: OWNER, documentId: started.value.document_id, expectedVersion: started.value.version,
    documentType: "RECU", idempotencyKey: `flow_command:save-receipt:${suffix}`,
    details: { payer: "Client Test", amount: 5000, reason: "Test", receipt_format: "A4" },
  });
  assert.deepEqual(result, { ok: false, error: "KADI_V1_RECEIPT_BENEFICIARY_UNRESOLVED" });

  // Reload independently — do not trust the failure result alone — and
  // prove beneficiary resolution happens strictly before the first
  // document mutation: nothing in the receipt or options changed.
  const after = await repository.getDocumentById({ documentId: started.value.document_id, ownerWaId: OWNER });
  assert.equal(after.ok, true, after.error);
  assert.equal(after.value.version, before.value.version);
  assert.equal(after.value.status, before.value.status);
  assert.equal(after.value.status, "COLLECTING");
  assert.deepEqual(after.value.receipt, before.value.receipt);
  assert.equal(after.value.receipt?.payer, undefined);
  assert.equal(after.value.receipt?.beneficiary, undefined);
  assert.equal(after.value.receipt?.amount, undefined);
  assert.equal(after.value.receipt?.reason, undefined);
  assert.equal(after.value.receipt?.payment_method, undefined);
  assert.equal(after.value.receipt?.reference, undefined);
  assert.deepEqual(after.value.options, before.value.options);
  assert.equal(after.value.options?.receipt_format, undefined);
}

test("a receipt fails closed with zero document mutation when no valid issuer identity can be resolved", async () => {
  await assertUnresolvedBeneficiaryMutatesNothing(
    { issuerProfileById: async () => ({ ok: false, error: "KADI_V1_ISSUER_PROFILE_NOT_FOUND" }) },
    "3a"
  );
  await assertUnresolvedBeneficiaryMutatesNothing(
    { issuerProfileById: async () => ({ ok: true, value: { business_name: "", owner_name: "" } }) },
    "3b"
  );
  await assertUnresolvedBeneficiaryMutatesNothing(
    { issuerProfileById: async () => { throw new Error("network down"); } },
    "3c"
  );
});

test("the derived beneficiary appears in the review/preview projection", async () => {
  const { runtime } = documentRuntimeFixture();
  const started = await runtime.start({ ownerWaId: OWNER, documentType: "RECU", idempotencyKey: "flow_command:start:4" });
  const saved = await runtime.setReceiptDetails({
    ownerWaId: OWNER, documentId: started.value.document_id, expectedVersion: started.value.version,
    documentType: "RECU", idempotencyKey: "flow_command:save-receipt:4",
    details: { payer: "Client Test", amount: 5000, reason: "Test", receipt_format: "A4" },
  });
  assert.equal(saved.ok, true, saved.error);
  const preview = buildPreviewData(saved.value);
  assert.equal(preview.beneficiary, "Kadi Boutique");
});

test("a successful receipt is truly persisted: reloading independently from the repository confirms every field, for both A4 and TICKET_80", async () => {
  for (const receiptFormat of ["A4", "TICKET_80"]) {
    const { runtime, repository } = documentRuntimeFixture();
    const started = await runtime.start({ ownerWaId: OWNER, documentType: "RECU", idempotencyKey: `flow_command:start:persist-${receiptFormat}` });
    assert.equal(started.ok, true, started.error);
    const saved = await runtime.setReceiptDetails({
      ownerWaId: OWNER, documentId: started.value.document_id, expectedVersion: started.value.version,
      documentType: "RECU", idempotencyKey: `flow_command:save-receipt:persist-${receiptFormat}`,
      details: {
        payer: "Client Test", amount: 75000, reason: "Paiement prestation",
        payment_method: "Espèces", reference: "REF-PERSIST-1", receipt_format: receiptFormat,
      },
    });
    assert.equal(saved.ok, true, saved.error);

    // Independent reload: do not trust saved.value alone — go back through
    // the repository exactly as a fresh request would.
    const reloaded = await repository.getDocumentById({ documentId: started.value.document_id, ownerWaId: OWNER });
    assert.equal(reloaded.ok, true, reloaded.error);
    const document = reloaded.value;

    assert.equal(document.receipt.payer, "Client Test");
    assert.equal(document.receipt.beneficiary, "Kadi Boutique");
    assert.equal(document.receipt.amount, 75000);
    assert.equal(typeof document.receipt.amount, "number");
    assert.equal(document.receipt.reason, "Paiement prestation");
    assert.equal(document.receipt.payment_method, "Espèces");
    assert.equal(document.receipt.reference, "REF-PERSIST-1");
    assert.equal(document.options.receipt_format, receiptFormat);
    assert.ok(["A4", "TICKET_80"].includes(document.options.receipt_format));
    // start() (v1) -> addContent (v2) -> setReceiptFormat (v3). The implicit
    // markReadyForReview promotion triggered by advanceIfComplete is a
    // state transition, not a patch, so it does not bump the version.
    assert.equal(document.version, 3);
    assert.equal(document.status, "READY_FOR_REVIEW");
  }
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

test("A4 and TICKET_80 receipts label the payer field 'Payeur', never the generic 'Client'", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const a4Source = fs.readFileSync(path.join(__dirname, "..", "pdf", "kadiPdfRecuA4.js"), "utf8");
  const compactSource = fs.readFileSync(path.join(__dirname, "..", "pdf", "kadiPdfRecuCompact.js"), "utf8");
  assert.match(a4Source, /label:\s*"Payeur"/);
  assert.doesNotMatch(a4Source, /label:\s*"Client"/);
  assert.match(compactSource, /"PAYEUR"/);
  assert.doesNotMatch(compactSource, /"CLIENT"/);
});

test("resolveReceiptFormat fails closed on a missing or invalid persisted format, never defaulting to A4", () => {
  for (const invalid of [null, undefined, "", "compact", "ticket", "a4", "unknown"]) {
    assert.throws(() => resolveReceiptFormat(invalid), /RECEIPT_FORMAT_INVALID/);
  }
});

// --- Category: logo loading for the compact receipt (mission items 15, 16, 17) ---

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function fakeSupabaseWithStorage(downloadByBucket) {
  return {
    from() { throw new Error("TABLE_ACCESS_FORBIDDEN"); },
    rpc() { throw new Error("RPC_FORBIDDEN"); },
    storage: {
      from: (bucket) => ({
        bucket,
        download: (path) => {
          const impl = typeof downloadByBucket === "function" ? downloadByBucket : downloadByBucket[bucket];
          if (!impl) return Promise.resolve({ data: null, error: { message: "bucket not found" } });
          return impl(path);
        },
      }),
    },
  };
}

function pngResponse() {
  return { data: { arrayBuffer: async () => PNG_MAGIC.buffer.slice(PNG_MAGIC.byteOffset, PNG_MAGIC.byteOffset + PNG_MAGIC.byteLength) }, error: null };
}

test("the approved bucket allowlist is exactly logos and kadi-logos", () => {
  assert.deepEqual(APPROVED_LOGO_BUCKETS, ["logos", "kadi-logos"]);
});

test("a valid object from the current bucket (logos) is loaded", async () => {
  const client = fakeSupabaseWithStorage({ logos: async (path) => { assert.equal(path, "22670000000/logo.png"); return pngResponse(); } });
  const loader = createKadiV1IssuerLogoLoader({ client, buckets: ["logos", "kadi-logos"] });
  const result = await loader.getLogoBuffer({ issuerProfile: { logo_path: "22670000000/logo.png", no_logo: false } });
  assert.equal(result.ok, true);
  assert.ok(Buffer.isBuffer(result.value) && result.value.length > 0);
});

test("a valid object from the legacy bucket (kadi-logos) is loaded when the current bucket has nothing at that path", async () => {
  const client = fakeSupabaseWithStorage({
    logos: async () => ({ data: null, error: { message: "not found" } }),
    "kadi-logos": async (path) => { assert.equal(path, "22670000000/logo.png"); return pngResponse(); },
  });
  const loader = createKadiV1IssuerLogoLoader({ client, buckets: ["logos", "kadi-logos"] });
  const result = await loader.getLogoBuffer({ issuerProfile: { logo_path: "22670000000/logo.png", no_logo: false } });
  assert.equal(result.ok, true);
  assert.ok(Buffer.isBuffer(result.value) && result.value.length > 0);
});

test("an explicit bucket prefix outside the allowlist is rejected safely, never queried", async () => {
  let queried = false;
  const client = fakeSupabaseWithStorage(async () => { queried = true; return pngResponse(); });
  const loader = createKadiV1IssuerLogoLoader({ client, buckets: ["logos", "kadi-logos"] });
  const result = await loader.getLogoBuffer({ issuerProfile: { logo_path: "some-random-bucket:22670000000/logo.png", no_logo: false } });
  assert.deepEqual(result, { ok: true, value: null });
  assert.equal(queried, false, "an unapproved bucket must never be queried");
});

test("constructing the loader with a bucket outside the allowlist throws", () => {
  const client = fakeSupabaseWithStorage(async () => pngResponse());
  assert.throws(() => createKadiV1IssuerLogoLoader({ client, buckets: ["arbitrary-bucket"] }), /KADI_V1_LOGO_BUCKET_INVALID/);
});

test("a bucket-prefixed logo_path within the allowlist is honored directly", async () => {
  const client = fakeSupabaseWithStorage({ "kadi-logos": async (path) => { assert.equal(path, "issuer1/logo.png"); return pngResponse(); } });
  const loader = createKadiV1IssuerLogoLoader({ client, buckets: ["logos", "kadi-logos"] });
  const result = await loader.getLogoBuffer({ issuerProfile: { logo_path: "kadi-logos:issuer1/logo.png", no_logo: false } });
  assert.equal(result.ok, true);
  assert.ok(Buffer.isBuffer(result.value));
});

test("no logo configured (no_logo=true or missing logo_path) resolves to null without error", async () => {
  const client = fakeSupabaseWithStorage(async () => { throw new Error("MUST_NOT_BE_CALLED"); });
  const loader = createKadiV1IssuerLogoLoader({ client, buckets: ["logos", "kadi-logos"] });
  const noLogoFlag = await loader.getLogoBuffer({ issuerProfile: { logo_path: "profiles/x/logo.png", no_logo: true } });
  assert.deepEqual(noLogoFlag, { ok: true, value: null });
  const noPath = await loader.getLogoBuffer({ issuerProfile: { logo_path: null, no_logo: false } });
  assert.deepEqual(noPath, { ok: true, value: null });
});

test("a path attempting traversal is rejected without any bucket being queried", async () => {
  let queried = false;
  const client = fakeSupabaseWithStorage(async () => { queried = true; return pngResponse(); });
  const loader = createKadiV1IssuerLogoLoader({ client, buckets: ["logos", "kadi-logos"] });
  const result = await loader.getLogoBuffer({ issuerProfile: { logo_path: "../../etc/passwd", no_logo: false } });
  assert.deepEqual(result, { ok: true, value: null });
  assert.equal(queried, false);
});

test("logo download failure, decode failure, oversized or unsupported-type buffers are all non-blocking (resolve to null)", async () => {
  const failingDownload = fakeSupabaseWithStorage(async () => ({ data: null, error: { message: "not found" } }));
  const loaderA = createKadiV1IssuerLogoLoader({ client: failingDownload, buckets: ["logos"] });
  assert.deepEqual(await loaderA.getLogoBuffer({ issuerProfile: { logo_path: "a.png", no_logo: false } }), { ok: true, value: null });

  const throwingDownload = fakeSupabaseWithStorage(async () => { throw new Error("network down"); });
  const loaderB = createKadiV1IssuerLogoLoader({ client: throwingDownload, buckets: ["logos"] });
  assert.deepEqual(await loaderB.getLogoBuffer({ issuerProfile: { logo_path: "b.png", no_logo: false } }), { ok: true, value: null });

  const wrongType = fakeSupabaseWithStorage(async () => ({ data: { arrayBuffer: async () => Buffer.from("not an image").buffer }, error: null }));
  const loaderC = createKadiV1IssuerLogoLoader({ client: wrongType, buckets: ["logos"] });
  assert.deepEqual(await loaderC.getLogoBuffer({ issuerProfile: { logo_path: "c.png", no_logo: false } }), { ok: true, value: null });

  const oversized = Buffer.concat([PNG_MAGIC, Buffer.alloc(3 * 1024 * 1024)]);
  const tooBig = fakeSupabaseWithStorage(async () => ({ data: { arrayBuffer: async () => oversized.buffer }, error: null }));
  const loaderD = createKadiV1IssuerLogoLoader({ client: tooBig, buckets: ["logos"] });
  assert.deepEqual(await loaderD.getLogoBuffer({ issuerProfile: { logo_path: "d.png", no_logo: false } }), { ok: true, value: null });
});

test("logo loader never logs the storage path, a token or a raw error payload", async () => {
  const events = [];
  const logger = { log: (scope, details) => events.push({ scope, details }) };
  const failingDownload = fakeSupabaseWithStorage(async () => ({ data: null, error: { message: "SECRET_DETAIL_should_not_leak" } }));
  const loader = createKadiV1IssuerLogoLoader({ client: failingDownload, buckets: ["logos", "kadi-logos"], logger });
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
  assert.equal(a4Result.value.buffer.toString(), "no-logo", "A4 rendering must not be affected by logo availability");
  assert.equal(logoCalls.length, 0, "A4 must never trigger a logo lookup");

  const compactPreview = { structured_preview: { document_type: "RECU", issuer: { profile_id: "issuer:1" }, document_number: null, issued_at: null, payer: "x", reason: "y", total: 1, receipt_format: "TICKET_80" } };
  const compactResult = await renderer.render({ preview: compactPreview });
  assert.equal(compactResult.ok, true, compactResult.error);
  assert.equal(compactResult.value.buffer.toString(), "with-logo", "TICKET_80 must receive the resolved logo buffer");
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
