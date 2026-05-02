"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDechargePreviewMessage,
  buildDechargeText,
  normalizeDechargeFields,
} = require("../kadiDecharge");
const {
  parseNaturalDechargeMessage,
} = require("../kadiNaturalParser");

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
  assert.equal(parsed.object_label, "perceuse");
  assert.equal(parsed.amount_received, 35000);
  assert.equal(parsed.discharge_purpose, "travaux");
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
