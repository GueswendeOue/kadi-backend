"use strict";

const KADI_PRIVACY_SCHEMA_VERSION = "kadi.privacy-gateway.v1";
const KADI_PRIVACY_INPUT_VERSION = "kadi.privacy-input.v1";
const KADI_PRIVACY_RESULT_VERSION = "kadi.privacy-result.v1";

const KADI_PRIVACY_CATEGORIES = Object.freeze({
  NONE: "NONE",
  PUBLIC: "PUBLIC",
  PERSONAL_NAME: "PERSONAL_NAME",
  PHONE: "PHONE",
  EMAIL: "EMAIL",
  ADDRESS: "ADDRESS",
  BUSINESS_IDENTIFIER: "BUSINESS_IDENTIFIER",
  FINANCIAL: "FINANCIAL",
  BUSINESS_SENSITIVE: "BUSINESS_SENSITIVE",
  DOCUMENT_SENSITIVE: "DOCUMENT_SENSITIVE",
  AUTH_SECRET: "AUTH_SECRET",
  ACCESS_SECRET: "ACCESS_SECRET",
  SESSION_IDENTIFIER: "SESSION_IDENTIFIER",
  RAW_IDENTITY: "RAW_IDENTITY",
  UNKNOWN_SENSITIVE: "UNKNOWN_SENSITIVE",
});

const KADI_PRIVACY_ACTIONS = Object.freeze({
  KEEP: "KEEP",
  REMOVE: "REMOVE",
  REDACT: "REDACT",
  PSEUDONYMIZE: "PSEUDONYMIZE",
  BLOCK: "BLOCK",
});

const KADI_PRIVACY_DECISIONS = Object.freeze({
  ALLOWED: "ALLOWED",
  ALLOWED_WITH_REDACTION: "ALLOWED_WITH_REDACTION",
  BLOCKED: "BLOCKED",
  INVALID_INPUT: "INVALID_INPUT",
  INTERNAL_FAILURE: "INTERNAL_FAILURE",
});

const KADI_PRIVACY_ERROR_CODES = Object.freeze({
  NONE: "NONE",
  INVALID_INPUT: "INVALID_INPUT",
  INVALID_SCHEMA: "INVALID_SCHEMA",
  MESSAGE_TOO_LONG: "MESSAGE_TOO_LONG",
  CONTEXT_TOO_LARGE: "CONTEXT_TOO_LARGE",
  SECRET_DETECTED: "SECRET_DETECTED",
  UNSAFE_KEY: "UNSAFE_KEY",
  INVALID_RESTORATION_MAP: "INVALID_RESTORATION_MAP",
  INVALID_REDACTION: "INVALID_REDACTION",
  INVALID_RESULT: "INVALID_RESULT",
  INTERNAL_PRIVACY_FAILURE: "INTERNAL_PRIVACY_FAILURE",
});

const KADI_PRIVACY_LIMITS = Object.freeze({
  maxUserMessageCodePoints: 12000,
  maxContextEntries: 100,
  maxContextDepth: 6,
  maxContextStringCodePoints: 4000,
  maxRedactions: 200,
  maxRestorationEntries: 100,
  maxAliasCodePoints: 64,
  maxPathCodePoints: 256,
});

const DEFAULT_POLICY = Object.freeze({
  allowPersonalNames: false,
  allowBusinessIdentifiers: false,
  allowFinancialAmounts: true,
  blockSecrets: true,
  pseudonymizeNames: true,
  removePhones: true,
  removeEmails: true,
  removeAddresses: true,
});

