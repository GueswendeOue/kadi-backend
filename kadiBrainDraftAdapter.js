"use strict";

const BRAIN_DRAFT_ADAPTER_STATUSES = Object.freeze({
  ADAPTED: "adapted",
  NO_CHANGE: "no_change",
  REJECTED: "rejected",
});

const BRAIN_DRAFT_ADAPTER_REASONS = Object.freeze({
  DRAFT_ADAPTED: "draft_adapted",
  NO_DRAFT_CHANGE: "no_draft_change",
  INVALID_INPUT: "invalid_input",
  ACTIVATION_NOT_ALLOWED: "activation_not_allowed",
  ELIGIBILITY_NOT_GRANTED: "eligibility_not_granted",
  CANDIDATE_NOT_READY: "candidate_not_ready",
  DECISION_CHAIN_MISMATCH: "decision_chain_mismatch",
  MISSING_BRAIN_RESULT: "missing_brain_result",
  MALFORMED_BRAIN_RESULT: "malformed_brain_result",
  BRAIN_CANDIDATE_MISMATCH: "brain_candidate_mismatch",
  UNSUPPORTED_INTENT: "unsupported_intent",
  UNSUPPORTED_OPERATION: "unsupported_operation",
  UNSUPPORTED_DOCUMENT_TYPE: "unsupported_document_type",
  ACTIVE_DRAFT_REQUIRED: "active_draft_required",
  ACTIVE_DRAFT_CONFLICT: "active_draft_conflict",
  INVALID_CLIENT: "invalid_client",
  INVALID_ITEMS: "invalid_items",
  TOO_MANY_ITEMS: "too_many_items",
  INVALID_ITEM: "invalid_item",
  UNSUPPORTED_FIELD: "unsupported_field",
  AMBIGUOUS_DOCUMENT_FIELD: "ambiguous_document_field",
  UNSUPPORTED_PATCH: "unsupported_patch",
  UNSAFE_PATCH_PATH: "unsafe_patch_path",
  UNKNOWN_LINE_REFERENCE: "unknown_line_reference",
  ENGINE_OWNED_FIELD: "engine_owned_field",
});

const BRAIN_DRAFT_ALLOWED_FIELDS = Object.freeze([
  "operation", "documentId", "documentType", "clientName", "clientPhone",
  "subject", "notes", "motif", "items", "factureKind", "receiptFormat",
  "paid", "paymentMethod", "subtotal", "grandTotal", "amountPaid",
  "paymentStatus", "paymentDate", "currency",
]);

const BRAIN_DRAFT_ALLOWED_PATCH_PATHS = Object.freeze([
  "client", "clientPhone", "subject", "motif", "factureKind",
  "receiptFormat", "paid", "paymentMethod", "items.<lineRef>.label",
  "items.<lineRef>.qty", "items.<lineRef>.unit",
  "items.<lineRef>.unitPrice",
]);

