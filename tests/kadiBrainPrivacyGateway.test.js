"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const privacy = require("../kadiBrainPrivacyGateway");

const {
  KADI_PRIVACY_SCHEMA_VERSION,
  KADI_PRIVACY_INPUT_VERSION,
  KADI_PRIVACY_RESULT_VERSION,
  KADI_PRIVACY_CATEGORIES,
  KADI_PRIVACY_ACTIONS,
  KADI_PRIVACY_DECISIONS,
  KADI_PRIVACY_ERROR_CODES,
  KADI_PRIVACY_LIMITS,
  createEmptyPrivacyInput,
  createEmptyPrivacyResult,
  normalizePrivacyInput,
  classifySensitiveKey,
  detectSensitiveText,
  sanitizePrivacyInput,
  validatePrivacyResult,
  isPrivacySafeForProvider,
} = privacy;

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).reverse()) result[key] = reverseKeys(value[key]);
  return result;
}

function validInput(overrides = {}) {
  return {
    ...createEmptyPrivacyInput(),
    userMessage: "Créer une facture de 125000 FCFA",
    context: {},
    ...overrides,
  };
}

function assertNoRawFields(value) {
  const serialized = JSON.stringify(value);
  for (const key of ["value", "originalValue", "raw", "text", "secret"]) {
    assert.equal(serialized.includes(`"${key}"`), false);
  }
}

test("scenarios 1-7: exact immutable constants", () => {
  assert.equal(KADI_PRIVACY_SCHEMA_VERSION, "kadi.privacy-gateway.v1");
  assert.equal(KADI_PRIVACY_INPUT_VERSION, "kadi.privacy-input.v1");
  assert.equal(KADI_PRIVACY_RESULT_VERSION, "kadi.privacy-result.v1");
  for (const value of [
    KADI_PRIVACY_CATEGORIES, KADI_PRIVACY_ACTIONS, KADI_PRIVACY_DECISIONS,
    KADI_PRIVACY_ERROR_CODES, KADI_PRIVACY_LIMITS,
  ]) assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(KADI_PRIVACY_LIMITS, {
    maxUserMessageCodePoints: 12000,
    maxContextEntries: 100,
    maxContextDepth: 6,
    maxContextStringCodePoints: 4000,
    maxRedactions: 200,
    maxRestorationEntries: 100,
    maxAliasCodePoints: 64,
    maxPathCodePoints: 256,
  });
  assert.throws(() => { KADI_PRIVACY_LIMITS.maxRedactions = 2; }, TypeError);
});

test("scenarios 8-16: exact independent empty structures", () => {
  const input1 = createEmptyPrivacyInput();
  const input2 = createEmptyPrivacyInput();
  assert.deepEqual(input1, {
    schemaVersion: "kadi.privacy-input.v1",
    userMessage: "",
    context: {},
    policy: {
      allowPersonalNames: false,
      allowBusinessIdentifiers: false,
      allowFinancialAmounts: true,
      blockSecrets: true,
      pseudonymizeNames: true,
      removePhones: true,
      removeEmails: true,
      removeAddresses: true,
    },
  });
  assert.notStrictEqual(input1, input2);
  assert.notStrictEqual(input1.context, input2.context);
  assert.notStrictEqual(input1.policy, input2.policy);

  const result1 = createEmptyPrivacyResult();
  const result2 = createEmptyPrivacyResult();
  assert.deepEqual(result1, {
    schemaVersion: "kadi.privacy-result.v1",
    allowed: false,
    decision: "INVALID_INPUT",
    errorCode: "NONE",
    errors: [],
    sanitizedInput: { userMessage: "", context: {} },
    redactions: [],
    restorationMap: {},
    summary: {
      containsSecrets: false,
      containsPersonalDataBefore: false,
      containsPersonalDataAfter: false,
      containsBusinessSensitiveData: false,
      dataMinimized: false,
    },
  });
  for (const key of ["errors", "sanitizedInput", "redactions", "restorationMap", "summary"]) {
    assert.notStrictEqual(result1[key], result2[key]);
  }
  assert.notStrictEqual(result1.sanitizedInput.context, result2.sanitizedInput.context);
});