const CATEGORY_VALUES = new Set(Object.values(KADI_PRIVACY_CATEGORIES));
const ACTION_VALUES = new Set(Object.values(KADI_PRIVACY_ACTIONS));
const DECISION_VALUES = new Set(Object.values(KADI_PRIVACY_DECISIONS));
const ERROR_VALUES = new Set(Object.values(KADI_PRIVACY_ERROR_CODES));
const DANGEROUS_KEYS = new Set(["proto", "prototype", "constructor"]);
const POLICY_KEYS = Object.keys(DEFAULT_POLICY);
const SECRET_CATEGORIES = new Set(["AUTH_SECRET", "ACCESS_SECRET"]);
const PERSONAL_CATEGORIES = new Set([
  "PERSONAL_NAME", "PHONE", "EMAIL", "ADDRESS", "RAW_IDENTITY",
  "SESSION_IDENTIFIER", "DOCUMENT_SENSITIVE",
]);

const KEY_GROUPS = Object.freeze({
  PERSONAL_NAME: new Set([
    "name", "fullname", "customername", "clientname", "recipientname",
    "sendername", "nom", "nomclient",
  ]),
  PHONE: new Set([
    "phone", "phonenumber", "customerphone", "recipientphone", "senderphone",
    "mobile", "telephone", "tel",
  ]),
  EMAIL: new Set(["email", "customeremail", "recipientemail", "senderemail"]),
  ADDRESS: new Set([
    "address", "customeraddress", "billingaddress", "deliveryaddress",
    "location", "adresse",
  ]),
  BUSINESS_IDENTIFIER: new Set([
    "ifu", "rccm", "taxid", "fiscalid", "companyregistration",
    "businessregistration",
  ]),
  FINANCIAL: new Set([
    "amount", "total", "unitprice", "price", "subtotal", "tax", "vat",
    "balance", "currency",
  ]),
  AUTH_SECRET: new Set([
    "password", "passcode", "pin", "otp", "onetimepassword",
    "verificationcode", "mobilemoneypin",
  ]),
  ACCESS_SECRET: new Set([
    "apikey", "accesstoken", "refreshtoken", "servicerolekey",
    "bearertoken", "secretkey",
  ]),
  SESSION_IDENTIFIER: new Set([
    "sessionid", "requestid", "correlationid", "traceid",
  ]),
  RAW_IDENTITY: new Set([
    "waid", "bsuid", "userid", "phonenumberid", "whatsappid",
  ]),
  DOCUMENT_SENSITIVE: new Set([
    "identitycard", "idcard", "passport", "signature", "stamp",
    "fingerprint", "nationalid",
  ]),
});