const DOCUMENT_TYPES = new Set(["devis", "facture", "recu", "decharge"]);
const INTENTS = new Set([
  "create_document", "edit_document", "clarify", "confirm_document",
]);
const PATCH_OPS = new Set(["add", "remove", "replace"]);
const TOP_LEVEL_PATCHES = new Set(BRAIN_DRAFT_ALLOWED_PATCH_PATHS.slice(0, 8));
const ENGINE_FIELDS = new Set([
  "amount", "finance", "docNumber", "requestId", "status", "_saving",
  "savedDocumentId", "savedPdfMediaId", "savedPdfFilename",
  "savedPdfCaption", "pdf_media_id", "pdfMediaId", "pdf_filename",
  "pdfFilename", "pdf_caption", "pdfCaption", "creditsConsumed",
  "usedStamp", "stampRequested", "stampApplied", "stampSource",
  "stampReason", "stampMode", "convertedAt", "confirmedAt", "confirmedBy",
]);
const FINANCIAL_INPUT_FIELDS = new Set([
  "subtotal", "grandTotal", "amountPaid",
]);
const UNSAFE_PATH_PARTS = new Set([
  "__proto__", "prototype", "constructor", "finance", "amount",
  "docNumber", "savedDocumentId", "savedPdfMediaId", "savedPdfFilename",
  "savedPdfCaption", "pdf_media_id", "pdfMediaId", "pdf_filename",
  "pdfFilename", "pdf_caption", "pdfCaption", "creditsConsumed",
  "usedStamp", "stampRequested", "stampApplied", "stampSource",
  "stampReason", "stampMode",
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function emptyMetadata() {
  return {
    itemCount: 0,
    hasCurrentDraft: false,
    requiresDeterministicNormalization: false,
    requiresDeterministicFinance: false,
  };
}

function makeResult({
  status = BRAIN_DRAFT_ADAPTER_STATUSES.REJECTED,
  reason,
  candidateId = null,
  intent = null,
  operation = null,
  documentType = null,
  draft = null,
  missingFields = [],
  rejectedFields = [],
  ignoredEngineFields = [],
  warnings = [],
  metadata = emptyMetadata(),
}) {
  return {
    status,
    adapted: status === BRAIN_DRAFT_ADAPTER_STATUSES.ADAPTED,
    reason,
    candidateId,
    intent,
    operation,
    documentType,
    draft,
    missingFields: [...missingFields],
    rejectedFields: [...rejectedFields],
    ignoredEngineFields: [...ignoredEngineFields],
    warnings: [...warnings],
    metadata: { ...metadata },
  };
}

function nonEmptyString(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function nullableText(value) {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, value: null };
  const normalized = value.trim();
  return { ok: true, value: normalized || null };
}

function cloneValue(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isPlainObject(value)) return null;
  const copy = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = cloneValue(entry);
  return copy;
}

function readyActivation(value) {
  return isPlainObject(value)
    && value.status === "allowed"
    && value.allowed === true
    && value.reason === "activation_allowed"
    && nonEmptyString(value.candidateId);
}

function readyEligibility(value) {
  return isPlainObject(value)
    && value.status === "eligible"
    && value.eligible === true
    && value.reason === "conversation_eligible"
    && nonEmptyString(value.candidateId);
}

function readyCandidate(value) {
  return isPlainObject(value)
    && value.status === "candidate"
    && value.eligible === true
    && value.reason === "candidate_ready"
    && nonEmptyString(value.candidateId)
    && INTENTS.has(value.intent)
    && DOCUMENT_TYPES.has(value.documentType);
}

function copyDiagnostics(candidate) {
  return {
    missingFields: Array.isArray(candidate.missingFields)
      ? candidate.missingFields.filter((value) => typeof value === "string")
      : [],
    warnings: Array.isArray(candidate.warnings)
      ? candidate.warnings.filter((value) => typeof value === "string")
      : [],
  };
}

function checkDocumentFields(document) {
  const allowed = new Set(BRAIN_DRAFT_ALLOWED_FIELDS);
  for (const [field, value] of Object.entries(document)) {
    if (ENGINE_FIELDS.has(field) && value !== null && value !== undefined) {
      return { reason: BRAIN_DRAFT_ADAPTER_REASONS.ENGINE_OWNED_FIELD, field };
    }
    if (!allowed.has(field)) {
      return { reason: BRAIN_DRAFT_ADAPTER_REASONS.UNSUPPORTED_FIELD, field };
    }
    if (FINANCIAL_INPUT_FIELDS.has(field)
        && value !== null && value !== undefined) {
      return { reason: BRAIN_DRAFT_ADAPTER_REASONS.ENGINE_OWNED_FIELD, field };
    }
  }
  return null;
}

function copyItems(items, allowEmpty) {
  if (!Array.isArray(items)) {
    return { reason: BRAIN_DRAFT_ADAPTER_REASONS.INVALID_ITEMS };
  }
  if (items.length > 50) {
    return { reason: BRAIN_DRAFT_ADAPTER_REASONS.TOO_MANY_ITEMS };
  }
  if (!allowEmpty && items.length === 0) {
    return { reason: BRAIN_DRAFT_ADAPTER_REASONS.INVALID_ITEMS };
  }

  const copied = [];
  for (const item of items) {
    if (!isPlainObject(item)) {
      return { reason: BRAIN_DRAFT_ADAPTER_REASONS.INVALID_ITEM };
    }
    const allowed = new Set([
      "lineRef", "label", "quantity", "unit", "unitPrice", "lineTotal",
    ]);
    if (Object.keys(item).some((field) => !allowed.has(field))) {
      return { reason: BRAIN_DRAFT_ADAPTER_REASONS.UNSUPPORTED_FIELD };
    }
    if (item.lineTotal !== null && item.lineTotal !== undefined) {
      return { reason: BRAIN_DRAFT_ADAPTER_REASONS.ENGINE_OWNED_FIELD };
    }
    const label = nullableText(item.label);
    const unit = nullableText(item.unit);
    if (!label.ok || !label.value || !unit.ok) {
      return { reason: BRAIN_DRAFT_ADAPTER_REASONS.INVALID_ITEM };
    }
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
      return { reason: BRAIN_DRAFT_ADAPTER_REASONS.INVALID_ITEM };
    }
    if (!Number.isFinite(item.unitPrice) || item.unitPrice < 0) {
      return { reason: BRAIN_DRAFT_ADAPTER_REASONS.INVALID_ITEM };
    }
    copied.push({
      label: label.value,
      qty: item.quantity,
      unit: unit.value,
      unitPrice: item.unitPrice,
    });
  }
  return { items: copied };
}

