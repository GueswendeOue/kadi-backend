"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const modulePath = require.resolve("../check_env");

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
  for (const marker of markers) {
    assert.equal(output.includes(marker), false);
  }
  for (const line of lines) {
    assert.equal(/^[A-Z][A-Z0-9_]+=(SET|MISSING)$/.test(line), true);
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
