"use strict";

const crypto = require("node:crypto");
const { createBrainProvider } = require("./kadiV1BrainProviders");
const { AUTHORITY_FIELDS, EXTRACTED_FIELD_KEYS, normalizeDocumentType, validateBrainResult } = require("./kadiV1BrainContracts");
const { assertTemporaryMediaStore } = require("./kadiV1TemporaryMediaStore");

const VISION_POLICIES = Object.freeze(["GEMINI_PRIMARY_ONLY", "CONTROLLED_FALLBACK", "SHADOW_COMPARE"]);
const VISION_EVENTS = new Set([
  "vision_analysis_started", "vision_analysis_succeeded", "vision_analysis_failed",
  "structured_extraction_validated", "structured_extraction_rejected",
]);
// Imported from kadiV1BrainContracts.js rather than redefined here — this
// used to be a second, independently-maintained list that had drifted from
// the canonical one (missing credit_debit and delivered). Not currently
// exploitable on its own (EXTRACTED_FIELD_KEYS, RAW_RESULT_KEYS and the
// final validateBrainResult pass already close every gap independently),
// but a duplicated security-relevant list is still a real drift risk.
const FORBIDDEN_AUTHORITY_KEYS = AUTHORITY_FIELDS;
const RAW_RESULT_KEYS = new Set(["document_type", "fields", "missing_fields", "uncertainties", "confidence", "multiple_documents"]);
const RAW_FIELD_KEYS = new Set(["value", "status", "confidence", "source_reference", "uncertainty_reason"]);
const RAW_ITEM_KEYS = new Set(["description", "label", "quantity", "unit", "unit_price", "confidence", "status", "source_reference"]);
const RAW_UNCERTAINTY_KEYS = new Set(["field", "reason", "candidate_value", "confidence", "source_reference"]);

class GeminiVisionError extends Error {
  constructor(code, userMessage = "Je n’ai pas pu lire ce document. Envoyez une photo plus nette ou écrivez les informations.") {
    super(code);
    this.name = "GeminiVisionError";
    this.code = code;
    this.recoverable = true;
    this.user_message = userMessage;
  }
}

function safeEmitter(logger) {
  const sink = typeof logger === "function" ? logger : () => {};
  return (event, details = {}) => {
    if (!VISION_EVENTS.has(event)) return;
    const safe = {
      correlation_id: typeof details.correlation_id === "string" ? crypto.createHash("sha256").update(details.correlation_id).digest("hex").slice(0, 16) : null,
      checksum_short: typeof details.checksum === "string" ? details.checksum.slice(0, 12) : null,
      mime_type: typeof details.mime_type === "string" ? details.mime_type.slice(0, 100) : null,
      page_count: Number.isSafeInteger(details.page_count) ? details.page_count : null,
      extracted_field_count: Number.isSafeInteger(details.extracted_field_count) ? details.extracted_field_count : null,
      uncertainty_count: Number.isSafeInteger(details.uncertainty_count) ? details.uncertainty_count : null,
      error_code: typeof details.error_code === "string" ? details.error_code.slice(0, 80) : null,
    };
    try { sink(event, Object.freeze(safe)); } catch { /* observability is non-authoritative */ }
  };
}

function cleanSource(value, fallback) {
  const source = typeof value === "string" ? value.trim() : "";
  return source && source.length <= 300 && /^(page|image):[0-9]+(?::[A-Za-z0-9_.:-]+)?$/.test(source) ? source : fallback;
}

function cleanConfidence(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : fallback;
}

function normalizeItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  if (Object.keys(item).some((key) => !RAW_ITEM_KEYS.has(key))) return null;
  const description = String(item.description || item.label || "").trim();
  const quantity = Number(item.quantity);
  const unitPrice = Number(item.unit_price);
  if (!description || description.length > 300 || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) return null;
  return {
    description,
    quantity,
    unit: item.unit == null ? null : String(item.unit).trim().slice(0, 50),
    unit_price: unitPrice,
    confidence: cleanConfidence(item.confidence, 0),
    status: ["CONFIRMED", "UNCERTAIN", "CONTRADICTORY"].includes(item.status) ? item.status : "UNCERTAIN",
    source_reference: cleanSource(item.source_reference, "page:1"),
  };
}

function questionFor(fields) {
  const first = fields[0];
  if (first === "client") return "Quel est le nom exact du client ?";
  if (first === "items") return "Pouvez-vous confirmer les produits, les quantités et les prix ?";
  if (first === "amount" || first === "total_read") return "Quel est le montant exact ?";
  if (first === "payer") return "Quel est le nom exact du payeur ?";
  if (first === "receiver") return "Qui reçoit la somme, le bien ou le document ?";
  if (first === "document_type") return "Quel document voulez-vous préparer ?";
  return "Pouvez-vous préciser l’information difficile à lire ?";
}

