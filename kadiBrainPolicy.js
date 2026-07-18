"use strict";

const { BRAIN_MODES, normalizeBrainMode } = require("./kadiBrainConfig");

const MVP_DOCUMENT_TYPES = Object.freeze([
  "devis",
  "facture",
  "recu",
  "decharge",
]);

const MVP_INTENTS = Object.freeze([
  "create_document",
  "edit_document",
  "clarify",
  "confirm_document",
]);

const BRAIN_POLICY_REASONS = Object.freeze({
  ELIGIBLE: "eligible",
  INVALID_INPUT: "invalid_input",
  MODE_NOT_CANDIDATE_CAPABLE: "mode_not_candidate_capable",
  MISSING_TEXT: "missing_text",
  LOCAL_COMMAND: "local_command",
  ADMIN_COMMAND: "admin_command",
  UNSUPPORTED_INTENT: "unsupported_intent",
  UNSUPPORTED_DOCUMENT_TYPE: "unsupported_document_type",
});

const CANDIDATE_MODES = new Set([
  BRAIN_MODES.CANDIDATE,
  BRAIN_MODES.ACTIVE_ALLOWLIST,
  BRAIN_MODES.ACTIVE,
]);
const MVP_INTENT_SET = new Set(MVP_INTENTS);
const MVP_DOCUMENT_TYPE_SET = new Set(MVP_DOCUMENT_TYPES);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeTextValue(value) {
  return typeof value === "string" ? value.trim() : null;
}

function normalizeIntent(value) {
  const text = normalizeTextValue(value);
  return text ? text.toLowerCase() : null;
}

function normalizeDocumentType(value) {
  const text = normalizeTextValue(value);
  if (!text) return null;

  const normalized = text.toLowerCase();
  if (normalized === "reçu") return "recu";
  if (normalized === "décharge") return "decharge";
  return normalized;
}

function makeDecision({ eligible, reason, documentType, intent, mode, metadata }) {
  return {
    eligible,
    reason,
    documentType,
    intent,
    mode,
    metadata,
  };
}

function evaluateBrainMvpPolicy(input) {
  if (!isPlainObject(input)) {
    return makeDecision({
      eligible: false,
      reason: BRAIN_POLICY_REASONS.INVALID_INPUT,
      documentType: null,
      intent: null,
      mode: null,
      metadata: {
        hasText: false,
        isLocalCommand: false,
        isAdminCommand: false,
      },
    });
  }

  const mode = normalizeBrainMode(input.mode);
  const text = normalizeTextValue(input.text);
  const intent = normalizeIntent(input.intent);
  const documentType = normalizeDocumentType(input.documentType);
  const metadata = {
    hasText: Boolean(text),
    isLocalCommand: input.isLocalCommand === true,
    isAdminCommand: input.isAdminCommand === true,
  };

  const reject = (reason) =>
    makeDecision({
      eligible: false,
      reason,
      documentType,
      intent,
      mode,
      metadata,
    });

  if (!CANDIDATE_MODES.has(mode)) {
    return reject(BRAIN_POLICY_REASONS.MODE_NOT_CANDIDATE_CAPABLE);
  }
  if (!metadata.hasText) {
    return reject(BRAIN_POLICY_REASONS.MISSING_TEXT);
  }
  if (metadata.isAdminCommand) {
    return reject(BRAIN_POLICY_REASONS.ADMIN_COMMAND);
  }
  if (metadata.isLocalCommand) {
    return reject(BRAIN_POLICY_REASONS.LOCAL_COMMAND);
  }
  if (!MVP_INTENT_SET.has(intent)) {
    return reject(BRAIN_POLICY_REASONS.UNSUPPORTED_INTENT);
  }
  if (!MVP_DOCUMENT_TYPE_SET.has(documentType)) {
    return reject(BRAIN_POLICY_REASONS.UNSUPPORTED_DOCUMENT_TYPE);
  }

  return makeDecision({
    eligible: true,
    reason: BRAIN_POLICY_REASONS.ELIGIBLE,
    documentType,
    intent,
    mode,
    metadata,
  });
}

module.exports = {
  MVP_DOCUMENT_TYPES,
  MVP_INTENTS,
  BRAIN_POLICY_REASONS,
  evaluateBrainMvpPolicy,
};
