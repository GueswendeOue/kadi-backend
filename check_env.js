"use strict";

const RUNTIME_ENV_NAMES = Object.freeze([
  "VERIFY_TOKEN",
  "WHATSAPP_TOKEN",
  "APP_SECRET",
  "WHATSAPP_2FA_PIN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "PHONE_NUMBER_ID",
  "WHATSAPP_WABA_ID",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_OCR_JSON_BASE64",
  "GOOGLE_OCR_JSON",
  "GCP_SA_JSON_B64",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);

function getOwnDataValue(source, name) {
  if (!source || (typeof source !== "object" && typeof source !== "function")) {
    return undefined;
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, name);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch (_) {
    return undefined;
  }
}

function buildEnvPresenceReport(source) {
  const report = Object.create(null);

  for (const name of RUNTIME_ENV_NAMES) {
    const value = getOwnDataValue(source, name);
    report[name] =
      typeof value === "string" && value.trim().length > 0 ? "SET" : "MISSING";
  }

  return Object.freeze(report);
}

function printEnvPresenceReport(report, writeLine = console.log) {
  if (typeof writeLine !== "function") {
    return;
  }

  for (const name of RUNTIME_ENV_NAMES) {
    const status = report?.[name] === "SET" ? "SET" : "MISSING";
    writeLine(`${name}: ${status}`);
  }
}

function runCli() {
  require("dotenv").config();
  printEnvPresenceReport(buildEnvPresenceReport(process.env));
}

if (require.main === module) {
  runCli();
}

module.exports = {
  RUNTIME_ENV_NAMES,
  buildEnvPresenceReport,
  printEnvPresenceReport,
};
