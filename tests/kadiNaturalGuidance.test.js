"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectBusinessContext,
  detectVagueRequest,
  buildSmartGuidanceMessage,
  isGreetingToKadi,
} = require("../kadiNaturalGuidance");

test("detects vague BTP document requests and guides with examples", () => {
  const result = detectVagueRequest("Fais moi un devis pour une maison");

  assert.equal(result.isVague, true);
  assert.equal(result.reason, "project_estimation_without_items");
  assert.equal(result.context, "btp");
  assert.equal(result.docType, "devis");

  const message = buildSmartGuidanceMessage("Fais moi un devis pour une maison");

  assert.match(message, /Oui, je peux préparer le devis/);
  assert.match(message, /1000 briques/);
  assert.match(message, /20 sacs de ciment/);
  assert.match(message, /Ou en une seule phrase/);
});

test("does not mark a clear line-item request as vague", () => {
  const result = detectVagueRequest("Devis pour Moussa, 2 portes à 25000");

  assert.equal(result.isVague, false);
  assert.equal(result.reason, null);
  assert.equal(result.context, "menuiserie");
  assert.equal(result.docType, "devis");
});

test("detects business context and simple Kadi greetings", () => {
  assert.equal(detectBusinessContext("installation électrique avec prises"), "electricite");
  assert.equal(detectBusinessContext("réparation voiture au garage"), "mecanique");

  assert.equal(isGreetingToKadi("Bonjour Kadi"), true);
  assert.equal(isGreetingToKadi("Bonjour Kadi, fais un devis"), false);
});