test("scenarios 17-35: sensitive key classification is canonical", () => {
  const cases = {
    name: "PERSONAL_NAME", fullName: "PERSONAL_NAME", customer_name: "PERSONAL_NAME",
    phone: "PHONE", phoneNumber: "PHONE", email: "EMAIL", address: "ADDRESS",
    IFU: "BUSINESS_IDENTIFIER", rccm: "BUSINESS_IDENTIFIER", amount: "FINANCIAL",
    password: "AUTH_SECRET", PIN: "AUTH_SECRET", otp: "AUTH_SECRET",
    apiKey: "ACCESS_SECRET", ACCESS_TOKEN: "ACCESS_SECRET",
    waId: "RAW_IDENTITY", bsuid: "RAW_IDENTITY",
    identityCard: "DOCUMENT_SENSITIVE", ordinary: "NONE",
  };
  for (const [key, category] of Object.entries(cases)) {
    assert.equal(classifySensitiveKey(key), category);
  }
  assert.equal(classifySensitiveKey(null), "NONE");
});

test("scenarios 36-49: textual detection has safe deterministic offsets", () => {
  const cases = [
    ["Téléphone 70 12 34 56", "PHONE"],
    ["Email awa@example.com", "EMAIL"],
    ["Mot de passe abc123", "AUTH_SECRET"],
    ["PIN 1234", "AUTH_SECRET"],
    ["OTP 819244", "AUTH_SECRET"],
    ["API key secret-value", "ACCESS_SECRET"],
    ["access token token-value", "ACCESS_SECRET"],
    ["IFU 00012345", "BUSINESS_IDENTIFIER"],
    ["RCCM BF-OUA-2024", "BUSINESS_IDENTIFIER"],
  ];
  for (const [text, category] of cases) {
    const detections = detectSensitiveText(text);
    assert.equal(detections.some((item) => item.category === category), true);
    for (const detection of detections) {
      assert.deepEqual(Object.keys(detection), ["category", "start", "end"]);
      assert.equal(typeof detection.start, "number");
      assert.equal(typeof detection.end, "number");
    }
  }
  assert.equal(
    detectSensitiveText("Montant 125000 FCFA").some((item) =>
      ["AUTH_SECRET", "ACCESS_SECRET"].includes(item.category)
    ),
    false
  );
  assert.deepEqual(detectSensitiveText("Bonjour artisan"), []);
  const multiple = detectSensitiveText("Email a@b.com téléphone 70 12 34 56");
  assert.equal(multiple.length, 2);
  assert.equal(JSON.stringify(multiple), JSON.stringify(detectSensitiveText("Email a@b.com téléphone 70 12 34 56")));
  assert.equal(JSON.stringify(multiple).includes("a@b.com"), false);
});

test("scenarios 50-70: normalization is total, bounded, pure, and independent", () => {
  for (const value of [null, undefined, "x", 4, true, []]) {
    assert.deepEqual(normalizePrivacyInput(value), createEmptyPrivacyInput());
  }
  const partial = normalizePrivacyInput({
    userMessage: " hello ",
    context: { nested: { enabled: true }, invalid: () => "x", symbol: Symbol("x") },
    policy: { removePhones: false, unknown: true },
    unknown: "discard",
  });
  assert.equal(partial.userMessage, "hello");
  assert.deepEqual(partial.context, { nested: { enabled: true } });
  assert.equal(partial.policy.removePhones, false);
  assert.deepEqual(Object.keys(partial.policy), Object.keys(createEmptyPrivacyInput().policy));
  assert.equal("unknown" in partial, false);

  const frozen = Object.freeze({ userMessage: " frozen ", context: Object.freeze({ a: 1 }) });
  const before = JSON.stringify(frozen);
  assert.doesNotThrow(() => normalizePrivacyInput(frozen));
  assert.equal(JSON.stringify(frozen), before);

  const cyclic = validInput(); cyclic.context.self = cyclic.context;
  assert.equal(normalizePrivacyInput(cyclic).schemaVersion, null);
  const longMessage = validInput({ userMessage: `😀${"a".repeat(12000)}` });
  assert.equal(normalizePrivacyInput(longMessage).schemaVersion, null);
  const deep = validInput({ context: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } });
  assert.equal(normalizePrivacyInput(deep).schemaVersion, null);
  const many = {}; for (let index = 0; index < 101; index += 1) many[`k${index}`] = index;
  assert.equal(normalizePrivacyInput(validInput({ context: many })).schemaVersion, null);
  assert.equal(
    normalizePrivacyInput(validInput({ context: { text: "x".repeat(4001) } })).schemaVersion,
    null
  );
  const buffer = validInput({ context: { buffer: Buffer.from("x") } });
  assert.equal(normalizePrivacyInput(buffer).schemaVersion, null);
  class Custom {}
  assert.equal(normalizePrivacyInput(validInput({ context: { custom: new Custom() } })).schemaVersion, null);
  const getter = {};
  Object.defineProperty(getter, "danger", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.doesNotThrow(() => normalizePrivacyInput(validInput({ context: getter })));
  assert.equal(normalizePrivacyInput(validInput({ context: getter })).schemaVersion, null);
  const first = normalizePrivacyInput(validInput({ context: { items: [{ value: "x" }] } }));
  const second = normalizePrivacyInput(validInput({ context: { items: [{ value: "x" }] } }));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.notStrictEqual(first.context, second.context);
  assert.notStrictEqual(first.context.items, second.context.items);
  assert.notStrictEqual(first.context.items[0], second.context.items[0]);
});