function requiredFields(documentType) {
  if (["FACTURE", "DEVIS"].includes(documentType)) return ["client", "items"];
  if (documentType === "RECU") return ["payer", "amount"];
  if (documentType === "DECHARGE") return ["giver", "receiver", "subject", "reason"];
  return [];
}

function normalizeStructuredExtraction(raw, { model, minimumConfidence = 0.7 } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new GeminiVisionError("VISION_RESULT_INVALID");
  if (Object.keys(raw).some((key) => FORBIDDEN_AUTHORITY_KEYS.has(key))) throw new GeminiVisionError("VISION_AUTHORITY_FIELD_FORBIDDEN");
  if (Object.keys(raw).some((key) => !RAW_RESULT_KEYS.has(key))) throw new GeminiVisionError("VISION_RESULT_FIELD_FORBIDDEN");
  const documentType = normalizeDocumentType(raw.document_type);
  if (raw.document_type != null && !documentType) throw new GeminiVisionError("BRAIN_DOCUMENT_TYPE_INVALID");
  const fields = raw.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new GeminiVisionError("VISION_FIELDS_INVALID");
  const extracted = {};
  const uncertainties = [];
  if (raw.missing_fields != null && (!Array.isArray(raw.missing_fields) || raw.missing_fields.some((field) => !EXTRACTED_FIELD_KEYS.has(field)))) {
    throw new GeminiVisionError("VISION_MISSING_FIELDS_INVALID");
  }
  const missing = new Set(raw.missing_fields || []);

  for (const [rawField, input] of Object.entries(fields)) {
    const field = rawField === "total" ? "total_read" : rawField;
    if (!EXTRACTED_FIELD_KEYS.has(field) || FORBIDDEN_AUTHORITY_KEYS.has(rawField)) throw new GeminiVisionError("VISION_FIELD_FORBIDDEN");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new GeminiVisionError("VISION_FIELD_INVALID");
    if (Object.keys(input).some((key) => !RAW_FIELD_KEYS.has(key))) throw new GeminiVisionError("VISION_FIELD_INVALID");
    const confidence = cleanConfidence(input.confidence);
    const sourceReference = cleanSource(input.source_reference, "page:1");
    let value = input.value;
    if (field === "items") {
      if (!Array.isArray(value)) throw new GeminiVisionError("VISION_ITEMS_INVALID");
      const unique = new Map();
      for (const rawItem of value) {
        const item = normalizeItem(rawItem);
        if (!item) throw new GeminiVisionError("VISION_ITEMS_INVALID");
        const key = `${item.description.toLocaleLowerCase("fr")}|${item.quantity}|${item.unit_price}|${item.unit || ""}`;
        if (!unique.has(key)) unique.set(key, item);
      }
      value = [...unique.values()];
    }
    const explicitStatus = ["CONFIRMED", "UNCERTAIN", "ABSENT", "CONTRADICTORY"].includes(input.status) ? input.status : null;
    let status = explicitStatus || (confidence >= minimumConfidence ? "CONFIRMED" : "UNCERTAIN");
    if (field === "items" && value.some((item) => item.status !== "CONFIRMED" || item.confidence < minimumConfidence)) status = "UNCERTAIN";
    if (value == null) status = "ABSENT";
    if (field === "total_read") status = "UNCERTAIN";
    extracted[field] = { value: status === "ABSENT" ? null : value, status, confidence, source_reference: sourceReference };
    if (status !== "CONFIRMED") {
      missing.add(field);
      uncertainties.push({
        field,
        reason: field === "total_read" ? "SERVER_RECALCULATION_REQUIRED" : String(input.uncertainty_reason || (field === "items" ? "ITEM_REQUIRES_CONFIRMATION" : status === "CONTRADICTORY" ? "CONTRADICTORY_VALUES" : status === "ABSENT" ? "FIELD_ABSENT" : "LOW_CONFIDENCE")).slice(0, 300),
        ...(status === "ABSENT" ? {} : { candidate_value: value }),
        confidence,
        source_reference: sourceReference,
      });
    }
  }

  for (const entry of Array.isArray(raw.uncertainties) ? raw.uncertainties : []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).some((key) => !RAW_UNCERTAINTY_KEYS.has(key)) || !EXTRACTED_FIELD_KEYS.has(entry.field) || typeof entry.reason !== "string") {
      throw new GeminiVisionError("VISION_UNCERTAINTY_INVALID");
    }
    missing.add(entry.field);
    if (!uncertainties.some((item) => item.field === entry.field && item.reason === entry.reason)) {
      uncertainties.push({
        field: entry.field,
        reason: entry.reason.slice(0, 300),
        ...(entry.candidate_value == null ? {} : { candidate_value: entry.candidate_value }),
        confidence: cleanConfidence(entry.confidence),
        source_reference: cleanSource(entry.source_reference, "page:1"),
      });
    }
    if (extracted[entry.field]) extracted[entry.field].status = "UNCERTAIN";
  }
  for (const field of requiredFields(documentType)) if (!extracted[field] || extracted[field].status !== "CONFIRMED") missing.add(field);
  if (!documentType) {
    missing.add("document_type");
    uncertainties.push({ field: "document_type", reason: "DOCUMENT_TYPE_UNKNOWN", confidence: 0, source_reference: "page:1" });
  }
  if (raw.multiple_documents === true) {
    missing.add("subject");
    uncertainties.push({ field: "subject", reason: "MULTIPLE_DOCUMENTS_DETECTED", confidence: 0, source_reference: "page:1" });
  }
  const missingFields = [...missing];
  const confidence = cleanConfidence(raw.confidence);
  const needsQuestion = missingFields.length > 0 || uncertainties.length > 0 || confidence < minimumConfidence;
  const result = {
    intent: "CREATE_DOCUMENT",
    document_type: documentType,
    extracted_fields: extracted,
    missing_fields: missingFields,
    uncertainties,
    confidence,
    suggested_next_action: needsQuestion ? "ASK_TARGETED_QUESTION" : "REVIEW_EXTRACTED_DATA",
    user_facing_message_draft: needsQuestion ? questionFor(missingFields) : null,
    provider_metadata: { provider: "GEMINI", model },
  };
  const checked = validateBrainResult(result, { minimumConfidence });
  if (!checked.ok) throw new GeminiVisionError(checked.error);
  return checked.value;
}

