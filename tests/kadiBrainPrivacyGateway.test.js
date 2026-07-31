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
    summary: {
      containsSecrets: false,
      containsPersonalDataBefore: false,
      containsPersonalDataAfter: false,
      containsBusinessSensitiveData: false,
      dataMinimized: false,
    },
  });
  assert.deepEqual(result1.restorationMap, {});
  assert.equal(Object.keys(result1).includes("restorationMap"), false);
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

test("free-form names: explicit personal contexts pseudonymize simple and typographic names", () => {
  const cases = [
    ["Créer une facture pour Awa", "Awa"],
    ["Facture à Issa", "Issa"],
    ["Client: Fatou", "Fatou"],
    ["Nom = Paul", "Paul"],
    ["Madame Kaboré", "Kaboré"],
    ["Au nom de Aminata Traoré", "Aminata Traoré"],
    ["Reçu de Jean-Pierre", "Jean-Pierre"],
    ["Destinataire O'Connor", "O'Connor"],
    ["Invoice for Awa", "Awa"],
    ["Customer: John", "John"],
    ["Nom : Élodie", "Élodie"],
    ["Client O’Connor", "O’Connor"],
    ["pour JEAN PIERRE", "JEAN PIERRE"],
    ["M. KABORÉ", "KABORÉ"],
  ];
  for (const [message, rawName] of cases) {
    const result = sanitizePrivacyInput(validInput({ userMessage: message }));
    assert.equal(result.allowed, true, message);
    assert.equal(result.decision, "ALLOWED_WITH_REDACTION", message);
    assert.equal(result.sanitizedInput.userMessage.includes(rawName), false, message);
    assert.equal(Object.values(result.restorationMap).includes(rawName), true, message);
    assert.equal(isPrivacySafeForProvider(result), true, message);
  }
});

test("free-form names: isolated likely-name replies are pseudonymized", () => {
  for (const message of ["Awa", "Issa Ouedraogo", "Jean-Pierre", "Mme Kaboré"]) {
    const result = sanitizePrivacyInput(validInput({ userMessage: message }));
    assert.equal(result.decision, "ALLOWED_WITH_REDACTION", message);
    assert.match(result.sanitizedInput.userMessage, /^(?:Mme )?PERSON_[1-9]\d*$/u);
    assert.equal(result.sanitizedInput.userMessage.includes(message), false);
    assert.equal(isPrivacySafeForProvider(result), true);
  }
});

test("free-form names: business commands, products, organizations and places remain usable", () => {
  const messages = [
    "Créer une facture de 25000 FCFA",
    "Devis pour réparation téléphone",
    "3 sacs de ciment",
    "Service de plomberie",
    "Orange Money",
    "Ouagadougou",
    "Burkina Faso",
    "Article Samsung A15",
    "PDF",
    "Oui",
    "Non",
    "Confirmer",
    "Moov",
    "WhatsApp",
    "Supabase",
    "Gemini",
    "Kadi",
  ];
  for (const message of messages) {
    const result = sanitizePrivacyInput(validInput({ userMessage: message }));
    assert.equal(result.sanitizedInput.userMessage, message);
    assert.deepEqual(result.restorationMap, {});
    assert.equal(isPrivacySafeForProvider(result), true);
  }
  const explicit = sanitizePrivacyInput(validInput({ userMessage: "Client : Orange" }));
  assert.equal(explicit.sanitizedInput.userMessage, "Client : PERSON_1");
  assert.equal(explicit.restorationMap.PERSON_1, "Orange");
});

test("free-form names: placeholders are stable, distinct and collision-safe", () => {
  const repeated = sanitizePrivacyInput(validInput({
    userMessage: "Client Awa, destinataire Awa, responsable Issa",
  }));
  assert.equal(repeated.restorationMap.PERSON_1, "Awa");
  assert.equal(repeated.restorationMap.PERSON_2, "Issa");
  assert.equal(
    repeated.sanitizedInput.userMessage.match(/PERSON_1/gu)?.length,
    2
  );
  const collision = sanitizePrivacyInput(validInput({
    userMessage: "PERSON_1 client Awa",
  }));
  assert.equal(collision.sanitizedInput.userMessage.includes("PERSON_1"), true);
  assert.equal(collision.restorationMap.PERSON_2, "Awa");
  assert.equal(collision.restorationMap.PERSON_1, undefined);
});