const TEXT_PATTERNS = Object.freeze([
  ["EMAIL", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu],
  ["PHONE", /(?:\+?226[\s.-]*)?(?:[02567]\d(?:[\s.-]*\d{2}){3})\b/gu],
  ["AUTH_SECRET", /\b(?:mot[\s-]*de[\s-]*passe|password|passcode|pin|otp|code[\s-]*de[\s-]*v[ée]rification|mobile[\s-]*money[\s-]*pin)\b\s*[:=]?\s*\S+/giu],
  ["ACCESS_SECRET", /\b(?:api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|service[\s_-]*role[\s_-]*key|bearer[\s_-]*token|secret[\s_-]*key)\b\s*[:=]?\s*\S+/giu],
  ["BUSINESS_IDENTIFIER", /\b(?:IFU|RCCM|tax[\s_-]*id|fiscal[\s_-]*id)\b\s*[:=]?\s*[A-Z0-9./-]+/giu],
  ["DOCUMENT_SENSITIVE", /\b(?:passport|carte[\s-]*d['’]?identit[ée]|national[\s_-]*id)\b\s*[:=]?\s*[A-Z0-9./-]+/giu],
  ["FINANCIAL", /\b(?:montant|total|prix|solde)\b\s*[:=]?\s*\d[\d\s.,]*(?:FCFA|XOF|€|\$)?/giu],
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function codePointLength(value) {
  return Array.from(value).length;
}

function normalizeKey(key) {
  return String(key).trim().toLowerCase().replace(/[_\-\s]/g, "");
}

function isDangerousKey(key) {
  return DANGEROUS_KEYS.has(normalizeKey(key));
}

function inspectStructure(value, seen = new Set()) {
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return "INVALID_INPUT";
  seen.add(value);
  if (!Array.isArray(value) && !isPlainObject(value)) return "INVALID_INPUT";
  for (const key of Object.keys(value)) {
    if (isDangerousKey(key)) return "UNSAFE_KEY";
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) return "INVALID_INPUT";
    const issue = inspectStructure(descriptor.value, seen);
    if (issue) return issue;
  }
  seen.delete(value);
  return null;
}

function createEmptyPrivacyInput() {
  return {
    schemaVersion: KADI_PRIVACY_INPUT_VERSION,
    userMessage: "",
    context: {},
    policy: { ...DEFAULT_POLICY },
  };
}

function createEmptyPrivacyResult() {
  return {
    schemaVersion: KADI_PRIVACY_RESULT_VERSION,
    allowed: false,
    decision: KADI_PRIVACY_DECISIONS.INVALID_INPUT,
    errorCode: KADI_PRIVACY_ERROR_CODES.NONE,
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
  };
}

function classifySensitiveKey(key) {
  try {
    const normalized = normalizeKey(key);
    for (const [category, keys] of Object.entries(KEY_GROUPS)) {
      if (keys.has(normalized)) return category;
    }
    return KADI_PRIVACY_CATEGORIES.NONE;
  } catch {
    return KADI_PRIVACY_CATEGORIES.NONE;
  }
}

function detectSensitiveText(text) {
  if (typeof text !== "string") return [];
  const detections = [];
  for (const [category, pattern] of TEXT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      detections.push({
        category,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  return detections
    .sort((a, b) => a.start - b.start || a.end - b.end || a.category.localeCompare(b.category))
    .filter((item, index, list) =>
      index === 0 ||
      item.start !== list[index - 1].start ||
      item.end !== list[index - 1].end ||
      item.category !== list[index - 1].category
    );
}

function cloneContextValue(value, state, depth) {
  if (depth > KADI_PRIVACY_LIMITS.maxContextDepth) throw new Error("CONTEXT_TOO_LARGE");
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return value;
  if (typeof value === "string") {
    if (codePointLength(value) > KADI_PRIVACY_LIMITS.maxContextStringCodePoints) {
      throw new Error("CONTEXT_TOO_LARGE");
    }
    return value;
  }
  if (!value || typeof value !== "object") return undefined;
  if (state.seen.has(value)) throw new Error("INVALID_INPUT");
  state.seen.add(value);
  const output = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value)) {
    state.entries += 1;
    if (state.entries > KADI_PRIVACY_LIMITS.maxContextEntries) {
      throw new Error("CONTEXT_TOO_LARGE");
    }
    if (isDangerousKey(key)) throw new Error("UNSAFE_KEY");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) throw new Error("INVALID_INPUT");
    const cloned = cloneContextValue(descriptor.value, state, depth + 1);
    if (cloned !== undefined) {
      if (Array.isArray(output)) output.push(cloned);
      else output[key] = cloned;
    }
  }
  state.seen.delete(value);
  return output;
}

function normalizePrivacyInput(input) {
  try {
    if (!isPlainObject(input)) return createEmptyPrivacyInput();
    const structuralIssue = inspectStructure(input);
    if (structuralIssue) {
      const invalid = createEmptyPrivacyInput();
      invalid.schemaVersion = null;
      return invalid;
    }
    const result = createEmptyPrivacyInput();
    result.schemaVersion =
      typeof input.schemaVersion === "string"
        ? input.schemaVersion
        : KADI_PRIVACY_INPUT_VERSION;
    result.userMessage =
      typeof input.userMessage === "string" ? input.userMessage.trim() : "";
    if (codePointLength(result.userMessage) > KADI_PRIVACY_LIMITS.maxUserMessageCodePoints) {
      result.schemaVersion = null;
      return result;
    }
    if (input.context !== undefined) {
      if (!isPlainObject(input.context)) {
        result.schemaVersion = null;
        return result;
      }
      result.context = cloneContextValue(
        input.context,
        { entries: 0, seen: new Set() },
        0
      );
    }
    if (input.policy !== undefined) {
      if (!isPlainObject(input.policy)) {
        result.schemaVersion = null;
        return result;
      }
      result.policy = {};
      for (const key of POLICY_KEYS) {
        result.policy[key] =
          typeof input.policy[key] === "boolean"
            ? input.policy[key]
            : DEFAULT_POLICY[key];
      }
    }
    return result;
  } catch {
    const invalid = createEmptyPrivacyInput();
    invalid.schemaVersion = null;
    return invalid;
  }
}

function addRedaction(state, path, category, action, alias = null) {
  if (state.redactions.length >= KADI_PRIVACY_LIMITS.maxRedactions) {
    throw new Error("CONTEXT_TOO_LARGE");
  }
  state.redactions.push({ path, category, action, alias });
}

function aliasName(value, state) {
  if (state.nameAliases.has(value)) return state.nameAliases.get(value);
  if (state.nameAliases.size >= KADI_PRIVACY_LIMITS.maxRestorationEntries) {
    throw new Error("INVALID_RESTORATION_MAP");
  }
  const alias = `PERSON_${state.nameAliases.size + 1}`;
  state.nameAliases.set(value, alias);
  state.restorationMap[alias] = value;
  return alias;
}

function textNameMatches(text) {
  const pattern = /\b(?:pour|client(?:e)?|nom)\s+([A-ZÀ-ÖØ-Þ][\p{L}'’.-]+(?:\s+[A-ZÀ-ÖØ-Þ][\p{L}'’.-]+)+)/gu;
  const matches = [];
  for (const match of text.matchAll(pattern)) {
    const value = match[1];
    const start = match.index + match[0].lastIndexOf(value);
    matches.push({ start, end: start + value.length, value });
  }
  return matches;
}

function sanitizeText(text, path, policy, state) {
  const replacements = [];
  for (const detection of detectSensitiveText(text)) {
    if (SECRET_CATEGORIES.has(detection.category)) {
      state.containsSecrets = true;
      continue;
    }
    if (detection.category === "PHONE" && policy.removePhones) {
      replacements.push({ ...detection, replacement: "" });
      addRedaction(state, path, "PHONE", "REMOVE");
      state.personalBefore = true;
    } else if (detection.category === "EMAIL" && policy.removeEmails) {
      replacements.push({ ...detection, replacement: "" });
      addRedaction(state, path, "EMAIL", "REMOVE");
      state.personalBefore = true;
    } else if (detection.category === "BUSINESS_IDENTIFIER" && !policy.allowBusinessIdentifiers) {
      replacements.push({ ...detection, replacement: "BUSINESS_ID_REMOVED" });
      addRedaction(state, path, "BUSINESS_IDENTIFIER", "REDACT");
      state.businessSensitive = true;
    } else if (detection.category === "DOCUMENT_SENSITIVE") {
      replacements.push({ ...detection, replacement: "" });
      addRedaction(state, path, "DOCUMENT_SENSITIVE", "REMOVE");
      state.personalBefore = true;
    } else if (detection.category === "FINANCIAL" && !policy.allowFinancialAmounts) {
      replacements.push({ ...detection, replacement: "AMOUNT_REMOVED" });
      addRedaction(state, path, "FINANCIAL", "REDACT");
    }
  }
  if (!policy.allowPersonalNames && policy.pseudonymizeNames) {
    for (const match of textNameMatches(text)) {
      const alias = aliasName(match.value, state);
      replacements.push({
        start: match.start,
        end: match.end,
        replacement: alias,
        category: "PERSONAL_NAME",
      });
      addRedaction(state, path, "PERSONAL_NAME", "PSEUDONYMIZE", alias);
      state.personalBefore = true;
    }
  }
  let result = text;
  const accepted = replacements
    .sort((a, b) => b.start - a.start || b.end - a.end)
    .filter((item, index, list) =>
      !list.slice(0, index).some(
        (other) => item.start < other.end && item.end > other.start
      )
    );
  for (const item of accepted) {
    result = `${result.slice(0, item.start)}${item.replacement}${result.slice(item.end)}`;
  }
  return result.replace(/\s{2,}/g, " ").trim();
}

function sanitizeContextValue(value, path, policy, state, keyCategory = "NONE") {
  if (SECRET_CATEGORIES.has(keyCategory)) {
    state.containsSecrets = true;
    return undefined;
  }
  if (keyCategory === "PERSONAL_NAME") {
    state.personalBefore = true;
    if (!policy.allowPersonalNames) {
      if (policy.pseudonymizeNames && typeof value === "string") {
        const alias = aliasName(value, state);
        addRedaction(state, path, keyCategory, "PSEUDONYMIZE", alias);
        return alias;
      }
      addRedaction(state, path, keyCategory, "REMOVE");
      return undefined;
    }
    state.personalAfter = true;
  }
  if (
    (keyCategory === "PHONE" && policy.removePhones) ||
    (keyCategory === "EMAIL" && policy.removeEmails) ||
    (keyCategory === "ADDRESS" && policy.removeAddresses) ||
    keyCategory === "RAW_IDENTITY" ||
    keyCategory === "SESSION_IDENTIFIER" ||
    keyCategory === "DOCUMENT_SENSITIVE"
  ) {
    state.personalBefore = true;
    addRedaction(state, path, keyCategory, "REMOVE");
    return undefined;
  }
  if (keyCategory === "BUSINESS_IDENTIFIER" && !policy.allowBusinessIdentifiers) {
    state.businessSensitive = true;
    addRedaction(state, path, keyCategory, "REDACT");
    return "BUSINESS_ID_REMOVED";
  }
  if (keyCategory === "FINANCIAL" && !policy.allowFinancialAmounts) {
    addRedaction(state, path, keyCategory, "REDACT");
    return "AMOUNT_REMOVED";
  }
  if (typeof value === "string") return sanitizeText(value, path, policy, state);
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      sanitizeContextValue(item, `${path}[${index}]`, policy, state)
    ).filter((item) => item !== undefined);
  }
  if (isPlainObject(value)) {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      const childPath = `${path}.${key}`;
      const sanitized = sanitizeContextValue(
        value[key],
        childPath,
        policy,
        state,
        classifySensitiveKey(key)
      );
      if (sanitized !== undefined) output[key] = sanitized;
    }
    return output;
  }
  return value;
}

