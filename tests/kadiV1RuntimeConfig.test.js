"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FLOW_ENV_KEYS,
  createKadiV1RuntimeConfig,
  parseBoolean,
  resolveConfiguredFlowId,
} = require("../kadiV1RuntimeConfig");

test("Kadi V1 reste désactivé par défaut et aucun Flow n'est codé en dur", () => {
  const config = createKadiV1RuntimeConfig({});
  assert.equal(config.enabled, false);
  assert.ok(Object.values(config.features).every((value) => value === false));
  assert.ok(Object.values(config.flowIds).every((value) => value === null));
  assert.equal(Object.keys(config.flowIds).length, Object.keys(FLOW_ENV_KEYS).length);
});

test("les fonctionnalités sont indépendantes mais restent coupées si le flag global est faux", () => {
  const config = createKadiV1RuntimeConfig({
    KADI_V1_ENABLED: "false",
    KADI_V1_BRAIN_ENABLED: "true",
    KADI_V1_VISION_ENABLED: "true",
  });
  assert.equal(config.features.brain, false);
  assert.equal(config.features.vision, false);
});

test("le flag global active uniquement les fonctionnalités explicitement autorisées", () => {
  const config = createKadiV1RuntimeConfig({
    KADI_V1_ENABLED: "true",
    KADI_V1_BRAIN_ENABLED: "true",
    KADI_V1_VISION_ENABLED: "false",
    KADI_V1_HISTORY_ENABLED: "1",
  });
  assert.equal(config.enabled, true);
  assert.equal(config.features.brain, true);
  assert.equal(config.features.vision, false);
  assert.equal(config.features.history, true);
  assert.equal(config.features.generation, false);
});

test("une valeur booléenne inconnue échoue fermée", () => {
  assert.equal(parseBoolean("peut-être", true), false);
});

test("les IDs Meta sont lus uniquement depuis l'environnement et validés", () => {
  const config = createKadiV1RuntimeConfig({
    KADI_V1_ENABLED: "true",
    KADI_V1_FLOW_MENU_ID: "123456789012345",
    KADI_V1_FLOW_ONBOARDING_ID: "not-an-id",
  });
  assert.equal(config.flowIds.MENU, "123456789012345");
  assert.equal(config.flowIds.ONBOARDING, null);
  assert.deepEqual(resolveConfiguredFlowId(config, "MENU"), { ok: true, value: "123456789012345" });
  assert.deepEqual(resolveConfiguredFlowId(config, "ONBOARDING"), { ok: false, error: "KADI_V1_FLOW_ID_MISSING" });
});

test("KADI_V1_FLOW_ARTICLE_FORM_ID est lu et validé comme les autres IDs Meta (5 à 30 chiffres)", () => {
  assert.equal(FLOW_ENV_KEYS.ARTICLE_FORM, "KADI_V1_FLOW_ARTICLE_FORM_ID");
  const config = createKadiV1RuntimeConfig({
    KADI_V1_ENABLED: "true",
    KADI_V1_FLOW_ARTICLE_FORM_ID: "987654321098765",
  });
  assert.equal(config.flowIds.ARTICLE_FORM, "987654321098765");
  assert.deepEqual(resolveConfiguredFlowId(config, "ARTICLE_FORM"), { ok: true, value: "987654321098765" });

  const invalid = createKadiV1RuntimeConfig({
    KADI_V1_ENABLED: "true",
    KADI_V1_FLOW_ARTICLE_FORM_ID: "123",
  });
  assert.equal(invalid.flowIds.ARTICLE_FORM, null, "moins de 5 chiffres doit être rejeté");
  assert.deepEqual(resolveConfiguredFlowId(invalid, "ARTICLE_FORM"), { ok: false, error: "KADI_V1_FLOW_ID_MISSING" });
});

test("la résolution d'un Flow refuse la V1 désactivée et les clés inconnues", () => {
  const disabled = createKadiV1RuntimeConfig({ KADI_V1_FLOW_MENU_ID: "123456" });
  assert.deepEqual(resolveConfiguredFlowId(disabled, "MENU"), { ok: false, error: "KADI_V1_DISABLED" });
  const enabled = createKadiV1RuntimeConfig({ KADI_V1_ENABLED: "true" });
  assert.deepEqual(resolveConfiguredFlowId(enabled, "UNKNOWN"), { ok: false, error: "KADI_V1_FLOW_KEY_UNKNOWN" });
});