test("free-form names: restoration data stays local and residual names fail final safety", () => {
  const result = sanitizePrivacyInput(validInput({ userMessage: "Client Awa" }));
  assert.equal(JSON.stringify(result.sanitizedInput).includes("Awa"), false);
  assert.equal("restorationMap" in result.sanitizedInput, false);
  assert.equal(JSON.stringify({
    privacySafe: isPrivacySafeForProvider(result),
    blocked: !result.allowed,
    reasonCode: result.errorCode,
    placeholderCount: Object.keys(result.restorationMap).length,
  }).includes("Awa"), false);

  const forged = structuredClone(result);
  forged.sanitizedInput.userMessage = "Client Awa";
  forged.summary.containsPersonalDataAfter = true;
  assert.equal(validatePrivacyResult(forged).valid, false);
  assert.equal(isPrivacySafeForProvider(forged), false);
});

test("free-form names: secret precedence, immutability and determinism remain closed", () => {
  const frozen = Object.freeze(validInput({ userMessage: "Client Awa, OTP 123456" }));
  const before = JSON.stringify(frozen);
  const blocked = sanitizePrivacyInput(frozen);
  assert.equal(blocked.decision, "BLOCKED");
  assert.equal(blocked.errorCode, "SECRET_DETECTED");
  assert.equal(JSON.stringify(blocked).includes("Awa"), false);
  assert.equal(JSON.stringify(blocked).includes("123456"), false);
  assert.equal(JSON.stringify(frozen), before);

  const unicode = validInput({ userMessage: "Nom : E\u0301lodie" });
  const first = sanitizePrivacyInput(unicode);
  const second = sanitizePrivacyInput(unicode);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.sanitizedInput.userMessage.includes("lodie"), false);
});

test("free-form names: detection stays bounded on maximum-length input", () => {
  const input = validInput({ userMessage: "facture ".repeat(1500).slice(0, 12000) });
  const started = process.hrtime.bigint();
  const result = sanitizePrivacyInput(input);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(result.allowed, true);
  assert.equal(elapsedMs < 1000, true);
});

test("residual gaps: lowercase short names never remain provider-safe in clear", () => {
  const messages = [
    "jean pierre", "awa", "issa ouedraogo", "jean-pierre", "o'connor",
    "o’connor", "élodie", "mme kaboré", "m. traoré",
  ];
  for (const message of messages) {
    const result = sanitizePrivacyInput(validInput({ userMessage: message }));
    assert.equal(result.sanitizedInput.userMessage.includes(message), false, message);
    assert.equal(result.decision, "ALLOWED_WITH_REDACTION", message);
    assert.equal(isPrivacySafeForProvider(result), true, message);
  }
});

test("residual gaps: transactional subjects and recipients are both protected", () => {
  const cases = [
    ["Awa a payé pour Fatou", "PERSON_1 a payé pour PERSON_2"],
    ["Issa commande pour Paul", "PERSON_1 commande pour PERSON_2"],
    ["Jean reçoit de Aminata", "PERSON_1 reçoit de PERSON_2"],
    ["Élodie achète pour Kaboré", "PERSON_1 achète pour PERSON_2"],
    ["O’Connor a livré à Fatou", "PERSON_1 a livré à PERSON_2"],
  ];
  for (const [message, expected] of cases) {
    const result = sanitizePrivacyInput(validInput({ userMessage: message }));
    assert.equal(result.sanitizedInput.userMessage, expected);
    assert.equal(Object.keys(result.restorationMap).length, 2);
    assert.equal(isPrivacySafeForProvider(result), true);
  }
});

