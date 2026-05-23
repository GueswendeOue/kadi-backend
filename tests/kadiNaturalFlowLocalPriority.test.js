"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeKadiNaturalFlow } = require("../kadiNaturalFlow");
const { parseNaturalWhatsAppMessage } = require("../kadiNaturalParser");

function makeFlow({ parseNaturalWithOpenAI }) {
  const session = {};
  const calls = [];

  const flow = makeKadiNaturalFlow({
    getSession: () => session,
    sendText: async (to, text) => calls.push({ kind: "text", to, text }),
    sendButtons: async (to, text, buttons) =>
      calls.push({ kind: "buttons", to, text, buttons }),
    money: (value) => String(value),
    LIMITS: {
      maxClientNameLength: 80,
      maxItemLabelLength: 120,
    },
    formatDateISO: () => "2026-05-23",
    makeDraftMeta: (overrides = {}) => ({ ...overrides }),
    makeItem: (label, qty, unitPrice) => ({
      label,
      qty: Number(qty || 1),
      unitPrice: Number(unitPrice || 0),
      amount: Math.round(Number(qty || 1) * Number(unitPrice || 0)),
    }),
    computeFinance: (draft) => {
      const gross = (draft.items || []).reduce(
        (sum, item) => sum + Number(item.amount || 0),
        0
      );
      draft.finance = { gross, total: gross, subtotal: gross };
      return draft.finance;
    },
    computeBasePdfCost: () => 1,
    formatBaseCostLine: () => "Coût: 1",
    buildPreviewMessage: ({ doc }) =>
      `preview:${doc.items.map((item) => item.label).join("|")}`,
    sendPreviewMenu: async (to, draft) =>
      calls.push({ kind: "previewMenu", to, draft }),
    askItemLabel: async (to) => calls.push({ kind: "askItemLabel", to }),
    parseNaturalWhatsAppMessage,
    parseNaturalWithOpenAI,
    analyzeSmartBlock: () => ({
      businessType: null,
      gapInfo: { gap: 0, severity: "none" },
      hint: null,
    }),
    logLearningEvent: async () => {},
    detectDechargeType: () => null,
    buildDechargePreviewMessage: () => "",
    initDechargeDraft: () => ({}),
    buildPostConfirmationMessage: () => "",
    parseItemsBlockSmart: () => ({ items: [], ignored: [] }),
    extractBlockTotals: () => ({}),
    buildSmartMismatchMessage: () => ({ warning: false, text: "" }),
    safe: (value) => String(value || "").trim(),
    getOrCreateProfile: async () => ({}),
  });

  return { calls, flow, session };
}

test("natural business text uses OpenAI before local parser", async () => {
  let openAiCalls = 0;
  const { flow, session } = makeFlow({
    parseNaturalWithOpenAI: async () => {
      openAiCalls += 1;
      return {
        kind: "items",
        documentType: "devis",
        docType: "devis",
        client: "Madi",
        items: [
          { label: "Lampe 120", qty: 5, quantity: 5, unitPrice: 1500, lineTotal: 7500 },
          { label: "Coca Cola", qty: 10, quantity: 10, unitPrice: 300, lineTotal: 3000 },
          { label: "Main d’œuvre", qty: 1, quantity: 1, unitPrice: 5000, lineTotal: 5000 },
        ],
        total: 15500,
        paid: false,
        paymentMethod: null,
        warnings: [],
        confidence: 0.94,
      };
    },
  });

  const handled = await flow.tryHandleNaturalMessage(
    "22670000000",
    ["Devis pour Madi", "lampe 120 5 1500", "coca cola 10 300", "main d’œuvre 5000"].join("\n")
  );

  assert.equal(handled, true);
  assert.equal(openAiCalls, 1);
  assert.equal(session.step, "doc_review");
  assert.equal(session.lastDocDraft.meta.nluSource, "openai");
  assert.equal(session.lastDocDraft.client, "Madi");
  assert.deepEqual(
    session.lastDocDraft.items.map((item) => [item.label, item.qty, item.unitPrice]),
    [
      ["Lampe 120", 5, 1500],
      ["Coca Cola", 10, 300],
      ["Main d’œuvre", 1, 5000],
    ]
  );
  assert.equal(session.lastDocDraft.finance.gross, 15500);
});