function normalizeDocument(document, documentType) {
  const fieldIssue = checkDocumentFields(document);
  if (fieldIssue) return fieldIssue;

  const client = nullableText(document.clientName);
  const clientPhone = nullableText(document.clientPhone);
  const subject = nullableText(document.subject);
  const notes = nullableText(document.notes);
  const motif = nullableText(document.motif);
  const paymentMethod = nullableText(document.paymentMethod);
  if (!client.ok || !clientPhone.ok) {
    return { reason: BRAIN_DRAFT_ADAPTER_REASONS.INVALID_CLIENT };
  }
  if (!subject.ok || !notes.ok || !motif.ok || !paymentMethod.ok) {
    return { reason: BRAIN_DRAFT_ADAPTER_REASONS.UNSUPPORTED_FIELD };
  }
  if (notes.value && motif.value && notes.value !== motif.value) {
    return { reason: BRAIN_DRAFT_ADAPTER_REASONS.AMBIGUOUS_DOCUMENT_FIELD };
  }

  let factureKind = document.factureKind ?? null;
  if (documentType === "facture") {
    factureKind = factureKind === null ? "definitive" : factureKind;
    if (factureKind !== "definitive" && factureKind !== "proforma") {
      return { reason: BRAIN_DRAFT_ADAPTER_REASONS.UNSUPPORTED_FIELD };
    }
  } else {
    factureKind = null;
  }
  if (![null, "compact", "a4"].includes(document.receiptFormat ?? null)) {
    return { reason: BRAIN_DRAFT_ADAPTER_REASONS.UNSUPPORTED_FIELD };
  }
  if (document.paid !== undefined && document.paid !== null
      && typeof document.paid !== "boolean") {
    return { reason: BRAIN_DRAFT_ADAPTER_REASONS.UNSUPPORTED_FIELD };
  }

  const itemResult = copyItems(document.items, documentType === "decharge");
  if (!itemResult.items) return itemResult;
  const fields = {
    client: client.value,
    clientPhone: clientPhone.value,
    subject: subject.value,
    motif: motif.value ?? notes.value,
    items: itemResult.items,
  };
  if (document.receiptFormat !== undefined) {
    fields.receiptFormat = document.receiptFormat;
  }
  if (document.paid !== undefined) fields.paid = document.paid;
  if (document.paymentMethod !== undefined) {
    fields.paymentMethod = paymentMethod.value;
  }
  return { fields, factureKind };
}

function patchValue(patch, numeric) {
  if (patch.op === "remove") return { ok: true, value: null };
  const value = numeric ? patch.valueNumber : patch.valueText;
  if (numeric) {
    return { ok: Number.isFinite(value), value };
  }
  return nullableText(value);
}

