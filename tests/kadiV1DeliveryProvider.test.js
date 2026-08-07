"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const { createKadiV1WhatsAppDeliveryProvider, DESTINATION_LOOKUP_MAX_ATTEMPTS } = require("../kadiV1ProductionInfrastructure");

function digest(value) {
  return crypto.createHash("sha256").update(String(value || "missing"), "utf8").digest("hex");
}

// A. OWNER / DESTINATION VERIFICATION fixture — kadi_v1_documents has no
// "options" column (the confirmed real-production root cause: PostgreSQL
// 42703 on that exact selection). This fixture asserts the real query
// shape stays minimal — only "owner_wa_id" — so this exact defect class
// can never silently return.
function fakeSupabase(ownerRow, { queryError = false } = {}) {
  return {
    from(table) {
      assert.equal(table, "kadi_v1_documents");
      return {
        select(columns) {
          assert.equal(columns, "owner_wa_id", "the owner/destination lookup must select only real physical columns — never the nonexistent \"options\"");
          return {
            eq(column) {
              assert.equal(column, "document_id");
              return {
                async maybeSingle() {
                  if (queryError) return { data: null, error: { message: "boom" } };
                  return { data: ownerRow, error: null };
                },
              };
            },
          };
        },
      };
    },
    async rpc() { return { data: null, error: null }; },
    storage: { from() { return {}; } },
  };
}

// Each call to maybeSingle() consumes the next scripted outcome (repeating
// the last one once exhausted), letting a test script "fails N times then
// succeeds" or "always fails" without any real network/timing behavior.
function scriptedSupabase(outcomes) {
  let callCount = 0;
  return {
    callCount: () => callCount,
    from(table) {
      assert.equal(table, "kadi_v1_documents");
      return {
        select(columns) {
          assert.equal(columns, "owner_wa_id");
          return {
            eq() {
              return {
                async maybeSingle() {
                  const outcome = outcomes[Math.min(callCount, outcomes.length - 1)];
                  callCount += 1;
                  return outcome;
                },
              };
            },
          };
        },
      };
    },
    async rpc() { return { data: null, error: null }; },
    storage: { from() { return {}; } },
  };
}

// B. DELIVERY FILENAME METADATA fixture — the already-authoritative
// document repository, reused rather than another hand-written raw query.
// Throws if called before A ever succeeds (shouldNotBeCalled), proving
// filename resolution never runs ahead of, or instead of, owner
// verification.
function unexpectedMethod(name) {
  return async () => { throw new Error(`documentRepository.${name} must not be called by the delivery provider`); };
}

function fakeDocumentRepository(hydratedDocument, { shouldNotBeCalled = false, expectedOwnerWaId = null } = {}) {
  return {
    async getDocumentById({ documentId, ownerWaId }) {
      if (shouldNotBeCalled) {
        throw new Error("documentRepository.getDocumentById must not be called until destination verification (A) has already succeeded");
      }
      if (expectedOwnerWaId) {
        assert.equal(ownerWaId, expectedOwnerWaId, "filename metadata must be resolved using the server-verified owner from step A, never a different or client-supplied value");
      }
      assert.ok(documentId, "documentId is required");
      if (hydratedDocument === null) return { ok: false, error: "DOCUMENT_NOT_FOUND" };
      return { ok: true, value: hydratedDocument };
    },
    createDocument: unexpectedMethod("createDocument"),
    saveNewVersion: unexpectedMethod("saveNewVersion"),
    appendDomainEvent: unexpectedMethod("appendDomainEvent"),
    persistTransition: unexpectedMethod("persistTransition"),
    findByIdempotencyKey: unexpectedMethod("findByIdempotencyKey"),
    listVersions: unexpectedMethod("listVersions"),
  };
}

function fakeStorage(bytes = Buffer.from("%PDF-fake")) {
  return {
    async readFinal() {
      return { ok: true, value: bytes };
    },
  };
}

