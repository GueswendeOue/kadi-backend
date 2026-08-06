"use strict";

// Bridges kadiV1ConversationalMultimodalPolicy.js into the SAME
// interpretationRuntime port kadiV1ConversationOrchestrator.js already
// consumes (createKadiV1InterpretationRuntimeAdapter's { intent,
// document_type, brain_result } shape). This is what keeps
// kadiV1ConversationOrchestrator.js's existing CREATE_DOCUMENT/UPDATE_DOCUMENT
// handling (draft application, missing-field questions, Flow launching)
// completely unmodified and reused — only the upstream understanding step
// changes for eligible owners.
//
// Canonical chain enforced here, matching kadiV1ConversationalMultimodalBrainAdapter.js:
//   interpretConversationalInput -> validateConversationalResult (inside it)
//   -> conversationalResultToBrainResult -> validateBrainResult (inside it)
//   -> returned as brain_result for the caller's existing documents.apply(...).
// There is no other document-mutation path here.
//
// Eligibility (`gate`) is checked on every call, not baked in at
// construction: a single orchestrator instance serves every owner, eligible
// or not. When ineligible, or when the input type is FLOW_REPLY (Flow
// replies are never reinterpreted by an AI result — see
// kadiV1FlowReplyRuntime.js, the sole authoritative path for those), this
// adapter delegates to `fallback` — the existing, unmodified
// createKadiV1InterpretationRuntimeAdapter instance — so behavior for
// ineligible owners is byte-for-byte identical to before this integration.

const { resolveRemovalTarget } = require("./kadiV1ConversationalMultimodalItemLookup");
const { createConversationalObservabilityEmitter } = require("./kadiV1ConversationalMultimodalObservability");

function ok(value) { return { ok: true, value }; }
function fail(error) { return { ok: false, error }; }

// REMOVE_ITEM is intercepted here, BEFORE conversationalResultToBrainResult
// (which always rejects it — see kadiV1ConversationalMultimodalBrainAdapter.js
// SUPPORTED_OPERATIONS): removing an item is not a documents.apply(...) field
// mutation, it is the existing, separate documents.removeContent(...) port
// (kadiV1RuntimeAdapters.js -> kadiV1SharedDocumentPipeline.js), which the
// orchestrator calls directly from its own new REMOVE_ITEM branch. This
// adapter only resolves WHICH item_id that refers to, using items already
// persisted on activeDocument — it never mutates an array itself.
function removalHintFromEnvelope(envelope) {
  const correction = envelope.requested_corrections.find((entry) => entry.field === "items");
  return correction ? correction.new_value_hint : null;
}

function removalClarificationText(language, status) {
  if (language === "en") {
    return status === "AMBIGUOUS"
      ? "Several items on this document match that description. Which one would you like to remove?"
      : "I could not find that item on the document. Which one would you like to remove?";
  }
  return status === "AMBIGUOUS"
    ? "Plusieurs articles du document correspondent à cette description. Lequel voulez-vous enlever ?"
    : "Je n'ai pas retrouvé cet article dans le document. Lequel voulez-vous enlever ?";
}

// CHANGE_DOCUMENT_TYPE is supported for exactly one data-compatible pair,
// FACTURE<->DEVIS (kadiV1DocumentDomain.js's changeDocumentType, backed by
// documents.changeDocumentType(...) — see kadiV1SharedDocumentPipeline.js).
// Every other pair (anything involving RECU or DECHARGE) still fails closed:
// those types have an incompatible stored shape (receipt/discharge instead
// of client+items) and no safe backend conversion exists — inventing a
// migration/data-carryover policy for them is explicitly out of scope. The
// TARGET type is never invented here: it is exactly envelope.document_type,
// the brain's own validated inference (see detectOperation in
// kadiV1ConversationalMultimodalPolicy.js, which only classifies
// CHANGE_DOCUMENT_TYPE when the brain's document_type differs from the
// active document's own type).
const CONVERTIBLE_DOCUMENT_TYPES = new Set(["FACTURE", "DEVIS"]);

function changeDocumentTypeClarificationText(language) {
  if (language === "en") {
    return "I can't change the type of a document already in progress. Would you like to cancel it and start a new one of the type you want?";
  }
  return "Je ne peux pas changer le type d'un document déjà en cours. Voulez-vous l'annuler et en démarrer un nouveau du type souhaité ?";
}

function assertMethods(target, methods, name) {
  if (!target || typeof target !== "object") throw new TypeError(`${name}_REQUIRED`);
  for (const method of methods) if (typeof target[method] !== "function") throw new TypeError(`${name}_METHOD_REQUIRED:${method}`);
  return target;
}

