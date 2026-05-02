"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseNaturalWhatsAppMessage,
} = require("../kadiNaturalParser");

function lineTotal(item) {
  return Number(item.qty || 0) * Number(item.unitPrice || 0);
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
