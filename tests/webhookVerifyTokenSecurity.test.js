"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function readTrackedSource(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("index uses the fail-closed webhook verification boundary without a literal fallback", () => {
  const source = readTrackedSource("index.js");
  const hasDirectRead = /const\s+VERIFY_TOKEN\s*=\s*process\.env\.VERIFY_TOKEN\s*;/.test(
    source
  );
  const hasFallback = /process\.env\.VERIFY_TOKEN\s*(?:\|\||\?\?)/.test(source);
  const usesBoundary = /evaluateWebhookVerification\s*\(\s*\{/.test(source);
  const keepsPostWebhook = /app\.post\s*\(\s*["']\/webhook["']/.test(source);
  const keepsAck = source.includes("EVENT_RECEIVED");
  const keepsHealth = /app\.get\s*\(\s*["']\/health["']/.test(source);

  assert.equal(hasDirectRead, true);
  assert.equal(hasFallback, false);
  assert.equal(usesBoundary, true);
  assert.equal(keepsPostWebhook, true);
  assert.equal(keepsAck, true);
  assert.equal(keepsHealth, true);
});

test("check_env has no direct runtime value logging or global environment serialization", () => {
  const source = readTrackedSource("check_env.js");
  const logsRuntimeValue = /console\.(?:log|warn|error)\s*\([^)]*process\.env\./s.test(
    source
  );
  const serializesRuntime = /JSON\.stringify\s*\(\s*process\.env\s*\)/.test(source);

  assert.equal(logsRuntimeValue, false);
  assert.equal(serializesRuntime, false);
  assert.equal(source.includes("require.main === module"), true);
});

test("tracked example documents only placeholders for security variables", () => {
  const source = readTrackedSource(".env.exeample");
  const entries = Object.create(null);

  for (const line of source.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) {
      entries[match[1]] = match[2];
    }
  }

  const expectedPlaceholderNames = [
    "VERIFY_TOKEN",
    "WHATSAPP_TOKEN",
    "WHATSAPP_PHONE_NUMBER_ID",
    "PHONE_NUMBER_ID",
    "APP_SECRET",
    "WHATSAPP_WABA_ID",
    "WHATSAPP_2FA_PIN",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "OPENAI_API_KEY",
  ];

  for (const name of expectedPlaceholderNames) {
    assert.equal(Object.prototype.hasOwnProperty.call(entries, name), true);
    assert.equal(/^YOUR_[A-Z0-9_]+_HERE$/.test(entries[name]), true);
  }

  assert.equal(Object.prototype.hasOwnProperty.call(entries, "SUPABASE_SERVICE_KEY"), false);
  assert.equal(/^\s*shadow\s*$/i.test(entries.KADI_BRAIN_MODE || ""), false);
});