function fakeWhatsAppApi({ uploadedFilenames = [], sentFilenames = [] } = {}) {
  return {
    async uploadMediaBuffer({ filename }) {
      uploadedFilenames.push(filename);
      return { id: "media:1" };
    },
    async sendDocument({ filename }) {
      sentFilenames.push(filename);
      return { messages: [{ id: "wamid:1" }] };
    },
  };
}

const OWNER = "22670626055";
const EXPECTED_DESTINATION = `owner:${digest(OWNER).slice(0, 12)}`;

// ==================================================
// A/F. Successful destination lookup using only real physical columns,
// FACTURE FINAL filename.
// ==================================================
test("A/F: delivers using the canonical reference-based filename, real columns only, no internal DB error surfaced", async () => {
  const uploadedFilenames = [];
  const sentFilenames = [];
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client: fakeSupabase({ owner_wa_id: OWNER }),
    documentRepository: fakeDocumentRepository(
      { document_type: "FACTURE", options: {}, document_number: "FA-20260806190633-A0EAC605" },
      { expectedOwnerWaId: OWNER },
    ),
    storage: fakeStorage(),
    whatsappApi: fakeWhatsAppApi({ uploadedFilenames, sentFilenames }),
  });
  const result = await provider.deliverDocument({
    finalFile: { document_id: "document:abc", storage_ref: "private-final:x" },
    destinationRef: EXPECTED_DESTINATION,
    deliveryAttemptId: "delivery:1",
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(uploadedFilenames[0], "facture_FA-20260806190633-A0EAC605.pdf");
  assert.equal(sentFilenames[0], "facture_FA-20260806190633-A0EAC605.pdf");
  assert.notEqual(uploadedFilenames[0], "facture.pdf");
});

// ==================================================
// G. FACTURE PROFORMA filename — proves invoice_kind survives the fix.
// ==================================================
test("G: proforma delivery filename differs from a final invoice", async () => {
  const uploadedFilenames = [];
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client: fakeSupabase({ owner_wa_id: OWNER }),
    documentRepository: fakeDocumentRepository({ document_type: "FACTURE", options: { invoice_kind: "PROFORMA" }, document_number: "FA-20260806190633-A0EAC605" }),
    storage: fakeStorage(),
    whatsappApi: fakeWhatsAppApi({ uploadedFilenames }),
  });
  const result = await provider.deliverDocument({
    finalFile: { document_id: "document:abc", storage_ref: "private-final:x" },
    destinationRef: EXPECTED_DESTINATION,
    deliveryAttemptId: "delivery:1",
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(uploadedFilenames[0], "facture-proforma_FA-20260806190633-A0EAC605.pdf");
});

// ==================================================
// H/I/J. DEVIS, RECU, DECHARGE canonical filenames.
// ==================================================
test("H: DEVIS delivery filename", async () => {
  const uploadedFilenames = [];
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client: fakeSupabase({ owner_wa_id: OWNER }),
    documentRepository: fakeDocumentRepository({ document_type: "DEVIS", options: {}, document_number: "DV-20260807-0001" }),
    storage: fakeStorage(),
    whatsappApi: fakeWhatsAppApi({ uploadedFilenames }),
  });
  const result = await provider.deliverDocument({
    finalFile: { document_id: "document:abc", storage_ref: "private-final:x" },
    destinationRef: EXPECTED_DESTINATION,
    deliveryAttemptId: "delivery:1",
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(uploadedFilenames[0], "devis_DV-20260807-0001.pdf");
});

test("I: RECU delivery filename", async () => {
  const uploadedFilenames = [];
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client: fakeSupabase({ owner_wa_id: OWNER }),
    documentRepository: fakeDocumentRepository({ document_type: "RECU", options: {}, document_number: "RC-20260807-0001" }),
    storage: fakeStorage(),
    whatsappApi: fakeWhatsAppApi({ uploadedFilenames }),
  });
  const result = await provider.deliverDocument({
    finalFile: { document_id: "document:abc", storage_ref: "private-final:x" },
    destinationRef: EXPECTED_DESTINATION,
    deliveryAttemptId: "delivery:1",
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(uploadedFilenames[0], "recu_RC-20260807-0001.pdf");
});

