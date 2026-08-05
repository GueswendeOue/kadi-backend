"use strict";

const crypto = require("node:crypto");

const SHARED_DOCUMENT_TYPES = Object.freeze(["FACTURE", "DEVIS", "RECU"]);
const DOCUMENT_TYPES = Object.freeze([...SHARED_DOCUMENT_TYPES, "DECHARGE"]);
const EDITABLE_STATES = new Set([
  "COLLECTING", "INCOMPLETE", "READY_FOR_REVIEW", "VERIFIED",
  "PREVIEW_READY", "COST_CALCULATED", "AWAITING_GENERATION_CONFIRMATION", "RECHARGE_REQUIRED",
]);

function ok(value, extra = {}) { return { ok: true, value, ...extra }; }
function fail(error) { return { ok: false, error }; }
function clone(value) { return value == null ? value : structuredClone(value); }
function assertMethods(target, methods, name) {
  if (!target || typeof target !== "object") throw new TypeError(`${name}_REQUIRED`);
  for (const method of methods) if (typeof target[method] !== "function") throw new TypeError(`${name}_METHOD_REQUIRED:${method}`);
  return target;
}
function asResult(result, fallback) {
  return result && typeof result === "object" && typeof result.ok === "boolean" ? result : fail(fallback);
}
function runtimeKey(prefix, source, scope = "") {
  const digest = crypto.createHash("sha256").update(`${source || ""}:${scope}`).digest("hex").slice(0, 40);
  return `${prefix}${digest}`;
}
function documentIdentity(command) {
  if (!command || typeof command !== "object") return fail("KADI_V1_DOCUMENT_RUNTIME_COMMAND_INVALID");
  if (!/^\d{8,20}$/.test(command.ownerWaId || "")) return fail("KADI_V1_DOCUMENT_RUNTIME_OWNER_INVALID");
  if (!/^[A-Za-z0-9:_-]{1,200}$/.test(command.documentId || "")) return fail("KADI_V1_DOCUMENT_RUNTIME_ID_INVALID");
  if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) return fail("KADI_V1_DOCUMENT_RUNTIME_VERSION_INVALID");
  if (!DOCUMENT_TYPES.includes(command.documentType)) return fail("KADI_V1_DOCUMENT_RUNTIME_TYPE_INVALID");
  return ok(command);
}

