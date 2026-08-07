"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const { createKadiV1WhatsAppDeliveryProvider } = require("../kadiV1ProductionInfrastructure");

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