test("J: DECHARGE delivery filename", async () => {
  const uploadedFilenames = [];
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client: fakeSupabase({ owner_wa_id: OWNER }),
    documentRepository: fakeDocumentRepository({ document_type: "DECHARGE", options: {}, document_number: "DC-20260807-0001" }),
    storage: fakeStorage(),
    whatsappApi: fakeWhatsAppApi({ uploadedFilenames }),
  });
  const result = await provider.deliverDocument({
    finalFile: { document_id: "document:abc", storage_ref: "private-final:x" },
    destinationRef: EXPECTED_DESTINATION,
    deliveryAttemptId: "delivery:1",
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(uploadedFilenames[0], "decharge_DC-20260807-0001.pdf");
});

// ==================================================
// The regression: reproducing the real production schema contract.
// Before the fix, the raw query selected "owner_wa_id,document_type,
// options,document_number" — "options" is not a physical column on
// kadi_v1_documents (confirmed by direct reproduction against the real
// database: PostgreSQL 42703, HTTP 400, deterministic). This test proves
// the current, fixed query shape never reproduces that failure, and that
// Meta is never called when the underlying lookup does fail.
// ==================================================
test("regression: the owner/destination lookup never selects a nonexistent column, and a 42703-shaped failure never reaches Meta", async () => {
  const uploadedFilenames = [];
  const sentFilenames = [];
  const client = scriptedSupabase([{ data: null, error: { message: "column kadi_v1_documents.options does not exist", code: "42703" } }]);
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client,
    documentRepository: fakeDocumentRepository(null, { shouldNotBeCalled: true }),
    storage: fakeStorage(),
    whatsappApi: fakeWhatsAppApi({ uploadedFilenames, sentFilenames }),
    sleep: async () => { throw new Error("must never sleep — 42703 is permanent, not transient"); },
  });
  const result = await provider.deliverDocument({
    finalFile: { document_id: "document:abc", storage_ref: "private-final:x" },
    destinationRef: EXPECTED_DESTINATION,
    deliveryAttemptId: "delivery:1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "DELIVERY_DESTINATION_LOOKUP_FAILED");
  assert.equal(client.callCount(), 1, "a 42703 schema error is permanent — read exactly once, never retried");
  assert.equal(uploadedFilenames.length, 0);
  assert.equal(sentFilenames.length, 0);
});

// ==================================================
// B. 42703 fails fast after exactly one attempt, zero sleeps.
// ==================================================
test("B: a 42703 (undefined_column) error exits without exhausting the retry budget, exactly like other permanent-shaped errors", async () => {
  const schemaError = { data: null, error: { message: "column kadi_v1_documents.options does not exist", code: "42703" } };
  const client = scriptedSupabase([schemaError]);
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client,
    documentRepository: fakeDocumentRepository(null, { shouldNotBeCalled: true }),
    storage: fakeStorage(),
    whatsappApi: fakeWhatsAppApi(),
    sleep: async () => { throw new Error("must never sleep — a permanent error must not retry at all"); },
  });
  const result = await provider.deliverDocument({
    finalFile: { document_id: "document:abc", storage_ref: "private-final:x" },
    destinationRef: EXPECTED_DESTINATION,
    deliveryAttemptId: "delivery:1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "DELIVERY_DESTINATION_LOOKUP_FAILED");
  assert.equal(client.callCount(), 1);
});

test("owner/destination lookup that errors (non-42703) is reported distinctly from a genuine mismatch, filename metadata never resolved", async () => {
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client: fakeSupabase(null, { queryError: true }),
    documentRepository: fakeDocumentRepository(null, { shouldNotBeCalled: true }),
    storage: fakeStorage(),
    whatsappApi: fakeWhatsAppApi(),
  });
  const result = await provider.deliverDocument({
    finalFile: { document_id: "document:abc", storage_ref: "private-final:x" },
    destinationRef: EXPECTED_DESTINATION,
    deliveryAttemptId: "delivery:1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "DELIVERY_DESTINATION_LOOKUP_FAILED");
});

