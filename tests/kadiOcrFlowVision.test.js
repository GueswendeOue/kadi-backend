"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeKadiOcrFlow } = require("../kadiOcrFlow");

function makeItem(label, qty, unitPrice) {
  const safeQty = Number(qty || 1);
  const safeUnitPrice = Number(unitPrice || 0);
  return {
    label: String(label || "").trim(),
    qty: safeQty,
    unitPrice: safeUnitPrice,
    amount: Math.round(safeQty * safeUnitPrice),
  };
}

function computeFinance(draft) {
  const gross = (draft.items || []).reduce(
    (sum, item) => sum + Number(item.amount || 0),
    0
  );
  return { gross, total: gross, subtotal: gross };
}

function makeFlow({ visionResult }) {
  const session = {};
  const calls = [];

  const flow = makeKadiOcrFlow({
    getSession: () => session,
    sendText: async (to, text) => calls.push({ kind: "text", to, text }),
    sendButtons: async (to, text, buttons) =>
      calls.push({ kind: "buttons", to, text, buttons }),
    getMediaInfo: async () => ({
      url: "https://example.test/ocr-image.jpg",
      mime_type: "image/jpeg",
      file_size: 1234,
    }),
    downloadMediaToBuffer: async () => Buffer.from("fake-image"),
    LIMITS: {
      maxImageSize: 5_000_000,
      maxOcrRetries: 1,
      maxItems: 50,
      maxClientNameLength: 80,
    },
    formatDateISO: () => "2026-05-22",
    sleep: async () => {},
    makeDraftMeta: (overrides = {}) => ({
      usedGeminiParse: false,
      ...overrides,
    }),
    makeItem,
    computeFinance,
    normalizeAndValidateDraft: (draft) => ({
      ok: true,
      draft: {
        ...draft,
        finance: draft.finance || computeFinance(draft),
      },
      issues: [],
    }),
    buildPreviewMessage: ({ doc }) =>
      `PREVIEW ${doc.items.map((it) => it.label).join(" | ")}`,
    computeBasePdfCost: () => 2,
    formatBaseCostLine: () => "COST",
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    safe: (value) => String(value || "").trim(),
    sendPreviewMenu: async (to, draft) =>
      calls.push({ kind: "previewMenu", to, draft }),
    ocrImageToText: async () => visionResult,
    parseInvoiceTextWithGemini: null,
    parseNumberSmart: (value) => {
      const n = Number(String(value || "").replace(/\s+/g, ""));
      return Number.isFinite(n) ? n : null;
    },
    sanitizeOcrLabel: (value) => String(value || "").trim(),
    looksLikeRealItemLabel: (value) => /[a-zA-ZÀ-ÿ]/.test(String(value || "")),
  });

  return { calls, flow, session };
}

test("OCR vision JSON preserves table labels, units and totals", async () => {
  const visionResult = {
    kind: "vision_json",
    text: "TYPE: devis\nTOTAL: 756750",
    parsed: {
      docType: "devis",
      client: "Moussa",
      detectedTotal: 756750,
      warnings: [],
      items: [
        {
          label: "Batterie lithium 2.5KWH",
          quantity: 1,
          unit: null,
          unitPrice: 250000,
          lineTotal: 250000,
        },
        {
          label: "Convertisseur hybride 3KVA",
          quantity: 1,
          unit: null,
          unitPrice: 200500,
          lineTotal: 200500,
        },
        {
          label: "Câble",
          quantity: 15,
          unit: "m",
          unitPrice: 1750,
          lineTotal: 26250,
        },
        {
          label: "Panneaux 450W",
          quantity: 4,
          unit: null,
          unitPrice: 70000,
          lineTotal: 280000,
        },
      ],
    },
  };

  const { calls, flow, session } = makeFlow({ visionResult });
  await flow.processOcrImageToDraft("22670000000", "media-1");

  assert.equal(session.step, "doc_review");
  assert.equal(session.lastDocDraft.client, "Moussa");
  assert.equal(session.lastDocDraft.meta.usedOpenAIVisionJson, true);
  assert.equal(session.lastDocDraft.meta.ocrDetectedTotal, 756750);
  assert.equal(session.lastDocDraft.finance.gross, 756750);

  const items = session.lastDocDraft.items;
  assert.equal(items[0].label, "Batterie lithium 2.5KWH");
  assert.equal(items[1].label, "Convertisseur hybride 3KVA");
  assert.equal(items[2].label, "Câble");
  assert.equal(items[2].qty, 15);
  assert.equal(items[2].unit, "m");
  assert.equal(items[2].unitPrice, 1750);
  assert.equal(items[2].lineTotal, 26250);
  assert.equal(items[3].label, "Panneaux 450W");
  assert.equal(items[3].qty, 4);
  assert.equal(items[3].unitPrice, 70000);
  assert.equal(items[3].lineTotal, 280000);

  assert.ok(calls.some((call) => call.kind === "previewMenu"));
});

test("OCR vision JSON warns and blocks direct generation when total differs", async () => {
  const visionResult = {
    kind: "vision_json",
    text: "TYPE: devis\nTOTAL: 756750",
    parsed: {
      docType: "devis",
      client: "Moussa",
      detectedTotal: 756750,
      warnings: [],
      items: [
        {
          label: "Batterie lithium 2.5KWH",
          quantity: 1,
          unitPrice: 240000,
          lineTotal: 240000,
        },
        {
          label: "Convertisseur hybride 3KVA",
          quantity: 1,
          unitPrice: 200500,
          lineTotal: 200500,
        },
        {
          label: "Câble",
          quantity: 15,
          unit: "m",
          unitPrice: 1750,
          lineTotal: 26250,
        },
        {
          label: "Panneaux 450W",
          quantity: 4,
          unitPrice: 70000,
          lineTotal: 280000,
        },
      ],
    },
  };

  const { calls, flow, session } = makeFlow({ visionResult });
  await flow.processOcrImageToDraft("22670000000", "media-1");

  assert.equal(session.step, "doc_review");
  assert.equal(session.lastDocDraft.meta.ocrTotalMismatch, true);
  assert.equal(session.lastDocDraft.meta.ocrComputedTotal, 746750);
  assert.equal(session.lastDocDraft.meta.ocrDetectedTotal, 756750);

  const warning = calls.find(
    (call) => call.kind === "text" && call.text.includes("Je ne suis pas sûr du total")
  );
  assert.ok(warning);
  assert.match(warning.text, /J’ai calculé 746750 FCFA/);
  assert.match(warning.text, /l’image indique 756750 FCFA/);
});
