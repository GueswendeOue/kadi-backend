"use strict";

const { resolveFlowKey } = require("./kadiV1FlowRouter");

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
  BALANCE: (credits) => `Votre solde est de ${credits} crédit${credits === 1 ? "" : "s"}.`,
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

function detectNaturalIntent(text) {
  const normalized = normalizeForIntent(text);
  if (!normalized) return Object.freeze({ intent: "CONTINUE", document_type: null });
  if (/\b(retrouve|retrouver|historique|dernier|derniers|brouillon|reprends|reprendre)\b/.test(normalized)) {
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
} = {}) {
  if (!config || typeof config.enabled !== "boolean" || !config.features) throw new TypeError("KADI_V1_RUNTIME_CONFIG_REQUIRED");
  if (typeof legacyHandler !== "function") throw new TypeError("KADI_V1_LEGACY_HANDLER_REQUIRED");
  const users = assertPort(userContextService, ["getContext"], "KADI_V1_USER_CONTEXT_SERVICE");
  const onboarding = assertPort(onboardingRuntime, ["start"], "KADI_V1_ONBOARDING_RUNTIME");
  const interpretation = assertPort(interpretationRuntime, ["interpret"], "KADI_V1_INTERPRETATION_RUNTIME");
  const documents = assertPort(documentRuntime, ["start", "apply", "cancel"], "KADI_V1_DOCUMENT_RUNTIME");
  const history = assertPort(historyRuntime, ["search"], "KADI_V1_HISTORY_RUNTIME");
  const wallet = assertPort(walletRuntime, ["getBalance"], "KADI_V1_WALLET_RUNTIME");
  if (voicePolicy != null) assertPort(voicePolicy, ["evaluate"], "KADI_V1_VOICE_POLICY");

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
      const balance = asResult(await wallet.getBalance({ ownerWaId: input.ownerWaId }), "KADI_V1_BALANCE_FAILED");
      if (!balance.ok || !Number.isSafeInteger(balance.value?.credits) || balance.value.credits < 0) return fail("KADI_V1_BALANCE_INVALID");
      return buildResponse({ canonicalText: COPY.BALANCE(balance.value.credits), action: "SHOW_BALANCE" });
    }
    if (direct.intent === "HISTORY_SEARCH") {
      if (!config.features.history) return buildResponse({ canonicalText: COPY.SAVED_RETRY, action: "HISTORY_UNAVAILABLE" });
      const found = asResult(await history.search({ ownerWaId: input.ownerWaId, query: input.text || "", limit: 5 }), "KADI_V1_HISTORY_FAILED");
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
    if (direct.intent === "PREPARE_DOCUMENT") {
      const started = asResult(await documents.start({
        ownerWaId: input.ownerWaId,
        documentType: direct.document_type,
        idempotencyKey: input.idempotencyKey,
      }), "KADI_V1_DOCUMENT_START_FAILED");
      if (!started.ok) return started;
      const canonicalText = COPY.DOCUMENT_STARTED[direct.document_type];
      return buildResponse({
        canonicalText,
        action: "DOCUMENT_STARTED",
        nextState: started.value?.status || "COLLECTING",
        voiceRequest: await optionalVoice({ profile, canonicalText, inputType: input.inputType, step: "DOCUMENT_STARTED" }),
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
      return buildResponse({ canonicalText: COPY.SAVED_RETRY, action: "INTERPRETATION_RECOVERABLE_FAILURE" });
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
