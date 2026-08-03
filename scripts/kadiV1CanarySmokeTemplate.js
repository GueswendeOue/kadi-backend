"use strict";

const {
  createKadiV1CanarySmokeTemplate,
} = require("../kadiV1CanarySmokeGate");

const template = createKadiV1CanarySmokeTemplate();
process.stdout.write(`${JSON.stringify(template, null, 2)}\n`);
process.exitCode = template.ok ? 0 : 1;
