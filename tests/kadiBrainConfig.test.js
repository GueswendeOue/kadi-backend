"use strict";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-openai-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BRAIN_MODES,
  normalizeBrainMode,
  parseLegacyShadowFlag,
  resolveBrainMode,
  isShadowObservationEnabled,
} = require("../kadiBrainConfig");
const { makeKadiBrainShadow } = require("../kadiBrainShadow");

test("defines and normalizes the five exact Brain modes", () => {
  assert.deepEqual(Object.values(BRAIN_MODES), [
    "off",
    "shadow",
    "candidate",
    "active_allowlist",
    "active",
  ]);

  for (const mode of Object.values(BRAIN_MODES)) {
    assert.equal(normalizeBrainMode(mode), mode);
    assert.equal(normalizeBrainMode(`  ${mode.toUpperCase()}  `), mode);
  }

  assert.equal(normalizeBrainMode("active-allowlist"), null);
  assert.equal(normalizeBrainMode("unknown"), null);
  assert.equal(normalizeBrainMode(null), null);
});

test("defaults to off when configuration is absent or invalid", () => {
  assert.equal(resolveBrainMode({}), BRAIN_MODES.OFF);
  assert.equal(resolveBrainMode(null), BRAIN_MODES.OFF);
  assert.equal(
    resolveBrainMode({ KADI_BRAIN_SHADOW_ENABLED: "invalid" }),
    BRAIN_MODES.OFF
  );
});

test("preserves every historically true shadow flag", () => {
  for (const value of ["1", "true", "TRUE", " yes ", "On"]) {
    assert.equal(parseLegacyShadowFlag(value), true, value);
    assert.equal(
      resolveBrainMode({ KADI_BRAIN_SHADOW_ENABLED: value }),
      BRAIN_MODES.SHADOW,
      value
    );
  }
});

test("treats all other legacy flag values as off", () => {
  for (const value of ["0", "false", "no", "off", "invalid", "", null]) {
    assert.equal(parseLegacyShadowFlag(value), false, String(value));
    assert.equal(
      resolveBrainMode({ KADI_BRAIN_SHADOW_ENABLED: value }),
      BRAIN_MODES.OFF,
      String(value)
    );
  }
});

test("new valid mode takes priority over the legacy flag", () => {
  for (const mode of Object.values(BRAIN_MODES)) {
    assert.equal(
      resolveBrainMode({
        KADI_BRAIN_MODE: ` ${mode.toUpperCase()} `,
        KADI_BRAIN_SHADOW_ENABLED: mode === "shadow" ? "false" : "true",
      }),
      mode
    );
  }
});

test("invalid non-empty new mode fails closed without legacy fallback", () => {
  for (const value of ["shdow", "enabled", "production"]) {
    assert.equal(
      resolveBrainMode({
        KADI_BRAIN_MODE: value,
        KADI_BRAIN_SHADOW_ENABLED: "true",
      }),
      BRAIN_MODES.OFF,
      value
    );
  }
});

test("empty new mode still permits legacy fallback", () => {
  for (const value of ["", "   "]) {
    assert.equal(
      resolveBrainMode({
        KADI_BRAIN_MODE: value,
        KADI_BRAIN_SHADOW_ENABLED: " true ",
      }),
      BRAIN_MODES.SHADOW
    );
  }
});

test("only shadow mode enables shadow observation", () => {
  for (const mode of Object.values(BRAIN_MODES)) {
    assert.equal(
      isShadowObservationEnabled(mode),
      mode === BRAIN_MODES.SHADOW,
      mode
    );
  }
  assert.equal(isShadowObservationEnabled("invalid"), false);
});

test("future modes stay operationally disabled in the Shadow factory", async () => {
  const previousMode = process.env.KADI_BRAIN_MODE;
  const previousLegacy = process.env.KADI_BRAIN_SHADOW_ENABLED;
  let calls = 0;
  const provider = {
    understand: async () => {
      calls += 1;
      throw new Error("provider must not be called");
    },
  };

  try {
    delete process.env.KADI_BRAIN_SHADOW_ENABLED;
    for (const mode of ["candidate", "active_allowlist", "active"]) {
      process.env.KADI_BRAIN_MODE = mode;
      const shadow = makeKadiBrainShadow({ provider, logger: {} });
      assert.equal(shadow.enabled, false, mode);
      assert.deepEqual(
        await shadow.observeText({ text: "Facture pour Awa" }),
        { observed: false, reason: "disabled" },
        mode
      );
    }
    assert.equal(calls, 0);
  } finally {
    if (previousMode === undefined) delete process.env.KADI_BRAIN_MODE;
    else process.env.KADI_BRAIN_MODE = previousMode;
    if (previousLegacy === undefined) delete process.env.KADI_BRAIN_SHADOW_ENABLED;
    else process.env.KADI_BRAIN_SHADOW_ENABLED = previousLegacy;
  }
});

test("explicit enabled injection remains authoritative", async () => {
  const disabled = makeKadiBrainShadow({ enabled: false, provider: {}, logger: {} });
  assert.equal(disabled.enabled, false);

  let calls = 0;
  const enabled = makeKadiBrainShadow({
    enabled: true,
    logger: {},
    provider: {
      understand: async () => {
        calls += 1;
        return {
          result: { providerFailed: true, errorType: "test" },
          telemetry: {},
        };
      },
    },
  });

  assert.equal(enabled.enabled, true);
  await enabled.observeText({ text: "Facture pour Awa", messageId: "inject-1" });
  assert.equal(calls, 1);
});