function invalidPrivacyResult(errorCode, path = "$") {
  const result = createEmptyPrivacyResult();
  result.errorCode = errorCode;
  result.errors = [{ path, code: errorCode }];
  return result;
}

function sanitizePrivacyInput(input) {
  try {
    if (!isPlainObject(input)) return invalidPrivacyResult("INVALID_INPUT");
    const structuralIssue = inspectStructure(input);
    if (structuralIssue) return invalidPrivacyResult(structuralIssue);
    const normalized = normalizePrivacyInput(input);
    if (normalized.schemaVersion !== KADI_PRIVACY_INPUT_VERSION) {
      return invalidPrivacyResult(
        typeof input.userMessage === "string" &&
        codePointLength(input.userMessage) > KADI_PRIVACY_LIMITS.maxUserMessageCodePoints
          ? "MESSAGE_TOO_LONG"
          : input.schemaVersion &&
              input.schemaVersion !== KADI_PRIVACY_INPUT_VERSION
            ? "INVALID_SCHEMA"
            : "INVALID_INPUT"
      );
    }
    const state = {
      containsSecrets: false,
      personalBefore: false,
      personalAfter: false,
      businessSensitive: false,
      redactions: [],
      restorationMap: {},
      nameAliases: new Map(),
    };
    const sanitizedMessage = sanitizeText(
      normalized.userMessage,
      "userMessage",
      normalized.policy,
      state
    );
    const sanitizedContext = sanitizeContextValue(
      normalized.context,
      "context",
      normalized.policy,
      state
    );
    if (state.containsSecrets && normalized.policy.blockSecrets) {
      const blocked = invalidPrivacyResult("SECRET_DETECTED");
      blocked.decision = "BLOCKED";
      blocked.summary.containsSecrets = true;
      return blocked;
    }
    state.redactions.sort((a, b) =>
      a.path.localeCompare(b.path) ||
      a.category.localeCompare(b.category) ||
      String(a.alias).localeCompare(String(b.alias))
    );
    const result = createEmptyPrivacyResult();
    result.allowed = true;
    result.decision =
      state.redactions.length > 0 ? "ALLOWED_WITH_REDACTION" : "ALLOWED";
    result.errorCode = "NONE";
    result.sanitizedInput = {
      userMessage: sanitizedMessage,
      context: sanitizedContext,
    };
    result.redactions = state.redactions;
    result.restorationMap = state.restorationMap;
    result.summary = {
      containsSecrets: state.containsSecrets,
      containsPersonalDataBefore: state.personalBefore,
      containsPersonalDataAfter: state.personalAfter,
      containsBusinessSensitiveData: state.businessSensitive,
      dataMinimized: state.redactions.length > 0,
    };
    return result;
  } catch {
    const failed = createEmptyPrivacyResult();
    failed.decision = "INTERNAL_FAILURE";
    failed.errorCode = "INTERNAL_PRIVACY_FAILURE";
    failed.errors = [{ path: "$", code: "INTERNAL_PRIVACY_FAILURE" }];
    return failed;
  }
}

