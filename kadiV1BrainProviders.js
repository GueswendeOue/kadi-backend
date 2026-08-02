"use strict";

const { normalizeDocumentType } = require("./kadiV1BrainContracts");

function createBrainProvider({ name, understand }) {
  if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]{1,39}$/.test(name)) {
    throw new TypeError("BRAIN_PROVIDER_NAME_INVALID");
  }
  if (typeof understand !== "function") throw new TypeError("BRAIN_PROVIDER_UNDERSTAND_REQUIRED");
  return Object.freeze({ name, understand });
}

function source(modality, field) {
  return `${String(modality || "input").toLowerCase()}:${field}`;
}

function candidate(value, modality, field, confidence, status = "CONFIRMED") {
  return { value, status, confidence, source_reference: source(modality, field) };
}

function targetedQuestion(missingFields) {
  const first = missingFields[0];
  if (first === "client") return "Quel est le nom du client ?";
  if (first === "items") return "Quel produit ou service faut-il ajouter ?";
  if (first === "amount") return "Quel est le montant exact ?";
  return "Pouvez-vous préciser l’information manquante ?";
}

function inferIntent(raw) {
  const kind = String(raw?.kind || raw?.intent || "").toLowerCase();
  if (kind.includes("search")) return "SEARCH_DOCUMENT";
  if (kind.includes("update") || kind.includes("edit")) return "UPDATE_DOCUMENT";
  if (kind.includes("help")) return "REQUEST_HELP";
  if (normalizeDocumentType(raw?.documentType || raw?.docType || raw?.document_type)) return "CREATE_DOCUMENT";
  return "UNKNOWN";
}

function normalizeItems(items, modality, confidence) {
  if (!Array.isArray(items) || items.length === 0) return { candidate: null, invalid: false };
  const safe = items.map((item) => ({
    description: String(item?.description || item?.label || "").trim(),
    quantity: Number(item?.quantity ?? item?.qty),
    unit: item?.unit == null ? null : String(item.unit).trim(),
    unit_price: Number(item?.unit_price ?? item?.unitPrice),
  })).filter((item) => item.description && Number.isFinite(item.quantity) && item.quantity > 0 &&
    Number.isFinite(item.unit_price) && item.unit_price >= 0);
  return {
    candidate: safe.length ? candidate(safe, modality, "items", confidence) : null,
    invalid: safe.length !== items.length,
  };
}

function normalizeLegacyProviderResult(raw, request, provider) {
  if (!raw || typeof raw !== "object") return raw;
  const confidence = Number.isFinite(Number(raw.confidence))
    ? Math.max(0, Math.min(1, Number(raw.confidence)))
    : 0.75;
  const rawDocumentType = raw.document_type || raw.documentType || raw.docType;
  const documentType = normalizeDocumentType(rawDocumentType);
  if (rawDocumentType != null && !documentType) {
    throw Object.assign(new Error("BRAIN_DOCUMENT_TYPE_INVALID"), { code: "BRAIN_DOCUMENT_TYPE_INVALID" });
  }
  const extractedFields = {};
  if (raw.client) extractedFields.client = candidate({ name: String(raw.client).trim() }, request.modality, "client", confidence);
  const normalizedItems = normalizeItems(raw.items, request.modality, confidence);
  if (normalizedItems.candidate) extractedFields.items = normalizedItems.candidate;
  if (raw.motif || raw.subject) {
    extractedFields.subject = candidate(String(raw.subject || raw.motif).trim(), request.modality, "subject", confidence);
  }
  const hasTotalCandidate = raw.total != null || raw.detectedTotal != null;
  if (hasTotalCandidate) {
    const totalRead = Number(raw.total ?? raw.detectedTotal);
    if (Number.isFinite(totalRead) && totalRead >= 0) {
      extractedFields.total_read = candidate(totalRead, request.modality, "total_read", confidence, "UNCERTAIN");
    }
  }
  const missingFields = [];
  if (["FACTURE", "DEVIS"].includes(documentType) && !extractedFields.client) missingFields.push("client");
  if (["FACTURE", "DEVIS"].includes(documentType) && !extractedFields.items) missingFields.push("items");
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter((entry) => typeof entry === "string") : [];
  const uncertainties = warnings.slice(0, 20).map((reason) => ({
    field: "items",
    reason: reason.slice(0, 300),
    confidence,
    source_reference: source(request.modality, "items"),
  }));
  if (normalizedItems.invalid) {
    uncertainties.push({
      field: "items",
      reason: "INVALID_ITEM_VALUE",
      confidence,
      source_reference: source(request.modality, "items"),
    });
  }
  if (hasTotalCandidate && !extractedFields.total_read) {
    uncertainties.push({
      field: "total_read",
      reason: "INVALID_NUMBER",
      confidence,
      source_reference: source(request.modality, "total_read"),
    });
  }
  if (extractedFields.total_read) {
    missingFields.push("total_read");
    uncertainties.push({
      field: "total_read",
      reason: "SERVER_RECALCULATION_REQUIRED",
      candidate_value: extractedFields.total_read.value,
      confidence,
      source_reference: source(request.modality, "total_read"),
    });
  }
  for (const uncertainty of uncertainties) {
    if (!missingFields.includes(uncertainty.field)) missingFields.push(uncertainty.field);
    if (extractedFields[uncertainty.field]) extractedFields[uncertainty.field].status = "UNCERTAIN";
  }
  if (confidence < 0.6 && uncertainties.length === 0) {
    const field = Object.keys(extractedFields)[0] || "subject";
    missingFields.push(field);
    uncertainties.push({
      field,
      reason: "LOW_CONFIDENCE",
      confidence,
      source_reference: source(request.modality, field),
    });
    if (extractedFields[field]) extractedFields[field].status = "UNCERTAIN";
  }
  const needsQuestion = missingFields.length > 0 || confidence < 0.6;
  return {
    intent: inferIntent(raw),
    document_type: documentType,
    extracted_fields: extractedFields,
    missing_fields: [...new Set(missingFields)],
    uncertainties,
    confidence,
    suggested_next_action: needsQuestion ? "ASK_TARGETED_QUESTION" : "REVIEW_EXTRACTED_DATA",
    user_facing_message_draft: needsQuestion ? targetedQuestion(missingFields) : null,
    provider_metadata: {
      provider,
      ...(typeof raw.model === "string" && raw.model.trim() ? { model: raw.model.trim().slice(0, 120) } : {}),
    },
  };
}

function createOpenAIBrainProvider({ understand }) {
  const provider = createBrainProvider({
    name: "OPENAI",
    understand: async (request) => normalizeLegacyProviderResult(await understand(request), request, "OPENAI"),
  });
  return provider;
}

function createGeminiBrainProvider({ understand }) {
  const provider = createBrainProvider({
    name: "GEMINI",
    understand: async (request) => normalizeLegacyProviderResult(await understand(request), request, "GEMINI"),
  });
  return provider;
}

module.exports = {
  createBrainProvider,
  createGeminiBrainProvider,
  createOpenAIBrainProvider,
  normalizeLegacyProviderResult,
};