test("scenarios 71-84: secrets block without leaking", () => {
  const keys = [
    "password", "Password", "PASSWORD", "pin", "otp", "apiKey", "API_KEY",
    "accessToken", "serviceRoleKey", "mobileMoneyPin",
  ];
  keys.forEach((key, index) => {
    const sentinel = `SECRET_SENTINEL_${index}`;
    const result = sanitizePrivacyInput(validInput({ context: { [key]: sentinel } }));
    assert.equal(result.allowed, false);
    assert.equal(result.decision, "BLOCKED");
    assert.equal(result.errorCode, "SECRET_DETECTED");
    assert.equal(result.summary.containsSecrets, true);
    assert.deepEqual(result.restorationMap, {});
    assert.equal(JSON.stringify(result).includes(sentinel), false);
    result.errors.forEach((error) => assert.deepEqual(Object.keys(error), ["path", "code"]));
  });
  for (const message of ["OTP 819244", "Mot de passe abc123", "API key secret-value"]) {
    const result = sanitizePrivacyInput(validInput({ userMessage: message }));
    assert.equal(result.decision, "BLOCKED");
    assert.equal(JSON.stringify(result).includes(message), false);
  }
});

test("scenarios 85-95: names are pseudonymized deterministically with a local map", () => {
  const input = validInput({
    userMessage: "Facture pour Issa Ouédraogo et client Awa Kaboré",
    context: {
      customerName: "Issa Ouédraogo",
      recipientName: "Awa Kaboré",
      repeatedName: "public",
    },
  });
  const first = sanitizePrivacyInput(input);
  const second = sanitizePrivacyInput(reverseKeys(input));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.sanitizedInput.userMessage.includes("Issa Ouédraogo"), false);
  assert.equal(first.sanitizedInput.userMessage.includes("Awa Kaboré"), false);
  assert.equal(JSON.stringify(first.sanitizedInput).includes("Issa Ouédraogo"), false);
  assert.equal(new Set(Object.values(first.restorationMap)).size, 2);
  assert.equal(first.restorationMap.PERSON_1, "Issa Ouédraogo");
  assert.equal(first.restorationMap.PERSON_2, "Awa Kaboré");
  assert.equal(first.sanitizedInput.context.customerName, "PERSON_1");
  assert.equal(first.sanitizedInput.context.recipientName, "PERSON_2");
  assert.equal(JSON.stringify(first.restorationMap).includes("SECRET_"), false);
  assert.deepEqual(Object.keys(first.restorationMap), ["PERSON_1", "PERSON_2"]);
  assert.equal(first.redactions.every((item) => !("originalValue" in item)), true);
});