function createKadiV1DocumentRuntimeAdapter({ sharedPipeline, dischargePipeline, documentRepository, issuerResolver } = {}) {
  const shared = assertMethods(sharedPipeline, [
    "createDraft", "applyBrainExtraction", "setInvoiceKind", "setReceiptFormat", "setClientOrPayer", "addContent", "updateContent",
    "removeContent", "setOptions", "markReadyForReview", "verifyDocument", "reopenForCorrection", "cancelDocument",
  ], "KADI_V1_SHARED_PIPELINE");
  const discharge = assertMethods(dischargePipeline, [
    "createDischargeDraft", "applyBrainExtraction", "setIssuerOrGiver", "setRecipient", "setTransferredContent",
    "setReason", "setOptions", "markReadyForReview", "verifyDischarge", "reopenForCorrection", "cancelDischarge",
  ], "KADI_V1_DISCHARGE_PIPELINE");
  const documents = assertMethods(documentRepository, ["getDocumentById"], "KADI_V1_DOCUMENT_REPOSITORY");
  const issuers = assertMethods(issuerResolver, ["getIssuerProfileId"], "KADI_V1_ISSUER_RESOLVER");

  function pipelineFor(type) { return type === "DECHARGE" ? discharge : shared; }
  function sharedKey(operation, source, scope) {
    const prefixes = {
      createDraft: "create_draft:", applyBrainExtraction: "brain_extraction:", setInvoiceKind: "set_invoice_kind:", setReceiptFormat: "set_receipt_format:", setClientOrPayer: "set_party:",
      addContent: "add_content:", updateContent: "update_content:", removeContent: "remove_content:",
      setOptions: "set_options:", markReadyForReview: "mark_ready:", verifyDocument: "verify:",
      reopenForCorrection: "reopen:", cancelDocument: "cancel:",
    };
    return runtimeKey(prefixes[operation], source, scope);
  }
  function dischargeKey(operation, source, scope) { return runtimeKey(`discharge_${operation}:`, source, scope); }
  function keyFor(type, operation, source, scope) {
    return type === "DECHARGE" ? dischargeKey(operation, source, scope) : sharedKey(operation, source, scope);
  }
  async function load(command) {
    const checked = documentIdentity(command);
    if (!checked.ok) return checked;
    const loaded = await documents.getDocumentById({ documentId: command.documentId, ownerWaId: command.ownerWaId });
    if (!loaded.ok) return loaded;
    if (loaded.value.version !== command.expectedVersion) return fail("DOCUMENT_VERSION_CONFLICT");
    if (loaded.value.document_type !== command.documentType) return fail("DOCUMENT_TYPE_MISMATCH");
    return loaded;
  }
  async function advanceIfComplete(document, ownerWaId, sourceKey) {
    if (!document || !["COLLECTING", "INCOMPLETE"].includes(document.status)) return ok(document);
    if ((document.missing_fields || []).length > 0 || (document.uncertainties || []).length > 0) return ok(document);
    const type = document.document_type;
    const command = {
      ownerWaId,
      documentId: document.document_id,
      expectedVersion: document.version,
      idempotencyKey: keyFor(type, type === "DECHARGE" ? "markReadyForReview" : "markReadyForReview", sourceKey, "ready"),
    };
    return type === "DECHARGE" ? discharge.markReadyForReview(command) : shared.markReadyForReview(command);
  }
  async function start({ ownerWaId, documentType, idempotencyKey }) {
    if (!/^\d{8,20}$/.test(ownerWaId || "") || !DOCUMENT_TYPES.includes(documentType)) return fail("KADI_V1_DOCUMENT_START_INPUT_INVALID");
    if (documentType === "DECHARGE") {
      return discharge.createDischargeDraft({ ownerWaId, idempotencyKey: dischargeKey("create", idempotencyKey) });
    }
    const issuer = await issuers.getIssuerProfileId({ ownerWaId });
    if (!issuer?.ok || !/^[A-Za-z0-9:_-]{1,200}$/.test(issuer.value?.issuerProfileId || "")) {
      return fail(issuer?.error || "KADI_V1_ISSUER_NOT_CONFIGURED");
    }
    return shared.createDraft({
      ownerWaId, documentType, issuerProfileId: issuer.value.issuerProfileId,
      idempotencyKey: sharedKey("createDraft", idempotencyKey),
    });
  }
  async function apply({ ownerWaId, document, brainResult, idempotencyKey }) {
    if (!document || !DOCUMENT_TYPES.includes(document.document_type)) return fail("KADI_V1_DOCUMENT_APPLY_CONTEXT_INVALID");
    const type = document.document_type;
    const command = {
      ownerWaId, documentId: document.document_id, expectedVersion: document.version, brainResult,
      idempotencyKey: keyFor(type, "applyBrainExtraction", idempotencyKey),
    };
    const applied = type === "DECHARGE" ? await discharge.applyBrainExtraction(command) : await shared.applyBrainExtraction(command);
    if (!applied.ok) return applied;
    return advanceIfComplete(applied.value, ownerWaId, idempotencyKey);
  }
  async function setInvoiceKind(command) {
    const checked = documentIdentity(command);
    if (!checked.ok) return checked;
    if (command.documentType !== "FACTURE") return fail("KADI_V1_INVOICE_KIND_FLOW_FORBIDDEN");
    return shared.setInvoiceKind({
      ownerWaId: command.ownerWaId, documentId: command.documentId, expectedVersion: command.expectedVersion,
      invoiceKind: command.invoiceKind, idempotencyKey: sharedKey("setInvoiceKind", command.idempotencyKey),
    });
  }
  async function setReceiptDetails(command) {
    const checked = documentIdentity(command);
    if (!checked.ok) return checked;
    if (command.documentType !== "RECU") return fail("KADI_V1_RECEIPT_DETAILS_FLOW_FORBIDDEN");
    const details = command.details && typeof command.details === "object" ? clone(command.details) : null;
    if (!details) return fail("KADI_V1_RECEIPT_DETAILS_INVALID");
    let current = await load(command);
    if (!current.ok) return current;
    let step = 0;
    async function mutate(method, payload) {
      const result = await shared[method]({
        ownerWaId: command.ownerWaId, documentId: command.documentId, expectedVersion: current.value.version,
        ...payload, idempotencyKey: sharedKey(method, command.idempotencyKey, String(++step)),
      });
      if (result.ok) current = result;
      return result;
    }
    const content = await mutate("addContent", {
      content: {
        payer: details.payer,
        beneficiary: details.beneficiary,
        amount: details.amount,
        reason: details.reason,
        payment_method: details.payment_method,
        reference: details.reference,
      },
    });
    if (!content.ok) return content;
    const format = await mutate("setReceiptFormat", { receiptFormat: details.receipt_format });
    if (!format.ok) return format;
    return advanceIfComplete(current.value, command.ownerWaId, command.idempotencyKey);
  }
  async function setClient(command) {
    const checked = documentIdentity(command);
    if (!checked.ok) return checked;
    if (command.documentType === "DECHARGE") return fail("KADI_V1_DISCHARGE_CLIENT_FLOW_FORBIDDEN");
    return shared.setClientOrPayer({
      ownerWaId: command.ownerWaId, documentId: command.documentId, expectedVersion: command.expectedVersion,
      party: clone(command.client), idempotencyKey: sharedKey("setClientOrPayer", command.idempotencyKey),
    });
  }
  async function startAddContent(command) {
    const checked = documentIdentity(command);
    if (!checked.ok) return checked;
    if (command.documentType === "DECHARGE") return fail("KADI_V1_DISCHARGE_CONTENT_FLOW_REQUIRED");
    return load(command);
  }
  async function addContent(command) {
    const checked = documentIdentity(command);
    if (!checked.ok) return checked;
    if (command.documentType === "DECHARGE") return fail("KADI_V1_DISCHARGE_CONTENT_FLOW_REQUIRED");
    return shared.addContent({
      ownerWaId: command.ownerWaId, documentId: command.documentId, expectedVersion: command.expectedVersion,
      content: clone(command.content), idempotencyKey: sharedKey("addContent", command.idempotencyKey),
    });
  }
  async function updateContent(command) {
    const checked = documentIdentity(command);
    if (!checked.ok) return checked;
    if (command.documentType === "DECHARGE") return fail("KADI_V1_DISCHARGE_CONTENT_FLOW_REQUIRED");
    return shared.updateContent({
      ownerWaId: command.ownerWaId, documentId: command.documentId, expectedVersion: command.expectedVersion,
      itemId: command.itemId, content: clone(command.content), idempotencyKey: sharedKey("updateContent", command.idempotencyKey),
    });
  }
  async function removeContent(command) {
    const checked = documentIdentity(command);
    if (!checked.ok) return checked;
    if (command.documentType === "DECHARGE") return fail("KADI_V1_DISCHARGE_CONTENT_FLOW_REQUIRED");
    return shared.removeContent({
      ownerWaId: command.ownerWaId, documentId: command.documentId, expectedVersion: command.expectedVersion,
      itemId: command.itemId, idempotencyKey: sharedKey("removeContent", command.idempotencyKey),
    });
  }
  async function setOptions(command) {
    const checked = documentIdentity(command);
    if (!checked.ok) return checked;
    const type = command.documentType;
    const options = clone(command.options);
    if (!options || typeof options !== "object" || Array.isArray(options)) return fail("KADI_V1_DOCUMENT_OPTIONS_INVALID");
    if (Object.keys(options).length === 0) {
      const current = await load(command);
      return current.ok ? advanceIfComplete(current.value, command.ownerWaId, command.idempotencyKey) : current;
    }
    const saved = type === "DECHARGE"
      ? await discharge.setOptions({ ownerWaId: command.ownerWaId, documentId: command.documentId, expectedVersion: command.expectedVersion, options, idempotencyKey: dischargeKey("setOptions", command.idempotencyKey) })
      : await shared.setOptions({ ownerWaId: command.ownerWaId, documentId: command.documentId, expectedVersion: command.expectedVersion, options, idempotencyKey: sharedKey("setOptions", command.idempotencyKey) });
    if (!saved.ok) return saved;
    return advanceIfComplete(saved.value, command.ownerWaId, command.idempotencyKey);
  }
  async function verify(command) {
    const checked = documentIdentity(command);
    if (!checked.ok) return checked;
    const type = command.documentType;
    const input = { ownerWaId: command.ownerWaId, documentId: command.documentId, expectedVersion: command.expectedVersion, idempotencyKey: keyFor(type, type === "DECHARGE" ? "verify" : "verifyDocument", command.idempotencyKey) };
    return type === "DECHARGE" ? discharge.verifyDischarge(input) : shared.verifyDocument(input);
  }
  async function beginEdit(command) {
    const loaded = await load(command);
    if (!loaded.ok) return loaded;
    if (!EDITABLE_STATES.has(loaded.value.status)) return fail("DOCUMENT_MODIFICATION_FORBIDDEN");
    if (loaded.value.status !== "VERIFIED") return loaded;
    const type = command.documentType;
    const input = { ownerWaId: command.ownerWaId, documentId: command.documentId, expectedVersion: command.expectedVersion, idempotencyKey: keyFor(type, type === "DECHARGE" ? "reopen" : "reopenForCorrection", command.idempotencyKey) };
    return type === "DECHARGE" ? discharge.reopenForCorrection(input) : shared.reopenForCorrection(input);
  }
  async function saveForLater(command) { return load(command); }
  async function finishContent(command) {
    const checked = documentIdentity(command);
    if (!checked.ok) return checked;
    if (command.documentType === "DECHARGE") return fail("KADI_V1_DISCHARGE_FINISH_CONTENT_INVALID");
    const loaded = await load(command);
    if (!loaded.ok) return loaded;
    const doc = loaded.value;
    if (doc.document_type !== "RECU" && (!Array.isArray(doc.items) || doc.items.length === 0)) {
      return fail("KADI_V1_DOCUMENT_CONTENT_REQUIRED");
    }
    return ok(doc);
  }
  function normalizeDischargeType(value) {
    const normalized = String(value || "").trim().toUpperCase();
    return ({ ARGENT: "MONEY", MONEY: "MONEY", BIEN: "GOODS", GOODS: "GOODS", DOCUMENT: "DOCUMENT", AUTRE: "OTHER", OTHER: "OTHER" })[normalized] || null;
  }
  async function saveDischargeDetails(command) {
    const checked = documentIdentity(command);
    if (!checked.ok) return checked;
    if (command.documentType !== "DECHARGE") return fail("KADI_V1_DISCHARGE_TYPE_REQUIRED");
    const details = command.details && typeof command.details === "object" ? clone(command.details) : null;
    if (!details) return fail("KADI_V1_DISCHARGE_DETAILS_INVALID");
    let current = await load(command);
    if (!current.ok) return current;
    let step = 0;
    async function mutate(method, payload) {
      const result = await discharge[method]({
        ownerWaId: command.ownerWaId, documentId: command.documentId, expectedVersion: current.value.version,
        ...payload, idempotencyKey: dischargeKey(method, command.idempotencyKey, String(++step)),
      });
      if (result.ok) current = result;
      return result;
    }
    if (details.giver != null) { const result = await mutate("setIssuerOrGiver", { giver: details.giver }); if (!result.ok) return result; }
    if (details.recipient != null) { const result = await mutate("setRecipient", { recipient: details.recipient }); if (!result.ok) return result; }
    if (details.transferred_content_type != null || details.content != null) {
      const raw = details.content && typeof details.content === "object" ? details.content : {};
      const type = normalizeDischargeType(raw.type || details.transferred_content_type);
      if (!type) return fail("DISCHARGE_CONTENT_TYPE_INVALID");
      const content = {
        type,
        amount: type === "MONEY" ? (raw.amount ?? details.amount) : null,
        currency: type === "MONEY" ? (raw.currency ?? details.currency ?? current.value.currency) : null,
        description: type === "MONEY" ? null : (raw.description ?? details.description ?? details.transferred_content ?? null),
        quantity: type === "MONEY" ? null : (raw.quantity ?? details.quantity ?? null),
      };
      const result = await mutate("setTransferredContent", { content }); if (!result.ok) return result;
    }
    if (details.reason != null) { const result = await mutate("setReason", { reason: details.reason }); if (!result.ok) return result; }
    if (details.observations != null) { const result = await mutate("setOptions", { options: { observations: details.observations } }); if (!result.ok) return result; }
    return advanceIfComplete(current.value, command.ownerWaId, command.idempotencyKey);
  }
  async function cancel(command) {
    const checked = documentIdentity(command);
    if (!checked.ok) return checked;
    const type = command.documentType;
    const input = { ownerWaId: command.ownerWaId, documentId: command.documentId, expectedVersion: command.expectedVersion, idempotencyKey: keyFor(type, type === "DECHARGE" ? "cancel" : "cancelDocument", command.idempotencyKey) };
    return type === "DECHARGE" ? discharge.cancelDischarge(input) : shared.cancelDocument(input);
  }

  return Object.freeze({ start, apply, setInvoiceKind, setReceiptDetails, setClient, startAddContent, addContent, updateContent, removeContent, finishContent, setOptions, verify, beginEdit, saveForLater, saveDischargeDetails, cancel });
}

