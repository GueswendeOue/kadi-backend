"use strict";

const { randomUUID } = require("node:crypto");
const { BRAIN_REQUEST_SCHEMA_VERSION } = require("./kadiBrainContract");

const MAX_ITEMS = 30;
const MAX_TEXT = 300;

function cleanText(value, max = MAX_TEXT) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizeItem(item = {}, index = 0) {
  return {
    lineRef: cleanText(item.lineRef || item.id || String(index + 1), 40),
    label: cleanText(item.label, 200),
    quantity: finiteOrNull(item.quantity ?? item.qty),
    unit: cleanText(item.unit, 30),
    unitPrice: finiteOrNull(item.unitPrice),
    lineTotal: finiteOrNull(item.lineTotal),
  };
}

function sanitizeDraft(draft) {
  if (!draft || typeof draft !== "object") return null;
  return {
    documentType: cleanText(draft.type, 30),
    documentId: cleanText(draft.savedDocumentId, 80),
    clientName: cleanText(draft.client, 160),
    clientPhone: cleanText(draft.clientPhone, 30),
    subject: cleanText(draft.subject || draft.motif, 240),
    items: (Array.isArray(draft.items) ? draft.items : [])
      .slice(0, MAX_ITEMS)
      .map(sanitizeItem),
    total: finiteOrNull(draft.finance?.gross ?? draft.total),
    paid: draft.paid === true,
    paymentMethod: cleanText(draft.paymentMethod, 80),
    currency: cleanText(draft.currency, 20),
  };
}

function sanitizeMediaFacts(mediaFacts) {
  if (!mediaFacts || typeof mediaFacts !== "object") return null;
  return {
    mimeType: cleanText(mediaFacts.mimeType, 80),
    extractedText: cleanText(mediaFacts.extractedText, 4000),
    transcriptionConfidence: finiteOrNull(mediaFacts.transcriptionConfidence),
    detectedLanguages: (Array.isArray(mediaFacts.detectedLanguages) ? mediaFacts.detectedLanguages : [])
      .slice(0, 5)
      .map((language) => cleanText(language, 20))
      .filter(Boolean),
    visionWarnings: (Array.isArray(mediaFacts.visionWarnings) ? mediaFacts.visionWarnings : [])
      .slice(0, 20)
      .map((warning) => cleanText(warning, 200))
      .filter(Boolean),
  };
}

function inferActiveFlow(session = {}) {
  const step = cleanText(session.step, 80);
  if (!step || step === "idle") return null;
  if (step.startsWith("history")) return "history";
  if (step.startsWith("profile")) return "profile";
  if (step.startsWith("stamp")) return "stamp";
  if (step.startsWith("recharge")) return "recharge";
  if (step.includes("ocr") || step.includes("image")) return "image";
  return session.lastDocDraft ? "document" : "structured";
}

function allowedIntentsForSession(session = {}) {
  const step = String(session.step || "idle");
  if (step.startsWith("history")) {
    return ["list_documents", "search_documents", "open_document", "resend_document", "send_document_to_client", "clarify", "unknown"];
  }
  if (session.lastDocDraft) {
    return [
      "edit_document", "add_document_item", "remove_document_item",
      "replace_document_item", "change_document_type", "confirm_document",
      "generate_pdf", "mark_paid", "mark_unpaid", "set_payment_method",
      "record_partial_payment", "cancel_document", "configure_stamp",
      "generate_with_stamp", "generate_without_stamp", "clarify", "unknown"
    ];
  }
  return [
    "create_document", "list_documents", "search_documents", "open_document",
    "resend_document", "request_support", "report_problem", "clarify",
    "unknown", "unsupported"
  ];
}

function buildKadiContext({ session, recentDocumentCandidates = [], profileHints = {} } = {}) {
  const safeSession = session && typeof session === "object" ? session : {};
  return {
    session: {
      step: cleanText(safeSession.step, 80) || "idle",
      activeFlow: inferActiveFlow(safeSession),
      activeDocumentType: cleanText(safeSession.lastDocDraft?.type || safeSession.mode, 30),
      lastQuestion: cleanText(safeSession.lastQuestion, 240),
      expectedFields: (Array.isArray(safeSession.expectedFields) ? safeSession.expectedFields : [])
        .slice(0, 12)
        .map((field) => cleanText(field, 80))
        .filter(Boolean),
      language: cleanText(safeSession.language, 12) || "fr",
    },
    currentDraft: sanitizeDraft(safeSession.lastDocDraft),
    recentDocumentCandidates: (Array.isArray(recentDocumentCandidates) ? recentDocumentCandidates : [])
      .slice(0, 5)
      .map((doc) => ({
        documentId: cleanText(doc?.id, 80),
        documentType: cleanText(doc?.type || doc?.doc_type, 30),
        documentNumber: cleanText(doc?.doc_number, 80),
        clientName: cleanText(doc?.client || doc?.client_name, 160),
        date: cleanText(doc?.date || doc?.created_at, 30),
      })),
    profileHints: {
      language: cleanText(profileHints.language, 12) || "fr",
      currency: cleanText(profileHints.currency, 12) || "XOF",
      country: cleanText(profileHints.country, 8) || "BF",
    },
    allowedIntents: allowedIntentsForSession(safeSession),
  };
}

function buildBrainRequest({ requestId, inputType = "text", text, mediaFacts = null, context }) {
  return {
    schemaVersion: BRAIN_REQUEST_SCHEMA_VERSION,
    requestId: cleanText(requestId, 120) || randomUUID(),
    inputType,
    text: cleanText(text, 4000),
    mediaFacts: sanitizeMediaFacts(mediaFacts),
    context: structuredClone(context || buildKadiContext()),
  };
}

module.exports = {
  allowedIntentsForSession,
  buildBrainRequest,
  buildKadiContext,
  sanitizeDraft,
  sanitizeMediaFacts,
};