test("scenarios 96-104: default removal and financial policy are enforced", () => {
  const result = sanitizePrivacyInput(validInput({
    userMessage: "Téléphone 70 12 34 56 email awa@example.com IFU 00012345 montant 125000 FCFA",
    context: {
      phone: "70 12 34 56",
      email: "awa@example.com",
      address: "Ouagadougou",
      waId: "22670123456",
      ifu: "00012345",
      rccm: "BF-OUA-2024",
      amount: 125000,
    },
  }));
  const serialized = JSON.stringify(result.sanitizedInput);
  for (const forbidden of [
    "70 12 34 56", "awa@example.com", "Ouagadougou", "22670123456",
    "00012345", "BF-OUA-2024",
  ]) assert.equal(serialized.includes(forbidden), false);
  assert.equal(result.sanitizedInput.context.amount, 125000);
  assert.equal(result.sanitizedInput.userMessage.includes("125000 FCFA"), true);
  const hidden = sanitizePrivacyInput(validInput({
    context: { amount: 125000 },
    policy: { ...createEmptyPrivacyInput().policy, allowFinancialAmounts: false },
  }));
  assert.equal(hidden.sanitizedInput.context.amount, "AMOUNT_REMOVED");
});

test("scenarios 105-115: redactions and summary are minimal and deterministic", () => {
  const result = sanitizePrivacyInput(validInput({
    userMessage: "Facture pour Awa Kaboré, téléphone 70 12 34 56, email awa@example.com, IFU 12345",
  }));
  for (const category of ["PERSONAL_NAME", "PHONE", "EMAIL", "BUSINESS_IDENTIFIER"]) {
    assert.equal(result.redactions.some((item) => item.category === category), true);
  }
  result.redactions.forEach((redaction) => {
    assert.deepEqual(Object.keys(redaction), ["path", "category", "action", "alias"]);
  });
  assertNoRawFields(result.redactions);
  assert.deepEqual(
    result.redactions,
    [...result.redactions].sort((a, b) =>
      a.path.localeCompare(b.path) ||
      a.category.localeCompare(b.category) ||
      String(a.alias).localeCompare(String(b.alias))
    )
  );
  assert.equal(result.summary.containsSecrets, false);
  assert.equal(result.summary.containsPersonalDataBefore, true);
  assert.equal(result.summary.containsPersonalDataAfter, false);
  assert.equal(result.summary.containsBusinessSensitiveData, true);
  assert.equal(result.summary.dataMinimized, true);
});

test("scenarios 116-127: validation and safe helper enforce full coherence", () => {
  const allowed = sanitizePrivacyInput(validInput());
  assert.equal(allowed.decision, "ALLOWED");
  assert.equal(validatePrivacyResult(allowed).valid, true);
  assert.equal(isPrivacySafeForProvider(allowed), true);

  const redacted = sanitizePrivacyInput(validInput({ context: { phone: "70 12 34 56" } }));
  assert.equal(redacted.decision, "ALLOWED_WITH_REDACTION");
  assert.equal(validatePrivacyResult(redacted).valid, true);
  assert.equal(isPrivacySafeForProvider(redacted), true);

  const blocked = sanitizePrivacyInput(validInput({ context: { otp: "123456" } }));
  assert.equal(validatePrivacyResult(blocked).valid, true);
  assert.equal(isPrivacySafeForProvider(blocked), false);

  const variants = [];
  variants.push({ ...allowed, errorCode: "INVALID_RESULT" });
  variants.push({ ...redacted, redactions: [{ path: "x", value: "raw" }] });
  variants.push({ ...redacted, restorationMap: { constructor: "x" } });
  variants.push({ ...allowed, summary: { bad: true } });
  for (const value of variants) {
    assert.equal(validatePrivacyResult(value).valid, false);
    assert.equal(isPrivacySafeForProvider(value), false);
  }
  const personal = sanitizePrivacyInput(validInput({
    context: { customerName: "Awa Kaboré" },
    policy: { ...createEmptyPrivacyInput().policy, allowPersonalNames: true },
  }));
  assert.equal(personal.summary.containsPersonalDataAfter, true);
  assert.equal(isPrivacySafeForProvider(personal), false);
  for (const value of [null, undefined, "x", 2, []]) {
    assert.doesNotThrow(() => isPrivacySafeForProvider(value));
    assert.equal(isPrivacySafeForProvider(value), false);
  }
});

