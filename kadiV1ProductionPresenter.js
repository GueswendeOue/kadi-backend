"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  createConversationSessionService,
} = require("./kadiV1ConversationSession");
const {
  createSupabaseV1ConversationSessionRepository,
} = require("./kadiV1SupabaseConversationSessionRepository");
const {
  KADI_V1_DRAFT_FLOW_CATALOG,
} = require("./kadiV1DraftFlowCatalog");
const { FLOW_KEYS } = require("./kadiV1FlowRouter");
const { buildPreviewData } = require("./kadiV1PreviewService");

const MAX_SUMMARY_ITEMS = 10;

const FLOW_MESSAGE_VERSION = "3";
const OWNER_PATTERN = /^\d{8,20}$/;
const ID_PATTERN = /^[A-Za-z0-9:_.-]{1,200}$/;
const FLOW_ID_PATTERN = /^\d{5,30}$/;
const FLOW_MODES = new Set(["draft", "published"]);
const DOCUMENT_TYPES = new Set(["FACTURE", "DEVIS", "RECU", "DECHARGE"]);
const DOCUMENT_STATES = new Set([
  "COLLECTING",
  "INCOMPLETE",
  "READY_FOR_REVIEW",
  "VERIFIED",
  "PREVIEW_READY",
  "COST_CALCULATED",
  "AWAITING_GENERATION_CONFIRMATION",
  "RECHARGE_REQUIRED",
  "GENERATION_IN_PROGRESS",
  "GENERATED",
  "DELIVERED",
  "RECOVERABLE_FAILURE",
  "CANCELLED",
]);
const FORBIDDEN_META_DATA_KEYS = new Set([
  "owner_wa_id",
  "ownerWaId",
  "document_id",
  "document_version",
  "version",
  "status",
  "issued_at",
  "document_number",
  "subtotal",
  "total",
  "tax_amount",
  "page_count",
  "cost",
  "credits",
  "flow_id",
  "flow_token",
  "draft_id",
  "meta_flow_id",
]);

function isPlainObject(value) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function assertMethod(target, method, error) {
  if (!target || typeof target[method] !== "function") {
    throw new TypeError(error);
  }
  return target;
}

function stableRef(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || "missing"), "utf8")
    .digest("hex")
    .slice(0, 32);
}

function safeLog(logger, event, details = {}) {
  try {
    logger?.log?.(
      "KADI_V1_PRESENTER",
      Object.freeze({
        event,
        flow_key: FLOW_KEYS.includes(details.flowKey)
          ? details.flowKey
          : null,
        business_action:
          typeof details.businessAction === "string"
            ? details.businessAction.slice(0, 80)
            : null,
        reason:
          typeof details.reason === "string"
            ? details.reason.slice(0, 100)
            : null,
      })
    );
  } catch {
    // Presenter observability is non-authoritative.
  }
}

function defaultForSchema(schema) {
  if (!schema || typeof schema !== "object") return null;
  if (Object.hasOwn(schema, "__example__")) return clone(schema.__example__);
  if (schema.type === "string") return "";
  if (schema.type === "number") return 0;
  if (schema.type === "boolean") return false;
  if (schema.type === "array") return [];
  if (schema.type === "object") return {};
  return null;
}

// Meta rejects opening any screen other than a Flow's first declared
// screen ((#131009) "Specified screen ARTICLE_FORM is not allowed as
// first screen of this flow"). Every draft Flow is therefore locked to
// exactly one terminal, complete-only screen; ARTICLE_FORM is its own
// independent flow_key/Flow, not a second screen of DOCUMENT_CONTENT.
function loadFlowRegistry(rootDir = __dirname) {
  const registry = {};

  for (const flowKey of FLOW_KEYS) {
    const catalog = KADI_V1_DRAFT_FLOW_CATALOG[flowKey];
    if (!catalog) throw new TypeError(`KADI_V1_FLOW_CATALOG_MISSING:${flowKey}`);

    const absolutePath = path.join(rootDir, catalog.file);
    const parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
    const screens = Array.isArray(parsed.screens) ? parsed.screens : [];
    const first = screens[0];
    const routingKeys =
      parsed.routing_model &&
      typeof parsed.routing_model === "object"
        ? Object.keys(parsed.routing_model)
        : [];

    if (
      screens.length !== 1 ||
      first?.id !== flowKey ||
      routingKeys.length !== 1 ||
      routingKeys[0] !== flowKey ||
      !Array.isArray(parsed.routing_model[flowKey]) ||
      parsed.routing_model[flowKey].length !== 0 ||
      first?.terminal !== true ||
      !isPlainObject(first.data) ||
      !Object.hasOwn(first.data, "session_id")
    ) {
      throw new TypeError(`KADI_V1_FLOW_ENTRY_CONTRACT_INVALID:${flowKey}`);
    }

    const defaults = {};
    for (const [key, schema] of Object.entries(first.data)) {
      defaults[key] = defaultForSchema(schema);
    }

    registry[flowKey] = Object.freeze({
      flowKey,
      entryScreen: first.id,
      dataKeys: Object.freeze(Object.keys(first.data)),
      defaults: Object.freeze(defaults),
      card: Object.freeze({
        body: String(catalog.card?.body || "Continuez avec Kadi.").slice(
          0,
          1024
        ),
        cta: String(catalog.card?.cta || "Continuer").slice(0, 30),
      }),
    });
  }

  return Object.freeze(registry);
}

function documentLabel(documentType) {
  return (
    {
      FACTURE: "Facture",
      DEVIS: "Devis",
      RECU: "Reçu",
      DECHARGE: "Décharge",
    }[documentType] || "Document"
  );
}

const HISTORY_OPTION_TITLE_MAX_LENGTH = 30;

// Built only from the history projection's already-safe list fields
// (kadiV1HistoryService.js's listProjection: document_number, counterparty,
// document_type, status) — never a raw internal code, never a full
// WhatsApp identifier. Truncated to fit the WhatsApp Flow dropdown option
// title limit.
function historyOptionLabel(entry) {
  const reference = typeof entry?.document_number === "string" && entry.document_number
    ? entry.document_number
    : "Brouillon";
  const who = typeof entry?.counterparty === "string" && entry.counterparty.trim()
    ? entry.counterparty.trim()
    : documentLabel(entry?.document_type);
  const label = `${reference} — ${who}`;
  return label.length > HISTORY_OPTION_TITLE_MAX_LENGTH ? `${label.slice(0, HISTORY_OPTION_TITLE_MAX_LENGTH - 1)}…` : label;
}

// items_summary / preview_summary formatting — built exclusively from the
// server's own kadiV1PreviewService.buildPreviewData(document) projection
// (real item_id/description/quantity_millis/unit/unit_price/line_total and
// document subtotal/taxes/discount/total), never from invented field names.

function formatFcfaAmount(amount) {
  return Number.isSafeInteger(amount) ? `${amount.toLocaleString("fr-FR")} FCFA` : "—";
}

