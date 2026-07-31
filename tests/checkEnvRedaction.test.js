"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const modulePath = require.resolve("../check_env");

const REQUIRED_SENSITIVE_NAMES = Object.freeze([
  "VERIFY_TOKEN",
  "WHATSAPP_TOKEN",
  "APP_SECRET",
  "WHATSAPP_2FA_PIN",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_OCR_JSON_BASE64",
  "GOOGLE_OCR_JSON",
  "GCP_SA_JSON_B64",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);

function renderReport(source) {
  const {
    RUNTIME_ENV_NAMES,
    buildEnvPresenceReport,
    printEnvPresenceReport,
  } = require(modulePath);
  const report = buildEnvPresenceReport(source);
  const lines = [];
  printEnvPresenceReport(report, (line) => lines.push(line));

  assert.deepEqual(Object.keys(report), [...RUNTIME_ENV_NAMES]);
  assert.equal(Object.isFrozen(report), true);
  for (const line of lines) {
    assert.equal(/^[A-Z][A-Z0-9_]+: (SET|MISSING)$/.test(line), true);
  }

  return { report, lines, output: lines.join("\n") };
}

test("importing check_env is silent", () => {
  const writes = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  try {
    console.log = (...args) => writes.push(["log", args.length]);
    console.warn = (...args) => writes.push(["warn", args.length]);
    console.error = (...args) => writes.push(["error", args.length]);
    process.stdout.write = (...args) => {
      writes.push(["stdout", args.length]);
      return true;
    };
    process.stderr.write = (...args) => {
      writes.push(["stderr", args.length]);
      return true;
    };

    delete require.cache[modulePath];
    require(modulePath);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  assert.equal(writes.length, 0);
});

test("check_env reports only SET or MISSING from an explicit allowlist", () => {
  delete require.cache[modulePath];
  const {
    RUNTIME_ENV_NAMES,
    buildEnvPresenceReport,
    printEnvPresenceReport,
  } = require(modulePath);

  const fakeValues = Object.create(null);
  const markers = [];
  for (const [index, name] of RUNTIME_ENV_NAMES.entries()) {
    const marker = `FAKE_SECRET_MARKER_${index}`;
    markers.push(marker);
    if (index % 2 === 0) {
      fakeValues[name] = marker;
    }
  }
  fakeValues.UNEXPECTED_SECRET = "FAKE_UNEXPECTED_MARKER";

  const report = buildEnvPresenceReport(fakeValues);
  const lines = [];
  printEnvPresenceReport(report, (line) => lines.push(line));
  const output = lines.join("\n");

  assert.deepEqual(Object.keys(report), [...RUNTIME_ENV_NAMES]);
  assert.equal(lines.length, RUNTIME_ENV_NAMES.length);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(output.includes("UNEXPECTED_SECRET"), false);
  assert.equal(output.includes("FAKE_UNEXPECTED_MARKER"), false);
  assert.equal(output.includes("FAKE_SECRET_MARKER"), false);
  for (const marker of markers) {
    assert.equal(output.includes(marker), false);
  }
  for (const line of lines) {
    assert.equal(/^[A-Z][A-Z0-9_]+: (SET|MISSING)$/.test(line), true);
  }
  for (const name of REQUIRED_SENSITIVE_NAMES) {
    assert.equal(RUNTIME_ENV_NAMES.includes(name), true);
  }
});

test("check_env ignores getters instead of executing them", () => {
  const { buildEnvPresenceReport } = require(modulePath);
  let getterCalls = 0;
  const source = {};
  Object.defineProperty(source, "VERIFY_TOKEN", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("getter must not run");
    },
  });

  const report = buildEnvPresenceReport(source);
  assert.equal(getterCalls, 0);
  assert.equal(report.VERIFY_TOKEN, "MISSING");
});

test("frozen and null-prototype sources remain immutable and safely bounded", () => {
  const frozenSource = Object.freeze({
    VERIFY_TOKEN: "FAKE_FROZEN_MARKER_ALPHA",
    GOOGLE_APPLICATION_CREDENTIALS: "FAKE_FROZEN_MARKER_BETA",
  });
  const nullPrototypeSource = Object.create(null);
  nullPrototypeSource.WHATSAPP_TOKEN = "FAKE_NULL_MARKER_ALPHA";
  nullPrototypeSource.SUPABASE_SERVICE_ROLE_KEY = "FAKE_NULL_MARKER_BETA";

  const frozenResult = renderReport(frozenSource);
  const nullResult = renderReport(nullPrototypeSource);

  assert.equal(Object.isFrozen(frozenSource), true);
  assert.equal(frozenResult.report.VERIFY_TOKEN, "SET");
  assert.equal(frozenResult.report.GOOGLE_APPLICATION_CREDENTIALS, "SET");
  assert.equal(nullResult.report.WHATSAPP_TOKEN, "SET");
  assert.equal(nullResult.report.SUPABASE_SERVICE_ROLE_KEY, "SET");
  assert.equal(frozenResult.output.includes("FAKE_FROZEN_MARKER"), false);
  assert.equal(nullResult.output.includes("FAKE_NULL_MARKER"), false);
});