test("simple local commands do not call OpenAI from natural flow", async () => {
  let openAiCalls = 0;
  const { flow } = makeFlow({
    parseNaturalWithOpenAI: async () => {
      openAiCalls += 1;
      return null;
    },
  });

  assert.equal(await flow.tryHandleNaturalMessage("22670000000", "menu"), false);
  assert.equal(await flow.tryHandleNaturalMessage("22670000000", "solde"), false);
  assert.equal(openAiCalls, 0);
});

test("OpenAI natural parse preserves technical digits and payment metadata", async () => {
  const { flow, session } = makeFlow({
    parseNaturalWithOpenAI: async (text) => {
      if (text.includes("batterie")) {
        return {
          kind: "items",
          documentType: "devis",
          docType: "devis",
          client: "Client",
          items: [
            { label: "Batterie lithium 2.5KWH", qty: 1, quantity: 1, unitPrice: 270000, lineTotal: 270000 },
            { label: "Panneaux 450W", qty: 4, quantity: 4, unitPrice: 70000, lineTotal: 280000 },
          ],
          total: 550000,
          paid: false,
          paymentMethod: null,
          warnings: [],
          confidence: 0.95,
        };
      }

      return {
        kind: "items",
        documentType: "facture",
        docType: "facture",
        client: "Awa",
        items: [
          { label: "Réparation téléphone", qty: 1, quantity: 1, unitPrice: 15000, lineTotal: 15000 },
          { label: "Accessoire", qty: 1, quantity: 1, unitPrice: 5000, lineTotal: 5000 },
        ],
        total: 20000,
        paid: true,
        paymentMethod: "espèces",
        warnings: [],
        confidence: 0.93,
      };
    },
  });

  await flow.tryHandleNaturalMessage(
    "22670000000",
    "batterie lithium 2.5KWH 1 270000\npanneaux 450W 4 70000"
  );

  assert.equal(session.lastDocDraft.items[0].label, "Batterie lithium 2.5KWH");
  assert.equal(session.lastDocDraft.items[1].label, "Panneaux 450W");

  session.lastDocDraft = null;
  session.step = null;

  await flow.tryHandleNaturalMessage(
    "22670000000",
    "Facture pour Awa réparation téléphone 15000 accessoire 5000 payé en espèces"
  );

  assert.equal(session.lastDocDraft.type, "facture");
  assert.equal(session.lastDocDraft.client, "Awa");
  assert.equal(session.lastDocDraft.paid, true);
  assert.equal(session.lastDocDraft.paymentMethod, "espèces");
  assert.equal(session.lastDocDraft.finance.gross, 20000);
});

test("natural OpenAI total mismatch blocks preview confirmation path", async () => {
  const { calls, flow, session } = makeFlow({
    parseNaturalWithOpenAI: async () => ({
      kind: "items",
      documentType: "devis",
      docType: "devis",
      client: "Madi",
      items: [
        { label: "Lampe", qty: 5, quantity: 5, unitPrice: 1500, lineTotal: 7500 },
        { label: "Coca Cola", qty: 10, quantity: 10, unitPrice: 300, lineTotal: 3000 },
      ],
      total: 20000,
      paid: false,
      paymentMethod: null,
      warnings: [],
      confidence: 0.9,
    }),
  });

  const handled = await flow.tryHandleNaturalMessage(
    "22670000000",
    "Devis pour Madi lampe 5 1500 coca cola 10 300 total 20000"
  );

  assert.equal(handled, true);
  assert.notEqual(session.step, "doc_review");
  assert.equal(session.lastDocDraft.meta.nluDetectedTotal, 20000);
  assert.ok(calls.some((call) => call.kind === "text" && call.text.includes("revérifier")));
  assert.equal(calls.some((call) => call.kind === "previewMenu"), false);
});
