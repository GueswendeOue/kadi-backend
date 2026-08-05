"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FEATURE_ENV_KEYS,
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

test("KADI_V1_FLOW_INVOICE_TYPE_ID est lu et validé comme les autres IDs Meta, et échoue fermé si absent", () => {
  assert.equal(FLOW_ENV_KEYS.INVOICE_TYPE, "KADI_V1_FLOW_INVOICE_TYPE_ID");
  const config = createKadiV1RuntimeConfig({
    KADI_V1_ENABLED: "true",
    KADI_V1_FLOW_INVOICE_TYPE_ID: "555666777888999",
  });
  assert.equal(config.flowIds.INVOICE_TYPE, "555666777888999");
  assert.deepEqual(resolveConfiguredFlowId(config, "INVOICE_TYPE"), { ok: true, value: "555666777888999" });

  const missing = createKadiV1RuntimeConfig({ KADI_V1_ENABLED: "true" });
  assert.equal(missing.flowIds.INVOICE_TYPE, null);
  assert.deepEqual(resolveConfiguredFlowId(missing, "INVOICE_TYPE"), { ok: false, error: "KADI_V1_FLOW_ID_MISSING" });
});

test("KADI_CONVERSATIONAL_MULTIMODAL_V1_ENABLED et KADI_GEMINI_AUDIO_V1_ENABLED sont enregistrés, indépendants et désactivés par défaut", () => {
  assert.equal(FEATURE_ENV_KEYS.conversationalMultimodalV1, "KADI_CONVERSATIONAL_MULTIMODAL_V1_ENABLED");
  assert.equal(FEATURE_ENV_KEYS.geminiAudioV1, "KADI_GEMINI_AUDIO_V1_ENABLED");
  const off = createKadiV1RuntimeConfig({ KADI_V1_ENABLED: "true" });
  assert.equal(off.features.conversationalMultimodalV1, false);
  assert.equal(off.features.geminiAudioV1, false);
  const on = createKadiV1RuntimeConfig({
    KADI_V1_ENABLED: "true",
    KADI_CONVERSATIONAL_MULTIMODAL_V1_ENABLED: "true",
  });
  assert.equal(on.features.conversationalMultimodalV1, true, "peut être activé indépendamment");
  assert.equal(on.features.geminiAudioV1, false, "l'audio Gemini reste désactivé tant qu'il n'est pas explicitement activé");
});

test("KADI_CONVERSATIONAL_MULTIMODAL_V1_ENABLED suit exactement la convention établie pour absent/vide/false/FALSE/0/malformé/true", () => {
  const cases = [
    [undefined, false],
    ["", false],
    ["false", false],
    ["FALSE", false],
    ["0", false],
    ["peut-etre", false],
    ["true", true],
    ["TRUE", true],
    ["1", true],
  ];
  for (const [raw, expected] of cases) {
    const env = { KADI_V1_ENABLED: "true" };
    if (raw !== undefined) env.KADI_CONVERSATIONAL_MULTIMODAL_V1_ENABLED = raw;
    const config = createKadiV1RuntimeConfig(env);
    assert.equal(config.features.conversationalMultimodalV1, expected, `raw=${JSON.stringify(raw)}`);
  }
});

test("KADI_GEMINI_AUDIO_V1_ENABLED exige les deux portes : le flag global ET le flag spécifique", () => {
  const globalOffFlagOn = createKadiV1RuntimeConfig({
    KADI_V1_ENABLED: "false",
    KADI_GEMINI_AUDIO_V1_ENABLED: "true",
  });
  assert.equal(globalOffFlagOn.features.geminiAudioV1, false, "le flag global faux doit couper même si le flag spécifique est vrai");

  const globalOnFlagOn = createKadiV1RuntimeConfig({
    KADI_V1_ENABLED: "true",
    KADI_GEMINI_AUDIO_V1_ENABLED: "true",
  });
  assert.equal(globalOnFlagOn.features.geminiAudioV1, true, "les deux portes vraies activent la fonctionnalité");
});

test("les routes fournisseur actuelles ne changent pas tant que les nouveaux flags sont faux", () => {
  const withoutFlags = createKadiV1RuntimeConfig({ KADI_V1_ENABLED: "true", KADI_V1_BRAIN_ENABLED: "true" });
  const withNewFlagsFalse = createKadiV1RuntimeConfig({
    KADI_V1_ENABLED: "true",
    KADI_V1_BRAIN_ENABLED: "true",
    KADI_CONVERSATIONAL_MULTIMODAL_V1_ENABLED: "false",
    KADI_GEMINI_AUDIO_V1_ENABLED: "false",
  });
  assert.deepEqual(withoutFlags.features, withNewFlagsFalse.features);
});

test("la résolution d'un Flow refuse la V1 désactivée et les clés inconnues", () => {
  const disabled = createKadiV1RuntimeConfig({ KADI_V1_FLOW_MENU_ID: "123456" });
  assert.deepEqual(resolveConfiguredFlowId(disabled, "MENU"), { ok: false, error: "KADI_V1_DISABLED" });
  const enabled = createKadiV1RuntimeConfig({ KADI_V1_ENABLED: "true" });
  assert.deepEqual(resolveConfiguredFlowId(enabled, "UNKNOWN"), { ok: false, error: "KADI_V1_FLOW_KEY_UNKNOWN" });
});
