"use strict";

const path = require("node:path");
const {
  createKadiV1ActivationPreparationReport,
} = require("../kadiV1ActivationPreparation");

const report = createKadiV1ActivationPreparationReport({
  env: process.env,
  rootDir: path.resolve(__dirname, ".."),
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.ok ? 0 : 1;