test("residual gaps: personal enumerations and canonical apostrophes are protected", () => {
  const cases = [
    ["Jean-Pierre et Jean Pierre", "PERSON_1 et PERSON_2", 2],
    ["Awa et Fatou", "PERSON_1 et PERSON_2", 2],
    ["Client Awa et bénéficiaire Issa", "Client PERSON_1 et bénéficiaire PERSON_2", 2],
    ["Monsieur Kaboré, Madame Traoré", "Monsieur PERSON_1, Madame PERSON_2", 2],
    ["O’Connor & O'Connor", "PERSON_1 & PERSON_1", 1],
  ];
  for (const [message, expected, count] of cases) {
    const result = sanitizePrivacyInput(validInput({ userMessage: message }));
    assert.equal(result.sanitizedInput.userMessage, expected);
    assert.equal(Object.keys(result.restorationMap).length, count);
    assert.equal(isPrivacySafeForProvider(result), true);
  }
  const hyphenated = sanitizePrivacyInput(validInput({
    userMessage: "Jean-Pierre et Jean Pierre",
  }));
  assert.notEqual(
    hyphenated.sanitizedInput.userMessage.split(" et ")[0],
    hyphenated.sanitizedInput.userMessage.split(" et ")[1]
  );
});

test("residual gaps: independent final inspection closes a primary context miss", () => {
  const result = sanitizePrivacyInput(validInput({
    userMessage: "Créer une facture",
    context: { publicNote: "jean pierre" },
  }));
  assert.equal(result.sanitizedInput.context.publicNote, "jean pierre");
  assert.equal(result.allowed, true);
  assert.equal(validatePrivacyResult(result).valid, false);
  assert.equal(isPrivacySafeForProvider(result), false);
});

test("residual gaps: English beneficiary context preserves public structure", () => {
  const result = sanitizePrivacyInput(validInput({
    userMessage: "Beneficiary Alice",
  }));
  assert.equal(result.sanitizedInput.userMessage, "Beneficiary PERSON_1");
  assert.deepEqual(result.restorationMap, { PERSON_1: "Alice" });
  assert.equal(isPrivacySafeForProvider(result), true);
});

test("residual gaps: restoration data is local and excluded from default serialization", () => {
  const result = sanitizePrivacyInput(validInput({ userMessage: "Client Awa" }));
  assert.equal(result.restorationMap.PERSON_1, "Awa");
  assert.equal(Object.keys(result).includes("restorationMap"), false);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("restorationMap"), false);
  assert.equal(serialized.includes("Awa"), false);
  assert.equal(serialized.includes("PERSON_1"), true);
});

test("residual gaps: explicit secret and payment values block without disclosure", () => {
  const cases = [
    "token sk-test",
    "clé API abc123",
    "bearer eyJhbGciOiJIUzI1NiJ9",
    "password azerty",
    "otp 123456",
    "numéro de carte 4111111111111111",
    "CVV 123",
    "date d’expiration 12/29",
    "PIN 4321",
    "compte bancaire BF001234567890",
    "IBAN BF42TEST123456789",
    "mobile money secret code 7890",
  ];
  for (const message of cases) {
    const result = sanitizePrivacyInput(validInput({ userMessage: message }));
    assert.equal(result.allowed, false, message);
    assert.equal(result.decision, "BLOCKED", message);
    assert.equal(result.errorCode, "SECRET_DETECTED", message);
    assert.equal(JSON.stringify(result).includes(message), false, message);
  }
});

test("residual gaps: conceptual payment and bounded business conjunctions remain usable", () => {
  const conceptual = sanitizePrivacyInput(validInput({
    userMessage: "Jean avec donnée de paiement",
  }));
  assert.equal(
    conceptual.sanitizedInput.userMessage,
    "PERSON_1 avec donnée de paiement"
  );
  assert.equal(conceptual.summary.containsSecrets, false);
  assert.equal(isPrivacySafeForProvider(conceptual), true);

  for (const message of [
    "ciment et sable", "Orange et Moov", "peinture Awa", "savon Awa",
    "restaurant Chez Awa", "marque Awa", "modèle Jean", "tissu Kaboré",
  ]) {
    const result = sanitizePrivacyInput(validInput({ userMessage: message }));
    assert.equal(result.sanitizedInput.userMessage, message);
    assert.deepEqual(result.restorationMap, {});
    assert.equal(isPrivacySafeForProvider(result), true, message);
  }
});

