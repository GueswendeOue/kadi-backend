"use strict";

const { isPlainRecord } = require("./kadiDynamicInvoiceContract");
const { calculateInvoiceFlowDraft } = require("./kadiInvoiceCalculator");
const { decryptFlowRequest, encryptFlowResponse, parseEncryptedEnvelopeJson } = require("./kadiFlowCrypto");
const { flowTokenReference } = require("./kadiInvoiceCartService");

const ACTIONS = new Set(["ping", "INIT", "data_exchange"]);
const INTENTS = new Set(["save_client", "add_item", "decide_articles", "save_options"]);
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function safeRecord(value) {
  if (!isPlainRecord(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).some((key) => DANGEROUS_KEYS.has(key) || !Object.hasOwn(descriptors[key], "value"))) return null;
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
  } catch {
    return null;
  }
}

function actionKey(body, suffix) {
  const token = flowTokenReference(body.flow_token) || "invalid-flow";
  const version = typeof body.version === "string" ? body.version : "3.0";
  return `${version}:${token}:${suffix}`;
}

function draftData(draft) {
  const last = draft.items.at(-1);
  const subtotal = draft.items.reduce(
    (sum, item) => sum + ((BigInt(item.quantity_millis) * BigInt(item.unit_price) + 500n) / 1000n),
    0n
  );
  const subtotalText = subtotal <= BigInt(Number.MAX_SAFE_INTEGER)
    ? `${Number(subtotal).toLocaleString("fr-FR")} FCFA`
    : "À calculer";
  return {
    draft_id: draft.draft_id,
    item_count: draft.items.length,
    last_item_summary: last ? `${last.quantity} × ${last.description}`.slice(0, 120) : "",
    provisional_subtotal: subtotalText,
  };
}

function estimateData(estimate, itemCount) {
  const value = estimate?.ok === true ? estimate.value : estimate;
  if (!value) return {
    item_count: itemCount,
    page_count_text: "À calculer",
    page_count_mode_text: "Renderer final non exécuté",
    credit_cost_text: "Aucun débit",
    amount_fcfa_text: "À confirmer",
    estimate_notice: "Aucun crédit n'a été débité et aucun PDF n'a été envoyé.",
  };
  if (value.debit_performed === true || value.sent === true) return null;
  const pageCount = Number.isSafeInteger(value.page_count) && value.page_count > 0
    ? value.page_count
    : null;
  return {
    item_count: itemCount,
    page_count_text: pageCount ? String(pageCount) : "À calculer",
    page_count_mode_text: value.page_count_mode === "final_renderer"
      ? "Comptage issu du renderer PDF Kadi final"
      : "Mode de pagination non confirmé",
    credit_cost_text: Number.isSafeInteger(value.credit_cost) ? String(value.credit_cost) : "Aucun débit",
    amount_fcfa_text: Number.isSafeInteger(value.amount_fcfa) ? `${value.amount_fcfa} FCFA` : "À confirmer",
    estimate_notice: "Estimation locale uniquement : aucun débit et aucun envoi PDF.",
  };
}

