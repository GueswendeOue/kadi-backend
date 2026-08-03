"use strict";

const path = require("node:path");
const {
  RELEASE_MODES,
  evaluateKadiV1ReleaseGate,
} = require("../kadiV1ReleaseGate");

const mode = process.env.KADI_V1_RELEASE_MODE || RELEASE_MODES.REHEARSAL;
const report = evaluateKadiV1ReleaseGate({
  env: process.env,
  mode,
  rootDir: path.resolve(__dirname, ".."),
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.ok ? 0 : 1;
