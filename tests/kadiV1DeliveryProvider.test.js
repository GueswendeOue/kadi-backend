"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const { createKadiV1WhatsAppDeliveryProvider, DESTINATION_LOOKUP_MAX_ATTEMPTS } = require("../kadiV1ProductionInfrastructure");

function digest(value) {
  return crypto.createHash("sha256").update(String(value || "missing"), "utf8").digest("hex");
}

function fakeSupabase(documentRow, { queryError = false } = {}) {
  return {
    from(table) {
      assert.equal(table, "kadi_v1_documents");
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  if (queryError) return { data: null, error: { message: "boom" } };
                  return { data: documentRow, error: null };
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
        select() {
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

test("delivers using the canonical reference-based filename, not a generic one", async () => {
  const uploadedFilenames = [];
  const sentFilenames = [];
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client: fakeSupabase({ owner_wa_id: OWNER, document_type: "FACTURE", options: {}, document_number: "FA-20260806190633-A0EAC605" }),
    storage: fakeStorage(),
    whatsappApi: fakeWhatsAppApi({ uploadedFilenames, sentFilenames }),
  });
  const result = await provider.deliverDocument({
    finalFile: { document_id: "document:abc", storage_ref: "private-final:x" },
    destinationRef: EXPECTED_DESTINATION,
    deliveryAttemptId: "delivery:1",
  });
  assert.equal(result.ok, true);
  assert.equal(uploadedFilenames[0], "facture_FA-20260806190633-A0EAC605.pdf");
  assert.equal(sentFilenames[0], "facture_FA-20260806190633-A0EAC605.pdf");
  assert.notEqual(uploadedFilenames[0], "facture.pdf");
});

test("proforma delivery filename differs from a final invoice", async () => {
  const uploadedFilenames = [];
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client: fakeSupabase({ owner_wa_id: OWNER, document_type: "FACTURE", options: { invoice_kind: "PROFORMA" }, document_number: "FA-20260806190633-A0EAC605" }),
    storage: fakeStorage(),
    whatsappApi: fakeWhatsAppApi({ uploadedFilenames }),
  });
  const result = await provider.deliverDocument({
    finalFile: { document_id: "document:abc", storage_ref: "private-final:x" },
    destinationRef: EXPECTED_DESTINATION,
    deliveryAttemptId: "delivery:1",
  });
  assert.equal(result.ok, true);
  assert.equal(uploadedFilenames[0], "facture-proforma_FA-20260806190633-A0EAC605.pdf");
});

test("owner/destination lookup that errors is reported distinctly from a genuine mismatch", async () => {
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client: fakeSupabase(null, { queryError: true }),
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

test("owner_wa_id missing from the freshly-read row is a lookup failure, not a confirmed mismatch", async () => {
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client: fakeSupabase({ owner_wa_id: null, document_type: "FACTURE", document_number: "FA-1" }),
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

test("owner loaded successfully but the destination hash genuinely differs is a confirmed mismatch", async () => {
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client: fakeSupabase({ owner_wa_id: "22600000000", document_type: "FACTURE", document_number: "FA-1" }),
    storage: fakeStorage(),
    whatsappApi: fakeWhatsAppApi(),
  });
  const result = await provider.deliverDocument({
    finalFile: { document_id: "document:abc", storage_ref: "private-final:x" },
    destinationRef: EXPECTED_DESTINATION,
    deliveryAttemptId: "delivery:1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "DELIVERY_DESTINATION_MISMATCH");
});

test("B: a transient lookup failure recovers on retry — delivery continues exactly once, using the value from the successful attempt", async () => {
  const documentRow = { owner_wa_id: OWNER, document_type: "FACTURE", options: {}, document_number: "FA-B-TRANSIENT" };
  const client = scriptedSupabase([
    { data: null, error: { message: "connection reset", code: "ECONNRESET" } },
    { data: documentRow, error: null },
  ]);
  const sleeps = [];
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client, storage: fakeStorage(), whatsappApi: fakeWhatsAppApi(),
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
    client, storage: fakeStorage(), whatsappApi: fakeWhatsAppApi({ uploadedFilenames }),
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
    client, storage: fakeStorage(), whatsappApi: fakeWhatsAppApi(),
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

test("D: a genuine mismatch (owner loaded successfully, hash truly differs) never retries — a single read is sufficient and conclusive", async () => {
  const client = scriptedSupabase([{ data: { owner_wa_id: "22600000000", document_type: "FACTURE", document_number: "FA-D-MISMATCH" }, error: null }]);
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client, storage: fakeStorage(), whatsappApi: fakeWhatsAppApi(),
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

test("E: lookup returns no row (no error, no data) at all — remains fail closed as a lookup failure, absence is never treated as a valid destination, even after retrying", async () => {
  const noRow = { data: null, error: null };
  const client = scriptedSupabase([noRow]);
  const uploadedFilenames = [];
  const provider = createKadiV1WhatsAppDeliveryProvider({
    client, storage: fakeStorage(), whatsappApi: fakeWhatsAppApi({ uploadedFilenames }),
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

test("both distinct failure codes fail closed — neither ever proceeds to upload/send", async () => {
  const uploadedFilenames = [];
  for (const client of [fakeSupabase(null, { queryError: true }), fakeSupabase({ owner_wa_id: "22600000000", document_type: "FACTURE", document_number: "FA-1" })]) {
    const provider = createKadiV1WhatsAppDeliveryProvider({
      client, storage: fakeStorage(), whatsappApi: fakeWhatsAppApi({ uploadedFilenames }),
    });
    await provider.deliverDocument({
      finalFile: { document_id: "document:abc", storage_ref: "private-final:x" },
      destinationRef: EXPECTED_DESTINATION,
      deliveryAttemptId: "delivery:1",
    });
  }
  assert.equal(uploadedFilenames.length, 0);
});