test("scenarios 128-136: dangerous keys fail closed recursively without pollution", () => {
  const keys = ["__proto__", "__PROTO__", "__proto_", "constructor", "Constructor", "CONSTRUCTOR", "prototype", "Prototype", "PROTO_TYPE"];
  for (const key of keys) {
    const nested = JSON.parse(`{${JSON.stringify(key)}:{"polluted":true}}`);
    for (const context of [nested, { deep: nested }, { array: [nested] }]) {
      const result = sanitizePrivacyInput(validInput({ context }));
      assert.equal(result.allowed, false);
      assert.equal(["UNSAFE_KEY", "INVALID_INPUT"].includes(result.errorCode), true);
      assert.equal({}.polluted, undefined);
      assert.equal(Object.prototype.polluted, undefined);
    }
  }
});

test("determinism and mutable references are isolated", () => {
  const input = validInput({
    userMessage: "Facture pour Awa Kaboré",
    context: { list: [{ customerName: "Issa Ouédraogo" }] },
  });
  const first = sanitizePrivacyInput(input);
  const second = sanitizePrivacyInput(input);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  for (const key of [
    "errors", "sanitizedInput", "redactions", "restorationMap", "summary",
  ]) assert.notStrictEqual(first[key], second[key]);
  assert.notStrictEqual(first.sanitizedInput.context, second.sanitizedInput.context);
  first.redactions.forEach((redaction, index) =>
    assert.notStrictEqual(redaction, second.redactions[index])
  );
  first.redactions[0].path = "changed";
  first.restorationMap.PERSON_1 = "changed";
  first.summary.dataMinimized = false;
  first.sanitizedInput.context.changed = true;
  assert.notEqual(JSON.stringify(first), JSON.stringify(second));
});

test("Unicode limits are exact and never truncate silently", () => {
  for (const size of [11999, 12000, 12001]) {
    const message = `😀${"a".repeat(size - 1)}`;
    const normalized = normalizePrivacyInput(validInput({ userMessage: message }));
    if (size <= 12000) assert.equal(normalized.userMessage, message);
    else assert.equal(normalized.schemaVersion, null);
  }
  for (const size of [3999, 4000, 4001]) {
    const text = `😀${"a".repeat(size - 1)}`;
    const normalized = normalizePrivacyInput(validInput({ context: { text } }));
    if (size <= 4000) assert.equal(normalized.context.text, text);
    else assert.equal(normalized.schemaVersion, null);
  }
});

test("scenarios 137-153: production source is pure and has no persistence or execution", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "kadiBrainPrivacyGateway.js"),
    "utf8"
  );
  assert.deepEqual(
    Array.from(source.matchAll(/require\((["'])(.*?)\1\)/g), (match) => match[2]),
    []
  );
  assert.doesNotMatch(source, /\bimport\s*\(/);
  const forbidden = [
    /@openai/i, /\bopenai\b/i, /\bgoogle\b/i, /\bgemini\b/i, /generative-ai/i,
    /\bfetch\s*\(/, /\baxios\b/i,
    /\brequire\s*\(\s*["'](?:node:)?(?:http|https|net|tls|fs|crypto|vm|child_process)["']/i,
    /https?:\/\//i, /\bsupabase\b/i, /process\.env/,
    /\breadFile\b/, /\bwriteFile\b/, /\bappendFile\b/, /\bcreateWriteStream\b/,
    /Date\.now/, /Math\.random/, /\brandomUUID\b/, /\buuid\b/i,
    /\beval\s*\(/, /\bnew\s+Function\b/, /\bFunction\s*\(/,
    /\bexec\s*\(/, /\bspawn\s*\(/, /\bsetTimeout\b/, /\bsetInterval\b/,
    /\bAbortController\b/, /\bwebhook\b/i, /\bdispatch\b/i,
    /\bexecuteIntent\b/, /\bcreateInvoice\b/, /\bcreateQuote\b/,
    /\bcreateReceipt\b/, /\bdebitCredit\b/,
    /\b(?:redis|database|session|cache)\b/i,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(source, pattern);
});