function createKadiV1PreviewRuntimeAdapter({ previewService, temporaryRenderService, generationQuoteService } = {}) {
  const previews = assertMethods(previewService, ["persistPreview"], "KADI_V1_PREVIEW_SERVICE");
  const renders = assertMethods(temporaryRenderService, ["createTemporaryRender", "inspectTemporaryRender"], "KADI_V1_TEMPORARY_RENDER_SERVICE");
  const quotes = assertMethods(generationQuoteService, ["createGenerationQuote"], "KADI_V1_GENERATION_QUOTE_SERVICE");
  async function prepare(command) {
    const checked = documentIdentity({ ...command, documentType: command.documentType });
    if (!checked.ok) return checked;
    const preview = await previews.persistPreview({
      ownerWaId: command.ownerWaId, documentId: command.documentId, expectedVersion: command.expectedVersion,
      idempotencyKey: runtimeKey("preview:", command.idempotencyKey),
    });
    if (!preview.ok) return preview;
    const render = await renders.createTemporaryRender({
      ownerWaId: command.ownerWaId, previewId: preview.value.preview_id, documentId: command.documentId,
      documentVersion: preview.value.document_version, idempotencyKey: runtimeKey("render:", command.idempotencyKey),
    });
    if (!render.ok) return render;
    const inspected = await renders.inspectTemporaryRender({ renderId: render.value.render_id, ownerWaId: command.ownerWaId });
    if (!inspected.ok) return inspected;
    const quote = await quotes.createGenerationQuote({
      ownerWaId: command.ownerWaId, documentId: command.documentId, documentVersion: preview.value.document_version,
      previewId: preview.value.preview_id, renderId: inspected.value.render_id,
      inputModality: command.inputModality || null, options: clone(command.options || {}),
      idempotencyKey: runtimeKey("quote:", command.idempotencyKey),
    });
    if (!quote.ok) return quote;
    return ok(Object.freeze({ preview: preview.value, temporary_render: inspected.value, quote: quote.value, document: quote.document || preview.document || null }));
  }
  return Object.freeze({ prepare });
}

