"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseNaturalWhatsAppMessage,
} = require("../kadiNaturalParser");
const { normalizeBusinessInput } = require("../kadiLanguageNormalizer");

function lineTotal(item) {
  return Number(item.qty || 0) * Number(item.unitPrice || 0);
}

function parseTerrainVoice(text) {
  const normalized = normalizeBusinessInput(text, {
    localeHint: "fr-BF",
    languages: ["fr"],
  });

  return parseNaturalWhatsAppMessage(normalized.parseText);
}

test("terrain: parse un devis multi-ligne avec client et service", () => {
  const parsed = parseNaturalWhatsAppMessage(
    [
      "Devis pour Moussa",
      "2 portes à 25000",
      "Main d’œuvre à 50000",
    ].join("\n")
  );

  assert.equal(parsed.docType, "devis");
  assert.equal(parsed.client, "Moussa");
  assert.equal(parsed.kind, "items");
  assert.equal(parsed.items.length, 2);

  assert.equal(parsed.items[0].label, "Porte");
  assert.equal(parsed.items[0].qty, 2);
  assert.equal(parsed.items[0].unitPrice, 25000);

  assert.equal(parsed.items[1].label, "Main d’œuvre");
  assert.equal(parsed.items[1].qty, 1);
  assert.equal(parsed.items[1].unitPrice, 50000);
});

test("terrain: parse un devis compact avec deux lignes", () => {
  const parsed = parseNaturalWhatsAppMessage(
    "Fais-moi un devis pour Moussa avec 2 portes à 25000 et main d’œuvre 50000"
  );

  assert.equal(parsed.docType, "devis");
  assert.equal(parsed.client, "Moussa");
  assert.equal(parsed.kind, "items");
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].qty, 2);
  assert.equal(parsed.items[0].unitPrice, 25000);
  assert.equal(parsed.items[1].qty, 1);
  assert.equal(parsed.items[1].unitPrice, 50000);
  assert.equal(parsed.items.reduce((sum, item) => sum + lineTotal(item), 0), 100000);
});

test("terrain: parse une facture multi-ligne sans fusionner le paiement", () => {
  const parsed = parseNaturalWhatsAppMessage(
    [
      "Facture pour Awa",
      "Réparation téléphone 15000",
      "Accessoire 5000",
      "Payé en espèces",
    ].join("\n")
  );

  assert.equal(parsed.docType, "facture");
  assert.equal(parsed.client, "Awa");
  assert.equal(parsed.kind, "items");
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].label, "Réparation téléphone");
  assert.equal(parsed.items[0].qty, 1);
  assert.equal(parsed.items[0].unitPrice, 15000);
  assert.equal(parsed.items[1].label, "Accessoire");
  assert.equal(parsed.items[1].qty, 1);
  assert.equal(parsed.items[1].unitPrice, 5000);
  assert.equal(parsed.paymentMethod, "espèces");
  assert.equal(parsed.paid, true);
});

test("terrain: parse un reçu avec client, motif, montant et paiement", () => {
  const parsed = parseNaturalWhatsAppMessage(
    [
      "Reçu pour Ibrahim",
      "Paiement de 20000 pour réparation moto",
      "Payé en espèces",
    ].join("\n")
  );

  assert.equal(parsed.docType, "recu");
  assert.equal(parsed.client, "Ibrahim");
  assert.equal(parsed.kind, "simple_payment");
  assert.equal(parsed.total, 20000);
  assert.equal(parsed.motif, "réparation moto");
  assert.equal(parsed.paymentMethod, "espèces");
  assert.equal(parsed.paid, true);
});

test("terrain vocal: extraction client generale avant prestations", () => {
  const factureRepeated = parseTerrainVoice(
    "fais-moi une facture pour Awa, une facture pour Awa, réparation de téléphone quinze mille, accessoires cinq mille, payé en espèces"
  );

  assert.equal(factureRepeated.docType, "facture");
  assert.equal(factureRepeated.client, "awa");
  assert.equal(factureRepeated.items.length, 2);
  assert.equal(factureRepeated.items[0].unitPrice, 15000);
  assert.equal(factureRepeated.items[1].unitPrice, 5000);
  assert.equal(factureRepeated.paid, true);
  assert.equal(factureRepeated.paymentMethod, "espèces");

  const factureServices = parseTerrainVoice(
    "fais-moi une facture pour Moussa, pose climatiseur vingt-cinq mille, déplacement cinq mille"
  );

  assert.equal(factureServices.docType, "facture");
  assert.equal(factureServices.client, "moussa");
  assert.equal(factureServices.items.length, 2);
  assert.equal(factureServices.items[0].unitPrice, 25000);
  assert.equal(factureServices.items[1].unitPrice, 5000);

  const devis = parseTerrainVoice(
    "fais-moi un devis pour Salif avec 2 fenêtres à 30000 et main d’œuvre 10000"
  );

  assert.equal(devis.docType, "devis");
  assert.equal(devis.client, "salif");
  assert.equal(devis.items.length, 2);
  assert.equal(devis.items[0].qty, 2);
  assert.equal(devis.items[0].unitPrice, 30000);
  assert.equal(devis.items[1].unitPrice, 10000);

  const recu = parseTerrainVoice(
    "reçu pour Ibrahim, paiement de vingt mille pour réparation moto en espèces"
  );

  assert.equal(recu.docType, "recu");
  assert.equal(recu.client, "ibrahim");
  assert.equal(recu.total, 20000);
  assert.equal(recu.motif, "reparation moto");
  assert.equal(recu.paymentMethod, "espèces");

  const factureBoutique = parseTerrainVoice(
    "facture pour Boutique Wend-Panga, 3 sacs de ciment à 5000, transport 2000"
  );

  assert.equal(factureBoutique.docType, "facture");
  assert.equal(factureBoutique.client, "boutique wend-panga");
  assert.equal(factureBoutique.items.length, 2);
  assert.equal(factureBoutique.items[0].qty, 3);
  assert.equal(factureBoutique.items[0].unitPrice, 5000);
  assert.equal(factureBoutique.items[1].label, "Transport");
  assert.equal(factureBoutique.items[1].unitPrice, 2000);
});
