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

function makeDraft() {
  return {
    type: "facture",
    factureKind: "definitive",
    date: "2026-05-03",
    client: "Awa",
    items: [{ label: "Pagne", qty: 5, unitPrice: 3000, amount: 15000 }],
    finance: { gross: 15000 },
    source: "product",
    meta: {},
  };
}

function makePdfRun(overrides = {}) {
  const session =
    overrides.session ||
    {
      step: "doc_review",
      addStampForNextDoc: true,
      stampMode: "one_time",
      lastDocDraft: makeDraft(),
    };

  const calls = {
    texts: [],
    consume: [],
    stamp: [],
    downloads: [],
    saved: [],
  };

  const flow = makeFlow({
    getSession: () => session,
    sendText: async (to, text) => calls.texts.push({ to, text }),
    getOrCreateProfile: async () => ({
      stamp_enabled: true,
      stamp_source: "generated",
      stamp_paid: false,
      business_name: "Kadi Services",
    }),
    consumeCredit: async (...args) => {
      calls.consume.push(args);
      return { ok: true, balance: 9 };
    },
    saveDocument: async ({ doc }) => {
      calls.saved.push(doc);
      return { id: "doc-id" };
    },
    sendDocument: async () => {},
    buildPdfBuffer: async () => Buffer.from("pdf"),
    uploadMediaBuffer: async () => ({ id: "pdf-media-id" }),
    kadiStamp: {
      applyStampToPdfBuffer: async (pdfBuffer, profile, opts) => {
        calls.stamp.push({ profile, opts });
        return Buffer.from(`${pdfBuffer.toString()}-stamped`);
      },
    },
    resetStampChoice: (s) => {
      s.addStampForNextDoc = false;
      s.stampMode = null;
    },
    downloadSignedUrlToBuffer: async (url) => {
      calls.downloads.push(url);
      return Buffer.from("stamp-png");
    },
    ...overrides,
  });

  return { flow, session, calls };
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

test("facture with generated one-time stamp consumes +1 and applies stamp despite stamp_paid false", async () => {
  const { flow, calls } = makePdfRun();

  await flow.createAndSendPdf("22670000000");

  assert.equal(calls.consume.length, 1);
  assert.equal(calls.consume[0][1], 2);
  assert.equal(calls.consume[0][2], "pdf_stamp_once");
  assert.equal(calls.consume[0][4].stampExtraCost, 1);
  assert.equal(calls.consume[0][4].useStampForThisDoc, true);

  assert.equal(calls.stamp.length, 1);
  assert.equal(calls.stamp[0].profile.stamp_paid, true);
  assert.equal(calls.stamp[0].profile.stamp_source, "generated");
  assert.equal(calls.stamp[0].opts.ignorePaidFlag, true);
  assert.equal(calls.stamp[0].opts.required, true);

  assert.equal(calls.saved[0].meta.usedStamp, true);
  assert.equal(calls.saved[0].meta.stampApplied, true);
  assert.equal(calls.saved[0].meta.stampSource, "generated");
});

test("facture with uploaded one-time stamp passes downloaded stampBuffer and consumes +1", async () => {
  const { flow, calls } = makePdfRun({
    getOrCreateProfile: async () => ({
      stamp_enabled: true,
      stamp_source: "uploaded",
      stamp_paid: false,
      stamp_image_path: "22670000000/stamp.png",
    }),
  });

  await flow.createAndSendPdf("22670000000");

  assert.equal(calls.consume[0][1], 2);
  assert.equal(calls.stamp.length, 1);
  assert.equal(calls.stamp[0].profile.stamp_source, "uploaded");
  assert.equal(Buffer.isBuffer(calls.stamp[0].opts.stampBuffer), true);
  assert.equal(calls.stamp[0].opts.stampBuffer.toString(), "stamp-png");
  assert.equal(calls.stamp[0].opts.ignorePaidFlag, true);
});

test("uploaded stamp image download failure without generated profile does not consume +1", async () => {
  const { flow, calls } = makePdfRun({
    getOrCreateProfile: async () => ({
      stamp_enabled: true,
      stamp_source: "uploaded",
      stamp_paid: false,
      stamp_image_path: "22670000000/stamp.png",
    }),
    downloadSignedUrlToBuffer: async () => {
      throw new Error("missing stamp image");
    },
  });

  await flow.createAndSendPdf("22670000000");

  assert.equal(calls.consume.length, 1);
  assert.equal(calls.consume[0][1], 1);
  assert.equal(calls.consume[0][4].stampExtraCost, 0);
  assert.equal(calls.consume[0][4].useStampForThisDoc, false);
  assert.equal(calls.stamp.length, 0);
  assert.match(calls.texts[0].text, /sans tampon et sans crédit supplémentaire/);
  assert.equal(calls.saved[0].meta.usedStamp, false);
  assert.equal(calls.saved[0].meta.stampApplied, false);
});

test("choosing without stamp does not consume +1 and does not apply stamp", async () => {
  const session = {
    step: "doc_review",
    addStampForNextDoc: false,
    stampMode: null,
    lastDocDraft: makeDraft(),
  };
  const { flow, calls } = makePdfRun({ session });

  await flow.createAndSendPdf("22670000000");

  assert.equal(calls.consume.length, 1);
  assert.equal(calls.consume[0][1], 1);
  assert.equal(calls.consume[0][4].stampExtraCost, 0);
  assert.equal(calls.consume[0][4].useStampForThisDoc, false);
  assert.equal(calls.stamp.length, 0);
  assert.equal(calls.saved[0].meta.usedStamp, false);
});
