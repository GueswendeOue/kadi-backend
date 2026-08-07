"use strict";

const { resolveFlowKey } = require("./kadiV1FlowRouter");
const { formatAvailableBalanceText } = require("./kadiV1BalancePresentation");

const INPUT_TYPES = Object.freeze([
  "TEXT",
  "TRANSCRIPTION",
  "IMAGE",
  "PDF",
  "FLOW_REPLY",
  "MENU_ACTION",
  "RESUME_EVENT",
]);

const DOCUMENT_TYPES = Object.freeze(["FACTURE", "DEVIS", "RECU", "DECHARGE"]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const OWNER_PATTERN = /^\d{8,20}$/;
const FORBIDDEN_USER_TERMS = /\b(?:flow|payload|session|endpoint|openai|gemini|ocr)\b|erreur interne|commande non reconnue/i;

const WELCOME_TEXT = [
  "Bienvenue chez Kadi 👋",
  "",
  "Je vous aide à préparer vos factures, devis, reçus et décharges directement sur WhatsApp.",
  "",
  "Vous pouvez m’écrire, m’envoyer un vocal ou une photo.",
  "",
  "🎁 5 crédits viennent de vous être offerts pour commencer.",
].join("\n");

const COPY = Object.freeze({
  MENU: "Que souhaitez-vous faire ?",
  HELP: "Je peux préparer une facture, un devis, un reçu ou une décharge. Écrivez simplement ce dont vous avez besoin, ou envoyez un vocal ou une photo.",
  DOCUMENT_STARTED: Object.freeze({
    FACTURE: "Bien sûr. Envoyez-moi le nom du client, les produits ou services, les quantités et les prix.",
    DEVIS: "Bien sûr. Envoyez-moi le nom du client, les produits ou services, les quantités et les prix.",
    RECU: "Bien sûr. Indiquez qui a payé, qui reçoit, le montant et le motif.",
    DECHARGE: "Bien sûr. Indiquez qui remet, qui reçoit, ce qui est remis et le motif.",
  }),
  HISTORY_EMPTY: "Je n’ai trouvé aucun document correspondant. Donnez-moi un nom, un type de document ou une période.",
  // T6/BALANCE-001: delegates to the same shared formatter
  // kadiV1ProductionPresenter.js's Flow/menu BALANCE path uses, so both
  // paths report the exact same available_credits/reserved_credits text —
  // never two independent financial calculations.
  BALANCE: (available, reserved) => formatAvailableBalanceText({ availableCredits: available, reservedCredits: reserved }),
  SAVED_RETRY: "Je n’ai pas pu continuer pour le moment. Vos informations sont conservées. Réessayez dans un instant.",
  MEDIA_DISABLED: "Cette entrée n’est pas encore disponible ici. Vous pouvez écrire les informations ou envoyer un vocal.",
  CANCELLED: "D’accord, j’ai annulé cette préparation.",
  DELIVERED: "Votre document est prêt et a été envoyé.",
  CONTINUE: "Envoyez-moi les informations à ajouter ou à corriger.",
});

const MISSING_FIELD_QUESTIONS = Object.freeze({
  issuer: "Quel nom doit apparaître comme émetteur du document ?",
  client: "Quel est le nom du client ?",
  payer: "Qui a effectué le paiement ?",
  beneficiary: "Qui reçoit le paiement ?",
  items: "Quel produit ou service faut-il ajouter ?",
  amount: "Quel est le montant ?",
  reason: "Quel est le motif ?",
  giver: "Qui remet le bien, le document ou l’argent ?",
  recipient: "Qui le reçoit ?",
  transferred_content_type: "Que remettez-vous : de l’argent, un bien, un document ou autre chose ?",
  transferred_content: "Que remettez-vous exactement ?",
  currency: "Quelle est la devise ?",
});

function ok(value) {
  return { ok: true, value };
}

function fail(error) {
  return { ok: false, error };
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function normalizeForIntent(value) {
  return normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// Two separate regex literals (never a single shared global one): a global
// regex object's lastIndex persists across .test()/.exec() calls on the
// same object, which would silently corrupt repeated intent-detection calls
// across unrelated requests. The non-global one below is safe to reuse for
// .test(); a fresh global regex literal is created at each call site that
// needs .replace() to strip every occurrence.
const HISTORY_TRIGGER_WORDS_PATTERN = /\b(retrouve|retrouver|historique|dernier|derniers|brouillon|reprends|reprendre)\b/;

function stripHistoryTriggerWords(text) {
  return String(text || "")
    .replace(/\b(retrouve|retrouver|historique|dernier|derniers|brouillon|reprends|reprendre)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectNaturalIntent(text) {
  const normalized = normalizeForIntent(text);
  if (!normalized) return Object.freeze({ intent: "CONTINUE", document_type: null });
  if (HISTORY_TRIGGER_WORDS_PATTERN.test(normalized)) {
    return Object.freeze({ intent: "HISTORY_SEARCH", document_type: null });
  }
  if (/\b(facture|facturer)\b/.test(normalized)) return Object.freeze({ intent: "PREPARE_DOCUMENT", document_type: "FACTURE" });
  if (/\b(devis|proforma)\b/.test(normalized)) return Object.freeze({ intent: "PREPARE_DOCUMENT", document_type: "DEVIS" });
  if (/\b(recu|reçu)\b/.test(normalized)) return Object.freeze({ intent: "PREPARE_DOCUMENT", document_type: "RECU" });
  if (/\b(decharge|décharge)\b/.test(normalized)) return Object.freeze({ intent: "PREPARE_DOCUMENT", document_type: "DECHARGE" });
  if (/\b(solde|credit|credits|crédit|crédits)\b/.test(normalized)) return Object.freeze({ intent: "BALANCE", document_type: null });
  if (/\b(aide|comment|besoin d aide)\b/.test(normalized)) return Object.freeze({ intent: "HELP", document_type: null });
  if (/\b(annule|annuler|abandonne|abandonner)\b/.test(normalized)) return Object.freeze({ intent: "CANCEL", document_type: null });
  if (/\b(menu|commencer|commence)\b/.test(normalized)) return Object.freeze({ intent: "MENU", document_type: null });
  return Object.freeze({ intent: "CONTINUE", document_type: null });
}

function validateInput(input) {
  if (!isPlainObject(input)) return fail("KADI_V1_CONVERSATION_INPUT_INVALID");
  if (!OWNER_PATTERN.test(input.ownerWaId || "")) return fail("KADI_V1_CONVERSATION_OWNER_INVALID");
  if (!INPUT_TYPES.includes(input.inputType)) return fail("KADI_V1_CONVERSATION_INPUT_TYPE_INVALID");
  if (!IDENTIFIER_PATTERN.test(input.correlationId || "")) return fail("KADI_V1_CONVERSATION_CORRELATION_INVALID");
  if (!IDENTIFIER_PATTERN.test(input.idempotencyKey || "")) return fail("KADI_V1_CONVERSATION_IDEMPOTENCY_INVALID");
  if (["TEXT", "TRANSCRIPTION"].includes(input.inputType) && !normalizeText(input.text)) {
    return fail("KADI_V1_CONVERSATION_TEXT_REQUIRED");
  }
  return ok(true);
}

function validateCanonicalText(text) {
  if (typeof text !== "string" || !text.trim() || text.length > 1200) return false;
  return !FORBIDDEN_USER_TERMS.test(text);
}

function assertPort(target, methods, name) {
  if (!target || typeof target !== "object") throw new TypeError(`${name}_REQUIRED`);
  for (const method of methods) if (typeof target[method] !== "function") throw new TypeError(`${name}_METHOD_REQUIRED:${method}`);
  return target;
}

function asResult(result, fallbackError) {
  if (!result || typeof result !== "object" || typeof result.ok !== "boolean") return fail(fallbackError);
  return result;
}

function firstTargetedQuestion(document) {
  const uncertain = Array.isArray(document?.uncertainties) ? document.uncertainties : [];
  const recommended = uncertain.find((entry) => typeof entry?.recommended_question === "string" && entry.recommended_question.trim());
  if (recommended) return recommended.recommended_question.trim();
  const missing = Array.isArray(document?.missing_fields) ? document.missing_fields : [];
  const first = missing.find((field) => typeof field === "string" && field.trim());
  return first ? (MISSING_FIELD_QUESTIONS[first] || "Quelle information souhaitez-vous ajouter ?") : null;
}

function routeForDocument(document) {
  if (!document || !DOCUMENT_TYPES.includes(document.document_type)) return null;
  const state = document.status;
  let intent = null;
  if (["READY_FOR_REVIEW"].includes(state)) intent = "REVIEW";
  else if (["VERIFIED", "PREVIEW_READY"].includes(state)) intent = "PREVIEW";
  else if (["COST_CALCULATED", "AWAITING_GENERATION_CONFIRMATION"].includes(state)) intent = "CONFIRM_GENERATION";
  else if (state === "RECHARGE_REQUIRED") intent = "RECHARGE";
  if (!intent) return null;
  const route = resolveFlowKey({ intent, documentType: document.document_type, documentState: state, ownerMatched: true });
  return route.ok ? route.value : null;
}

function buildResponse({ canonicalText, action, nextState = null, flowKey = null, prefill = null, voiceRequest = null, events = [] }) {
  if (!validateCanonicalText(canonicalText)) throw new Error("KADI_V1_CANONICAL_TEXT_INVALID");
  return deepFreeze({
    handled: true,
    canonical_text: canonicalText,
    business_action: action,
    next_state: nextState,
    flow_request: flowKey ? { flow_key: flowKey, prefill: prefill && isPlainObject(prefill) ? structuredClone(prefill) : {} } : null,
    voice_request: voiceRequest,
    events: events.map((event) => ({ ...event })),
  });
}

function createKadiV1ConversationOrchestrator({
  config,
  legacyHandler,
  userContextService,
  onboardingRuntime,
  interpretationRuntime,
  documentRuntime,
  historyRuntime,
  walletRuntime,
  voicePolicy = null,
  // Optional, synchronous, local-only (no network/provider call) — the SAME
  // allowlist gate kadiV1ConversationalMultimodalRuntimeAdapter.js already
  // uses internally (kadiV1ProductionOrchestratorComposition.js wires the
  // identical function to both). Defaults to "nobody is eligible", which
  // keeps every orchestrator instance that doesn't explicitly wire this
  // (i.e. every deployment before this mission, and every test that
  // doesn't pass it) byte-for-byte identical to before: the deterministic
  // PREPARE_DOCUMENT short-circuit below always fires, exactly as it always
  // has. See §"PREPARE_DOCUMENT contradiction" audit for why this exists.
  conversationalEligibilityGate = null,
  // Optional, injected, already-constructed (event, safeDetails) => void
  // callback — kadiV1ProductionOrchestratorComposition.js builds it via
  // kadiV1ConversationalMultimodalObservability.js's
  // createConversationalObservabilityEmitter(...), the SAME factory the
  // conversational runtime adapter uses, so this orchestrator never
  // constructs any telemetry itself. This is the ONLY place
  // "conversational_draft_applied" is ever emitted — see the REMOVE_ITEM /
  // CHANGE_DOCUMENT_TYPE / PREPARE_DOCUMENT branches below, each gated on
  // the corresponding backend port actually returning ok:true with
  // duplicate !== true.
  conversationalObservabilityEmit = null,
} = {}) {
  if (!config || typeof config.enabled !== "boolean" || !config.features) throw new TypeError("KADI_V1_RUNTIME_CONFIG_REQUIRED");
  if (typeof legacyHandler !== "function") throw new TypeError("KADI_V1_LEGACY_HANDLER_REQUIRED");
  const users = assertPort(userContextService, ["getContext"], "KADI_V1_USER_CONTEXT_SERVICE");
  const onboarding = assertPort(onboardingRuntime, ["start"], "KADI_V1_ONBOARDING_RUNTIME");
  const interpretation = assertPort(interpretationRuntime, ["interpret"], "KADI_V1_INTERPRETATION_RUNTIME");
  const documents = assertPort(documentRuntime, ["start", "apply", "cancel", "removeContent", "changeDocumentType"], "KADI_V1_DOCUMENT_RUNTIME");
  const history = assertPort(historyRuntime, ["search"], "KADI_V1_HISTORY_RUNTIME");
  const wallet = assertPort(walletRuntime, ["getBalance"], "KADI_V1_WALLET_RUNTIME");
  if (voicePolicy != null) assertPort(voicePolicy, ["evaluate"], "KADI_V1_VOICE_POLICY");

  // Never lets a telemetry failure affect the response returned to the
  // user — the injected emitter is already safe by construction
  // (kadiV1ConversationalMultimodalObservability.js wraps its own sink in
  // try/catch), but this local wrapper stays defensive even if a test or a
  // future caller injects something else.
  function emitDraftApplied(observabilityFields) {
    if (typeof conversationalObservabilityEmit !== "function" || !observabilityFields) return;
    try { conversationalObservabilityEmit("conversational_draft_applied", observabilityFields); } catch { /* observability is non-authoritative */ }
  }

  async function optionalVoice({ profile, canonicalText, inputType, step }) {
    if (!config.features.voice || !voicePolicy) return null;
    const evaluated = asResult(await voicePolicy.evaluate({
      voice_response_mode: profile?.voice_response_mode || "VOICE_WHEN_HELPFUL",
      canonical_text: canonicalText,
      input_type: inputType,
      step,
    }), "KADI_V1_VOICE_POLICY_FAILED");
    if (!evaluated.ok || evaluated.value?.mode !== "TEXT_AND_VOICE") return null;
    return { mode: "TEXT_AND_VOICE", reason: evaluated.value.reason || "POLICY" };
  }

  // The exact historical PREPARE_DOCUMENT behavior: start a blank draft of
  // `documentType` and report it, with no interpretation involved. Shared by
  // (1) the deterministic short-circuit for owners who are not eligible for
  // (or for whom conversational interpretation is unavailable/failed on)
  // the conversational-multimodal path, and (2) the exact-once fallback
  // used when an eligible owner's conversational interpretation itself
  // fails (timeout/refusal/malformed output/validation/mapping failure) —
  // see the FAILURE_AFTER_ELIGIBILITY branch below. Both call sites pass
  // the SAME `idempotencyKey` the historical branch always used, so a
  // duplicate webhook still starts at most one draft.
  async function startBlankDocument({ documentType, idempotencyKey, ownerWaId, profile, inputType }) {
    const started = asResult(await documents.start({
      ownerWaId,
      documentType,
      idempotencyKey,
    }), "KADI_V1_DOCUMENT_START_FAILED");
    if (!started.ok) return started;
    const canonicalText = COPY.DOCUMENT_STARTED[documentType];
    return buildResponse({
      canonicalText,
      action: "DOCUMENT_STARTED",
      nextState: started.value?.status || "COLLECTING",
      voiceRequest: await optionalVoice({ profile, canonicalText, inputType, step: "DOCUMENT_STARTED" }),
    });
  }

  async function respondFromDocument({ document, profile, inputType, action, events = [] }) {
    if (!document || !DOCUMENT_TYPES.includes(document.document_type)) {
      return buildResponse({ canonicalText: COPY.SAVED_RETRY, action: "RECOVERABLE_FAILURE", events });
    }
    if (document.status === "DELIVERED") {
      return buildResponse({ canonicalText: COPY.DELIVERED, action, nextState: document.status, events });
    }
    const question = firstTargetedQuestion(document);
    if (question) {
      return buildResponse({
        canonicalText: question,
        action: "ASK_MISSING_INFORMATION",
        nextState: document.status,
        voiceRequest: await optionalVoice({ profile, canonicalText: question, inputType, step: "MISSING_INFORMATION" }),
        events,
      });
    }
    const flowKey = routeForDocument(document);
    if (flowKey) {
      const canonicalText = flowKey === "DOCUMENT_REVIEW"
        ? "J’ai préparé les informations. Vérifiez-les avant de continuer."
        : flowKey === "DOCUMENT_PREVIEW"
          ? "Votre aperçu est prêt. Vérifiez-le avant de préparer le PDF."
          : flowKey === "GENERATION_CONFIRMATION"
            ? "Le coût est prêt. Vérifiez votre solde puis confirmez la génération."
            : "Votre solde est insuffisant. Choisissez une recharge pour continuer.";
      return buildResponse({
        canonicalText,
        action,
        nextState: document.status,
        flowKey,
        prefill: { document_id: document.document_id, document_version: document.version, document_type: document.document_type },
        events,
      });
    }
    return buildResponse({
      canonicalText: COPY.CONTINUE,
      action,
      nextState: document.status,
      voiceRequest: await optionalVoice({ profile, canonicalText: COPY.CONTINUE, inputType, step: "CONTINUE" }),
      events,
    });
  }

  async function handle(input) {
    const checked = validateInput(input);
    if (!checked.ok) return checked;
    if (!config.enabled) return legacyHandler(input);

    const context = asResult(await users.getContext({ ownerWaId: input.ownerWaId }), "KADI_V1_USER_CONTEXT_FAILED");
    if (!context.ok) return context;
    const profile = context.value?.profile || null;

    if (!profile || context.value?.is_new === true || profile.onboarding_status !== "COMPLETED") {
      const started = asResult(await onboarding.start({
        ownerWaId: input.ownerWaId,
        correlationId: input.correlationId,
        idempotencyKey: input.idempotencyKey,
      }), "KADI_V1_ONBOARDING_FAILED");
      if (!started.ok) return started;
      if (started.value?.welcome_credits_granted !== true) {
        return buildResponse({ canonicalText: COPY.SAVED_RETRY, action: "ONBOARDING_RECOVERABLE_FAILURE" });
      }
      return buildResponse({
        canonicalText: WELCOME_TEXT,
        action: "ONBOARDING_STARTED",
        flowKey: "ONBOARDING",
        voiceRequest: config.features.voice ? { mode: "TEXT_AND_VOICE", reason: "WELCOME" } : null,
        events: [{ type: "welcome_text_ready" }, { type: "welcome_voice_requested" }],
      });
    }

    const direct = ["TEXT", "TRANSCRIPTION", "MENU_ACTION"].includes(input.inputType)
      ? detectNaturalIntent(input.text || input.action)
      : { intent: "CONTINUE", document_type: null };

    if (direct.intent === "MENU") {
      return buildResponse({ canonicalText: COPY.MENU, action: "SHOW_MENU", flowKey: "MENU" });
    }
    if (direct.intent === "HELP") {
      return buildResponse({
        canonicalText: COPY.HELP,
        action: "SHOW_HELP",
        voiceRequest: await optionalVoice({ profile, canonicalText: COPY.HELP, inputType: input.inputType, step: "HELP" }),
      });
    }
    if (direct.intent === "BALANCE") {
      // T6/BALANCE-001: wallet.getBalance() here is the exact same
      // walletRuntime port kadiV1FlowCommandRuntime.js's BALANCE action
      // uses (kadiV1RuntimeAdapters.js's createKadiV1WalletRuntimeAdapter)
      // — the natural-language and Flow/menu paths share one authority,
      // never two independent financial calculations.
      const balance = asResult(await wallet.getBalance({ ownerWaId: input.ownerWaId }), "KADI_V1_BALANCE_FAILED");
      const total = balance.value?.total_credits;
      const reserved = balance.value?.reserved_credits;
      const available = balance.value?.available_credits;
      if (
        !balance.ok ||
        !Number.isSafeInteger(total) || total < 0 ||
        !Number.isSafeInteger(reserved) || reserved < 0 ||
        !Number.isSafeInteger(available) || available < 0 ||
        total - reserved !== available
      ) {
        return fail("KADI_V1_BALANCE_INVALID");
      }
      return buildResponse({ canonicalText: COPY.BALANCE(available, reserved), action: "SHOW_BALANCE" });
    }
    if (direct.intent === "HISTORY_SEARCH") {
      if (!config.features.history) return buildResponse({ canonicalText: COPY.SAVED_RETRY, action: "HISTORY_UNAVAILABLE" });
      // The bare trigger word itself ("Historique", "Retrouve", …) must
      // never be forwarded as search criteria — it would filter out every
      // real document and always report "nothing found", even when recent
      // documents (including RECOVERABLE_FAILURE ones) genuinely exist. Any
      // remaining text beyond the trigger word is real search criteria and
      // is preserved verbatim (original casing/accents), e.g. "Historique
      // facture" still searches for "facture".
      const query = stripHistoryTriggerWords(input.text);
      const found = asResult(await history.search({ ownerWaId: input.ownerWaId, query, limit: 5 }), "KADI_V1_HISTORY_FAILED");
      if (!found.ok) return found;
      if (!Array.isArray(found.value?.documents) || found.value.documents.length === 0) {
        return buildResponse({ canonicalText: COPY.HISTORY_EMPTY, action: "HISTORY_EMPTY", flowKey: "HISTORY_SEARCH" });
      }
      return buildResponse({
        canonicalText: `J’ai trouvé ${found.value.documents.length} document${found.value.documents.length === 1 ? "" : "s"}. Choisissez celui que vous souhaitez consulter.`,
        action: "HISTORY_RESULTS",
        flowKey: "HISTORY_SEARCH",
        prefill: { result_ids: found.value.documents.map((document) => document.document_id) },
      });
    }
    if (direct.intent === "CANCEL") {
      const active = context.value?.active_document;
      if (!active) return buildResponse({ canonicalText: COPY.CANCELLED, action: "NOTHING_TO_CANCEL" });
      const cancelled = asResult(await documents.cancel({
        ownerWaId: input.ownerWaId,
        documentId: active.document_id,
        expectedVersion: active.version,
        idempotencyKey: input.idempotencyKey,
      }), "KADI_V1_DOCUMENT_CANCEL_FAILED");
      if (!cancelled.ok) return cancelled;
      return buildResponse({ canonicalText: COPY.CANCELLED, action: "DOCUMENT_CANCELLED", nextState: cancelled.value?.status || "CANCELLED" });
    }
    // Conversational eligibility is a cheap, synchronous, local allowlist
    // check (no provider call) — safe to evaluate here, before deciding
    // whether the deterministic PREPARE_DOCUMENT short-circuit below should
    // fire. Also requires config.features.brain: if brain is disabled, the
    // interpretation call a few lines down would immediately return
    // BRAIN_DISABLED without ever starting a document, so skipping the
    // historical short-circuit in that combination would silently drop the
    // request instead of preserving old behavior — never do that.
    const conversationalEligible = typeof conversationalEligibilityGate === "function"
      && config.features.brain === true
      && conversationalEligibilityGate(input.ownerWaId) === true;

    // For an ineligible owner (the default for every existing deployment,
    // and for every test that does not pass conversationalEligibilityGate),
    // this fires exactly as it always has: zero conversational/provider
    // call, one blank draft, unchanged historical behavior.
    //
    // For an eligible owner, this is intentionally SKIPPED: falling through
    // lets the conversational interpretation below run once and capture
    // same-message data ("Fais une facture pour Moussa avec trois tables à
    // 45 000." must retain Moussa/items/quantity/price, not discard them —
    // see kadiV1ConversationalMultimodalPolicy.js's own comment on why
    // CREATE_DOCUMENT is deliberately never short-circuited at that layer).
    // No document_type hint needs to be threaded through manually: the
    // policy layer re-derives the identical hint via the same
    // detectNaturalIntent/detectDocumentTypeHint functions.
    if (direct.intent === "PREPARE_DOCUMENT" && !conversationalEligible) {
      return startBlankDocument({
        documentType: direct.document_type,
        idempotencyKey: input.idempotencyKey,
        ownerWaId: input.ownerWaId,
        profile,
        inputType: input.inputType,
      });
    }

    const activeDocument = context.value?.active_document || null;
    const visual = ["IMAGE", "PDF"].includes(input.inputType);
    if (visual && !config.features.vision) {
      return buildResponse({ canonicalText: COPY.MEDIA_DISABLED, action: "VISION_UNAVAILABLE" });
    }
    if (input.inputType === "TRANSCRIPTION" && !config.features.transcription) {
      return buildResponse({ canonicalText: COPY.MEDIA_DISABLED, action: "TRANSCRIPTION_UNAVAILABLE" });
    }
    if (!config.features.brain) {
      return buildResponse({ canonicalText: COPY.CONTINUE, action: "BRAIN_DISABLED" });
    }

    const interpreted = asResult(await interpretation.interpret({
      ownerWaId: input.ownerWaId,
      inputType: input.inputType,
      text: input.text || null,
      media: input.media || null,
      flowReply: input.flowReply || null,
      activeDocument,
      correlationId: input.correlationId,
    }), "KADI_V1_INTERPRETATION_FAILED");
    if (!interpreted.ok) {
      // Exact fallback for an eligible owner whose deterministic-looking
      // "create a document" request (direct.intent === "PREPARE_DOCUMENT",
      // computed above, before interpretation was ever attempted) hit a
      // conversational failure: provider timeout/refusal, malformed
      // provider output, envelope validation failure, or a Brain-mapping
      // failure that itself threw (all surface here as interpreted.ok ===
      // false — see kadiV1ConversationalMultimodalRuntimeAdapter.js's own
      // outer catch). Zero conversational mutation (no apply attempted, no
      // brain_result exists to apply), at most one blank draft (the exact
      // historical path, same idempotencyKey — a duplicate webhook replays
      // into the same idempotent documents.start call, not a second one),
      // no second provider call (interpretation.interpret is not retried).
      // For any other failure (activeDocument present, or direct.intent was
      // never PREPARE_DOCUMENT), the historical recoverable-failure message
      // is the correct, unchanged response — nothing is silently dropped
      // that wasn't already going to be a "please retry".
      if (direct.intent === "PREPARE_DOCUMENT" && conversationalEligible) {
        return startBlankDocument({
          documentType: direct.document_type,
          idempotencyKey: input.idempotencyKey,
          ownerWaId: input.ownerWaId,
          profile,
          inputType: input.inputType,
        });
      }
      return buildResponse({ canonicalText: COPY.SAVED_RETRY, action: "INTERPRETATION_RECOVERABLE_FAILURE" });
    }

    // "RECHARGE" is only ever produced by an interpretation runtime that
    // opts into it (e.g. the conversational-multimodal integration for
    // eligible owners) — the plain brain interpretation adapter's intentMap
    // never emits it, so this branch is unreachable dead code for every
    // owner not using that integration, preserving existing behavior
    // exactly. It never touches a document, only opens the existing
    // RECHARGE Flow, mirroring the HISTORY_SEARCH branch above.
    if (interpreted.value?.intent === "RECHARGE") {
      if (!config.features.recharge) {
        return buildResponse({ canonicalText: COPY.SAVED_RETRY, action: "RECHARGE_UNAVAILABLE" });
      }
      return buildResponse({
        canonicalText: "Voici les options pour recharger votre solde.",
        action: "RECHARGE_REQUESTED",
        flowKey: "RECHARGE",
      });
    }

    // "REMOVE_ITEM" is only ever produced by an interpretation runtime that
    // resolved the item unambiguously against the active document itself
    // (kadiV1ConversationalMultimodalRuntimeAdapter.js's own item lookup) —
    // the plain adapter never emits it. This calls the existing, unmodified
    // documents.removeContent(...) port (kadiV1RuntimeAdapters.js ->
    // kadiV1SharedDocumentPipeline.js), the same one already used elsewhere;
    // no new mutation logic is added here.
    if (interpreted.value?.intent === "REMOVE_ITEM" && typeof interpreted.value.remove_item_id === "string") {
      if (!activeDocument) {
        return buildResponse({ canonicalText: COPY.MENU, action: "SHOW_MENU", flowKey: "MENU" });
      }
      const removed = asResult(await documents.removeContent({
        ownerWaId: input.ownerWaId,
        documentId: activeDocument.document_id,
        expectedVersion: activeDocument.version,
        documentType: activeDocument.document_type,
        itemId: interpreted.value.remove_item_id,
        idempotencyKey: input.idempotencyKey,
      }), "KADI_V1_DOCUMENT_REMOVE_CONTENT_FAILED");
      if (!removed.ok) return removed;
      if (removed.duplicate !== true) emitDraftApplied(interpreted.value.observabilityFields);
      return respondFromDocument({ document: removed.value, profile, inputType: input.inputType, action: "DOCUMENT_ITEM_REMOVED" });
    }

    // "CHANGE_DOCUMENT_TYPE" is only ever produced for the one
    // data-compatible pair, FACTURE<->DEVIS (see
    // kadiV1ConversationalMultimodalRuntimeAdapter.js's CONVERTIBLE_DOCUMENT_TYPES
    // gate) — the plain adapter never emits it. This calls the existing,
    // dedicated documents.changeDocumentType(...) port
    // (kadiV1RuntimeAdapters.js -> kadiV1SharedDocumentPipeline.js ->
    // kadiV1DocumentDomain.js), never overwrites document_type inline.
    if (interpreted.value?.intent === "CHANGE_DOCUMENT_TYPE" && typeof interpreted.value.target_document_type === "string") {
      if (!activeDocument) {
        return buildResponse({ canonicalText: COPY.MENU, action: "SHOW_MENU", flowKey: "MENU" });
      }
      const changed = asResult(await documents.changeDocumentType({
        ownerWaId: input.ownerWaId,
        documentId: activeDocument.document_id,
        expectedVersion: activeDocument.version,
        documentType: activeDocument.document_type,
        targetDocumentType: interpreted.value.target_document_type,
        idempotencyKey: input.idempotencyKey,
      }), "KADI_V1_DOCUMENT_CHANGE_TYPE_FAILED");
      if (!changed.ok) return changed;
      if (changed.duplicate !== true) emitDraftApplied(interpreted.value.observabilityFields);
      return respondFromDocument({ document: changed.value, profile, inputType: input.inputType, action: "DOCUMENT_TYPE_CHANGED" });
    }

    if (interpreted.value?.intent === "PREPARE_DOCUMENT" && DOCUMENT_TYPES.includes(interpreted.value.document_type)) {
      const started = asResult(await documents.start({
        ownerWaId: input.ownerWaId,
        documentType: interpreted.value.document_type,
        idempotencyKey: input.idempotencyKey,
      }), "KADI_V1_DOCUMENT_START_FAILED");
      if (!started.ok) return started;
      if (!interpreted.value.brain_result) {
        return buildResponse({
          canonicalText: COPY.DOCUMENT_STARTED[interpreted.value.document_type],
          action: "DOCUMENT_STARTED",
          nextState: started.value?.status || "COLLECTING",
        });
      }
      const applied = asResult(await documents.apply({
        ownerWaId: input.ownerWaId,
        document: started.value,
        brainResult: interpreted.value.brain_result,
        idempotencyKey: `${input.idempotencyKey}:apply`,
      }), "KADI_V1_DOCUMENT_APPLY_FAILED");
      if (!applied.ok) return applied;
      if (applied.duplicate !== true) emitDraftApplied(interpreted.value.observabilityFields);
      return respondFromDocument({ document: applied.value, profile, inputType: input.inputType, action: "DOCUMENT_DATA_APPLIED" });
    }

    if (!activeDocument) {
      return buildResponse({ canonicalText: COPY.MENU, action: "SHOW_MENU", flowKey: "MENU" });
    }
    if (!interpreted.value?.brain_result) {
      return buildResponse({ canonicalText: COPY.CONTINUE, action: "ASK_FOR_INFORMATION", nextState: activeDocument.status });
    }
    const applied = asResult(await documents.apply({
      ownerWaId: input.ownerWaId,
      document: activeDocument,
      brainResult: interpreted.value.brain_result,
      idempotencyKey: input.idempotencyKey,
    }), "KADI_V1_DOCUMENT_APPLY_FAILED");
    if (!applied.ok) return applied;
    if (applied.duplicate !== true) emitDraftApplied(interpreted.value.observabilityFields);
    return respondFromDocument({ document: applied.value, profile, inputType: input.inputType, action: "DOCUMENT_DATA_APPLIED" });
  }

  return Object.freeze({ handle });
}

module.exports = {
  COPY,
  DOCUMENT_TYPES,
  INPUT_TYPES,
  WELCOME_TEXT,
  createKadiV1ConversationOrchestrator,
  detectNaturalIntent,
  firstTargetedQuestion,
  validateCanonicalText,
  validateInput,
};
