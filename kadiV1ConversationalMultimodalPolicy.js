"use strict";

// KADI_CONVERSATIONAL_MULTIMODAL_V1 interpretation policy.
//
// This module is the "understand what the user wants" layer requested by the
// mission. It deliberately does NOT reimplement provider calls, structured
// extraction, or media/audio validation — it reuses the existing, tested
// kadiV1Brain (OpenAI/Gemini routing + contract validation) for that. It only
// adds what did not already exist: a wider intent vocabulary
// (CHECK_BALANCE/RECHARGE/CANCEL/SEARCH_HISTORY/HELP as first-class outcomes
// of this envelope, not just the live orchestrator's private fast path), and
// operation/correction detection for natural edits to an active draft.
//
// This module is intentionally NOT wired into kadiV1ConversationOrchestrator.js
// in this mission — wiring a new understanding path into the live,
// CANARY-serving orchestrator is a production-integration change that needs
// its own reviewed mission, not something an "isolated foundation" branch
// should do silently.

const { SCHEMA_VERSION, validateConversationalResult } = require("./kadiV1ConversationalMultimodalContracts");
const { detectNaturalIntent, validateCanonicalText } = require("./kadiV1ConversationOrchestrator");

const DETERMINISTIC_MIN_CONFIDENCE = 0.99; // rule matches are certain about intent, not about field values.
const DEFAULT_MIN_CONFIDENCE = 0.6;

const REMOVE_KEYWORDS = /\b(enleve|enlever|supprime|supprimer|retire|retirer)\b/;
const ADD_KEYWORDS = /\b(ajoute|ajouter|rajoute|rajouter)\b/;
// Captures the phrase after the remove verb (and an optional article) as the
// search target for item lookup — e.g. "enleve la livraison" -> "livraison".
// Operates on the already-normalized (accent-stripped, lowercased) text so
// the same normalization is trivially reused when matching against item
// descriptions later (kadiV1ConversationalMultimodalItemLookup.js).
const REMOVE_HINT_PATTERN = /\b(?:enleve|enlever|supprime|supprimer|retire|retirer)\b\s*(?:le|la|les|l)?\s*(.+)/;

// detectNaturalIntent's own vocabulary (MENU/BALANCE/HISTORY_SEARCH/
// PREPARE_DOCUMENT/HELP/CANCEL/CONTINUE) mapped onto this mission's
// vocabulary. MENU and CONTINUE are intentionally left unmapped: neither
// has a faithful equivalent in CREATE_DOCUMENT/UPDATE_DOCUMENT/
// SEARCH_HISTORY/CHECK_BALANCE/RECHARGE/CANCEL/HELP/UNKNOWN, so both fall
// through to the brain-backed path rather than being guessed at.
const ORCHESTRATOR_INTENT_MAP = Object.freeze({
  PREPARE_DOCUMENT: "CREATE_DOCUMENT",
  HISTORY_SEARCH: "SEARCH_HISTORY",
  BALANCE: "CHECK_BALANCE",
  HELP: "HELP",
  CANCEL: "CANCEL",
});

