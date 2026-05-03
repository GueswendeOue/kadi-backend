"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeBusinessInput } = require("../kadiLanguageNormalizer");
const { parseNaturalWhatsAppMessage } = require("../kadiNaturalParser");

function parseVoiceTranscript(text) {
  const normalized = normalizeBusinessInput(text, {
    localeHint: "fr-BF",
    languages: ["fr"],
  });

  return parseNaturalWhatsAppMessage(normalized.parseText);
}

test("vocal terrain: devis avec quantite et montants en lettres", () => {
  const parsed = parseVoiceTranscript(
    "Fais-moi un devis pour Moussa, deux portes à vingt-cinq mille chacune et main d’œuvre cinquante mille."
  );

  assert.equal(parsed.docType, "devis");
  assert.equal(parsed.client, "moussa");
  assert.equal(parsed.kind, "items");
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].label, "Porte");
  assert.equal(parsed.items[0].qty, 2);
  assert.equal(parsed.items[0].unitPrice, 25000);
  assert.match(parsed.items[1].label.toLowerCase(), /main d/);
  assert.equal(parsed.items[1].unitPrice, 50000);
});

test("vocal terrain: facture avec paiement en especes", () => {
  const parsed = parseVoiceTranscript(
    "Facture pour Awa, réparation téléphone quinze mille, accessoire cinq mille, payé en espèces."
  );

  assert.equal(parsed.docType, "facture");
  assert.equal(parsed.client, "awa");
  assert.equal(parsed.kind, "items");
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].unitPrice, 15000);
  assert.equal(parsed.items[1].unitPrice, 5000);
  assert.equal(parsed.paid, true);
  assert.equal(parsed.paymentMethod, "espèces");
});

test("vocal terrain: recu avec montant motif et paiement", () => {
  const parsed = parseVoiceTranscript(
    "Reçu pour Ibrahim, il a payé vingt mille pour réparation moto en espèces."
  );

  assert.equal(parsed.docType, "recu");
  assert.equal(parsed.client, "ibrahim");
  assert.equal(parsed.kind, "simple_payment");
  assert.equal(parsed.total, 20000);
  assert.equal(parsed.motif, "reparation moto");
  assert.equal(parsed.paymentMethod, "espèces");
});

test("vocal terrain: decharge structuree avec montant en lettres", () => {
  const parsed = parseVoiceTranscript(
    "Décharge pour Ali, CNI B1234567, WhatsApp 70112233, il a reçu trente-cinq mille pour avance travaux."
  );

  assert.equal(parsed.docType, "decharge");
  assert.equal(parsed.client, "ali");
  assert.equal(parsed.cni_number, "b1234567");
  assert.equal(parsed.receiver_phone, "70112233");
  assert.equal(parsed.amount_received, 35000);
  assert.equal(parsed.discharge_purpose, "avance travaux");
});