test("residual gaps: aliases are request-scoped, user-scoped and deterministic", () => {
  const awa = sanitizePrivacyInput(validInput({ userMessage: "Client Awa" }));
  const fatou = sanitizePrivacyInput(validInput({ userMessage: "Client Fatou" }));
  const awaAgain = sanitizePrivacyInput(validInput({ userMessage: "Client Awa" }));
  assert.deepEqual(awa.restorationMap, { PERSON_1: "Awa" });
  assert.deepEqual(fatou.restorationMap, { PERSON_1: "Fatou" });
  assert.notStrictEqual(awa.restorationMap, fatou.restorationMap);
  assert.equal(JSON.stringify(awa), JSON.stringify(awaAgain));
  assert.deepEqual(awa.restorationMap, awaAgain.restorationMap);
});

test("final payment gaps: invoicing verbs protect every personal participant", () => {
  const cases = [
    ["Paul a facturé Aminata", "PERSON_1 a facturé PERSON_2"],
    ["Paul facture Aminata", "PERSON_1 facture PERSON_2"],
    ["Paul facturera Aminata", "PERSON_1 facturera PERSON_2"],
    ["Paul doit facturer Aminata", "PERSON_1 doit facturer PERSON_2"],
    ["Aminata est facturée par Paul", "PERSON_1 est facturée par PERSON_2"],
    ["Facturé par Paul pour Aminata", "Facturé par PERSON_1 pour PERSON_2"],
  ];
  for (const [message, expected] of cases) {
    const result = sanitizePrivacyInput(validInput({ userMessage: message }));
    assert.equal(result.sanitizedInput.userMessage, expected);
    assert.equal(Object.keys(result.restorationMap).length, 2);
    assert.equal(isPrivacySafeForProvider(result), true);
  }
});

test("final payment gaps: invoice nouns never trigger the personal subject rule", () => {
  for (const message of [
    "facture", "facturation", "facture proforma", "facture et devis",
    "logiciel de facturation",
  ]) {
    const result = sanitizePrivacyInput(validInput({ userMessage: message }));
    assert.equal(result.sanitizedInput.userMessage, message);
    assert.deepEqual(result.restorationMap, {});
    assert.equal(isPrivacySafeForProvider(result), true);
  }
});

test("final payment gaps: French, abbreviated and English account values block", () => {
  const messages = [
    "numéro de compte 1234567890",
    "numero de compte 1234567890",
    "n° de compte 1234567890",
    "no de compte 1234567890",
    "compte bancaire 1234567890",
    "bank account 1234567890",
    "account number 1234567890",
    "account no 1234567890",
    "account # 1234567890",
  ];
  for (const message of messages) {
    const result = sanitizePrivacyInput(validInput({ userMessage: message }));
    assert.equal(result.decision, "BLOCKED", message);
    assert.equal(result.errorCode, "SECRET_DETECTED", message);
    assert.equal(result.allowed, false, message);
    assert.equal(isPrivacySafeForProvider(result), false, message);
    assert.equal(JSON.stringify(result).includes("1234567890"), false, message);
  }
  for (const message of [
    "Comment ajouter un numéro de compte ?",
    "J’ai un problème avec mon compte bancaire.",
    "Où afficher le compte bancaire sur une facture ?",
  ]) {
    const result = sanitizePrivacyInput(validInput({ userMessage: message }));
    assert.equal(result.sanitizedInput.userMessage, message);
    assert.equal(result.summary.containsSecrets, false);
    assert.equal(isPrivacySafeForProvider(result), true);
  }
});

test("final payment gaps: mobile money secret values block but concepts remain usable", () => {
  const secrets = [
    "code secret mobile money 1234",
    "code secret Orange Money 1234",
    "code secret Moov Money 1234",
    "code mobile money 1234",
    "mobile money secret code 1234",
    "Orange Money PIN 1234",
    "Moov Money PIN 1234",
    "code PIN mobile money 1234",
  ];
  for (const message of secrets) {
    const result = sanitizePrivacyInput(validInput({ userMessage: message }));
    assert.equal(result.decision, "BLOCKED", message);
    assert.equal(result.errorCode, "SECRET_DETECTED", message);
    assert.equal(isPrivacySafeForProvider(result), false, message);
    assert.equal(JSON.stringify(result).includes("1234"), false, message);
  }
  for (const message of [
    "J’ai oublié mon code secret mobile money.",
    "Comment changer mon code Orange Money ?",
    "Problème de PIN Mobile Money.",
    "Kadi ne doit jamais demander mon code secret.",
  ]) {
    const result = sanitizePrivacyInput(validInput({ userMessage: message }));
    assert.equal(result.sanitizedInput.userMessage, message);
    assert.equal(result.summary.containsSecrets, false);
    assert.equal(isPrivacySafeForProvider(result), true);
  }
});