function createKadiV1GenerationRuntimeAdapter({ generationLifecycleService } = {}) {
  const lifecycle = assertMethods(generationLifecycleService, ["confirmGeneration"], "KADI_V1_GENERATION_LIFECYCLE_SERVICE");
  async function confirm(command) {
    const checked = documentIdentity(command);
    if (!checked.ok) return checked;
    if (!/^[A-Za-z0-9:_.-]{1,200}$/.test(command.quoteId || "")) return fail("KADI_V1_GENERATION_QUOTE_INVALID");
    return lifecycle.confirmGeneration({
      ownerWaId: command.ownerWaId, documentId: command.documentId, documentVersion: command.expectedVersion,
      quoteId: command.quoteId, idempotencyKey: runtimeKey("generation_confirm:", command.idempotencyKey),
    });
  }
  return Object.freeze({ confirm });
}

function createKadiV1OnboardingRuntimeAdapter({ onboardingService, profileCompleter = null } = {}) {
  const service = assertMethods(onboardingService, ["onboardNewUser", "getOnboardingState", "completeOnboarding"], "KADI_V1_ONBOARDING_SERVICE");
  const profiles = profileCompleter == null
    ? null
    : assertMethods(profileCompleter, ["complete"], "KADI_V1_ONBOARDING_PROFILE_COMPLETER");
  async function start({ ownerWaId }) {
    const onboarded = await service.onboardNewUser({ waId: ownerWaId });
    if (!onboarded?.ok) return fail(onboarded?.error || "KADI_V1_ONBOARDING_FAILED");
    const state = await service.getOnboardingState({ waId: ownerWaId });
    if (!state?.ok) return fail(state?.error || "KADI_V1_ONBOARDING_STATE_FAILED");
    return ok(Object.freeze({
      profile: onboarded.profile || state.value,
      welcome_credits_granted: state.value?.welcome_credits_granted === true,
      welcome_should_send: onboarded.credits_granted_now === true,
      welcome: onboarded.welcome || null,
    }));
  }
  async function continueOnboarding({
    ownerWaId,
    profileData = {},
    idempotencyKey = null,
  }) {
    if (profiles) {
      const completed = await profiles.complete({
        ownerWaId,
        profileData: clone(profileData),
        idempotencyKey,
      });
      if (!completed?.ok) {
        return fail(completed?.error || "KADI_V1_ONBOARDING_PROFILE_COMPLETE_FAILED");
      }
      const value = completed.value && typeof completed.value === "object"
        ? clone(completed.value)
        : {};
      return ok(Object.freeze({
        ...value,
        next_flow_key: "MENU",
      }), {
        duplicate: completed.duplicate === true,
      });
    }

    const completed = await service.completeOnboarding({ waId: ownerWaId });
    return completed?.ok
      ? ok(completed.value || completed.profile || null)
      : fail(completed?.error || "KADI_V1_ONBOARDING_COMPLETE_FAILED");
  }
  return Object.freeze({ start, continueOnboarding });
}

