"use strict";

const crypto = require("node:crypto");
const writtenNumber = require("written-number");

const VOICE_RESPONSE_MODES = Object.freeze(["TEXT_ONLY", "TEXT_AND_VOICE", "VOICE_WHEN_HELPFUL"]);
const VOICE_DECISIONS = Object.freeze(["TEXT_ONLY", "TEXT_AND_VOICE"]);
const VOICE_COST_POLICIES = Object.freeze(["FREE", "INCLUDED_IN_ACTION", "SEPARATE_CREDIT_COST"]);
const KADI_VOICE_STYLE = Object.freeze({
  id: "KADI_WEST_AFRICAN_FRENCH_V1",
  gender_identity: "FEMININE",
  regional_identity: "WEST_AFRICAN",
  qualities: Object.freeze(["NATURAL", "WARM", "PROFESSIONAL", "CLEAR", "CALM", "REASSURING"]),
  avoid: Object.freeze(["CARICATURE", "EXAGGERATED_ACCENT"]),
  pronunciation_hints: Object.freeze(["francs CFA", "IFU", "RCCM", "WhatsApp", "Mobile Money", "noms locaux", "montants"]),
});

const SENSITIVITY_RULES = Object.freeze([
  ["PHONE", /(?:\+?\d[\s.-]*){8,}/],
  ["FISCAL_ID", /\b(?:IFU|RCCM)\s*[:#-]?\s*[A-Z0-9-]{5,}\b/i],
  ["ACCOUNT", /\b(?:IBAN|compte|account)\s*[:#-]?\s*[A-Z0-9 -]{8,}\b/i],
  ["VALIDATION_CODE", /\b(?:code|PIN|OTP)\s*[:#-]?\s*\d{4,8}\b/i],
  ["TOKEN", /\b(?:token|bearer|secret|clé API|api[_ -]?key)\s*[:=]\s*\S+/i],
  ["PAYMENT_REFERENCE", /\b(?:référence de paiement|payment reference)\s*[:#-]?\s*[A-Z0-9-]{6,}\b/i],
  ["URL", /https?:\/\/\S+/i],
  ["JSON", /\{\s*"[^"\r\n]+"\s*:/],
]);

function detectSensitiveContent(text) {
  const value = typeof text === "string" ? text : "";
  const categories = SENSITIVITY_RULES.filter(([, pattern]) => pattern.test(value)).map(([category]) => category);
  return Object.freeze({ sensitive: categories.length > 0, categories: Object.freeze(categories) });
}

function numberInFrench(value) {
  const integer = Number(String(value).replace(/\s/g, ""));
  if (!Number.isSafeInteger(integer) || integer < 0 || integer > 999_999_999) return null;
  try { return writtenNumber(integer, { lang: "fr" }).replace(/-/g, " "); } catch { return String(integer); }
}

function prepareTextForSpeech(validatedText, { maxCharacters = 1_200 } = {}) {
  if (typeof validatedText !== "string" || !validatedText.trim()) return { ok: false, error: "CANONICAL_TEXT_REQUIRED" };
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 100) return { ok: false, error: "SPEECH_TEXT_LIMIT_INVALID" };
  const sensitivity = detectSensitiveContent(validatedText);
  if (sensitivity.sensitive) return { ok: false, error: "SENSITIVE_TEXT_BLOCKED", sensitivity };
  let speech = validatedText.replace(/https?:\/\/\S+/gi, "Consultez le lien dans le message écrit.");
  if (/\{\s*"[^"\r\n]+"\s*:/.test(speech)) return { ok: false, error: "TECHNICAL_TEXT_BLOCKED" };
  speech = speech.replace(/([0-9][0-9 ]*)\s*[×x]\s*([0-9]+)(?!\d)/g, (match, price, count) => {
    const priceWords = numberInFrench(price);
    const countWords = numberInFrench(count);
    return priceWords && countWords ? `${countWords} articles à ${priceWords} francs chacun` : match;
  });
  speech = speech.replace(/([0-9][0-9 ]*)\s*(?:F\s*CFA|FCFA|francs?\s+CFA)/gi, (match, amount) => {
    const words = numberInFrench(amount);
    return words ? `${words} francs CFA` : match;
  });
  speech = speech.replace(/([0-9][0-9 ]*)\s+crédits?\b/gi, (match, amount) => {
    const words = numberInFrench(amount);
    return words ? `${words} crédit${Number(String(amount).replace(/\s/g, "")) > 1 ? "s" : ""}` : match;
  });
  speech = speech.replace(/([0-9][0-9 ]*)\s+(pages?|articles?|éléments?)\b/gi, (match, amount, unit) => {
    const words = numberInFrench(amount);
    return words ? `${words} ${unit}` : match;
  });
  speech = speech.replace(/\s+/g, " ").trim();
  if (speech.length > maxCharacters) {
    speech = `${speech.slice(0, maxCharacters - 70).trim()} Consultez le message écrit pour tous les détails.`;
  }
  return {
    ok: true,
    value: Object.freeze({
      canonical_text: validatedText,
      speech_text: speech,
      canonical_text_checksum: crypto.createHash("sha256").update(validatedText).digest("hex"),
      semantically_derived: true,
    }),
  };
}

function createVoicePolicyEngine({ featureEnabled = false, costPolicy = "FREE", maxCostUnits = 0, logger = null } = {}) {
  if (!VOICE_COST_POLICIES.includes(costPolicy) || !Number.isFinite(maxCostUnits) || maxCostUnits < 0) throw new TypeError("VOICE_POLICY_CONFIG_INVALID");
  const sink = typeof logger === "function" ? logger : () => {};

  function evaluate(input = {}) {
    if (!VOICE_RESPONSE_MODES.includes(input.voice_response_mode)) throw new TypeError("VOICE_RESPONSE_MODE_INVALID");
    const text = input.validated_text;
    if (typeof text !== "string" || !text.trim()) throw new TypeError("CANONICAL_TEXT_REQUIRED");
    const detected = detectSensitiveContent(text);
    let decision = "TEXT_ONLY";
    let reason = "TEXT_DEFAULT";
    if (!featureEnabled) reason = "VOICE_FEATURE_DISABLED";
    else if (input.provider_available !== true) reason = "VOICE_PROVIDER_UNAVAILABLE";
    else if (detected.sensitive || input.contains_sensitive_data === true) reason = "SENSITIVE_DATA";
    else if (input.voice_response_mode === "TEXT_ONLY") reason = "USER_TEXT_ONLY";
    else if (costPolicy !== "FREE" && Number(input.estimated_cost_units || 0) > maxCostUnits) reason = "VOICE_COST_LIMIT";
    else if (input.journey_step === "SHORT_CONFIRMATION" && input.explicit_voice_request !== true) reason = "SHORT_CONFIRMATION";
    else if (input.voice_response_mode === "TEXT_AND_VOICE") { decision = "TEXT_AND_VOICE"; reason = "USER_TEXT_AND_VOICE"; }
    else if (input.explicit_voice_request === true) { decision = "TEXT_AND_VOICE"; reason = "EXPLICIT_REQUEST"; }
    else if (input.journey_step === "ONBOARDING_INITIAL") { decision = "TEXT_AND_VOICE"; reason = "INITIAL_ONBOARDING"; }
    else if (input.message_complexity === "COMPLEX") { decision = "TEXT_AND_VOICE"; reason = "COMPLEX_EXPLANATION"; }
    else if (input.last_input_modality === "VOICE") { decision = "TEXT_AND_VOICE"; reason = "VOICE_CONTINUITY"; }
    const result = Object.freeze({ decision, reason, sensitivity: detected, cost_policy: costPolicy, wallet_debit: false });
    try { sink("voice_policy_evaluated", Object.freeze({ decision, reason, sensitive: detected.sensitive })); } catch { /* non-authoritative */ }
    return result;
  }

  return Object.freeze({ evaluate, default_mode: "VOICE_WHEN_HELPFUL", cost_policy: costPolicy });
}

module.exports = {
  KADI_VOICE_STYLE,
  VOICE_COST_POLICIES,
  VOICE_DECISIONS,
  VOICE_RESPONSE_MODES,
  createVoicePolicyEngine,
  detectSensitiveContent,
  prepareTextForSpeech,
};
