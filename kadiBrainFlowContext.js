"use strict";

const EXPECTED_FIELDS_BY_STEP = Object.freeze({
  doc_client: Object.freeze(["clientName"]),
  doc_subject_input: Object.freeze(["subject"]),
  client_phone_input: Object.freeze(["clientPhone"]),
  item_label: Object.freeze(["itemLabel"]),
  item_price: Object.freeze(["itemPrice"]),
  item_qty: Object.freeze(["itemQuantity"]),
  decharge_client: Object.freeze(["clientName"]),
  decharge_motif: Object.freeze(["reason"]),
  decharge_amount: Object.freeze(["amount"]),
});

const DETERMINISTIC_STEPS = new Set([
  "recharge_proof",
  "pispi_pending",
  "doc_review",
  "doc_after_item_choice",
  "doc_subject_choice",
  "doc_client_phone_choice",
  "doc_already_generated",
  "smartblock_warning",
]);

const DOCUMENT_COLLECTION_STEPS = new Set([
  ...Object.keys(EXPECTED_FIELDS_BY_STEP),
  "receipt_format",
  "facture_kind",
  "doc_edit_text_waiting",
  "missing_client_pdf",
  "awaiting_ocr_image",
]);

function documentType(session) {
  const value = String(
    session?.mode || session?.lastDocDraft?.type || ""
  ).toLowerCase();
  return {
    devis: "quote",
    quote: "quote",
    facture: "invoice",
    invoice: "invoice",
    recu: "receipt",
    reçu: "receipt",
    receipt: "receipt",
    decharge: "discharge",
    décharge: "discharge",
    discharge: "discharge",
  }[value] || null;
}

function activeFlow(session) {
  const activeDocumentType = documentType(session);
  if (activeDocumentType) {
    return {
      quote: "QUOTE",
      invoice: "INVOICE",
      receipt: "RECEIPT",
      discharge: "DISCHARGE",
    }[activeDocumentType];
  }
  const step = String(session?.step || "");
  if (!step || step === "idle") return "NONE";
  if (step.startsWith("history")) return "HISTORY";
  if (step.startsWith("profile")) return "PROFILE";
  return "OTHER";
}

function stepCategory(session) {
  const step = String(session?.step || "");
  if (!step || step === "idle") return "NONE";
  if (step.startsWith("profile") || step.startsWith("onboarding")) {
    return "ONBOARDING";
  }
  if (["recharge_proof", "pispi_pending"].includes(step)) return "PAYMENT";
  if (step.startsWith("support")) return "SUPPORT";
  if (DETERMINISTIC_STEPS.has(step)) return "CONFIRMATION";
  if (
    DOCUMENT_COLLECTION_STEPS.has(step) ||
    step.startsWith("intent_") ||
    step.startsWith("decharge_")
  ) return "DOCUMENT_COLLECTION";
  return "OTHER";
}

function buildBrainRealShadowFlowContext(session, sourceType) {
  const step = String(session?.step || "");
  return {
    stepCategory: stepCategory(session),
    activeFlow: activeFlow(session),
    activeDocumentType: documentType(session),
    hasActiveDraft: !!session?.lastDocDraft,
    expectedFieldNames: [...(EXPECTED_FIELDS_BY_STEP[step] || [])],
    messageType: sourceType === "voice" ? "voice" : "text",
  };
}

function isBrainShadowDeterministicStep(step) {
  return DETERMINISTIC_STEPS.has(String(step || ""));
}

module.exports = {
  buildBrainRealShadowFlowContext,
  isBrainShadowDeterministicStep,
};