function sourceForInputType(inputType) {
  if (inputType === "TEXT") return "TEXT";
  if (inputType === "TRANSCRIPTION") return "AUDIO";
  if (inputType === "IMAGE" || inputType === "PDF") return inputType;
  return null; // FLOW_REPLY, MENU_ACTION, RESUME_EVENT: not handled here.
}

function createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
  brain,
  fallback,
  gate,
  interpretConversationalInput: interpretFn,
  conversationalResultToBrainResult: mapFn,
  logger = null,
} = {}) {
  const service = assertMethods(brain, ["understand"], "KADI_V1_BRAIN");
  const fallbackRuntime = assertMethods(fallback, ["interpret"], "KADI_V1_INTERPRETATION_RUNTIME");
  if (typeof gate !== "function") throw new TypeError("KADI_V1_CONVERSATIONAL_MULTIMODAL_GATE_REQUIRED");
  // Both injectable rather than required at module scope so tests never need
  // a real kadiV1Brain instance to exercise the routing/mapping logic in
  // isolation, and so this adapter never constructs its own provider.
  const interpretConversationalInput = typeof interpretFn === "function"
    ? interpretFn
    : require("./kadiV1ConversationalMultimodalPolicy").interpretConversationalInput;
  const conversationalResultToBrainResult = typeof mapFn === "function"
    ? mapFn
    : require("./kadiV1ConversationalMultimodalBrainAdapter").conversationalResultToBrainResult;
  // `logger` is injected (never constructed here), exactly like
  // kadiV1GeminiVisionProvider.js's own safeEmitter(logger) pattern. Emission
  // never changes what this function returns — see
  // kadiV1ConversationalMultimodalObservability.js for the closed
  // event/field allowlists and the try/catch that makes a failing logger
  // non-blocking. Events carry a stable, hashed correlation_ref derived from
  // command.correlationId (itself deterministic per source WhatsApp message
  // — see kadiV1WebhookRuntime.js's idempotencyFor/correlationFor).
  //
  // IMPORTANT: this adapter only ever emits interpretation-level events
  // (conversational_result_validated / conversational_route_selected /
  // conversational_fallback_selected / conversational_clarification_required)
  // — it NEVER emits "conversational_draft_applied". This adapter decides
  // WHAT should happen to a draft; it never calls documents.apply(...) /
  // documents.removeContent(...) / documents.changeDocumentType(...)
  // itself, so it cannot know whether that mutation will actually succeed,
  // fail, or be absorbed as a replayed duplicate. For the three outcomes
  // that hand a mutation to the caller (REMOVE_ITEM matched,
  // CHANGE_DOCUMENT_TYPE convertible, CREATE_DOCUMENT/UPDATE_DOCUMENT
  // mapped), the returned value carries a frozen, already-safe
  // `observabilityFields` bag (the exact same closed fields this module
  // would have used to emit) — kadiV1ConversationOrchestrator.js is the
  // only place that calls conversational_draft_applied, and only once the
  // corresponding backend port has actually returned `ok:true` with
  // `duplicate !== true`.
  const emit = createConversationalObservabilityEmitter(logger);

  async function interpret(command) {
    const source = sourceForInputType(command.inputType);
    if (!source || !gate(command.ownerWaId)) {
      return fallbackRuntime.interpret(command);
    }
    const startedAt = Date.now();
    try {
      const envelope = await interpretConversationalInput({
        requestId: command.correlationId,
        source,
        text: source === "TEXT" ? command.text : null,
        transcription: source === "AUDIO" ? command.text : null,
        media: ["IMAGE", "PDF"].includes(source) ? command.media : null,
        activeDocument: command.activeDocument,
        brain: service,
      });
      const durationMs = Date.now() - startedAt;
      const envelopeFields = {
        correlation_id: command.correlationId,
        source,
        document_type: envelope.document_type,
        operation: envelope.operation,
        missing_field_count: envelope.missing_fields.length,
        ambiguous_field_count: envelope.ambiguous_fields.length,
        provider_category: envelope.provider_metadata?.classifier || null,
        duration_ms: durationMs,
      };
      emit("conversational_result_validated", { ...envelopeFields, intent: envelope.intent, result_status: "OK" });

      if (envelope.intent === "RECHARGE") {
        emit("conversational_route_selected", { ...envelopeFields, intent: "RECHARGE", result_status: "OK" });
        return ok(Object.freeze({ intent: "RECHARGE", document_type: null, brain_result: null }));
      }
      if (envelope.intent === "UPDATE_DOCUMENT" && envelope.operation === "REMOVE_ITEM") {
        const hint = removalHintFromEnvelope(envelope);
        const lookup = resolveRemovalTarget({ hint, items: command.activeDocument?.items });
        if (lookup.status === "MATCHED") {
          // This adapter only decides WHICH item_id to target — it never
          // mutates anything and never claims a draft was applied. The
          // caller (kadiV1ConversationOrchestrator.js) still has to call
          // documents.removeContent(...); only once that call actually
          // returns ok:true (and is not a replayed duplicate) does the
          // orchestrator emit "conversational_draft_applied", using the
          // safe fields frozen into `observabilityFields` below — this
          // module never emits a success event itself.
          emit("conversational_route_selected", { ...envelopeFields, intent: "REMOVE_ITEM", result_status: "OK" });
          return ok(Object.freeze({
            intent: "REMOVE_ITEM",
            document_type: envelope.document_type,
            remove_item_id: lookup.item_id,
            brain_result: null,
            observabilityFields: Object.freeze({ ...envelopeFields, intent: "REMOVE_ITEM", result_status: "OK" }),
          }));
        }
        emit("conversational_fallback_selected", {
          ...envelopeFields, intent: "CONTINUE", result_status: "OK",
          fallback_reason_code: lookup.status === "AMBIGUOUS" ? "REMOVE_ITEM_AMBIGUOUS" : "REMOVE_ITEM_NO_MATCH",
        });
        emit("conversational_clarification_required", { ...envelopeFields, intent: "CONTINUE", result_status: "OK" });
        return ok(Object.freeze({
          intent: "CONTINUE",
          document_type: null,
          brain_result: null,
          clarification: removalClarificationText(envelope.language, lookup.status),
        }));
      }
      if (envelope.intent === "UPDATE_DOCUMENT" && envelope.operation === "CHANGE_DOCUMENT_TYPE") {
        const currentType = command.activeDocument?.document_type || null;
        const targetType = envelope.document_type;
        const convertible = CONVERTIBLE_DOCUMENT_TYPES.has(currentType)
          && CONVERTIBLE_DOCUMENT_TYPES.has(targetType)
          && currentType !== targetType;
        if (convertible) {
          // Same rule as REMOVE_ITEM above: no mutation happens here, so no
          // success event is emitted here either. The orchestrator emits
          // "conversational_draft_applied" only after
          // documents.changeDocumentType(...) itself returns ok:true and is
          // not a replayed duplicate.
          emit("conversational_route_selected", { ...envelopeFields, intent: "CHANGE_DOCUMENT_TYPE", result_status: "OK" });
          return ok(Object.freeze({
            intent: "CHANGE_DOCUMENT_TYPE",
            document_type: targetType,
            target_document_type: targetType,
            brain_result: null,
            observabilityFields: Object.freeze({ ...envelopeFields, intent: "CHANGE_DOCUMENT_TYPE", result_status: "OK" }),
          }));
        }
        emit("conversational_fallback_selected", {
          ...envelopeFields, intent: "CONTINUE", result_status: "OK", fallback_reason_code: "CHANGE_DOCUMENT_TYPE_UNSUPPORTED",
        });
        emit("conversational_clarification_required", { ...envelopeFields, intent: "CONTINUE", result_status: "OK" });
        return ok(Object.freeze({
          intent: "CONTINUE",
          document_type: null,
          brain_result: null,
          clarification: changeDocumentTypeClarificationText(envelope.language),
        }));
      }
      if (envelope.intent === "CREATE_DOCUMENT" || envelope.intent === "UPDATE_DOCUMENT") {
        const mapped = conversationalResultToBrainResult(envelope);
        if (mapped.ok) {
          const nextIntent = envelope.intent === "CREATE_DOCUMENT" ? "PREPARE_DOCUMENT" : "CONTINUE";
          // A validated brain_result is being HANDED to the caller here —
          // it has not been applied to any draft yet. The caller still has
          // to call documents.apply(...); only once that succeeds (and is
          // not a replayed duplicate) does the orchestrator emit
          // "conversational_draft_applied" using observabilityFields below.
          emit("conversational_route_selected", { ...envelopeFields, intent: nextIntent, result_status: "OK" });
          return ok(Object.freeze({
            intent: nextIntent,
            document_type: envelope.document_type,
            brain_result: mapped.value,
            observabilityFields: Object.freeze({ ...envelopeFields, intent: nextIntent, result_status: "OK" }),
          }));
        }
        // CREATE_DOCUMENT specifically: the brain already confidently
        // determined the user wants a NEW document and which type — that
        // signal is independent of whatever made the strict Brain-shape
        // mapping fail (a malformed/edge-case extraction, not a wrong
        // document_type). Silently returning a generic clarification here
        // would contradict what the interpretation actually established, so
        // this falls back to the exact pre-existing PREPARE_DOCUMENT path
        // (documents.start with no brain_result — identical to the
        // orchestrator's own deterministic short-circuit) instead: zero
        // conversational mutation, at most one draft, no second brain call.
        //
        // There are two distinct places a "start a blank draft" fallback
        // can be reached, and that is intentional, not duplicated logic:
        // 1. HERE — a mapping failure AFTER a successfully validated
        //    envelope (envelope.intent/.document_type are known-good); the
        //    orchestrator's ordinary `interpreted.value.intent ===
        //    "PREPARE_DOCUMENT"` handling (kadiV1ConversationOrchestrator.js)
        //    picks this up like any other PREPARE_DOCUMENT result.
        // 2. kadiV1ConversationOrchestrator.js's own `startBlankDocument`
        //    helper — used for (a) ineligible owners, where no envelope was
        //    ever built at all, and (b) a hard interpretation failure
        //    (interpreted.ok === false — timeout/refusal/malformed output/
        //    validation failure), where THIS module never even returns a
        //    value for the orchestrator to inspect. Both reuse the
        //    orchestrator's own already-computed `direct.document_type`
        //    (the deterministic keyword hint), since no envelope exists to
        //    read a document_type from.
        // Unifying these into one function would require this module to
        // either call the orchestrator's helper directly (inverting the
        // dependency direction) or return through the failure channel
        // instead of the success channel — a bigger structural change than
        // this fix warrants; see docs/KADI_ENGINEERING_MEMORY.md fiche N/O.
        if (envelope.intent === "CREATE_DOCUMENT" && envelope.document_type) {
          emit("conversational_fallback_selected", {
            ...envelopeFields, intent: "PREPARE_DOCUMENT", result_status: "OK", fallback_reason_code: "CREATE_DOCUMENT_MAPPING_FAILED",
          });
          emit("conversational_route_selected", { ...envelopeFields, intent: "PREPARE_DOCUMENT", result_status: "OK" });
          return ok(Object.freeze({ intent: "PREPARE_DOCUMENT", document_type: envelope.document_type, brain_result: null }));
        }
        // UPDATE_DOCUMENT (e.g. any other operation not expressible through
        // the existing single-call documents.apply(...) port — see
        // kadiV1ConversationalMultimodalBrainAdapter.js), or a CREATE_DOCUMENT
        // envelope with no usable document_type: zero mutation, safe
        // fallback to a clarifying question rather than guessing or
        // starting an untyped draft. Falls through to the generic
        // clarification below.
        emit("conversational_fallback_selected", {
          ...envelopeFields, intent: "CONTINUE", result_status: "OK", fallback_reason_code: "CONVERSATIONAL_TO_BRAIN_MAPPING_FAILED",
        });
      }
      // CANCEL/HELP/CHECK_BALANCE/SEARCH_HISTORY reaching this point means
      // the orchestrator's own detectNaturalIntent fast path (identical for
      // every owner) already found nothing — this adapter's deterministic
      // path reuses that exact function, so it cannot find anything either.
      // UNKNOWN/ambiguous and any unmapped operation safely fall back to
      // asking the single clarifying question the policy already composed,
      // never inventing a document mutation.
      const clarification = envelope.needs_confirmation ? envelope.user_facing_message_draft : null;
      emit("conversational_route_selected", { ...envelopeFields, intent: "CONTINUE", result_status: "OK" });
      if (clarification) emit("conversational_clarification_required", { ...envelopeFields, intent: "CONTINUE", result_status: "OK" });
      return ok(Object.freeze({
        intent: "CONTINUE",
        document_type: null,
        brain_result: null,
        clarification,
      }));
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code
        : typeof error?.message === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.message) ? error.message
          : "KADI_CONVERSATIONAL_MULTIMODAL_INTERPRETATION_FAILED";
      emit("conversational_fallback_selected", {
        correlation_id: command.correlationId, source, result_status: "ERROR",
        fallback_reason_code: code, duration_ms: Date.now() - startedAt,
      });
      return fail(code);
    }
  }

  return Object.freeze({ interpret });
}

module.exports = {
  createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter,
};