function createKadiV1InterpretationRuntimeAdapter({ brain } = {}) {
  const service = assertMethods(brain, ["understand"], "KADI_V1_BRAIN");
  const intentMap = Object.freeze({ CREATE_DOCUMENT: "PREPARE_DOCUMENT", UPDATE_DOCUMENT: "CONTINUE", SEARCH_DOCUMENT: "HISTORY_SEARCH", REQUEST_HELP: "HELP", UNKNOWN: "CONTINUE" });
  async function interpret(command) {
    const modality = command.inputType === "PDF" ? "DOCUMENT" : command.inputType;
    const request = {
      request_id: command.correlationId,
      modality,
      conversation_context: { has_active_document: Boolean(command.activeDocument) },
      document_type_hint: command.activeDocument?.document_type || null,
      collected_data: command.activeDocument ? clone(command.activeDocument) : {},
    };
    if (modality === "TEXT") request.text = command.text;
    else if (modality === "TRANSCRIPTION") request.transcription = command.text;
    else request.media = clone(command.media);
    try {
      const understood = await service.understand(request);
      return ok(Object.freeze({ intent: intentMap[understood.intent] || "CONTINUE", document_type: understood.document_type || null, brain_result: understood }));
    } catch (error) {
      return fail(typeof error?.code === "string" ? error.code : "KADI_V1_INTERPRETATION_FAILED");
    }
  }
  return Object.freeze({ interpret });
}

