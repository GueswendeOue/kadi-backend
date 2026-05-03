"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeKadiNaturalFlow } = require("../kadiNaturalFlow");
const { parseNaturalWhatsAppMessage } = require("../kadiNaturalParser");
const { normalizeBusinessInput } = require("../kadiLanguageNormalizer");

test("natural flow prefers local item parse over degraded OpenAI client extraction", async () => {
  const session = {};
  let openAiCalls = 0;

  const flow = makeKadiNaturalFlow({
    getSession: () => session,
    sendText: async () => {},
    sendButtons: async () => {},
    money: (value) => String(value),
    LIMITS: {
      maxClientNameLength: 80,
      maxItemLabelLength: 120,
    },
    formatDateISO: () => "2026-05-03",
    makeDraftMeta: (overrides = {}) => ({ ...overrides }),
    makeItem: (label, qty, unitPrice) => ({
      label,
      qty,
      unitPrice,
      amount: Math.round(Number(qty || 0) * Number(unitPrice || 0)),
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
    buildPreviewMessage: () => "preview",
    sendPreviewMenu: async () => {},
    askItemLabel: async () => {},
    parseNaturalWhatsAppMessage,
    parseNaturalWithOpenAI: async () => {
      openAiCalls += 1;
      return {
        kind: "items",
        docType: "facture",
        client:
          "fais-moi une facture pour awa, une facture pour awa, réparation de téléphone 15",
        items: [
          { label: "Réparation de téléphone", qty: 1, unitPrice: 15000 },
          { label: "Accessoires", qty: 1, unitPrice: 5000 },
        ],
      };
    },
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

  const normalized = normalizeBusinessInput(
    "fais-moi une facture pour awa, une facture pour awa, réparation de téléphone quinze mille, accessoires cinq mille, payé en espèces",
    { languages: ["fr"] }
  ).parseText;

  const handled = await flow.tryHandleNaturalMessage("22670000000", normalized);

  assert.equal(handled, true);
  assert.equal(openAiCalls, 0);
  assert.equal(session.step, "doc_review");
  assert.equal(session.lastDocDraft.type, "facture");
  assert.equal(session.lastDocDraft.client, "awa");
  assert.equal(session.lastDocDraft.items.length, 2);
  assert.equal(session.lastDocDraft.finance.gross, 20000);
});