function validatePrivacyResult(result) {
  const errors = [];
  const add = (path, code) => errors.push({ path, code });
  try {
    if (!isPlainObject(result)) {
      return { valid: false, errors: [{ path: "$", code: "INVALID_RESULT" }] };
    }
    if (inspectStructure(result)) add("$", "UNSAFE_KEY");
    const exactKeys = [
      "schemaVersion", "allowed", "decision", "errorCode", "errors",
      "sanitizedInput", "redactions", "restorationMap", "summary",
    ];
    if (JSON.stringify(Object.keys(result)) !== JSON.stringify(exactKeys)) add("$", "INVALID_RESULT");
    if (result.schemaVersion !== KADI_PRIVACY_RESULT_VERSION) add("schemaVersion", "INVALID_SCHEMA");
    if (typeof result.allowed !== "boolean") add("allowed", "INVALID_RESULT");
    if (!DECISION_VALUES.has(result.decision)) add("decision", "INVALID_RESULT");
    if (!ERROR_VALUES.has(result.errorCode)) add("errorCode", "INVALID_RESULT");
    if (!Array.isArray(result.errors)) add("errors", "INVALID_RESULT");
    else result.errors.forEach((error, index) => {
      if (
        !isPlainObject(error) ||
        JSON.stringify(Object.keys(error)) !== JSON.stringify(["path", "code"]) ||
        typeof error.path !== "string" ||
        codePointLength(error.path) > KADI_PRIVACY_LIMITS.maxPathCodePoints ||
        !ERROR_VALUES.has(error.code)
      ) add(`errors[${index}]`, "INVALID_RESULT");
    });
    if (
      !isPlainObject(result.sanitizedInput) ||
      JSON.stringify(Object.keys(result.sanitizedInput)) !==
        JSON.stringify(["userMessage", "context"]) ||
      typeof result.sanitizedInput.userMessage !== "string" ||
      !isPlainObject(result.sanitizedInput.context)
    ) add("sanitizedInput", "INVALID_RESULT");
    if (!Array.isArray(result.redactions) ||
        result.redactions.length > KADI_PRIVACY_LIMITS.maxRedactions) {
      add("redactions", "INVALID_REDACTION");
    } else result.redactions.forEach((redaction, index) => {
      if (
        !isPlainObject(redaction) ||
        JSON.stringify(Object.keys(redaction)) !==
          JSON.stringify(["path", "category", "action", "alias"]) ||
        typeof redaction.path !== "string" ||
        codePointLength(redaction.path) > KADI_PRIVACY_LIMITS.maxPathCodePoints ||
        !CATEGORY_VALUES.has(redaction.category) ||
        !ACTION_VALUES.has(redaction.action) ||
        (redaction.alias !== null &&
          (typeof redaction.alias !== "string" ||
            codePointLength(redaction.alias) > KADI_PRIVACY_LIMITS.maxAliasCodePoints))
      ) add(`redactions[${index}]`, "INVALID_REDACTION");
    });
    if (
      !isPlainObject(result.restorationMap) ||
      Object.keys(result.restorationMap).length >
        KADI_PRIVACY_LIMITS.maxRestorationEntries
    ) add("restorationMap", "INVALID_RESTORATION_MAP");
    else for (const [alias, value] of Object.entries(result.restorationMap)) {
      if (
        isDangerousKey(alias) ||
        typeof value !== "string" ||
        codePointLength(alias) > KADI_PRIVACY_LIMITS.maxAliasCodePoints ||
        detectSensitiveText(value).some((item) => SECRET_CATEGORIES.has(item.category))
      ) add("restorationMap", "INVALID_RESTORATION_MAP");
    }
    const summaryKeys = [
      "containsSecrets", "containsPersonalDataBefore", "containsPersonalDataAfter",
      "containsBusinessSensitiveData", "dataMinimized",
    ];
    if (
      !isPlainObject(result.summary) ||
      JSON.stringify(Object.keys(result.summary)) !== JSON.stringify(summaryKeys) ||
      summaryKeys.some((key) => typeof result.summary[key] !== "boolean")
    ) add("summary", "INVALID_RESULT");
    if (result.decision === "ALLOWED") {
      if (!result.allowed || result.errorCode !== "NONE") add("decision", "INVALID_RESULT");
    } else if (result.decision === "ALLOWED_WITH_REDACTION") {
      if (
        !result.allowed ||
        result.errorCode !== "NONE" ||
        !result.redactions?.length ||
        result.summary?.dataMinimized !== true
      ) add("decision", "INVALID_RESULT");
    } else if (result.decision === "BLOCKED") {
      if (
        result.allowed ||
        result.errorCode === "NONE" ||
        (result.errorCode === "SECRET_DETECTED" &&
          Object.keys(result.restorationMap || {}).length > 0)
      ) add("decision", "INVALID_RESULT");
    } else if (result.decision === "INVALID_INPUT") {
      if (
        result.allowed ||
        !["INVALID_INPUT", "INVALID_SCHEMA", "MESSAGE_TOO_LONG", "CONTEXT_TOO_LARGE", "UNSAFE_KEY", "NONE"].includes(result.errorCode)
      ) add("decision", "INVALID_RESULT");
    } else if (result.decision === "INTERNAL_FAILURE") {
      if (result.allowed || result.errorCode !== "INTERNAL_PRIVACY_FAILURE") {
        add("decision", "INVALID_RESULT");
      }
    }
  } catch {
    return { valid: false, errors: [{ path: "$", code: "INVALID_RESULT" }] };
  }
  return { valid: errors.length === 0, errors };
}

function isPrivacySafeForProvider(result) {
  try {
    if (!validatePrivacyResult(result).valid) return false;
    if (!result.allowed || result.summary.containsSecrets) return false;
    if (result.summary.containsPersonalDataAfter) return false;
    if (inspectStructure(result.sanitizedInput)) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = {
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
};