function applyPatches(draft, patches) {
  if (!Array.isArray(patches) || patches.length > 50) {
    return { reason: BRAIN_DRAFT_ADAPTER_REASONS.UNSUPPORTED_PATCH };
  }
  for (const patch of patches) {
    if (!isPlainObject(patch) || !PATCH_OPS.has(patch.op)
        || typeof patch.path !== "string") {
      return { reason: BRAIN_DRAFT_ADAPTER_REASONS.UNSUPPORTED_PATCH };
    }
    const parts = patch.path.split(".");
    if (parts.some((part) => UNSAFE_PATH_PARTS.has(part))) {
      return { reason: BRAIN_DRAFT_ADAPTER_REASONS.UNSAFE_PATCH_PATH };
    }
    if (TOP_LEVEL_PATCHES.has(patch.path)) {
      const numeric = false;
      const value = patchValue(patch, numeric);
      if (!value.ok) return { reason: BRAIN_DRAFT_ADAPTER_REASONS.UNSUPPORTED_PATCH };
      if (patch.path === "paid") {
        if (patch.op === "remove") draft.paid = null;
        else if (patch.valueText === "true") draft.paid = true;
        else if (patch.valueText === "false") draft.paid = false;
        else return { reason: BRAIN_DRAFT_ADAPTER_REASONS.UNSUPPORTED_PATCH };
      } else if (patch.path === "factureKind") {
        if (draft.type !== "facture"
            || ![null, "definitive", "proforma"].includes(value.value)) {
          return { reason: BRAIN_DRAFT_ADAPTER_REASONS.UNSUPPORTED_PATCH };
        }
        draft.factureKind = value.value;
      } else if (patch.path === "receiptFormat") {
        if (![null, "compact", "a4"].includes(value.value)) {
          return { reason: BRAIN_DRAFT_ADAPTER_REASONS.UNSUPPORTED_PATCH };
        }
        draft.receiptFormat = value.value;
      } else {
        draft[patch.path] = value.value;
      }
      continue;
    }

    if (parts.length !== 3 || parts[0] !== "items"
        || !["label", "qty", "unit", "unitPrice"].includes(parts[2])) {
      return { reason: BRAIN_DRAFT_ADAPTER_REASONS.UNSUPPORTED_PATCH };
    }
    const lineRef = parts[1];
    if (!lineRef || /^\d+$/.test(lineRef)) {
      return { reason: BRAIN_DRAFT_ADAPTER_REASONS.UNKNOWN_LINE_REFERENCE };
    }
    const matches = Array.isArray(draft.items)
      ? draft.items.filter((item) => isPlainObject(item) && item.lineRef === lineRef)
      : [];
    if (matches.length !== 1) {
      return { reason: BRAIN_DRAFT_ADAPTER_REASONS.UNKNOWN_LINE_REFERENCE };
    }
    const field = parts[2];
    const numeric = field === "qty" || field === "unitPrice";
    const value = patchValue(patch, numeric);
    if (!value.ok || (numeric && (value.value === null || value.value < 0))
        || (field === "qty" && value.value <= 0)
        || (field === "label" && !value.value)) {
      return { reason: BRAIN_DRAFT_ADAPTER_REASONS.INVALID_ITEM };
    }
    matches[0][field] = value.value;
  }
  return { draft };
}

