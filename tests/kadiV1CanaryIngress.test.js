"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_CANARY_OWNERS,
  ROLLOUT_MODES,
  createKadiV1ConversationalMultimodalCanaryConfig,
  createKadiV1RolloutConfig,
  isKadiV1ConversationalMultimodalOwnerAllowed,
  isKadiV1OwnerAllowed,
  parseCanaryOwnerList,
} = require("../kadiV1CanaryIngress");
const { createKadiV1RuntimeConfig } = require("../kadiV1RuntimeConfig");

test("rollout stays OFF by default and exposes no owner", () => {
  const rollout = createKadiV1RolloutConfig({});
  assert.equal(rollout.mode, ROLLOUT_MODES.OFF);
  assert.equal(rollout.valid, true);
  assert.equal(rollout.canaryOwnerCount, 0);
  assert.deepEqual(rollout.canaryWaIds, []);
});

test("canary list accepts separators, removes plus and deduplicates", () => {
  const parsed = parseCanaryOwnerList("+22670000000, 22671111111;22670000000");
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.owners, ["22670000000", "22671111111"]);
});

test("CANARY mode requires at least one valid WhatsApp owner", () => {
  const empty = createKadiV1RolloutConfig({ KADI_V1_ROLLOUT_MODE: "CANARY" });
  assert.equal(empty.valid, false);
  assert.equal(empty.error, "KADI_V1_CANARY_OWNER_REQUIRED");

  const invalid = createKadiV1RolloutConfig({
    KADI_V1_ROLLOUT_MODE: "CANARY",
    KADI_V1_CANARY_WA_IDS: "not-a-number",
  });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.error, "KADI_V1_CANARY_OWNER_INVALID");
});

test("unknown rollout mode fails closed to OFF", () => {
  const rollout = createKadiV1RolloutConfig({ KADI_V1_ROLLOUT_MODE: "gradual" });
  assert.equal(rollout.mode, ROLLOUT_MODES.OFF);
  assert.equal(rollout.valid, false);
  assert.equal(rollout.error, "KADI_V1_ROLLOUT_MODE_INVALID");
});

test("canary list enforces a small bounded recipient set", () => {
  const owners = Array.from({ length: MAX_CANARY_OWNERS + 1 }, (_, index) => `2267${String(index).padStart(7, "0")}`);
  const parsed = parseCanaryOwnerList(owners.join(","));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "KADI_V1_CANARY_OWNER_LIMIT_EXCEEDED");
});

test("owner access is deterministic for OFF, CANARY and FULL", () => {
  const canary = createKadiV1RolloutConfig({
    KADI_V1_ROLLOUT_MODE: "CANARY",
    KADI_V1_CANARY_WA_IDS: "22670000000",
  });
  const full = createKadiV1RolloutConfig({ KADI_V1_ROLLOUT_MODE: "FULL" });
  const off = createKadiV1RolloutConfig({});

  assert.equal(isKadiV1OwnerAllowed(canary, "22670000000"), true);
  assert.equal(isKadiV1OwnerAllowed(canary, "22671111111"), false);
  assert.equal(isKadiV1OwnerAllowed(full, "22671111111"), true);
  assert.equal(isKadiV1OwnerAllowed(off, "22670000000"), false);
});

test("runtime configuration carries the rollout decision without logging values", () => {
  const config = createKadiV1RuntimeConfig({
    KADI_V1_ENABLED: "true",
    KADI_V1_WEBHOOK_ENABLED: "true",
    KADI_V1_ROLLOUT_MODE: "CANARY",
    KADI_V1_CANARY_WA_IDS: "22670000000",
  });
  assert.equal(config.rollout.mode, "CANARY");
  assert.equal(config.rollout.valid, true);
  assert.equal(config.rollout.canaryOwnerCount, 1);
  assert.deepEqual(config.rollout.canaryWaIds, ["22670000000"]);
});

// --- KADI_CONVERSATIONAL_MULTIMODAL_V1's independent allowlist ---

test("l'allowlist conversationnelle est vide par défaut, pas une erreur", () => {
  const config = createKadiV1ConversationalMultimodalCanaryConfig({});
  assert.equal(config.valid, true);
  assert.equal(config.ownerCount, 0);
  assert.deepEqual(config.waIds, []);
});

test("l'allowlist conversationnelle n'hérite jamais implicitement de KADI_V1_CANARY_WA_IDS", () => {
  const config = createKadiV1ConversationalMultimodalCanaryConfig({
    KADI_V1_CANARY_WA_IDS: "22670000000",
  });
  assert.equal(config.ownerCount, 0, "seule KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS doit compter");
});

test("un numéro malformé dans l'allowlist conversationnelle échoue fermé", () => {
  const config = createKadiV1ConversationalMultimodalCanaryConfig({
    KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS: "not-a-number",
  });
  assert.equal(config.valid, false);
  assert.equal(isKadiV1ConversationalMultimodalOwnerAllowed(config, "22670000000"), false);
});

test("un propriétaire explicitement listé est autorisé, tout autre non", () => {
  const config = createKadiV1ConversationalMultimodalCanaryConfig({
    KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS: "22670000000, 22671111111",
  });
  assert.equal(isKadiV1ConversationalMultimodalOwnerAllowed(config, "22670000000"), true);
  assert.equal(isKadiV1ConversationalMultimodalOwnerAllowed(config, "22679999999"), false);
});

test("un identifiant invalide ou vide n'est jamais autorisé", () => {
  const config = createKadiV1ConversationalMultimodalCanaryConfig({
    KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS: "22670000000",
  });
  assert.equal(isKadiV1ConversationalMultimodalOwnerAllowed(config, ""), false);
  assert.equal(isKadiV1ConversationalMultimodalOwnerAllowed(config, null), false);
  assert.equal(isKadiV1ConversationalMultimodalOwnerAllowed(config, "abc"), false);
});