function formatItemQuantity(quantityMillis) {
  return (quantityMillis / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 3 });
}

function formatItemsList(items) {
  const shown = items.slice(0, MAX_SUMMARY_ITEMS);
  const lines = ["Articles enregistrés", ""];
  shown.forEach((item, index) => {
    const quantityLabel = item.unit
      ? `${formatItemQuantity(item.quantity_millis)} ${item.unit}`
      : formatItemQuantity(item.quantity_millis);
    lines.push(`${index + 1}. ${item.description}`);
    lines.push(`   ${quantityLabel} × ${formatFcfaAmount(item.unit_price)} = ${formatFcfaAmount(item.line_total)}`);
  });
  const remaining = items.length - shown.length;
  if (remaining > 0) {
    lines.push("");
    lines.push(`… et ${remaining} autre${remaining > 1 ? "s" : ""}`);
  }
  return lines;
}

function formatCommonItemsSummary(preview) {
  const items = Array.isArray(preview.items) ? preview.items : [];
  if (items.length === 0) return "Aucun article enregistré.";
  const lines = formatItemsList(items);
  lines.push("");
  lines.push(`Total : ${formatFcfaAmount(preview.total)}`);
  return lines.join("\n");
}

function formatReceiptSummary(preview) {
  const lines = [];
  if (preview.payer) lines.push(`Payeur : ${preview.payer}`);
  if (preview.beneficiary) lines.push(`Bénéficiaire : ${preview.beneficiary}`);
  if (preview.reason) lines.push(`Motif : ${preview.reason}`);
  const amount = preview.content?.amount ?? preview.total;
  if (Number.isSafeInteger(amount)) lines.push(`Montant : ${formatFcfaAmount(amount)}`);
  return lines.length > 0 ? lines.join("\n") : "Informations du reçu à renseigner.";
}

const INVOICE_KIND_LABELS = Object.freeze({
  FINAL: "Facture définitive",
  PROFORMA: "Facture proforma",
});

const PREVIEW_INTROS = Object.freeze({
  FACTURE: "Parfait, votre facture est presque prête. Vérifiez les informations avant de la générer.",
  DEVIS: "Parfait, votre devis est presque prêt. Vérifiez les informations avant de le générer.",
  RECU: "Parfait, votre reçu est presque prêt. Vérifiez les informations avant de le générer.",
  DECHARGE: "Parfait, votre décharge est presque prête. Vérifiez les informations avant de la générer.",
});

function formatIssuerLine(issuerProfile) {
  const businessName = typeof issuerProfile?.business_name === "string" ? issuerProfile.business_name.trim() : "";
  const ownerName = typeof issuerProfile?.owner_name === "string" ? issuerProfile.owner_name.trim() : "";
  const label = businessName
    ? (ownerName && ownerName !== businessName ? `${businessName} — ${ownerName}` : businessName)
    : ownerName;
  return label ? `Émetteur : ${label}` : null;
}

function formatPartiesLine(document, preview) {
  if (document.document_type === "DECHARGE") {
    const lines = [];
    if (document.discharge?.giver) lines.push(`Remettant : ${document.discharge.giver}`);
    if (document.discharge?.receiver) lines.push(`Bénéficiaire : ${document.discharge.receiver}`);
    return lines.length > 0 ? lines.join("\n") : null;
  }
  if (document.document_type === "RECU") {
    const lines = [];
    if (preview.payer) lines.push(`Payeur : ${preview.payer}`);
    if (preview.beneficiary) lines.push(`Bénéficiaire : ${preview.beneficiary}`);
    return lines.length > 0 ? lines.join("\n") : null;
  }
  const name = preview.client?.name;
  return name ? `Client : ${name}` : null;
}

function formatContentLine(document, preview) {
  if (document.document_type === "DECHARGE") {
    const content = preview.content;
    if (!content) return null;
    if (content.type === "MONEY") return `Objet : somme de ${formatFcfaAmount(content.amount)}`;
    const quantity = document.discharge?.quantity;
    return `Objet : ${content.description || "—"}${quantity ? ` (quantité : ${quantity})` : ""}`;
  }
  if (document.document_type === "RECU") return formatReceiptSummary(preview);
  return formatCommonItemsSummary(preview);
}