function createKadiV1HistoryRuntimeAdapter({ historyService } = {}) {
  const service = assertMethods(historyService, ["searchDocuments", "getDocumentDetails"], "KADI_V1_HISTORY_SERVICE");
  async function search(command) {
    const criteria = command.criteria && typeof command.criteria === "object" ? clone(command.criteria) : {};
    if (command.query && !criteria.text) criteria.text = String(command.query).trim();
    for (const field of ["action", "document_id", "limit", "query"]) delete criteria[field];
    const limit = Number.isSafeInteger(command.limit) ? Math.min(Math.max(command.limit, 1), 20) : 5;
    return service.searchDocuments({ ownerWaId: command.ownerWaId, filters: criteria, limit, correlationId: command.correlationId || null });
  }
  async function open({ ownerWaId, documentId }) { return service.getDocumentDetails({ ownerWaId, documentId }); }
  return Object.freeze({ search, open });
}

function createKadiV1WalletRuntimeAdapter({ balanceReader } = {}) {
  const reader = assertMethods(balanceReader, ["getBalance"], "KADI_V1_BALANCE_READER");
  async function getBalance({ ownerWaId }) {
    const balance = await reader.getBalance({ ownerWaId });
    if (!balance?.ok || !Number.isSafeInteger(balance.value?.credits) || balance.value.credits < 0) return fail(balance?.error || "KADI_V1_BALANCE_INVALID");
    return ok(Object.freeze({ credits: balance.value.credits }));
  }
  return Object.freeze({ getBalance });
}

