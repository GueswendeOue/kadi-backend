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
  const intro = PREVIEW_INTROS[document.document_type] || "Vérifiez les informations avant de générer le document.";
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

function nextFlowForReply(action, resultValue) {
  if (
    FLOW_KEYS.includes(resultValue?.next_flow_key)
  ) {
    return resultValue.next_flow_key;
  }

  const document = extractDocument(resultValue);
  const routed = routeDocument(document);
  if (routed) return routed;

  if (action === "PREPARE_DOCUMENT") return "DOCUMENT_TYPE";
  if (action === "SELECT_DOCUMENT_TYPE") {
    return document?.document_type === "DECHARGE"
      ? "DISCHARGE_DETAILS"
      : "DOCUMENT_CLIENT";
  }
  // ARTICLE_FORM is now its own independent flow_key/Flow (Meta refused
  // opening it as a second screen of DOCUMENT_CONTENT — #131009). The item
  // form is always reached via ARTICLE_FORM; DOCUMENT_CONTENT is the
  // decision screen reached after an item is saved or content is finished.
  if (action === "SAVE_CLIENT") return "ARTICLE_FORM";
  if (action === "START_ADD_CONTENT") return "ARTICLE_FORM";
  if (["ADD_CONTENT", "UPDATE_CONTENT", "REMOVE_CONTENT"].includes(action)) {
    return "DOCUMENT_CONTENT";
  }
  if (action === "FINISH_CONTENT") return "DOCUMENT_OPTIONS";
  if (action === "SAVE_OPTIONS") return "DOCUMENT_REVIEW";
  if (action === "VERIFY") return "DOCUMENT_PREVIEW";
  if (action === "EDIT_CLIENT") return "EDIT_CLIENT";
  if (action === "EDIT_CONTENT") return "EDIT_CONTENT";
  if (action === "EDIT_OPTIONS") return "EDIT_OPTIONS";
  if (action === "PREPARE_PDF") return "GENERATION_CONFIRMATION";
  if (action === "SELECT_PACK") return "RECHARGE";
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

  const copy = {
    START: "Merci. Votre profil est enregistré. Que voulez-vous préparer aujourd’hui ?",
    PREPARE_DOCUMENT: "Choisissez le document à préparer.",
    SELECT_DOCUMENT_TYPE: "Le type de document est enregistré.",
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
    SEARCH: "La recherche est terminée.",
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

  if (flowKey === "DOCUMENT_PREVIEW") {
    output.preview_summary = buildPreviewSummary(document, extra.issuerProfile || null);
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
      whatsappApi,
      "sendText",
      "KADI_V1_PRESENTER_SEND_TEXT_REQUIRED"
    ),
    "sendFlow",
    "KADI_V1_PRESENTER_SEND_FLOW_REQUIRED"
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

    const canonicalText = canonicalReplyText(
      result.action,
      result.result
    );
    await maybeTyping(messageId);
    await messaging.sendText(ownerWaId, canonicalText);

    const flowKey = nextFlowForReply(
      result.action,
      result.result
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
