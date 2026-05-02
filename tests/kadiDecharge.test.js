"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDechargePreviewMessage,
  buildDechargeText,
  detectDechargeType,
  initDechargeDraft,
  normalizeDechargeFields,
} = require("../kadiDecharge");
const {
  parseNaturalWhatsAppMessage,
  parseNaturalDechargeMessage,
} = require("../kadiNaturalParser");
const { makeKadiNaturalFlow } = require("../kadiNaturalFlow");

const money = (value) => new Intl.NumberFormat("fr-FR").format(Number(value));

test("parse une decharge objet avec CNI, WhatsApp et valeur", () => {
  const parsed = parseNaturalDechargeMessage(
    [
      "Décharge pour Ali",
      "CNI B1234567",
      "WhatsApp 70112233",
      "Il a reçu une perceuse",
      "Valeur 35000",
    ].join("\n")
  );

  assert.equal(parsed.docType, "decharge");
  assert.equal(parsed.client, "Ali");
  assert.equal(parsed.cni_number, "B1234567");
  assert.equal(parsed.receiver_phone, "70112233");
  assert.equal(parsed.object_label, "perceuse");
  assert.equal(parsed.amount_received, null);
  assert.equal(parsed.object_value, 35000);
});

test("parse une decharge de somme avec motif", () => {
  const parsed = parseNaturalDechargeMessage(
    [
      "Décharge pour Ali",
      "CNI B1234567",
      "Téléphone 70112233",
      "Il a reçu 35000 pour avance travaux",
    ].join("\n")
  );

  assert.equal(parsed.client, "Ali");
  assert.equal(parsed.cni_number, "B1234567");
  assert.equal(parsed.receiver_phone, "70112233");
  assert.equal(parsed.object_label, null);
  assert.equal(parsed.amount_received, 35000);
  assert.equal(parsed.discharge_purpose, "avance travaux");
});

test("parse une decharge mixte objet et somme", () => {
  const parsed = parseNaturalDechargeMessage(
    [
      "Décharge pour Ali",
      "CNI B1234567",
      "WhatsApp 70112233",
      "Il a reçu une perceuse et 35000 pour travaux",
    ].join("\n")
  );

  assert.equal(parsed.client, "Ali");
  assert.equal(parsed.cni_number, "B1234567");
  assert.equal(parsed.receiver_phone, "70112233");
  assert.equal(parsed.object_label, "perceuse");
  assert.equal(parsed.amount_received, 35000);
  assert.equal(parsed.discharge_purpose, "travaux");
});

test("flow decharge prefere le parseur local au NLU OpenAI degradé", async () => {
  const session = {};
  const sentTexts = [];
  let openAiCalls = 0;

  const flow = makeKadiNaturalFlow({
    getSession: () => session,
    sendText: async (_to, text) => sentTexts.push(text),
    sendButtons: async () => {},
    money,
    LIMITS: {
      maxClientNameLength: 80,
      maxItemLabelLength: 120,
    },
    formatDateISO: () => "2026-05-02",
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
    computeBasePdfCost: () => 2,
    formatBaseCostLine: (cost) => `Coût: ${cost}`,
    buildPreviewMessage: () => "",
    sendPreviewMenu: async () => {},
    askItemLabel: async () => {},
    parseNaturalWhatsAppMessage,
    parseNaturalWithOpenAI: async () => {
      openAiCalls += 1;
      return {
        kind: "intent_only",
        docType: "decharge",
        client: "Ali",
        subject: "Perceuse et paiement pour travaux",
        motif: "travaux",
        confidence: 0.9,
      };
    },
    analyzeSmartBlock: () => ({
      businessType: null,
      gapInfo: { gap: 0, severity: "none" },
      hint: null,
    }),
    logLearningEvent: async () => {},
    detectDechargeType,
    buildDechargePreviewMessage,
    initDechargeDraft,
    buildPostConfirmationMessage: () => "",
    parseItemsBlockSmart: () => ({ items: [], ignored: [] }),
    extractBlockTotals: () => ({}),
    buildSmartMismatchMessage: () => ({ warning: false, text: "" }),
    safe: (value) => String(value || "").trim(),
    getOrCreateProfile: async () => ({}),
  });

  const handled = await flow.tryHandleNaturalMessage(
    "22670000000",
    [
      "Décharge pour Ali",
      "CNI B1234567",
      "WhatsApp 70112233",
      "Il a reçu une perceuse et 35000 pour travaux",
    ].join("\n")
  );

  assert.equal(handled, true);
  assert.equal(openAiCalls, 0);
  assert.equal(session.step, "doc_review");
  assert.equal(session.lastDocDraft.cni_number, "B1234567");
  assert.equal(session.lastDocDraft.receiver_phone, "70112233");
  assert.equal(session.lastDocDraft.object_label, "perceuse");
  assert.equal(session.lastDocDraft.amount_received, 35000);
  assert.equal(session.lastDocDraft.discharge_purpose, "travaux");
  assert.equal(session.lastDocDraft.finance.gross, 35000);
  assert.match(sentTexts[0], /CNI \/ Pièce: B1234567/);
  assert.match(sentTexts[0], /Téléphone \/ WhatsApp: 70112233/);
  assert.match(sentTexts[0], /Objet reçu: perceuse/);
  assert.match(sentTexts[0], /Somme reçue: \*35 000 FCFA\*/);
  assert.match(sentTexts[0], /Motif: travaux/);
});