function createGoogleGenerativeAIClientAdapter({ client }) {
  if (!client || typeof client.getGenerativeModel !== "function") throw new TypeError("GEMINI_CLIENT_REQUIRED");
  return Object.freeze({
    async generateStructured({ model, prompt, media, temperature }) {
      const generativeModel = client.getGenerativeModel({ model });
      const parts = [{ text: prompt }, ...media.map((entry) => ({ inlineData: { mimeType: entry.mime_type, data: entry.buffer.toString("base64") } }))];
      const response = await generativeModel.generateContent({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature, responseMimeType: "application/json" },
      });
      const text = response?.response?.text?.();
      if (typeof text !== "string") throw new GeminiVisionError("VISION_RESPONSE_EMPTY");
      return JSON.parse(text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
    },
  });
}

function createGeminiVisionProvider({ client, temporaryMediaStore, config, logger = null } = {}) {
  if (!client || typeof client.generateStructured !== "function") throw new TypeError("GEMINI_VISION_CLIENT_REQUIRED");
  assertTemporaryMediaStore(temporaryMediaStore);
  const settings = {
    enabled: config?.enabled === true,
    model: config?.model,
    timeoutMs: config?.timeoutMs,
    maxRetries: config?.maxRetries,
    temperature: config?.temperature,
    policy: config?.policy || "GEMINI_PRIMARY_ONLY",
    minimumConfidence: config?.minimumConfidence ?? 0.7,
    maxImageBytes: config?.maxImageBytes,
    maxPdfBytes: config?.maxPdfBytes,
    maxPages: config?.maxPages,
  };
  if (typeof settings.model !== "string" || !settings.model.trim() || settings.model.length > 120 || /token|secret|api[_-]?key|bearer/i.test(settings.model) ||
      !Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs < 1 ||
      !Number.isSafeInteger(settings.maxRetries) || settings.maxRetries < 0 || settings.maxRetries > 3 ||
      !Number.isFinite(settings.temperature) || settings.temperature < 0 || settings.temperature > 1 ||
      !VISION_POLICIES.includes(settings.policy) || !Number.isFinite(settings.minimumConfidence) || settings.minimumConfidence < 0 || settings.minimumConfidence > 1 ||
      !Number.isSafeInteger(settings.maxImageBytes) || settings.maxImageBytes < 1 ||
      !Number.isSafeInteger(settings.maxPdfBytes) || settings.maxPdfBytes < 1 ||
      !Number.isSafeInteger(settings.maxPages) || settings.maxPages < 1) {
    throw new TypeError("GEMINI_VISION_CONFIG_INVALID");
  }
  const emit = safeEmitter(logger);
  const prompt = [
    "Analyse ce média administratif et retourne uniquement un objet JSON.",
    "Schéma: {document_type, fields, missing_fields, uncertainties, confidence, multiple_documents}.",
    "Chaque champ de fields contient {value,status,confidence,source_reference}; source_reference suit page:N:zone.",
    "Chaque article contient description, quantity, unit, unit_price, confidence, status et source_reference.",
    "Utilise total_read, date_read et document_number_read pour les valeurs visibles; jamais total, issued_at ou document_number.",
    "Signale toute valeur absente, incertaine ou contradictoire. N'invente rien et ne mélange pas plusieurs documents.",
  ].join(" ");

  async function callClient(media, correlationId) {
    let lastError;
    for (let attempt = 0; attempt <= settings.maxRetries; attempt += 1) {
      try {
        let timeout;
        try {
          return await Promise.race([
            client.generateStructured({ model: settings.model, prompt, media, temperature: settings.temperature }),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(new GeminiVisionError("VISION_PROVIDER_TIMEOUT")), settings.timeoutMs); }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        lastError = error;
        if (error instanceof GeminiVisionError && error.code === "VISION_PROVIDER_TIMEOUT") break;
      }
    }
    throw lastError instanceof GeminiVisionError ? lastError : new GeminiVisionError("VISION_PROVIDER_FAILED");
  }

  async function extractStructuredDocumentData(request, allowedSourceTypes = null) {
    if (!settings.enabled) throw new GeminiVisionError("VISION_FEATURE_DISABLED");
    const mediaId = request?.media?.media_id;
    const ownerRef = request?.media?.owner_ref;
    const stored = await temporaryMediaStore.getTemporaryMedia({ mediaId, ownerRef });
    if (!stored.ok) throw new GeminiVisionError(stored.error);
    const contract = stored.value.contract;
    if (allowedSourceTypes && !allowedSourceTypes.includes(contract.source_type)) throw new GeminiVisionError("MEDIA_SOURCE_TYPE_INVALID");
    const maximumBytes = contract.mime_type === "application/pdf" ? settings.maxPdfBytes : settings.maxImageBytes * contract.page_count;
    if (contract.byte_size > maximumBytes) throw new GeminiVisionError("MEDIA_TOO_LARGE");
    if (contract.page_count > settings.maxPages) throw new GeminiVisionError("MEDIA_PAGE_LIMIT_EXCEEDED");
    emit("vision_analysis_started", { correlation_id: contract.correlation_id, checksum: contract.checksum, mime_type: contract.mime_type, page_count: contract.page_count });
    const contents = Array.isArray(stored.value.content) ? stored.value.content : [stored.value.content];
    const media = contents.map((buffer) => ({ mime_type: contract.mime_type, buffer }));
    try {
      const raw = await callClient(media, contract.correlation_id);
      emit("vision_analysis_succeeded", { correlation_id: contract.correlation_id, checksum: contract.checksum, mime_type: contract.mime_type, page_count: contract.page_count });
      const normalized = normalizeStructuredExtraction(raw, { model: settings.model, minimumConfidence: settings.minimumConfidence });
      emit("structured_extraction_validated", { correlation_id: contract.correlation_id, extracted_field_count: Object.keys(normalized.extracted_fields).length, uncertainty_count: normalized.uncertainties.length });
      return normalized;
    } catch (error) {
      const controlled = error instanceof GeminiVisionError ? error : new GeminiVisionError("VISION_RESULT_INVALID");
      emit(error instanceof GeminiVisionError && error.code.startsWith("VISION_PROVIDER") ? "vision_analysis_failed" : "structured_extraction_rejected", { correlation_id: contract.correlation_id, error_code: controlled.code });
      throw controlled;
    }
  }

  const understand = async (request) => extractStructuredDocumentData(request);
  const provider = createBrainProvider({ name: "GEMINI", understand });
  return Object.freeze({
    ...provider,
    analyzeImage: (request) => extractStructuredDocumentData(request, ["IMAGE", "DOCUMENT_IMAGE", "MULTI_IMAGE"]),
    analyzePdf: (request) => extractStructuredDocumentData(request, ["PDF"]),
    analyzeDocument: (request) => extractStructuredDocumentData(request, ["PDF", "DOCUMENT_IMAGE", "MULTI_IMAGE"]),
    extractStructuredDocumentData,
    policy: settings.policy,
  });
}

module.exports = {
  GeminiVisionError,
  VISION_POLICIES,
  createGeminiVisionProvider,
  createGoogleGenerativeAIClientAdapter,
  normalizeStructuredExtraction,
};