test("hostile getters and proxies fail closed without invoking value access traps", () => {
  let getterCalls = 0;
  const getterSource = { WHATSAPP_TOKEN: "FAKE_SAFE_NEIGHBOR_MARKER" };
  Object.defineProperty(getterSource, "VERIFY_TOKEN", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("getter must not run");
    },
  });

  const trapCalls = { get: 0, descriptor: 0, has: 0, ownKeys: 0 };
  const proxySource = new Proxy(
    {},
    {
      get() {
        trapCalls.get += 1;
        throw new Error("get trap must not escape");
      },
      getOwnPropertyDescriptor() {
        trapCalls.descriptor += 1;
        throw new Error("descriptor trap must not escape");
      },
      has() {
        trapCalls.has += 1;
        throw new Error("has trap must not escape");
      },
      ownKeys() {
        trapCalls.ownKeys += 1;
        throw new Error("ownKeys trap must not escape");
      },
    }
  );

  const getterResult = renderReport(getterSource);
  const proxyResult = renderReport(proxySource);

  assert.equal(getterCalls, 0);
  assert.equal(getterResult.report.VERIFY_TOKEN, "MISSING");
  assert.equal(getterResult.report.WHATSAPP_TOKEN, "SET");
  assert.equal(getterResult.output.includes("FAKE_SAFE_NEIGHBOR_MARKER"), false);
  assert.equal(Object.values(proxyResult.report).every((value) => value === "MISSING"), true);
  assert.equal(trapCalls.descriptor > 0, true);
  assert.equal(trapCalls.get, 0);
  assert.equal(trapCalls.has, 0);
  assert.equal(trapCalls.ownKeys, 0);
});

test("non-object sources always produce a bounded fail-closed report", () => {
  const sources = [
    null,
    undefined,
    function sourceFunction() {},
    Symbol("fake-source"),
    1n,
    "fake-source-string",
    42,
    true,
    [],
  ];

  for (const source of sources) {
    const { report, output } = renderReport(source);
    assert.equal(Object.values(report).every((value) => value === "MISSING"), true);
    assert.equal(output.includes("fake-source"), false);
  }
});

test("hostile values are never converted, inspected or displayed", () => {
  let toStringCalls = 0;
  let valueOfCalls = 0;
  let proxyCalls = 0;
  const hostileValues = [
    function fakeFunctionValue() {},
    Symbol("fake-value"),
    1n,
    {},
    [],
    new Proxy(
      {},
      {
        get() {
          proxyCalls += 1;
          throw new Error("value proxy must not be read");
        },
      }
    ),
    {
      toString() {
        toStringCalls += 1;
        throw new Error("toString must not run");
      },
    },
    {
      valueOf() {
        valueOfCalls += 1;
        throw new Error("valueOf must not run");
      },
    },
  ];

  for (const value of hostileValues) {
    const { report, output } = renderReport({ VERIFY_TOKEN: value });
    assert.equal(report.VERIFY_TOKEN, "MISSING");
    assert.equal(output.includes("fake-value"), false);
  }

  assert.equal(toStringCalls, 0);
  assert.equal(valueOfCalls, 0);
  assert.equal(proxyCalls, 0);
});

test("default printing emits only allowlisted labels and SET or MISSING", () => {
  const {
    RUNTIME_ENV_NAMES,
    buildEnvPresenceReport,
    printEnvPresenceReport,
  } = require(modulePath);
  const source = Object.create(null);
  const markers = [];
  for (const [index, name] of REQUIRED_SENSITIVE_NAMES.entries()) {
    const marker = `FAKE_REDACTION_MARKER_${index}`;
    markers.push(marker);
    source[name] = marker;
  }
  const report = buildEnvPresenceReport(source);
  const captured = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  try {
    console.log = (...args) => captured.push(args.join(" "));
    console.warn = (...args) => captured.push(args.join(" "));
    console.error = (...args) => captured.push(args.join(" "));
    process.stdout.write = (...args) => {
      captured.push(String(args[0]));
      return true;
    };
    process.stderr.write = (...args) => {
      captured.push(String(args[0]));
      return true;
    };

    printEnvPresenceReport(report);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const output = captured.join("\n");
  assert.equal(captured.length, RUNTIME_ENV_NAMES.length);
  assert.equal(output.includes("FAKE_REDACTION_MARKER"), false);
  for (const marker of markers) {
    assert.equal(output.includes(marker), false);
  }
  for (const line of captured) {
    assert.equal(/^[A-Z][A-Z0-9_]+: (SET|MISSING)$/.test(line), true);
  }
});