test("final payment gaps: secret blocking has priority over personal names", () => {
  for (const [message, sentinel] of [
    ["Paul, numéro de compte 1234567890", "1234567890"],
    ["Awa code secret mobile money 1234", "1234"],
  ]) {
    const result = sanitizePrivacyInput(validInput({ userMessage: message }));
    assert.equal(result.decision, "BLOCKED");
    assert.equal(result.allowed, false);
    assert.equal(isPrivacySafeForProvider(result), false);
    assert.equal(JSON.stringify(result).includes(sentinel), false);
    assert.deepEqual(result.restorationMap, {});
  }
});

test("final payment gaps: bounded business conjunctions stay provider-safe", () => {
  for (const message of [
    "Samsung et iPhone", "Orange et Moov", "ciment et sable",
    "plomberie et peinture", "facture et devis", "téléphone et tablette",
    "ordinateur et imprimante",
  ]) {
    const result = sanitizePrivacyInput(validInput({ userMessage: message }));
    assert.equal(result.sanitizedInput.userMessage, message);
    assert.deepEqual(result.restorationMap, {});
    assert.equal(isPrivacySafeForProvider(result), true, message);
  }
  for (const message of [
    "Awa et Fatou", "Jean et Paul", "O’Connor et Alice",
    "Client Awa et bénéficiaire Issa",
    "Monsieur Kaboré et Madame Traoré",
  ]) {
    const result = sanitizePrivacyInput(validInput({ userMessage: message }));
    assert.equal(result.sanitizedInput.userMessage.includes("PERSON_"), true);
    assert.equal(isPrivacySafeForProvider(result), true, message);
  }
});

test("final payment gaps: independent final inspection catches every residual risk", () => {
  for (const userMessage of [
    "Paul a facturé Aminata",
    "numéro de compte 1234567890",
    "code secret mobile money 1234",
  ]) {
    const forged = sanitizePrivacyInput(validInput());
    forged.sanitizedInput.userMessage = userMessage;
    forged.summary.containsPersonalDataAfter = true;
    assert.equal(validatePrivacyResult(forged).valid, false, userMessage);
    assert.equal(isPrivacySafeForProvider(forged), false, userMessage);
  }
  const business = sanitizePrivacyInput(validInput({
    userMessage: "Samsung et iPhone",
  }));
  assert.equal(validatePrivacyResult(business).valid, true);
  assert.equal(isPrivacySafeForProvider(business), true);
});