function adaptBrainDecisionToDraft(input) {
  if (!isPlainObject(input)) {
    return makeResult({ reason: BRAIN_DRAFT_ADAPTER_REASONS.INVALID_INPUT });
  }
  if (!readyActivation(input.activationDecision)) {
    return makeResult({ reason: BRAIN_DRAFT_ADAPTER_REASONS.ACTIVATION_NOT_ALLOWED });
  }
  if (!readyEligibility(input.eligibilityDecision)) {
    return makeResult({ reason: BRAIN_DRAFT_ADAPTER_REASONS.ELIGIBILITY_NOT_GRANTED });
  }
  if (!readyCandidate(input.candidateDecision)) {
    return makeResult({ reason: BRAIN_DRAFT_ADAPTER_REASONS.CANDIDATE_NOT_READY });
  }

  const activation = input.activationDecision;
  const eligibility = input.eligibilityDecision;
  const candidate = input.candidateDecision;
  const common = {
    candidateId: candidate.candidateId,
    intent: candidate.intent,
    documentType: candidate.documentType,
  };
  const diagnostics = copyDiagnostics(candidate);
  if (activation.candidateId !== candidate.candidateId
      || eligibility.candidateId !== candidate.candidateId) {
    return makeResult({
      reason: BRAIN_DRAFT_ADAPTER_REASONS.DECISION_CHAIN_MISMATCH,
      ...common,
      ...diagnostics,
    });
  }

  const brain = input.brainResult;
  if (!isPlainObject(brain)) {
    return makeResult({
      reason: BRAIN_DRAFT_ADAPTER_REASONS.MISSING_BRAIN_RESULT,
      ...common,
      ...diagnostics,
    });
  }
  if (!isPlainObject(brain.intent) || !isPlainObject(brain.document)
      || !Array.isArray(brain.patches)) {
    return makeResult({
      reason: BRAIN_DRAFT_ADAPTER_REASONS.MALFORMED_BRAIN_RESULT,
      ...common,
      ...diagnostics,
    });
  }
  if (!INTENTS.has(brain.intent.name)) {
    return makeResult({ reason: BRAIN_DRAFT_ADAPTER_REASONS.UNSUPPORTED_INTENT, ...common });
  }
  if (!DOCUMENT_TYPES.has(brain.document.documentType)) {
    return makeResult({ reason: BRAIN_DRAFT_ADAPTER_REASONS.UNSUPPORTED_DOCUMENT_TYPE, ...common });
  }

  const operation = brain.document.operation;
  const expectedOperation = candidate.intent === "create_document"
    ? "create"
    : candidate.intent === "edit_document" ? "edit" : null;
  const candidateOperation = Array.isArray(candidate.operations)
    ? candidate.operations[0] ?? null
    : null;
  const coherent = brain.intent.name === candidate.intent
    && brain.document.documentType === candidate.documentType
    && operation === expectedOperation
    && candidateOperation === expectedOperation;
  if (!coherent) {
    return makeResult({
      reason: BRAIN_DRAFT_ADAPTER_REASONS.BRAIN_CANDIDATE_MISMATCH,
      operation: operation === "create" || operation === "edit" ? operation : null,
      ...common,
      ...diagnostics,
    });
  }

  if (candidate.intent === "clarify" || candidate.intent === "confirm_document") {
    return makeResult({
      status: BRAIN_DRAFT_ADAPTER_STATUSES.NO_CHANGE,
      reason: BRAIN_DRAFT_ADAPTER_REASONS.NO_DRAFT_CHANGE,
      operation: null,
      ...common,
      ...diagnostics,
      metadata: {
        ...emptyMetadata(),
        hasCurrentDraft: isPlainObject(input.currentDraft),
      },
    });
  }
  if (operation !== "create" && operation !== "edit") {
    return makeResult({ reason: BRAIN_DRAFT_ADAPTER_REASONS.UNSUPPORTED_OPERATION, ...common });
  }

  let draft;
  if (operation === "create") {
    const normalized = normalizeDocument(brain.document, candidate.documentType);
    if (!normalized.fields) {
      return makeResult({
        reason: normalized.reason,
        operation,
        rejectedFields: normalized.field ? [normalized.field] : [],
        ignoredEngineFields: normalized.reason === BRAIN_DRAFT_ADAPTER_REASONS.ENGINE_OWNED_FIELD
          && normalized.field ? [normalized.field] : [],
        ...common,
        ...diagnostics,
      });
    }
    if (input.currentDraft !== null) {
      return makeResult({ reason: BRAIN_DRAFT_ADAPTER_REASONS.ACTIVE_DRAFT_CONFLICT, operation, ...common });
    }
    draft = {
      type: candidate.documentType,
      factureKind: normalized.factureKind,
      docNumber: null,
      date: null,
      client: normalized.fields.client,
      clientPhone: normalized.fields.clientPhone,
      subject: normalized.fields.subject,
      motif: normalized.fields.motif,
      items: normalized.fields.items,
      finance: null,
      source: "brain",
      meta: { brainCandidateId: candidate.candidateId },
    };
    for (const field of ["receiptFormat", "paid", "paymentMethod"]) {
      if (Object.hasOwn(normalized.fields, field)) draft[field] = normalized.fields[field];
    }
  } else {
    const fieldIssue = checkDocumentFields(brain.document);
    if (fieldIssue) {
      return makeResult({
        reason: fieldIssue.reason,
        operation,
        rejectedFields: fieldIssue.field ? [fieldIssue.field] : [],
        ignoredEngineFields: fieldIssue.reason === BRAIN_DRAFT_ADAPTER_REASONS.ENGINE_OWNED_FIELD
          && fieldIssue.field ? [fieldIssue.field] : [],
        ...common,
        ...diagnostics,
      });
    }
    if (!isPlainObject(input.currentDraft)) {
      return makeResult({ reason: BRAIN_DRAFT_ADAPTER_REASONS.ACTIVE_DRAFT_REQUIRED, operation, ...common });
    }
    if (input.currentDraft.type !== candidate.documentType) {
      return makeResult({ reason: BRAIN_DRAFT_ADAPTER_REASONS.ACTIVE_DRAFT_CONFLICT, operation, ...common });
    }
    draft = cloneValue(input.currentDraft);
    if (!isPlainObject(draft)) {
      return makeResult({ reason: BRAIN_DRAFT_ADAPTER_REASONS.ACTIVE_DRAFT_REQUIRED, operation, ...common });
    }
    const patched = applyPatches(draft, brain.patches);
    if (!patched.draft) {
      return makeResult({ reason: patched.reason, operation, ...common, ...diagnostics });
    }
  }

  return makeResult({
    status: BRAIN_DRAFT_ADAPTER_STATUSES.ADAPTED,
    reason: BRAIN_DRAFT_ADAPTER_REASONS.DRAFT_ADAPTED,
    operation,
    draft,
    ...common,
    ...diagnostics,
    metadata: {
      itemCount: Array.isArray(draft.items) ? draft.items.length : 0,
      hasCurrentDraft: isPlainObject(input.currentDraft),
      requiresDeterministicNormalization: true,
      requiresDeterministicFinance: true,
    },
  });
}

module.exports = {
  BRAIN_DRAFT_ADAPTER_STATUSES,
  BRAIN_DRAFT_ADAPTER_REASONS,
  BRAIN_DRAFT_ALLOWED_FIELDS,
  BRAIN_DRAFT_ALLOWED_PATCH_PATHS,
  adaptBrainDecisionToDraft,
};