test("construit un aperçu avec seulement les champs disponibles", () => {
  const preview = buildDechargePreviewMessage({
    doc: {
      type: "decharge",
      date: "2026-05-02",
      client: "Ali",
      object_label: "perceuse",
      object_value: 35000,
    },
    money,
  });

  assert.match(preview, /Concerné: Ali/);
  assert.match(preview, /Objet reçu: perceuse/);
  assert.match(preview, /Valeur estimée: \*35 000 FCFA\*/);
  assert.doesNotMatch(preview, /CNI/);
  assert.doesNotMatch(preview, /Téléphone/);
});

test("ne transforme pas le motif d'une somme en objet reçu", () => {
  const preview = buildDechargePreviewMessage({
    doc: {
      type: "decharge",
      date: "2026-05-02",
      client: "Ali",
      subject: "avance travaux",
      motif: "avance travaux",
      dechargeType: "argent",
      amount_received: 35000,
    },
    money,
  });

  assert.match(preview, /Somme reçue: \*35 000 FCFA\*/);
  assert.match(preview, /Motif: avance travaux/);
  assert.doesNotMatch(preview, /Objet reçu/);
});

test("construit le texte PDF d'une somme sans objet implicite", () => {
  const text = buildDechargeText({
    client: "Ali",
    businessName: "Kadi SARL",
    cni_number: "B1234567",
    receiver_phone: "70112233",
    subject: "avance travaux",
    motif: "avance travaux",
    dechargeType: "argent",
    amount_received: 35000,
  });

  assert.match(text, /la somme de 35 000 FCFA\./);
  assert.doesNotMatch(text, /- Objet/);
});

test("construit le texte PDF sans contradiction objet non precise", () => {
  const text = buildDechargeText({
    client: "Ali",
    businessName: "Kadi SARL",
    cni_number: "B1234567",
    receiver_phone: "70112233",
    object_label: "perceuse",
    amount_received: 35000,
    discharge_purpose: "travaux",
  });

  assert.match(text, /Je soussigné\(e\), Ali/);
  assert.match(text, /titulaire de la pièce d’identité N° B1234567/);
  assert.match(text, /joignable au 70112233/);
  assert.match(text, /- Objet : perceuse/);
  assert.match(text, /- Somme : 35 000 FCFA/);
  assert.match(text, /Cette remise est faite pour : travaux\./);
  assert.doesNotMatch(text, /objet non précisé/);
});

test("normalise les alias existants sans inventer les champs absents", () => {
  const fields = normalizeDechargeFields({
    client: "Ali",
    clientPhone: "70112233",
    subject: "perceuse",
    motif: "avance travaux",
  });

  assert.equal(fields.client, "Ali");
  assert.equal(fields.receiver_phone, "70112233");
  assert.equal(fields.object_label, "perceuse");
  assert.equal(fields.discharge_purpose, "avance travaux");
  assert.equal(fields.cni_number, null);
});