test("final payment gaps: serialization, determinism and frozen inputs stay closed", () => {
  const input = validInput({ userMessage: "Paul a facturé Aminata" });
  Object.freeze(input.policy);
  Object.freeze(input.context);
  Object.freeze(input);
  const before = JSON.stringify(input);
  const first = sanitizePrivacyInput(input);
  const second = sanitizePrivacyInput(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.restorationMap, second.restorationMap);
  assert.notStrictEqual(first.restorationMap, second.restorationMap);
  assert.equal(Object.keys(first).includes("restorationMap"), false);
  assert.equal("restorationMap" in { ...first }, false);
  assert.equal("restorationMap" in structuredClone(first), false);
  assert.equal(JSON.stringify(first).includes("restorationMap"), false);
  assert.equal(JSON.stringify(first).includes("Paul"), false);
  assert.equal(JSON.stringify(first).includes("Aminata"), false);
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

test("hardening: every frozen constant rejects mutation", () => {
  for (const value of [
    KADI_PRIVACY_CATEGORIES,
    KADI_PRIVACY_ACTIONS,
    KADI_PRIVACY_DECISIONS,
    KADI_PRIVACY_ERROR_CODES,
    KADI_PRIVACY_LIMITS,
  ]) {
    const key = Object.keys(value)[0];
    assert.throws(() => { value[key] = "MUTATED"; }, TypeError);
  }
});

test("hardening: textual offsets and explicit addresses are exact", () => {
  assert.deepEqual(detectSensitiveText("Téléphone 70 12 34 56"), [
    { category: "PHONE", start: 10, end: 21 },
  ]);
  const addresses = [
    "Adresse Ouagadougou secteur 15",
    "Adresse : secteur 15",
    "Domicile : Gounghin",
    "Livraison à Tampouy",
    "Quartier Karpala secteur 30",
    "Rue 12.34",
    "Avenue Kwamé Nkrumah",
  ];
  for (const text of addresses) {
    const detections = detectSensitiveText(text);
    assert.equal(detections.some((item) => item.category === "ADDRESS"), true);
    assert.equal(JSON.stringify(detections).includes(text), false);
  }
});

test("hardening: bigint fails closed without throwing", () => {
  const input = validInput({ context: { count: 1n } });
  assert.doesNotThrow(() => normalizePrivacyInput(input));
  assert.equal(normalizePrivacyInput(input).schemaVersion, null);
  assert.equal(sanitizePrivacyInput(input).allowed, false);
});

test("hardening: one name is pseudonymized with an exact local restoration map", () => {
  const result = sanitizePrivacyInput(validInput({
    context: { customerName: "Awa Kaboré" },
  }));
  assert.equal(result.sanitizedInput.context.customerName, "PERSON_1");
  assert.deepEqual(result.restorationMap, { PERSON_1: "Awa Kaboré" });
  assert.equal(isPrivacySafeForProvider(result), true);
});

test("hardening: restoration map boundaries and allowed values are validated", () => {
  const exact = {};
  for (let index = 1; index <= KADI_PRIVACY_LIMITS.maxRestorationEntries; index += 1) {
    exact[`PERSON_${index}`] = `Personne ${"A".repeat(index)}`;
  }
  const exactResult = sanitizePrivacyInput(validInput());
  exactResult.restorationMap = exact;
  assert.equal(validatePrivacyResult(exactResult).valid, true);
  const excessive = { ...exact, PERSON_101: `Personne ${"A".repeat(101)}` };
  const excessiveResult = sanitizePrivacyInput(validInput());
  excessiveResult.restorationMap = excessive;
  assert.equal(validatePrivacyResult(excessiveResult).valid, false);

  const forbidden = [
    "70 12 34 56",
    "awa@example.com",
    "Adresse Ouagadougou secteur 15",
    "waId",
    "passport AB12345",
    "OTP 123456",
    "PIN 1234",
    "Mot de passe abc123",
    "access token secret-value",
    "API key secret-value",
  ];
  for (const value of forbidden) {
    const forged = sanitizePrivacyInput(validInput());
    forged.restorationMap = { PERSON_1: value };
    assert.equal(validatePrivacyResult(forged).valid, false);
    assert.equal(isPrivacySafeForProvider(forged), false);
  }
});

test("hardening: secrets at every depth and under unknown keys always block", () => {
  const keys = [
    "apiKey", "API_KEY", "accessToken", "ACCESS_TOKEN", "refreshToken",
    "serviceRoleKey", "password", "Password", "PASSWORD", "otp", "OTP",
    "pin", "PIN", "mobileMoneyPin", "bearerToken", "secretKey",
    "api key", "access-token", "service_role_key",
  ];
  keys.forEach((key, index) => {
    const sentinel = `ROOT_SECRET_SENTINEL_${index}`;
    const placements = [
      { [key]: sentinel },
      { context: { [key]: sentinel } },
      { policy: { [key]: sentinel } },
      { unknown: [{ nested: { [key]: sentinel } }] },
    ];
    for (const placement of placements) {
      const result = sanitizePrivacyInput({ ...validInput(), ...placement });
      assert.equal(result.allowed, false);
      assert.equal(result.decision, "BLOCKED");
      assert.equal(result.errorCode, "SECRET_DETECTED");
      assert.deepEqual(result.restorationMap, {});
      assert.deepEqual(result.sanitizedInput, { userMessage: "", context: {} });
      assert.equal(result.summary.containsSecrets, true);
      assert.equal(JSON.stringify(result).includes(sentinel), false);
    }
  });
});

test("hardening: permissive policies disclose state but can never become provider-safe", () => {
  const cases = [
    ["removePhones", "Téléphone 70 12 34 56", "PHONE"],
    ["removeEmails", "Email awa@example.com", "EMAIL"],
    ["removeAddresses", "Adresse Ouagadougou secteur 15", "ADDRESS"],
  ];
  for (const [policyKey, userMessage, category] of cases) {
    const input = validInput({ userMessage });
    input.policy[policyKey] = false;
    const result = sanitizePrivacyInput(input);
    assert.equal(result.allowed, true);
    assert.equal(result.sanitizedInput.userMessage, userMessage);
    assert.equal(result.summary.containsPersonalDataBefore, true);
    assert.equal(result.summary.containsPersonalDataAfter, true);
    assert.equal(isPrivacySafeForProvider(result), false);
    assert.equal(
      detectSensitiveText(result.sanitizedInput.userMessage)
        .some((item) => item.category === category),
      true
    );
  }
});

test("hardening: financial amounts are removed from messages when disabled", () => {
  const input = validInput({ userMessage: "Montant 125000 FCFA" });
  input.policy.allowFinancialAmounts = false;
  const result = sanitizePrivacyInput(input);
  assert.equal(result.sanitizedInput.userMessage, "AMOUNT_REMOVED");
  assert.equal(result.redactions.some((item) => item.category === "FINANCIAL"), true);
  assert.equal(JSON.stringify(result).includes("125000"), false);
});

test("hardening: forged sanitized payloads and lying summaries are rejected", () => {
  const clean = sanitizePrivacyInput(validInput());
  const forbiddenMessages = [
    "Téléphone 70 12 34 56",
    "Email awa@example.com",
    "Adresse Ouagadougou secteur 15",
    "Facture pour Awa Kaboré",
    "IFU 00012345",
    "OTP 123456",
  ];
  for (const userMessage of forbiddenMessages) {
    const forged = {
      ...clean,
      sanitizedInput: { userMessage, context: {} },
    };
    assert.equal(validatePrivacyResult(forged).valid, false);
    assert.equal(isPrivacySafeForProvider(forged), false);
  }
  const contextCases = [
    { phone: "70 12 34 56" },
    { email: "awa@example.com" },
    { address: "Ouagadougou" },
    { waId: "22670123456" },
    { passport: "AB12345" },
    { customerName: "Awa Kaboré" },
    { ifu: "00012345" },
    { apiKey: "secret-value" },
  ];
  for (const context of contextCases) {
    const forged = {
      ...clean,
      sanitizedInput: { userMessage: "Public", context },
    };
    assert.equal(validatePrivacyResult(forged).valid, false);
    assert.equal(isPrivacySafeForProvider(forged), false);
  }
  const lying = {
    ...clean,
    summary: { ...clean.summary, containsPersonalDataAfter: true },
  };
  assert.equal(validatePrivacyResult(lying).valid, false);
  assert.equal(isPrivacySafeForProvider(lying), false);
});

test("hardening: result references remain deeply independent", () => {
  const input = validInput({ context: { customerName: "Awa Kaboré" } });
  const first = sanitizePrivacyInput(input);
  const second = sanitizePrivacyInput(input);
  for (const key of [
    "errors", "redactions", "sanitizedInput", "restorationMap", "summary",
  ]) assert.notStrictEqual(first[key], second[key]);
  assert.notStrictEqual(first.sanitizedInput.context, second.sanitizedInput.context);
  first.redactions.forEach((item, index) =>
    assert.notStrictEqual(item, second.redactions[index])
  );
  first.errors.push({ path: "changed", code: "INVALID_RESULT" });
  first.redactions[0].path = "changed";
  first.sanitizedInput.context.customerName = "changed";
  first.restorationMap.PERSON_1 = "changed";
  first.summary.dataMinimized = false;
  assert.notEqual(JSON.stringify(first), JSON.stringify(second));
});
