"use strict";

const path = require("node:path");
const {
  createKadiV1ActivationPreparationReport,
} = require("../kadiV1ActivationPreparation");
const {
  createKadiV1ActivationEvidenceTemplate,
} = require("../kadiV1ActivationEvidence");

const preparationReport = createKadiV1ActivationPreparationReport({
  env: process.env,
  rootDir: path.resolve(__dirname, ".."),
});
const template = createKadiV1ActivationEvidenceTemplate({ preparationReport });

process.stdout.write(`${JSON.stringify(template, null, 2)}\n`);
process.exitCode = template.ok ? 0 : 1;
