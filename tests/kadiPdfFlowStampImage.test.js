"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeKadiPdfFlow } = require("../kadiPdfFlow");

function makeFlow(overrides = {}) {
  return makeKadiPdfFlow({
    getSession: () => ({}),
    sendText: async () => {},
    sendButtons: async () => {},
    sendDocument: async () => {},
    uploadMediaBuffer: async () => ({ id: "pdf-media-id" }),
    getSignedLogoUrl: async (path) => `signed:${path}`,
    downloadSignedUrlToBuffer: async (url) => Buffer.from(url),
    getOrCreateProfile: async () => ({}),
    saveDocument: async () => ({}),
    nextDocNumber: async () => "DOC-1",
    createDevisFollowup: async () => null,
    consumeCredit: async () => ({ balance: 10 }),
    addCredits: async () => ({}),
    buildPdfBuffer: async () => Buffer.from("pdf"),
    kadiStamp: {
      applyStampToPdfBuffer: async (pdfBuffer) => pdfBuffer,
    },
    kadiSignature: {},
    safe: (value) => String(value || "").trim(),
    formatDateISO: () => "2026-05-03",
    money: (value) => `${value}`,
    makeDraftMeta: (meta) => meta,
    computeFinance: () => ({ gross: 1000 }),
    computeBasePdfCost: () => 1,
    getDocTitle: () => "Facture",
    validateDraft: () => ({ ok: true }),
    normalizeAndValidateDraft: (draft) => ({ ok: true, draft }),
    resetStampChoice: () => {},
    buildDechargeText: () => "",
    ...overrides,
  });
}

test("pdf stamp flow downloads stamp image and passes it as stampBuffer", async () => {
  const calls = [];
  const flow = makeFlow({
    getSignedLogoUrl: async (path) => {
      calls.push({ kind: "signed", path });
      return `signed:${path}`;
    },
    downloadSignedUrlToBuffer: async (url) => {
      calls.push({ kind: "download", url });
      return Buffer.from("stamp-png");
    },
    kadiStamp: {
      applyStampToPdfBuffer: async (pdfBuffer, profile, opts) => {
        calls.push({ kind: "stamp", profile, opts });
        return pdfBuffer;
      },
    },
  });

  await flow.applyStampAndSignatureIfAny(
    Buffer.from("pdf"),
    {
      stamp_enabled: true,
      stamp_image_path: "22670000000/stamp.png",
      stamp_source: "uploaded",
    },
    null
  );

  assert.deepEqual(calls[0], {
    kind: "signed",
    path: "22670000000/stamp.png",
  });
  assert.deepEqual(calls[1], {
    kind: "download",
    url: "signed:22670000000/stamp.png",
  });
  assert.equal(calls[2].kind, "stamp");
  assert.equal(Buffer.isBuffer(calls[2].opts.stampBuffer), true);
  assert.equal(calls[2].opts.stampBuffer.toString(), "stamp-png");
});

test("pdf stamp flow uses generated stamp when source is generated even if image exists", async () => {
  const calls = [];
  const flow = makeFlow({
    getSignedLogoUrl: async () => {
      calls.push({ kind: "signed" });
      return "signed";
    },
    downloadSignedUrlToBuffer: async () => {
      calls.push({ kind: "download" });
      return Buffer.from("stamp-png");
    },
    kadiStamp: {
      applyStampToPdfBuffer: async (pdfBuffer, profile, opts) => {
        calls.push({ kind: "stamp", profile, opts });
        return pdfBuffer;
      },
    },
  });

  await flow.applyStampAndSignatureIfAny(
    Buffer.from("pdf"),
    {
      stamp_enabled: true,
      stamp_image_path: "22670000000/stamp.png",
      stamp_source: "generated",
    },
    null
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "stamp");
  assert.equal(calls[0].opts.stampBuffer, null);
  assert.equal(calls[0].profile.stamp_image_path, null);
});

test("pdf stamp flow keeps generated stamp fallback when image path is absent", async () => {
  const calls = [];
  const flow = makeFlow({
    getSignedLogoUrl: async () => {
      calls.push({ kind: "signed" });
      return "signed";
    },
    downloadSignedUrlToBuffer: async () => {
      calls.push({ kind: "download" });
      return Buffer.from("stamp-png");
    },
    kadiStamp: {
      applyStampToPdfBuffer: async (pdfBuffer, profile, opts) => {
        calls.push({ kind: "stamp", profile, opts });
        return pdfBuffer;
      },
    },
  });

  await flow.applyStampAndSignatureIfAny(
    Buffer.from("pdf"),
    {
      stamp_enabled: true,
      business_name: "Kadi Services",
    },
    null
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "stamp");
  assert.equal(calls[0].opts.stampBuffer, null);
  assert.equal(calls[0].profile.stamp_image_path, null);
});