function createKadiV1VoicePolicyRuntimeAdapter({ voicePolicyEngine, providerAvailability = async () => false } = {}) {
  const engine = assertMethods(voicePolicyEngine, ["evaluate"], "KADI_V1_VOICE_POLICY_ENGINE");
  if (typeof providerAvailability !== "function") throw new TypeError("KADI_V1_VOICE_PROVIDER_AVAILABILITY_REQUIRED");
  async function evaluate(command) {
    try {
      const available = await providerAvailability();
      const decision = engine.evaluate({
        voice_response_mode: command.voice_response_mode,
        validated_text: command.canonical_text,
        provider_available: available === true,
        last_input_modality: command.input_type === "TRANSCRIPTION" ? "VOICE" : command.input_type,
        journey_step: command.step === "WELCOME" ? "ONBOARDING_INITIAL" : command.step,
        contains_sensitive_data: false,
        explicit_voice_request: false,
        message_complexity: command.step === "HELP" || command.step === "MISSING_INFORMATION" ? "COMPLEX" : "SIMPLE",
      });
      return ok(Object.freeze({ mode: decision.decision, reason: decision.reason, wallet_debit: false }));
    } catch {
      return fail("KADI_V1_VOICE_POLICY_FAILED");
    }
  }
  return Object.freeze({ evaluate });
}

module.exports = {
  DOCUMENT_TYPES,
  createKadiV1DocumentRuntimeAdapter,
  createKadiV1GenerationRuntimeAdapter,
  createKadiV1HistoryRuntimeAdapter,
  createKadiV1InterpretationRuntimeAdapter,
  createKadiV1OnboardingRuntimeAdapter,
  createKadiV1PreviewRuntimeAdapter,
  createKadiV1VoicePolicyRuntimeAdapter,
  createKadiV1WalletRuntimeAdapter,
  runtimeKey,
};