function buildPreviewSummary(document, issuerProfile) {
  if (!isPlainObject(document)) return "Aperçu prêt.";
  const invoiceKind = document.document_type === "FACTURE" ? document.options?.invoice_kind : null;
  const invoiceKindLabel = INVOICE_KIND_LABELS[invoiceKind];
  const intro = invoiceKindLabel
    ? `Parfait, votre ${invoiceKindLabel.toLowerCase()} est presque prête. Vérifiez les informations avant de la générer.`
    : PREVIEW_INTROS[document.document_type] || "Vérifiez les informations avant de générer le document.";
  let preview = null;
  try { preview = buildPreviewData(document); } catch { preview = null; }
  const lines = [intro, ""];
  const issuerLine = formatIssuerLine(issuerProfile);
  if (issuerLine) lines.push(issuerLine);
  if (preview) {
    const partiesLine = formatPartiesLine(document, preview);
    if (partiesLine) lines.push(partiesLine);
    const contentLine = formatContentLine(document, preview);
    if (contentLine) {
      lines.push("");
      lines.push(contentLine);
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildItemsSummary(document) {
  if (!isPlainObject(document) || document.document_type === "DECHARGE") {
    return "Aucun article enregistré.";
  }
  if (document.document_type !== "RECU" && !Array.isArray(document.items)) {
    return "Aucun article enregistré.";
  }
  try {
    const preview = buildPreviewData(document);
    return document.document_type === "RECU"
      ? formatReceiptSummary(preview)
      : formatCommonItemsSummary(preview);
  } catch {
    return "Aucun article enregistré.";
  }
}

// REVIEW-001: DOCUMENT_REVIEW previously opened with no branch in
// suggestedDataForFlow() at all, so review_summary/review_actions always
// fell back to the Flow JSON's own static __example__ ("Résumé du document
// à vérifier." / the generic five-action list) — a real document was never
// actually shown to the owner being asked to verify it. Built exclusively
// from the same authoritative kadiV1PreviewService.buildPreviewData(document)
// projection already used for DOCUMENT_PREVIEW, plus the document's own
// tax/discount/notes fields — never from client-supplied Flow values, never
// an internal id/path/token.

function formatTaxRateLabel(basisPoints) {
  if (!Number.isSafeInteger(basisPoints) || basisPoints <= 0) return null;
  const percent = basisPoints / 100;
  const rounded = Number.isInteger(percent)
    ? String(percent)
    : percent.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${rounded}%`;
}

const RECEIPT_FORMAT_LABELS = Object.freeze({
  A4: "A4",
  TICKET_80: "Ticket 80 mm",
});

function buildInvoiceReviewSummary(document, preview) {
  const invoiceKind = document.document_type === "FACTURE" ? document.options?.invoice_kind : null;
  const invoiceKindLabel = INVOICE_KIND_LABELS[invoiceKind];
  const lines = [invoiceKindLabel || documentLabel(document.document_type), ""];
  const partiesLine = formatPartiesLine(document, preview);
  if (partiesLine) {
    lines.push(partiesLine, "");
  }
  const items = Array.isArray(preview.items) ? preview.items : [];
  if (items.length === 0) {
    lines.push("Aucun article enregistré.");
  } else {
    lines.push(...formatItemsList(items));
  }
  lines.push("");
  lines.push(`Sous-total : ${formatFcfaAmount(preview.subtotal)}`);
  if (Number.isSafeInteger(preview.discount) && preview.discount > 0) {
    lines.push(`Remise : ${formatFcfaAmount(preview.discount)}`);
  }
  const taxRateLabel = formatTaxRateLabel(document.tax_rate_basis_points);
  lines.push(
    taxRateLabel
      ? `TVA (${taxRateLabel}) : ${formatFcfaAmount(preview.taxes)}`
      : "TVA : non appliquée"
  );
  lines.push(`Total : ${formatFcfaAmount(preview.total)}`);
  if (typeof document.payment_terms === "string" && document.payment_terms.trim()) {
    lines.push("", `Conditions de paiement : ${document.payment_terms.trim()}`);
  }
  if (typeof document.notes === "string" && document.notes.trim()) {
    lines.push("", `Notes : ${document.notes.trim()}`);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildReceiptReviewSummary(preview) {
  const lines = [];
  if (preview.payer) lines.push(`Payeur : ${preview.payer}`);
  if (preview.beneficiary) lines.push(`Bénéficiaire : ${preview.beneficiary}`);
  if (preview.reason) lines.push(`Motif : ${preview.reason}`);
  const amount = preview.content?.amount ?? preview.total;
  if (Number.isSafeInteger(amount)) lines.push(`Montant : ${formatFcfaAmount(amount)}`);
  const formatLabel = RECEIPT_FORMAT_LABELS[preview.receipt_format];
  if (formatLabel) lines.push(`Format : ${formatLabel}`);
  return lines.length > 0 ? ["Reçu", "", ...lines].join("\n") : "Informations du reçu à renseigner.";
}

function buildDischargeReviewSummary(document, preview) {
  const lines = ["Décharge", ""];
  const partiesLine = formatPartiesLine(document, preview);
  if (partiesLine) lines.push(partiesLine);
  const contentLine = formatContentLine(document, preview);
  if (contentLine) lines.push("", contentLine);
  if (preview.reason) lines.push("", `Motif : ${preview.reason}`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildReviewSummary(document) {
  if (!isPlainObject(document)) return "Aucune information disponible pour le moment.";
  let preview = null;
  try {
    preview = buildPreviewData(document);
  } catch {
    preview = null;
  }
  if (!preview) return "Aucune information disponible pour le moment.";
  if (document.document_type === "RECU") return buildReceiptReviewSummary(preview);
  if (document.document_type === "DECHARGE") return buildDischargeReviewSummary(document, preview);
  return buildInvoiceReviewSummary(document, preview);
}

// Server-authoritative review_actions, never the Flow JSON's static example.
// FACTURE/DEVIS keep all three distinct edit sections (client, articles,
// options are genuinely separate mutations). RECU and DECHARGE each use one
// single combined edit Flow for every field (RECEIPT_DETAILS /
// DISCHARGE_DETAILS) — exposing three identically-destined buttons there
// would be redundant and, for DECHARGE, "Modifier le client" is simply
// wrong wording (a discharge has no invoice-style client). Every id below
// stays within kadiV1FlowReplyRuntime.js's existing DOCUMENT_REVIEW action
// allowlist (VERIFY/EDIT_CLIENT/EDIT_CONTENT/EDIT_OPTIONS/CANCEL) — no new
// action is introduced.
const DEFAULT_REVIEW_ACTIONS = Object.freeze([
  { id: "VERIFY", title: "Tout est correct" },
  { id: "EDIT_CLIENT", title: "Modifier le client" },
  { id: "EDIT_CONTENT", title: "Modifier les articles" },
  { id: "EDIT_OPTIONS", title: "Modifier les options" },
  { id: "CANCEL", title: "Annuler" },
]);
const RECEIPT_REVIEW_ACTIONS = Object.freeze([
  { id: "VERIFY", title: "Tout est correct" },
  { id: "EDIT_CLIENT", title: "Modifier les informations" },
  { id: "CANCEL", title: "Annuler" },
]);
const DISCHARGE_REVIEW_ACTIONS = Object.freeze([
  { id: "VERIFY", title: "Tout est correct" },
  { id: "EDIT_CONTENT", title: "Modifier les informations" },
  { id: "CANCEL", title: "Annuler" },
]);

function buildReviewActions(document) {
  if (document?.document_type === "RECU") return RECEIPT_REVIEW_ACTIONS;
  if (document?.document_type === "DECHARGE") return DISCHARGE_REVIEW_ACTIONS;
  return DEFAULT_REVIEW_ACTIONS;
}

const EDIT_ITEM_OPTION_TITLE_MAX_LENGTH = 30;

function editItemOptionLabel(item) {
  const description = typeof item?.description === "string" && item.description.trim()
    ? item.description.trim()
    : "Article";
  return description.length > EDIT_ITEM_OPTION_TITLE_MAX_LENGTH
    ? `${description.slice(0, EDIT_ITEM_OPTION_TITLE_MAX_LENGTH - 1)}…`
    : description;
}

function safeFlowData(contract, sessionId, suggested = {}) {
  const output = clone(contract.defaults);
  output.session_id = sessionId;

  const source = isPlainObject(suggested) ? suggested : {};
  for (const key of contract.dataKeys) {
    if (
      key === "session_id" ||
      FORBIDDEN_META_DATA_KEYS.has(key) ||
      !Object.hasOwn(source, key)
    ) {
      continue;
    }
    const value = source[key];
    if (
      value == null ||
      ["string", "number", "boolean"].includes(typeof value) ||
      Array.isArray(value) ||
      isPlainObject(value)
    ) {
      output[key] = clone(value);
    }
  }

  if (
    contract.dataKeys.includes("document_label") &&
    typeof source.document_type === "string"
  ) {
    output.document_label = documentLabel(source.document_type);
  }

  return Object.freeze(output);
}

function buildV1FlowMessage({
  to,
  flowKey,
  flowId,
  sessionId,
  flowMode,
  contract,
  data,
}) {
  if (!OWNER_PATTERN.test(to || "")) {
    throw new TypeError("KADI_V1_PRESENTER_OWNER_INVALID");
  }
  if (!FLOW_KEYS.includes(flowKey) || contract?.entryScreen !== flowKey) {
    throw new TypeError("KADI_V1_PRESENTER_FLOW_KEY_INVALID");
  }
  if (!FLOW_ID_PATTERN.test(flowId || "")) {
    throw new TypeError("KADI_V1_PRESENTER_FLOW_ID_INVALID");
  }
  if (!ID_PATTERN.test(sessionId || "")) {
    throw new TypeError("KADI_V1_PRESENTER_SESSION_INVALID");
  }
  if (!FLOW_MODES.has(flowMode)) {
    throw new TypeError("KADI_V1_PRESENTER_FLOW_MODE_INVALID");
  }

  return Object.freeze({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: Object.freeze({
      type: "flow",
      body: Object.freeze({ text: contract.card.body }),
      action: Object.freeze({
        name: "flow",
        parameters: Object.freeze({
          mode: flowMode,
          flow_message_version: FLOW_MESSAGE_VERSION,
          flow_token: sessionId,
          flow_id: flowId,
          flow_cta: contract.card.cta,
          flow_action: "navigate",
          flow_action_payload: Object.freeze({
            screen: contract.entryScreen,
            data,
          }),
        }),
      }),
    }),
  });
}

function extractDocument(value) {
  if (!value || typeof value !== "object") return null;
  if (
    ID_PATTERN.test(value.document_id || "") &&
    Number.isSafeInteger(value.version) &&
    value.version >= 1 &&
    DOCUMENT_TYPES.has(value.document_type) &&
    DOCUMENT_STATES.has(value.status)
  ) {
    return value;
  }
  for (const key of ["document", "value", "result"]) {
    const nested = extractDocument(value[key]);
    if (nested) return nested;
  }
  return null;
}

function documentFromPrefill(prefill, nextState) {
  if (!isPlainObject(prefill)) return null;
  const version = Number(prefill.document_version ?? prefill.version);
  const status = prefill.document_state || prefill.status || nextState;
  if (
    !ID_PATTERN.test(prefill.document_id || "") ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !DOCUMENT_TYPES.has(prefill.document_type) ||
    !DOCUMENT_STATES.has(status)
  ) {
    return null;
  }
  return Object.freeze({
    document_id: prefill.document_id,
    version,
    document_type: prefill.document_type,
    status,
  });
}

function routeDocument(document) {
  if (!document) return null;
  if (document.status === "READY_FOR_REVIEW") return "DOCUMENT_REVIEW";
  if (["VERIFIED", "PREVIEW_READY"].includes(document.status)) {
    return "DOCUMENT_PREVIEW";
  }
  if (
    ["COST_CALCULATED", "AWAITING_GENERATION_CONFIRMATION"].includes(
      document.status
    )
  ) {
    return "GENERATION_CONFIRMATION";
  }
  if (document.status === "RECHARGE_REQUIRED") return "RECHARGE";
  return null;
}

function nextFlowForReply(action, resultValue, originFlowKey = null) {
  if (
    FLOW_KEYS.includes(resultValue?.next_flow_key)
  ) {
    return resultValue.next_flow_key;
  }

  const document = extractDocument(resultValue);

  // Checked before the generic status-based routeDocument() fallback below
  // — a real production incident traced this exact ordering conflict:
  // beginEdit's reopenForCorrection legitimately moves the document back to
  // READY_FOR_REVIEW as part of reopening it for correction (so the review
  // Flow can re-verify it once the edit is saved), but routeDocument()
  // maps READY_FOR_REVIEW straight to DOCUMENT_REVIEW — which, checked
  // first, silently swallowed the explicit EDIT_CLIENT/EDIT_CONTENT/
  // EDIT_OPTIONS routing below every time, always reopening the review
  // screen instead of the intended edit Flow. The explicit, action-driven
  // choice here must always win over the generic document-status guess.
  if (["EDIT_CLIENT", "EDIT_CONTENT", "EDIT_OPTIONS"].includes(action)) {
    if (document?.document_type === "DECHARGE") return "DISCHARGE_DETAILS";
    if (document?.document_type === "RECU") return "RECEIPT_DETAILS";
    return action;
  }

  const routed = routeDocument(document);
  if (routed) return routed;

  if (action === "PREPARE_DOCUMENT") return "DOCUMENT_TYPE";
  if (action === "SELECT_DOCUMENT_TYPE") {
    if (document?.document_type === "DECHARGE") return "DISCHARGE_DETAILS";
    if (document?.document_type === "RECU") return "RECEIPT_DETAILS";
    if (document?.document_type === "FACTURE") return "INVOICE_TYPE";
    return "DOCUMENT_CLIENT";
  }
  if (action === "SAVE_INVOICE_TYPE") return "DOCUMENT_CLIENT";
  if (action === "SAVE_RECEIPT_DETAILS") return "DOCUMENT_REVIEW";
  if (action === "SAVE_DETAILS") return "DOCUMENT_REVIEW";
  // ARTICLE_FORM is now its own independent flow_key/Flow (Meta refused
  // opening it as a second screen of DOCUMENT_CONTENT — #131009). The item
  // form is always reached via ARTICLE_FORM; DOCUMENT_CONTENT is the
  // decision screen reached after an item is saved or content is finished.
  //
  // SAVE_CLIENT and FINISH_CONTENT are each reachable from two different
  // screens with the same action name: the initial-creation screen
  // (DOCUMENT_CLIENT / DOCUMENT_CONTENT-ARTICLE_FORM) and the correction
  // screen reached from review (EDIT_CLIENT / EDIT_CONTENT). Both must
  // return to their own origin's natural next step — initial creation
  // keeps moving forward through the document, correction returns to
  // DOCUMENT_REVIEW — decided from originFlowKey, the session-verified
  // screen the reply was actually submitted from (kadiV1FlowReplyRuntime.js
  // rejects any flow_key that does not match the session's own
  // expected_flow_key before this is ever reached), never a client-supplied
  // flag.
  if (action === "SAVE_CLIENT") {
    return originFlowKey === "EDIT_CLIENT" ? "DOCUMENT_REVIEW" : "ARTICLE_FORM";
  }
  if (action === "START_ADD_CONTENT") return "ARTICLE_FORM";
  if (["ADD_CONTENT", "UPDATE_CONTENT", "REMOVE_CONTENT"].includes(action)) {
    // UPDATE_CONTENT/REMOVE_CONTENT are only ever valid from EDIT_CONTENT
    // (kadiV1FlowReplyRuntime.js's FLOW_ACTIONS.ARTICLE_FORM has no such
    // action) — looping back to EDIT_CONTENT keeps the correction session
    // alive across several add/update/remove operations until the owner
    // explicitly presses "Terminer" (FINISH_CONTENT).
    return originFlowKey === "EDIT_CONTENT" ? "EDIT_CONTENT" : "DOCUMENT_CONTENT";
  }
  if (action === "FINISH_CONTENT") {
    return originFlowKey === "EDIT_CONTENT" ? "DOCUMENT_REVIEW" : "DOCUMENT_OPTIONS";
  }
  if (action === "SAVE_OPTIONS") return "DOCUMENT_REVIEW";
  if (action === "VERIFY") return "DOCUMENT_PREVIEW";
  if (action === "PREPARE_PDF") return "GENERATION_CONFIRMATION";
  if (action === "SELECT_PACK") return "RECHARGE";
  // Only re-open the Flow when there is something to show — an empty
  // result set has nothing to pick from, and canonicalReplyText already
  // states that honestly; reopening the Flow in that case would show an
  // unusable empty dropdown instead of just the plain "nothing found" text.
  if (action === "SEARCH" && Array.isArray(resultValue?.documents) && resultValue.documents.length > 0) {
    return "HISTORY_SEARCH";
  }
  return null;
}

function quoteFromResult(value) {
  if (!value || typeof value !== "object") return null;
  const candidate =
    value.quote_id ||
    value.quote?.quote_id ||
    value.result?.quote_id ||
    value.result?.quote?.quote_id;
  return ID_PATTERN.test(candidate || "") ? candidate : null;
}

function canonicalReplyText(action, value) {
  const document = extractDocument(value);
  if (document?.status === "DELIVERED") {
    return "Votre document est prêt et a été envoyé.";
  }

  if (action === "SELECT_PACK" && value?.payment_instructions) {
    const instructions = value.payment_instructions;
    const amount = Number(instructions.amount);
    const credits = Number(instructions.credits);
    const number = String(instructions.number || "").replace(/[^0-9]/g, "");
    const name = String(instructions.name || "").trim();
    const reference = String(instructions.reference || "").trim();
    if (
      Number.isSafeInteger(amount) && amount > 0 &&
      Number.isSafeInteger(credits) && credits > 0 &&
      /^\d{8,20}$/.test(number) &&
      name && reference
    ) {
      return [
        `Pack sélectionné : ${amount.toLocaleString("fr-FR")} FCFA pour ${credits} crédits.`,
        `Envoyez le paiement par Orange Money au ${number}, au nom de ${name}.`,
        `Référence à conserver : ${reference}.`,
        "Après le paiement, choisissez Vérifier mon paiement.",
      ].join("\n");
    }
  }

  if (action === "CHECK_PAYMENT" && value?.credited === true) {
    return "Votre paiement est confirmé et vos crédits ont été ajoutés.";
  }

  if (action === "CHECK_PAYMENT" && value?.credited === false) {
    return "Le paiement n’est pas encore confirmé. Vérifiez la référence puis réessayez.";
  }

  // SEARCH's result count is only known at reply time, unlike every other
  // action in the static table below — a fixed "La recherche est
  // terminée." for every case (whether 0 or 20 documents were found) was
  // the exact dead-end a real production incident traced: the search ran
  // and genuinely found nothing usable to say, and genuinely found
  // documents with nothing usable to show. Both must be told apart and
  // stated honestly.
  if (action === "SEARCH") {
    const count = Array.isArray(value?.documents) ? value.documents.length : 0;
    if (count === 0) {
      return "Je n’ai trouvé aucun document correspondant. Donnez-moi un nom, un type de document ou une période.";
    }
    return `J’ai trouvé ${count} document${count === 1 ? "" : "s"}. Choisissez celui que vous souhaitez consulter dans la liste, puis appuyez sur Continuer.`;
  }

  const copy = {
    START: "Merci. Votre profil est enregistré. Que voulez-vous préparer aujourd’hui ?",
    PREPARE_DOCUMENT: "Choisissez le document à préparer.",
    SELECT_DOCUMENT_TYPE: "Le type de document est enregistré.",
    SAVE_RECEIPT_DETAILS: "Les informations du reçu sont enregistrées. Votre reçu est prêt pour vérification.",
    SAVE_CLIENT: "Les informations du client sont enregistrées.",
    START_ADD_CONTENT: "Ajoutons un article.",
    ADD_CONTENT: "L’article est enregistré. Que souhaitez-vous faire ?",
    FINISH_CONTENT: "Les articles sont enregistrés.",
    UPDATE_CONTENT: "L’article est mis à jour.",
    REMOVE_CONTENT: "L’article est supprimé.",
    SAVE_OPTIONS: "Les options sont enregistrées.",
    VERIFY: "Les informations sont vérifiées.",
    EDIT_CLIENT: "Vous pouvez modifier le client.",
    EDIT_CONTENT: "Vous pouvez modifier les articles.",
    EDIT_OPTIONS: "Vous pouvez modifier les options.",
    PREPARE_PDF: "L’aperçu et le coût sont prêts.",
    CONFIRM_GENERATION: "La génération du document est terminée.",
    SELECT_PACK: "Le pack est sélectionné.",
    CHECK_PAYMENT: "La vérification du paiement est terminée.",
    OPEN_DOCUMENT: "Le document est ouvert.",
    SAVE_DETAILS: "Les informations de la décharge sont enregistrées.",
    BALANCE: "Votre solde a été consulté.",
    HELP: "Kadi peut préparer une facture, un devis, un reçu ou une décharge.",
    CANCEL: "L’opération est annulée.",
    SAVE_FOR_LATER: "Votre travail est conservé.",
  };

  return copy[action] || "Votre demande a bien été enregistrée.";
}

function suggestedDataForFlow(flowKey, source, extra = {}) {
  const document = extractDocument(source);
  const output = {};

  if (document) {
    output.document_type = document.document_type;
    output.document_label = documentLabel(document.document_type);
  }

  const quoteId = quoteFromResult(source);
  if (quoteId) output.quote_id = quoteId;

  // Populates the same history_options dropdown the Flow's own JSON
  // contract already declares (kadi_history_search_v1.json) — the search
  // screen and the results screen are the same single Meta screen (Meta
  // only allows one terminal screen per Flow — see ADR-002), so "showing
  // results" means re-opening HISTORY_SEARCH with real options instead of
  // the schema's placeholder example. Every option's id is the real,
  // already-server-authoritative document_id (the same opaque reference
  // used throughout the rest of this presenter); the title is built only
  // from fields the history projection already exposes (document_number,
  // counterparty, status) — safe to show the owner their own document
  // reference, never a full WhatsApp ID or any other party's identity.
  if (flowKey === "HISTORY_SEARCH" && Array.isArray(source?.documents)) {
    output.history_options = source.documents.slice(0, 20).map((entry) => ({
      id: entry.document_id,
      title: historyOptionLabel(entry),
    }));
  }

  if (flowKey === "MENU") {
    output.menu_options = [
      { id: "PREPARE_DOCUMENT", title: "Préparer un document" },
      { id: "HISTORY_SEARCH", title: "Retrouver un document" },
      { id: "BALANCE", title: "Mon solde" },
      { id: "HELP", title: "Aide" },
    ];
  }

  if (flowKey === "DOCUMENT_CONTENT") {
    const items = document?.items;
    const hasItems = Array.isArray(items) && items.length > 0;
    output.items_summary = buildItemsSummary(document);
    if (document?.document_type === "RECU") {
      output.content_actions = hasItems
        ? [
            { id: "START_ADD_CONTENT", title: "Modifier les informations" },
            { id: "FINISH_CONTENT", title: "Terminer le reçu" },
          ]
        : [{ id: "START_ADD_CONTENT", title: "Renseigner les informations" }];
    } else {
      output.content_actions = hasItems
        ? [
            { id: "START_ADD_CONTENT", title: "Ajouter un autre article" },
            { id: "FINISH_CONTENT", title: "Terminer les articles" },
          ]
        : [{ id: "START_ADD_CONTENT", title: "Ajouter un article" }];
    }
  }

  if (flowKey === "DOCUMENT_OPTIONS" || flowKey === "EDIT_OPTIONS") {
    output.current_summary = buildItemsSummary(document);
  }

  if (flowKey === "DOCUMENT_PREVIEW") {
    output.preview_summary = buildPreviewSummary(document, extra.issuerProfile || null);
  }

  // REVIEW-001: the real document, never the Flow JSON's placeholder — see
  // the block comment above buildReviewSummary()/buildReviewActions().
  if (flowKey === "DOCUMENT_REVIEW") {
    output.review_summary = buildReviewSummary(document);
    output.review_actions = buildReviewActions(document);
  }

  // The edit-content correction screen needs the owner's real current
  // items to pick from (item_options) — without this it always offered
  // the Flow JSON's single fake "item:example" id, so UPDATE_CONTENT/
  // REMOVE_CONTENT against it would only ever fail with
  // DOCUMENT_ITEM_NOT_FOUND. edit_actions is server-built so it can offer
  // "Terminer la modification" (FINISH_CONTENT) only once real items
  // exist to review — an empty item list has nothing to finish yet.
  if (flowKey === "EDIT_CONTENT") {
    const items = Array.isArray(document?.items) ? document.items : [];
    output.items_summary = buildItemsSummary(document);
    output.item_options = items.slice(0, 20).map((item) => ({
      id: item.item_id,
      title: editItemOptionLabel(item),
    }));
    output.edit_actions = items.length > 0
      ? [
          { id: "ADD_CONTENT", title: "Ajouter un article" },
          { id: "UPDATE_CONTENT", title: "Modifier un article" },
          { id: "REMOVE_CONTENT", title: "Supprimer un article" },
          { id: "FINISH_CONTENT", title: "Terminer la modification" },
        ]
      : [{ id: "ADD_CONTENT", title: "Ajouter un article" }];
  }

  return output;
}

function createKadiV1ProductionPresenter({
  config,
  supabase = null,
  whatsappApi,
  sessionService = null,
  flowMode = "draft",
  sessionTtlMs,
  clock,
  sessionIdFactory,
  voiceResponseEngine = null,
  voiceDelivery = null,
  issuerProfileReader = null,
  logger = console,
  rootDir = __dirname,
} = {}) {
  if (!config || typeof config.enabled !== "boolean" || !config.flowIds) {
    throw new TypeError("KADI_V1_RUNTIME_CONFIG_REQUIRED");
  }
  const messaging = assertMethod(
    assertMethod(
      assertMethod(
        whatsappApi,
        "sendText",
        "KADI_V1_PRESENTER_SEND_TEXT_REQUIRED"
      ),
      "sendFlow",
      "KADI_V1_PRESENTER_SEND_FLOW_REQUIRED"
    ),
    "sendButtons",
    "KADI_V1_PRESENTER_SEND_BUTTONS_REQUIRED"
  );
  if (!FLOW_MODES.has(flowMode)) {
    throw new TypeError("KADI_V1_PRESENTER_FLOW_MODE_INVALID");
  }

  let sessions = sessionService;
  if (sessions == null) {
    const repository =
      createSupabaseV1ConversationSessionRepository(supabase);
    const options = { repository };
    if (sessionTtlMs !== undefined) options.ttlMs = sessionTtlMs;
    if (clock !== undefined) options.clock = clock;
    if (sessionIdFactory !== undefined) options.idFactory = sessionIdFactory;
    sessions = createConversationSessionService(options);
  }
  assertMethod(
    sessions,
    "open",
    "KADI_V1_PRESENTER_SESSION_SERVICE_REQUIRED"
  );

  if (
    voiceResponseEngine != null &&
    typeof voiceResponseEngine.generate !== "function"
  ) {
    throw new TypeError("KADI_V1_PRESENTER_VOICE_ENGINE_INVALID");
  }
  if (
    voiceDelivery != null &&
    typeof voiceDelivery.sendGeneratedVoice !== "function"
  ) {
    throw new TypeError("KADI_V1_PRESENTER_VOICE_DELIVERY_INVALID");
  }
  if (
    issuerProfileReader != null &&
    typeof issuerProfileReader.getIssuerProfileById !== "function"
  ) {
    throw new TypeError("KADI_V1_PRESENTER_ISSUER_PROFILE_READER_INVALID");
  }

  const registry = loadFlowRegistry(rootDir);

  async function resolveIssuerProfileForPreview(document) {
    if (!issuerProfileReader || !document?.issuer_profile_id) return null;
    try {
      const resolved = await issuerProfileReader.getIssuerProfileById({
        issuerProfileId: document.issuer_profile_id,
      });
      return resolved?.ok ? resolved.value : null;
    } catch {
      return null;
    }
  }

  async function maybeTyping(messageId) {
    if (
      typeof messaging.sendTypingIndicator !== "function" ||
      typeof messageId !== "string" ||
      !messageId.trim()
    ) {
      return;
    }
    try {
      await messaging.sendTypingIndicator(messageId);
    } catch {
      // Typing feedback must never block the authoritative response.
    }
  }

  async function openAndSendFlow({
    ownerWaId,
    messageId,
    flowKey,
    document = null,
    suggestedData = {},
  }) {
    if (!FLOW_KEYS.includes(flowKey)) {
      throw new TypeError("KADI_V1_PRESENTER_FLOW_KEY_INVALID");
    }
    const flowId = config.flowIds[flowKey];
    if (!FLOW_ID_PATTERN.test(flowId || "")) {
      throw new TypeError("KADI_V1_PRESENTER_FLOW_ID_MISSING");
    }

    const source = `${messageId || ownerWaId}:${flowKey}:${
      document?.document_id || "none"
    }:${document?.version || 0}`;
    const opened = await sessions.open({
      ownerWaId,
      document,
      expectedFlowKey: flowKey,
      returnState: document?.status || null,
      idempotencyKey: `present:${stableRef(source)}`,
    });
    if (!opened?.ok) {
      throw new Error(opened?.error || "KADI_V1_PRESENTER_SESSION_OPEN_FAILED");
    }

    const contract = registry[flowKey];
    const data = safeFlowData(
      contract,
      opened.value.session_id,
      suggestedData
    );
    const payload = buildV1FlowMessage({
      to: ownerWaId,
      flowKey,
      flowId,
      sessionId: opened.value.session_id,
      flowMode,
      contract,
      data,
    });
    await messaging.sendFlow(payload);
    return Object.freeze({
      flow_key: flowKey,
      session_id: opened.value.session_id,
      duplicate: opened.duplicate === true,
    });
  }

  async function maybeVoice({
    ownerWaId,
    response,
    messageId,
  }) {
    if (
      response?.voice_request?.mode !== "TEXT_AND_VOICE" ||
      !voiceResponseEngine ||
      !voiceDelivery
    ) {
      return Object.freeze({ delivered: false, skipped: true });
    }

    try {
      const source = messageId || `${ownerWaId}:${response.business_action}`;
      const generated = await voiceResponseEngine.generate({
        owner_id: ownerWaId,
        validated_text: response.canonical_text,
        locale: "fr-BF",
        output_format: "audio/ogg",
        correlation_id: `presenter:${stableRef(source)}`,
        idempotency_key: `voice:${stableRef(source)}`,
        policy_input: {
          voice_response_mode: "VOICE_WHEN_HELPFUL",
          provider_available: true,
          journey_step: response.business_action || "CONVERSATION",
          message_complexity: "SIMPLE",
          last_input_modality: "TEXT",
        },
      });

      if (generated?.decision !== "TEXT_AND_VOICE" || !generated.audio) {
        return Object.freeze({ delivered: false, skipped: true });
      }

      await voiceDelivery.sendGeneratedVoice({
        ownerWaId,
        audio: generated.audio,
      });
      return Object.freeze({ delivered: true, skipped: false });
    } catch (error) {
      safeLog(logger, "voice_non_blocking_failure", {
        businessAction: response?.business_action,
        reason:
          typeof error?.code === "string"
            ? error.code
            : "VOICE_PRESENTATION_FAILED",
      });
      return Object.freeze({
        delivered: false,
        skipped: true,
        non_blocking: true,
      });
    }
  }

  async function presentConversation({
    ownerWaId,
    messageId = null,
    response,
  } = {}) {
    if (
      !OWNER_PATTERN.test(ownerWaId || "") ||
      !isPlainObject(response) ||
      response.handled !== true ||
      typeof response.canonical_text !== "string" ||
      !response.canonical_text.trim()
    ) {
      throw new TypeError("KADI_V1_PRESENTER_CONVERSATION_INVALID");
    }

    await maybeTyping(messageId);
    await messaging.sendText(ownerWaId, response.canonical_text);

    let flow = null;
    if (response.flow_request) {
      const flowKey = response.flow_request.flow_key;
      const document = documentFromPrefill(
        response.flow_request.prefill,
        response.next_state
      );
      const suggestedData = {
        ...(isPlainObject(response.flow_request.prefill)
          ? response.flow_request.prefill
          : {}),
        ...(document
          ? {
              document_type: document.document_type,
              document_label: documentLabel(document.document_type),
            }
          : {}),
      };
      flow = await openAndSendFlow({
        ownerWaId,
        messageId,
        flowKey,
        document,
        suggestedData,
      });
    }

    const voice = await maybeVoice({
      ownerWaId,
      response,
      messageId,
    });

    safeLog(logger, "conversation_presented", {
      flowKey: flow?.flow_key || null,
      businessAction: response.business_action,
    });

    return Object.freeze({
      text_sent: true,
      flow_sent: Boolean(flow),
      voice_sent: voice.delivered === true,
    });
  }

  async function presentFlowReply({
    ownerWaId,
    messageId = null,
    result,
  } = {}) {
    if (
      !OWNER_PATTERN.test(ownerWaId || "") ||
      !isPlainObject(result) ||
      result.handled !== true ||
      typeof result.action !== "string"
    ) {
      throw new TypeError("KADI_V1_PRESENTER_FLOW_REPLY_INVALID");
    }

    if (result.duplicate === true) {
      return Object.freeze({
        duplicate: true,
        text_sent: false,
        flow_sent: false,
      });
    }

    // History-driven recovery surface: opening a document whose delivery
    // needs attention offers the same real, reachable action the founder's
    // stuck document had no way to reach before this fix — never just the
    // generic "document is open" text. documentId here is the same opaque
    // reference already used for the original in-the-moment retry offer,
    // never a secret. See docs/KADI_ENGINEERING_MEMORY.md fiche R.
    if (result.action === "OPEN_DOCUMENT") {
      const documentId = result.result?.summary?.document_id;
      const actions = result.result?.summary?.actions;
      const outcome = result.result?.delivery?.outcome;
      if (Array.isArray(actions) && actions.includes("RETRY_DELIVERY") && ID_PATTERN.test(documentId || "")) {
        if (outcome === "OUTCOME_UNKNOWN") {
          await presentDeliveryOutcomeUnknownWithRetry({ ownerWaId, messageId, documentId });
        } else if (outcome === "IN_PROGRESS") {
          await presentDeliveryInProgress({ ownerWaId, messageId, documentId });
        } else {
          await presentDeliveryFailureWithRetry({ ownerWaId, messageId, documentId });
        }
        safeLog(logger, "flow_reply_presented", { flowKey: null, businessAction: result.action });
        return Object.freeze({ duplicate: false, text_sent: false, flow_sent: false, buttons_sent: true });
      }
    }

    const canonicalText = canonicalReplyText(
      result.action,
      result.result
    );
    await maybeTyping(messageId);
    await messaging.sendText(ownerWaId, canonicalText);

    const flowKey = nextFlowForReply(
      result.action,
      result.result,
      typeof result.flow_key === "string" ? result.flow_key : null
    );
    let flow = null;
    if (flowKey) {
      const document = extractDocument(result.result);
      const issuerProfile = flowKey === "DOCUMENT_PREVIEW"
        ? await resolveIssuerProfileForPreview(document)
        : null;
      flow = await openAndSendFlow({
        ownerWaId,
        messageId,
        flowKey,
        document,
        suggestedData: suggestedDataForFlow(
          flowKey,
          result.result,
          { issuerProfile }
        ),
      });
    }

    safeLog(logger, "flow_reply_presented", {
      flowKey: flow?.flow_key || null,
      businessAction: result.action,
    });

    return Object.freeze({
      duplicate: false,
      text_sent: true,
      flow_sent: Boolean(flow),
    });
  }

  // The one WhatsApp-visible entry point into the delivery-retry feature —
  // offered only after a real, confirmed post-capture delivery failure
  // (kadiV1WebhookRuntime.js's recover() dispatches here specifically for
  // reason === "DELIVERY_RECOVERABLE_FAILURE"). The button id carries only
  // the opaque documentId — already routinely exposed elsewhere (Flow
  // prefill payloads) — never a quote, delivery-attempt, destination or
  // credit value. No technical term is exposed in the body text.
  async function presentDeliveryFailureWithRetry({
    ownerWaId,
    messageId = null,
    documentId,
  } = {}) {
    if (!OWNER_PATTERN.test(ownerWaId || "") || !ID_PATTERN.test(documentId || "")) {
      throw new TypeError("KADI_V1_PRESENTER_DELIVERY_FAILURE_INVALID");
    }
    await maybeTyping(messageId);
    await messaging.sendButtons(
      ownerWaId,
      "Votre PDF est prêt, mais son envoi n’a pas abouti.\nAppuyez sur « Réenvoyer le PDF ».\nAucun crédit supplémentaire ne sera débité.",
      [{ id: `RETRY_DELIVERY:${documentId}`, title: "Réenvoyer le PDF" }]
    );
    safeLog(logger, "delivery_retry_offered", {});
    return Object.freeze({ buttons_sent: true });
  }

  // Offered when a stale IN_PROGRESS claim has just been reconciled (or a
  // document opened from history already carries this classification from
  // a prior reconciliation) — the provider outcome is genuinely unknown, so
  // resending requires this explicit, distinct second confirmation rather
  // than the single-button immediate retry used for a confirmed failure.
  async function presentDeliveryOutcomeUnknownWithRetry({ ownerWaId, messageId = null, documentId } = {}) {
    if (!OWNER_PATTERN.test(ownerWaId || "") || !ID_PATTERN.test(documentId || "")) {
      throw new TypeError("KADI_V1_PRESENTER_DELIVERY_OUTCOME_UNKNOWN_INVALID");
    }
    await maybeTyping(messageId);
    await messaging.sendButtons(
      ownerWaId,
      "Nous ne sommes pas certains que votre document ait été envoyé la dernière fois.\nSouhaitez-vous le renvoyer ?\nAucun crédit supplémentaire ne sera débité.",
      [
        { id: `RESEND_UNKNOWN_DELIVERY:${documentId}`, title: "Renvoyer le PDF" },
        { id: `CANCEL_UNKNOWN_DELIVERY:${documentId}`, title: "Annuler" },
      ]
    );
    safeLog(logger, "delivery_retry_unknown_outcome_offered", {});
    return Object.freeze({ buttons_sent: true });
  }

  // The user explicitly chose not to resend — state is left exactly as is;
  // no service call is made at all.
  async function presentDeliveryRetryCancelled({ ownerWaId, messageId = null, documentId } = {}) {
    if (!OWNER_PATTERN.test(ownerWaId || "") || !ID_PATTERN.test(documentId || "")) {
      throw new TypeError("KADI_V1_PRESENTER_DELIVERY_RETRY_CANCELLED_INVALID");
    }
    await maybeTyping(messageId);
    await messaging.sendText(ownerWaId, "D’accord, je ne renvoie rien pour le moment. Vous pourrez le faire plus tard depuis l’historique.");
    safeLog(logger, "delivery_retry_cancelled_presented", {});
    return Object.freeze({ text_sent: true });
  }

  // A claim still genuinely fresh (not yet stale) — shown when opening the
  // document from history, or after a check that found nothing to
  // reconcile yet. The button lets the user explicitly ask again later
  // without guessing whether one exists.
  async function presentDeliveryInProgress({ ownerWaId, messageId = null, documentId } = {}) {
    if (!OWNER_PATTERN.test(ownerWaId || "") || !ID_PATTERN.test(documentId || "")) {
      throw new TypeError("KADI_V1_PRESENTER_DELIVERY_IN_PROGRESS_INVALID");
    }
    await maybeTyping(messageId);
    await messaging.sendButtons(
      ownerWaId,
      "L’envoi de votre document est toujours en cours.",
      [{ id: `RETRY_DELIVERY:${documentId}`, title: "Vérifier l’envoi" }]
    );
    safeLog(logger, "delivery_in_progress_presented", {});
    return Object.freeze({ buttons_sent: true });
  }

  const DELIVERY_RETRY_OUTCOME_TEXT = Object.freeze({
    SUCCEEDED: "Votre document a bien été renvoyé.",
    FAILED_PERSISTENT: "Le PDF est toujours disponible.\nL’envoi n’a pas abouti et aucun crédit supplémentaire n’a été débité.\nVous pourrez réessayer.",
    REJECTED: "Je n’ai pas pu terminer cette étape. Réessayez dans un instant.",
  });

  // Every branch sends a fixed, pre-validated canonical string — reasonCode
  // (an internal eligibility code such as DELIVERY_RETRY_NOT_ELIGIBLE) is
  // accepted only for privacy-safe logging, never interpolated into the
  // outgoing text.
  async function presentDeliveryRetryOutcome({
    ownerWaId,
    messageId = null,
    outcome,
    reasonCode = null,
  } = {}) {
    const text = DELIVERY_RETRY_OUTCOME_TEXT[outcome];
    if (!OWNER_PATTERN.test(ownerWaId || "") || !text) {
      throw new TypeError("KADI_V1_PRESENTER_DELIVERY_RETRY_OUTCOME_INVALID");
    }
    await maybeTyping(messageId);
    await messaging.sendText(ownerWaId, text);
    safeLog(logger, "delivery_retry_outcome_presented", { outcome, reasonCode });
    return Object.freeze({ text_sent: true });
  }

  async function presentRecoverableError({
    ownerWaId,
    messageId = null,
    canonicalText,
    reason = null,
  } = {}) {
    if (
      !OWNER_PATTERN.test(ownerWaId || "") ||
      typeof canonicalText !== "string" ||
      !canonicalText.trim()
    ) {
      throw new TypeError("KADI_V1_PRESENTER_RECOVERABLE_ERROR_INVALID");
    }

    await maybeTyping(messageId);
    await messaging.sendText(ownerWaId, canonicalText);
    safeLog(logger, "recoverable_error_presented", { reason });

    return Object.freeze({ text_sent: true });
  }

  return Object.freeze({
    presentConversation,
    presentFlowReply,
    presentRecoverableError,
    presentDeliveryFailureWithRetry,
    presentDeliveryOutcomeUnknownWithRetry,
    presentDeliveryRetryCancelled,
    presentDeliveryInProgress,
    presentDeliveryRetryOutcome,
    readiness: Object.freeze({
      ready: true,
      text_required: true,
      flow_sessions_persistent: sessionService == null,
      voice_non_blocking: true,
      pdf_delivery_owned_by_generation_lifecycle: true,
      boot_external_calls: 0,
    }),
  });
}

module.exports = {
  FLOW_MESSAGE_VERSION,
  buildV1FlowMessage,
  createKadiV1ProductionPresenter,
  loadFlowRegistry,
  nextFlowForReply,
  safeFlowData,
};