// ==================================================
// E. Malformed/missing owner: fail closed, filename metadata never resolved.
// ==================================================
test("E: owner_wa_id missing from the freshly-read row is a lookup failure, not a confirmed mismatch, and filename metadata is never resolved", async () => {
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client: fakeSupabase({ owner_wa_id: null }),
    documentRepository: fakeDocumentRepository(null, { shouldNotBeCalled: true }),
    storage: fakeStorage(),
    whatsappApi: fakeWhatsAppApi(),
  });
  const result = await provider.deliverDocument({
    finalFile: { document_id: "document:abc", storage_ref: "private-final:x" },
    destinationRef: EXPECTED_DESTINATION,
    deliveryAttemptId: "delivery:1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "DELIVERY_DESTINATION_LOOKUP_FAILED");
});

// ==================================================
// D. Genuine mismatch: one resolved lookup, no Meta contact, filename
// metadata never resolved (no point — delivery is blocked regardless).
// ==================================================
test("D: owner loaded successfully but the destination hash genuinely differs is a confirmed mismatch — never retried, filename never resolved", async () => {
  const client = scriptedSupabase([{ data: { owner_wa_id: "22600000000" }, error: null }]);
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client,
    documentRepository: fakeDocumentRepository(null, { shouldNotBeCalled: true }),
    storage: fakeStorage(),
    whatsappApi: fakeWhatsAppApi(),
    sleep: async () => { throw new Error("must never sleep — a confirmed mismatch must never retry"); },
  });
  const result = await provider.deliverDocument({
    finalFile: { document_id: "document:abc", storage_ref: "private-final:x" },
    destinationRef: EXPECTED_DESTINATION,
    deliveryAttemptId: "delivery:1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "DELIVERY_DESTINATION_MISMATCH");
  assert.equal(client.callCount(), 1);
});