function createInvoiceFlowEndpoint({ cartService, ownerResolver, issuerResolver = null, estimateDocument, cryptoConfig = null } = {}) {
  if (!cartService || typeof ownerResolver !== "function") throw new TypeError("FLOW_ENDPOINT_DEPENDENCIES_REQUIRED");

  async function handle(decryptedBody, requestContext = {}) {
    const body = safeRecord(decryptedBody);
    if (!body || !ACTIONS.has(body.action)) return { ok: false, status: 400, error: "FLOW_REQUEST_INVALID" };
    if (body.action === "ping") return { ok: true, value: { data: { status: "active" } } };
    const ownerRef = await ownerResolver(requestContext);
    if (typeof ownerRef !== "string" || !ownerRef) return { ok: false, status: 403, error: "FLOW_CONTEXT_INVALID" };
    if (typeof body.flow_token !== "string") return { ok: false, status: 400, error: "FLOW_TOKEN_INVALID" };

    if (body.action === "INIT") {
      const created = await cartService.createDraft({ ownerRef, flowToken: body.flow_token });
      if (!created.ok) return { ok: false, status: 400, error: created.error };
      return { ok: true, value: { screen: "CLIENT", data: { draft_id: created.value.draft_id } }, draft: created.value };
    }

    const data = safeRecord(body.data);
    if (!data || !INTENTS.has(data.intent)) return { ok: false, status: 400, error: "FLOW_DATA_INVALID" };
    const common = { draftId: data.draft_id, ownerRef, flowToken: body.flow_token };

    if (data.intent === "save_client") {
      const client = {
        type: data.client_type,
        name: data.client_name,
        phone: data.client_phone,
        address: data.client_address,
        ifu: data.client_ifu,
        registry_number: data.client_registry_number,
        invoice_subject: data.invoice_subject,
        transaction_date: data.transaction_date,
      };
      const updated = await cartService.setClient({ ...common, actionKey: actionKey(body, `client:${data.draft_id}`), client });
      if (!updated.ok) return { ok: false, status: 400, error: updated.error };
      return { ok: true, value: { screen: "ARTICLE", data: { draft_id: updated.value.draft_id, item_count: updated.value.items.length } } };
    }
    if (data.intent === "add_item") {
      const item = { description: data.description, quantity: data.quantity, unit: data.unit, unit_price: data.unit_price };
      const updated = await cartService.addItem({ ...common, actionKey: actionKey(body, `item:${data.action_id || data.item_count}`), item });
      if (!updated.ok) return { ok: false, status: 400, error: updated.error };
      return { ok: true, value: { screen: "ARTICLE_DECISION", data: draftData(updated.value) } };
    }
    if (data.intent === "decide_articles") {
      if (data.decision === "add") {
        const loaded = await cartService.loadOwned(common.draftId, ownerRef, body.flow_token);
        if (!loaded.ok) return { ok: false, status: 400, error: loaded.error };
        return { ok: true, value: { screen: "ARTICLE", data: { draft_id: loaded.value.draft_id, item_count: loaded.value.items.length } } };
      }
      if (data.decision !== "finish") return { ok: false, status: 400, error: "ARTICLE_DECISION_INVALID" };
      const updated = await cartService.finishItems({ ...common, actionKey: actionKey(body, "finish-items") });
      if (!updated.ok) return { ok: false, status: 400, error: updated.error };
      return { ok: true, value: { screen: "OPTIONS", data: { draft_id: updated.value.draft_id, item_count: updated.value.items.length } } };
    }
    if (data.intent === "save_options") {
      const options = { tax_status: data.tax_status, tax_rate: data.tax_rate, discount_amount: data.discount_amount, amount_paid: data.amount_paid, due_date: data.due_date, payment_method: data.payment_method, payment_terms: data.payment_terms, note: data.note, add_stamp: data.add_stamp };
      const updated = await cartService.setOptions({ ...common, actionKey: actionKey(body, "options"), options });
      if (!updated.ok) return { ok: false, status: 400, error: updated.error };
      const submission = {
        client: updated.value.client,
        items: updated.value.items,
        invoice_subject: updated.value.client.invoice_subject,
        transaction_date: updated.value.client.transaction_date,
        ...updated.value.options,
      };
      const issuerProfile = typeof issuerResolver === "function"
        ? await issuerResolver(requestContext)
        : null;
      const calculated = calculateInvoiceFlowDraft(submission, issuerProfile);
      if (!calculated.ok) return { ok: false, status: 400, error: calculated.error };
      const estimate = typeof estimateDocument === "function" ? await estimateDocument(calculated.value) : null;
      const estimateScreenData = estimateData(estimate, updated.value.items.length);
      if (!estimateScreenData) return { ok: false, status: 500, error: "ESTIMATE_SIDE_EFFECT_FORBIDDEN" };
      return { ok: true, value: { screen: "DOCUMENT_ESTIMATE", data: estimateScreenData } };
    }
    return { ok: false, status: 400, error: "FLOW_DATA_INVALID" };
  }

  async function handleEncrypted(envelope, requestContext = {}) {
    if (requestContext.production === true && requestContext.https !== true) {
      return { ok: false, status: 400, error: "FLOW_HTTPS_REQUIRED" };
    }
    const decrypted = decryptFlowRequest(envelope, cryptoConfig || {});
    if (!decrypted.ok) return { ok: false, status: 421, error: decrypted.error };
    const response = await handle(decrypted.value, requestContext);
    if (!response.ok) return response;
    const encrypted = encryptFlowResponse(response.value, decrypted.context);
    return encrypted.ok
      ? { ok: true, status: 200, content_type: "text/plain", value: encrypted.value }
      : { ok: false, status: 500, error: encrypted.error };
  }

  async function handleEncryptedRaw(rawBody, requestContext = {}) {
    const parsed = parseEncryptedEnvelopeJson(rawBody);
    return parsed.ok ? handleEncrypted(parsed.value, requestContext) : { ok: false, status: 400, error: parsed.error };
  }

  return Object.freeze({ handle, handleEncrypted, handleEncryptedRaw });
}

module.exports = { ACTIONS, INTENTS, createInvoiceFlowEndpoint, estimateData, safeRecord };