function normalizeForMatch(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

function detectLanguage(text) {
  const normalized = normalizeForMatch(text);
  if (!normalized) return "fr";
  const englishMarkers = /\b(the|invoice|quote|receipt|please|change|cancel|balance)\b/;
  const frenchMarkers = /\b(facture|devis|recu|reçu|decharge|décharge|le|la|les|pour|montant)\b/;
  if (frenchMarkers.test(normalized)) return "fr";
  if (englishMarkers.test(normalized)) return "en";
  return "fr";
}

function classifierMetadata(classifier, extra = {}) {
  return Object.freeze({ provider: "KADI_CONVERSATIONAL_MULTIMODAL_V1", classifier, ...extra });
}

function baseResult(overrides) {
  return {
    schema_version: SCHEMA_VERSION,
    document_type: null,
    operation: null,
    extracted_entities: {},
    requested_corrections: [],
    missing_fields: [],
    ambiguous_fields: [],
    needs_confirmation: false,
    confidence: DETERMINISTIC_MIN_CONFIDENCE,
    user_facing_message_draft: null,
    provider_metadata: classifierMetadata("DETERMINISTIC"),
    ...overrides,
  };
}

// Deterministic fast path: intents that never require field extraction, so
// there is no reason to spend an LLM call on them.
//
// This reuses kadiV1ConversationOrchestrator.js's own exported
// detectNaturalIntent for every intent it already covers (PREPARE_DOCUMENT/
// HISTORY_SEARCH/BALANCE/HELP/CANCEL), instead of maintaining a second,
// independently-tuned keyword classifier that could silently drift from the
// one actually serving CANARY traffic. Only RECHARGE and the "which
// document" ambiguity — neither of which detectNaturalIntent handles today
// — are classified here directly.
//
// CREATE_DOCUMENT is deliberately NOT short-circuited here even though
// detectNaturalIntent detects it: the live orchestrator's own direct path
// starts a blank document and discards the rest of that message (see
// kadiV1ConversationOrchestrator.js ~line 323), but this mission requires
// "Fais une facture pour Moussa." to also capture "Moussa" from the same
// message (§Phase 5, "reuse information already provided"). Reusing the
// live short-circuit as-is would be a real behavioral regression against
// that requirement, so CREATE_DOCUMENT instead falls through to the
// brain-backed path below, which still receives detectNaturalIntent's
// document-type detection as a hint (see detectDocumentTypeHint).
function classifyDeterministicIntent(rawText, language) {
  const normalized = normalizeForMatch(rawText);
  if (!normalized) return null;
  if (/\b(recharge|recharger|acheter des credits|top up|topup)\b/.test(normalized)) {
    return baseResult({ intent: "RECHARGE", language });
  }
  if (/\b(je ne sais pas quel document|je ne sais pas|not sure which document)\b/.test(normalized)) {
    return baseResult({
      intent: "UNKNOWN",
      language,
      ambiguous_fields: ["document_type"],
      needs_confirmation: true,
      user_facing_message_draft: language === "en"
        ? "Which document do you want: invoice, quote, receipt, or discharge?"
        : "Quel document voulez-vous : facture, devis, reçu ou décharge ?",
      confidence: DEFAULT_MIN_CONFIDENCE,
    });
  }
  const direct = detectNaturalIntent(rawText);
  const mapped = ORCHESTRATOR_INTENT_MAP[direct.intent];
  if (!mapped || mapped === "CREATE_DOCUMENT") return null; // MENU/CONTINUE/CREATE_DOCUMENT: fall through to the brain-backed path
  if (mapped === "CANCEL") {
    return baseResult({
      intent: "CANCEL",
      language,
      user_facing_message_draft: language === "en" ? "Cancel the current document?" : "Voulez-vous annuler le document en cours ?",
      needs_confirmation: true,
    });
  }
  return baseResult({ intent: mapped, language });
}

// Used only as a document_type_hint feed into the brain request — never
// short-circuits extraction. Reuses detectNaturalIntent's own document-type
// keyword matching rather than a second copy of the same regex set.
function detectDocumentTypeHint(rawText) {
  return detectNaturalIntent(rawText).document_type || null;
}

function detectOperation({ rawText, brainResult, activeDocument }) {
  const normalized = normalizeForMatch(rawText);
  if (REMOVE_KEYWORDS.test(normalized)) return "REMOVE_ITEM";
  if (ADD_KEYWORDS.test(normalized)) return "ADD_ITEM";
  const activeType = activeDocument?.document_type || null;
  if (activeType && brainResult.document_type && brainResult.document_type !== activeType) {
    return "CHANGE_DOCUMENT_TYPE";
  }
  const collected = activeDocument || {};
  for (const [field, candidate] of Object.entries(brainResult.extracted_fields || {})) {
    if (candidate.status !== "CONFIRMED") continue;
    const previous = collected[field];
    if (previous != null && JSON.stringify(previous) !== JSON.stringify(candidate.value)) {
      return "CORRECT_FIELD";
    }
  }
  return null;
}

function extractRemovalHint(rawText) {
  const normalized = normalizeForMatch(rawText);
  const match = REMOVE_HINT_PATTERN.exec(normalized);
  const hint = match?.[1]?.trim().replace(/[.!?]+$/, "");
  return hint ? hint.slice(0, 300) : null;
}

// For REMOVE_ITEM, requested_corrections is load-bearing: it is the ONLY
// carrier for the removal hint text, read back by
// kadiV1ConversationalMultimodalRuntimeAdapter.js's removalHintFromEnvelope.
//
// For CORRECT_FIELD/ADD_ITEM, requested_corrections is a required part of
// the validated envelope shape (kadiV1ConversationalMultimodalContracts.js's
// RESULT_KEYS) but is NOT currently read back by anything — the actual
// mutation is driven entirely by `extracted_entities`
// (kadiV1ConversationalMultimodalBrainAdapter.js copies extracted_entities
// field-by-field into Brain's extracted_fields; it never reads
// requested_corrections). This is intentional, not a bug: the entries here
// are a rendering-friendly summary DERIVED from extracted_fields
// (computed below by diffing against activeDocument), not an independent
// source of truth, so nothing is lost by not re-reading it. Left in place
// (not removed) because the envelope schema requires the key regardless of
// operation, and because a future user-facing "changing X from A to B"
// confirmation message is a natural consumer of exactly this shape — this
// module should not have to reconstruct field-level diffs a second time
// when that mission arrives.
function buildCorrections({ brainResult, activeDocument, rawText, operation }) {
  if (operation === "REMOVE_ITEM") {
    const hint = extractRemovalHint(rawText);
    return hint ? [{ field: "items", new_value_hint: hint, source_reference: "text:0" }] : [];
  }
  const collected = activeDocument || {};
  const corrections = [];
  for (const [field, candidate] of Object.entries(brainResult.extracted_fields || {})) {
    if (candidate.status !== "CONFIRMED") continue;
    const previous = collected[field];
    if (previous != null && JSON.stringify(previous) !== JSON.stringify(candidate.value)) {
      corrections.push({
        field,
        new_value_hint: typeof candidate.value === "string" ? candidate.value.slice(0, 500) : JSON.stringify(candidate.value).slice(0, 500),
        source_reference: candidate.source_reference || null,
      });
    }
  }
  return corrections;
}

const BRAIN_INTENT_MAP = Object.freeze({
  CREATE_DOCUMENT: "CREATE_DOCUMENT",
  UPDATE_DOCUMENT: "UPDATE_DOCUMENT",
  SEARCH_DOCUMENT: "SEARCH_HISTORY",
  REQUEST_HELP: "HELP",
  UNKNOWN: "UNKNOWN",
});

function fromBrainResult({ brainResult, rawText, language, activeDocument }) {
  const intent = BRAIN_INTENT_MAP[brainResult.intent] || "UNKNOWN";
  const operation = intent === "UPDATE_DOCUMENT" ? detectOperation({ rawText, brainResult, activeDocument }) : null;
  const requestedCorrections = ["CORRECT_FIELD", "REMOVE_ITEM"].includes(operation)
    ? buildCorrections({ brainResult, activeDocument, rawText, operation })
    : [];
  const ambiguousFields = brainResult.uncertainties.map((entry) => entry.field);
  const needsConfirmation = ambiguousFields.length > 0 || brainResult.confidence < DEFAULT_MIN_CONFIDENCE;
  return baseResult({
    intent,
    document_type: brainResult.document_type,
    operation,
    language,
    extracted_entities: brainResult.extracted_fields,
    requested_corrections: requestedCorrections,
    missing_fields: brainResult.missing_fields,
    ambiguous_fields: ambiguousFields,
    needs_confirmation: needsConfirmation,
    confidence: brainResult.confidence,
    user_facing_message_draft: brainResult.user_facing_message_draft,
    provider_metadata: classifierMetadata("BRAIN", { model: brainResult.provider_metadata?.provider }),
  });
}

// interpret(): the single entry point the orchestrator integration calls.
// `brain` must expose `.understand(request)` — pass the same instance
// already constructed in kadiV1ProductionBootstrap.js; this function never
// constructs its own provider or makes a network call. Resolves the FLOW /
// deterministic / brain-backed branches exactly once per message.
// `brainResult` is the untouched object brain.understand() returned (already
// validated by kadiV1BrainContracts.validateBrainResult inside the real Brain
// implementation) — non-null only when the brain-backed path was taken.
async function resolveInterpretation({
  requestId,
  source,
  text = null,
  transcription = null,
  media = null,
  flowReply = null,
  activeDocument = null,
  brain,
}) {
  if (!brain || typeof brain.understand !== "function") {
    throw new TypeError("KADI_CONVERSATIONAL_MULTIMODAL_BRAIN_REQUIRED");
  }
  const rawText = source === "TEXT" ? text : source === "AUDIO" ? transcription : "";
  const language = detectLanguage(rawText);

  if (source === "FLOW") {
    if (!flowReply) throw new TypeError("KADI_CONVERSATIONAL_MULTIMODAL_FLOW_REPLY_REQUIRED");
    // A Flow reply's data is already validated by the existing, separate
    // FLOW_ACTIONS/ACTION_FIELDS allowlist in kadiV1FlowReplyRuntime.js
    // before it ever reaches this envelope — this branch intentionally does
    // not re-interpret flowReply.data itself, to avoid a second, weaker
    // path around that validation. It also does not guess which `operation`
    // the reply represents (correction vs. fresh save vs. cancel): that
    // requires the actual flow_key/action mapping, which is deferred to the
    // orchestrator-integration mission (see architecture doc §5). Emitting
    // an unverified "CORRECT_FIELD" here would be exactly the kind of
    // silently-invented certainty this contract exists to prevent.
    const envelope = baseResult({
      intent: "UPDATE_DOCUMENT",
      operation: null,
      language,
      needs_confirmation: false,
      provider_metadata: classifierMetadata("DETERMINISTIC", { model: null }),
    });
    return { envelope, brainResult: null };
  }

  const deterministic = ["TEXT", "AUDIO"].includes(source) ? classifyDeterministicIntent(rawText, language) : null;
  if (deterministic) return { envelope: deterministic, brainResult: null };

  const brainModality = source === "TEXT" ? "TEXT" : source === "AUDIO" ? "TRANSCRIPTION" : source;
  const documentTypeHint = activeDocument?.document_type
    || (["TEXT", "AUDIO"].includes(source) ? detectDocumentTypeHint(rawText) : null);
  const brainRequest = {
    request_id: requestId,
    modality: brainModality,
    conversation_context: { has_active_document: Boolean(activeDocument) },
    document_type_hint: documentTypeHint,
    collected_data: activeDocument ? JSON.parse(JSON.stringify(activeDocument)) : {},
  };
  if (brainModality === "TEXT") brainRequest.text = text;
  else if (brainModality === "TRANSCRIPTION") brainRequest.transcription = transcription;
  else brainRequest.media = media;

  const brainResult = await brain.understand(brainRequest);
  const envelope = fromBrainResult({ brainResult, rawText, language, activeDocument });
  return { envelope, brainResult };
}

// Phase 2 requirement: "the normalized contract must be validated before it
// is allowed to affect a document draft." This is the single exit point for
// every path (FLOW / deterministic / brain-backed), so nothing can return
// without passing through it — including from a future, non-conforming
// `brain` implementation that skips its own validateBrainResult call. Fails
// closed and also normalizes (e.g. document_type casing) rather than
// silently trusting the derived shape.
// The orchestrator integration (kadiV1ConversationalMultimodalRuntimeAdapter.js)
// feeds this envelope into kadiV1ConversationalMultimodalBrainAdapter.js's
// conversationalResultToBrainResult(...) — a single, explicit, closed
// mapping into the exact shape kadiV1BrainContracts.validateBrainResult (and
// therefore documents.apply(...)) requires. This function never returns
// anything Brain-shaped itself; see that adapter for why a second,
// independent mapping does not exist.
async function interpretConversationalInput(input) {
  const { envelope } = await resolveInterpretation(input);
  const checked = validateConversationalResult(envelope);
  if (!checked.ok) throw new TypeError(checked.error);
  return checked.value;
}

// Phase 7 — formal Kadi conversation policy check (see
// docs/KADI_CONVERSATION_POLICY.md for the full rule set this mirrors,
// consolidated from AGENTS.md §14). This validates a canonical response
// DRAFT before it is sent — it does not compose messages itself, and it
// never overrides the backend's actual confirmation state.
//
// Delegates the length and forbidden-term check to
// kadiV1ConversationOrchestrator.js's own validateCanonicalText (already
// covers flow/payload/session/endpoint/openai/gemini/ocr, at a 1200-char
// ceiling) instead of re-implementing that check a second time. This layer
// only adds what that function does not: a stricter length ceiling for
// conversational replies, a few extra internal terms specific to this
// mission's contract, and the "at most one question" rule.
const MAX_RESPONSE_LENGTH = 700;
const EXTRA_FORBIDDEN_TERMS = /\b(flow_token|flow token|nfm_reply|draft_id|brouillon technique|GPT-?\d|Whisper)\b/i;

function validateCanonicalResponseText(text) {
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: "CONVERSATION_POLICY_TEXT_REQUIRED" };
  if (text.length > MAX_RESPONSE_LENGTH) return { ok: false, error: "CONVERSATION_POLICY_TEXT_TOO_LONG" };
  if (!validateCanonicalText(text) || EXTRA_FORBIDDEN_TERMS.test(text)) {
    return { ok: false, error: "CONVERSATION_POLICY_INTERNAL_TERM_EXPOSED" };
  }
  const questionMarks = (text.match(/\?/g) || []).length;
  if (questionMarks > 1) return { ok: false, error: "CONVERSATION_POLICY_MULTIPLE_QUESTIONS" };
  return { ok: true, value: text };
}

module.exports = {
  DEFAULT_MIN_CONFIDENCE,
  MAX_RESPONSE_LENGTH,
  classifyDeterministicIntent,
  detectDocumentTypeHint,
  detectLanguage,
  interpretConversationalInput,
  validateCanonicalResponseText,
};