// ==================================================
// C. Transient lookup failure then success.
// ==================================================
test("C: a transient lookup failure recovers on retry — delivery continues exactly once, filename metadata resolved only after success", async () => {
  const client = scriptedSupabase([
    { data: null, error: { message: "connection reset", code: "ECONNRESET" } },
    { data: { owner_wa_id: OWNER }, error: null },
  ]);
  const sleeps = [];
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client,
    documentRepository: fakeDocumentRepository({ document_type: "FACTURE", options: {}, document_number: "FA-B-TRANSIENT" }, { expectedOwnerWaId: OWNER }),
    storage: fakeStorage(), whatsappApi: fakeWhatsAppApi(),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const result = await provider.deliverDocument({
    finalFile: { document_id: "document:abc", storage_ref: "private-final:x" },
    destinationRef: EXPECTED_DESTINATION,
    deliveryAttemptId: "delivery:1",
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(client.callCount(), 2, "exactly two reads: one failure, one success");
  assert.equal(sleeps.length, 1, "slept exactly once, between the two attempts");
});

test("C: every bounded lookup attempt fails transiently — DELIVERY_DESTINATION_LOOKUP_FAILED, zero Meta calls, bounded attempt count (no infinite loop)", async () => {
  const alwaysFails = { data: null, error: { message: "timeout", code: "ETIMEDOUT" } };
  const client = scriptedSupabase([alwaysFails]);
  const uploadedFilenames = [];
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client,
    documentRepository: fakeDocumentRepository(null, { shouldNotBeCalled: true }),
    storage: fakeStorage(), whatsappApi: fakeWhatsAppApi({ uploadedFilenames }),
    sleep: async () => {},
  });
  const result = await provider.deliverDocument({
    finalFile: { document_id: "document:abc", storage_ref: "private-final:x" },
    destinationRef: EXPECTED_DESTINATION,
    deliveryAttemptId: "delivery:1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "DELIVERY_DESTINATION_LOOKUP_FAILED");
  assert.equal(client.callCount(), DESTINATION_LOOKUP_MAX_ATTEMPTS, "bounded — exactly the configured attempt budget, never more");
  assert.equal(uploadedFilenames.length, 0, "zero Meta calls on a lookup failure");
});

test("C: a permanent-shaped error (permission/schema) exits without exhausting the retry budget", async () => {
  const permanentError = { data: null, error: { message: "permission denied", code: "42501" } };
  const client = scriptedSupabase([permanentError]);
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client,
    documentRepository: fakeDocumentRepository(null, { shouldNotBeCalled: true }),
    storage: fakeStorage(), whatsappApi: fakeWhatsAppApi(),
    sleep: async () => { throw new Error("must never sleep — a permanent error must not retry at all"); },
  });
  const result = await provider.deliverDocument({
    finalFile: { document_id: "document:abc", storage_ref: "private-final:x" },
    destinationRef: EXPECTED_DESTINATION,
    deliveryAttemptId: "delivery:1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "DELIVERY_DESTINATION_LOOKUP_FAILED");
  assert.equal(client.callCount(), 1, "a permanent-shaped error is read exactly once, never retried");
});

test("E: lookup returns no row (no error, no data) at all — remains fail closed as a lookup failure, absence is never treated as a valid destination, even after retrying", async () => {
  const noRow = { data: null, error: null };
  const client = scriptedSupabase([noRow]);
  const uploadedFilenames = [];
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client,
    documentRepository: fakeDocumentRepository(null, { shouldNotBeCalled: true }),
    storage: fakeStorage(), whatsappApi: fakeWhatsAppApi({ uploadedFilenames }),
    sleep: async () => {},
  });
  const result = await provider.deliverDocument({
    finalFile: { document_id: "document:abc", storage_ref: "private-final:x" },
    destinationRef: EXPECTED_DESTINATION,
    deliveryAttemptId: "delivery:1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "DELIVERY_DESTINATION_LOOKUP_FAILED");
  assert.equal(client.callCount(), DESTINATION_LOOKUP_MAX_ATTEMPTS, "an absent row is retried the same bounded number of times as a transient error, then fails closed");
  assert.equal(uploadedFilenames.length, 0);
});

test("both distinct failure codes fail closed — neither ever proceeds to upload/send, and filename metadata is never resolved", async () => {
  const uploadedFilenames = [];
  for (const client of [fakeSupabase(null, { queryError: true }), fakeSupabase({ owner_wa_id: "22600000000" })]) {
    const provider = createKadiV1WhatsAppDeliveryProvider({
      client,
      documentRepository: fakeDocumentRepository(null, { shouldNotBeCalled: true }),
      storage: fakeStorage(), whatsappApi: fakeWhatsAppApi({ uploadedFilenames }),
    });
    await provider.deliverDocument({
      finalFile: { document_id: "document:abc", storage_ref: "private-final:x" },
      destinationRef: EXPECTED_DESTINATION,
      deliveryAttemptId: "delivery:1",
    });
  }
  assert.equal(uploadedFilenames.length, 0);
});

// ==================================================
// Filename metadata resolution failure (the repository call itself fails
// after owner verification already succeeded) still fails closed — never
// falls back to a generic/guessed filename.
// ==================================================
test("if filename metadata cannot be resolved after a successful destination verification, delivery still fails closed, never with a guessed filename", async () => {
  const uploadedFilenames = [];
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client: fakeSupabase({ owner_wa_id: OWNER }),
    documentRepository: fakeDocumentRepository(null),
    storage: fakeStorage(),
    whatsappApi: fakeWhatsAppApi({ uploadedFilenames }),
  });
  const result = await provider.deliverDocument({
    finalFile: { document_id: "document:abc", storage_ref: "private-final:x" },
    destinationRef: EXPECTED_DESTINATION,
    deliveryAttemptId: "delivery:1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "DELIVERY_DOCUMENT_METADATA_UNAVAILABLE");
  assert.equal(uploadedFilenames.length, 0);
});
