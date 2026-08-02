"use strict";

const crypto = require("node:crypto");
const { isPlainRecord } = require("./kadiDynamicInvoiceContract");
const { calculateInvoiceFlowDraft } = require("./kadiInvoiceCalculator");
const { decryptFlowRequest, encryptFlowResponse, parseEncryptedEnvelopeJson } = require("./kadiFlowCrypto");
const { flowTokenReference } = require("./kadiInvoiceCartService");
const {
  articleEntryData,
  editClientData,
  editItemsData,
  editOptionsData,
  optionsData,
  reviewData: shortSessionReviewData,
} = require("./kadiInvoiceFlowScreens");

const ACTIONS = new Set(["ping", "INIT", "data_exchange"]);
const INTENTS = new Set(["save_client", "submit_article", "save_options", "review_action", "update_item", "delete_item"]);
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

function normalizeArticleSubmission(data) {
  return {
    designation: data.designation ?? data.designation_a ?? data.designation_b ?? data.description,
    quantity: data.quantity ?? data.quantity_a ?? data.quantity_b,
    unit: data.unit ?? data.unit_a ?? data.unit_b,
    unit_price: data.unit_price ?? data.unit_price_a ?? data.unit_price_b,
    article_decision: data.article_decision ?? data.article_decision_a ?? data.article_decision_b ?? data.decision,
  };
}

function itemSubmissionId(body, data, article, draftId) {
  const stable = [
    draftId,
    data.current_item_id || data.item_index || data.item_count || "0",
    article.designation || "",
    article.quantity || "",
    article.unit || "",
    article.unit_price || "",
    article.article_decision || "",
  ].map((value) => String(value)).join("\u001f");
  return crypto.createHash("sha256").update(stable, "utf8").digest("hex").slice(0, 32);
}

function articleScreenId(itemIndex) {
  return itemIndex % 2 === 1 ? "ARTICLE_CART_A" : "ARTICLE_CART_B";
}

function draftData(draft, { returnToReview = false } = {}) {
  const itemCount = draft.items.length;
  const itemIndex = itemCount + 1;
  const suffix = itemIndex % 2 === 1 ? "a" : "b";
  const currentItemId = `${draft.draft_id}:item:${itemIndex}`;
  const subtotal = draft.items.reduce(
    (sum, item) => sum + ((BigInt(item.quantity_millis) * BigInt(item.unit_price) + 500n) / 1000n),
    0n
  );
  const subtotalText = subtotal <= BigInt(Number.MAX_SAFE_INTEGER)
    ? `${Number(subtotal).toLocaleString("fr-FR")} FCFA`
    : "À calculer";
  const recentItems = draft.items.slice(-3).map((item) => `${item.description} — ${item.quantity} × ${Number(item.unit_price).toLocaleString("fr-FR")} FCFA`);
  const summaryPrefix = draft.items.length > recentItems.length ? "… · " : "";
  const savedSummary = draft.items.length ? `${summaryPrefix}${recentItems.join(" · ")}`.slice(0, 240) : "Aucun article enregistré";
  const savedCountText = itemCount === 1 ? "1 article enregistré" : `${itemCount} articles enregistrés`;
  return {
    draft_id: draft.draft_id,
    item_count: String(itemCount),
    item_index: String(itemIndex),
    item_number_text: `Article ${itemIndex}`,
    current_item_id: currentItemId,
    submission_id: currentItemId,
    saved_item_count_text: savedCountText,
    saved_items_summary: savedSummary,
    saved_subtotal_text: subtotalText,
    article_form_init_values: {
      [`designation_${suffix}`]: "",
      [`quantity_${suffix}`]: "1",
      [`unit_price_${suffix}`]: "",
    },
    return_to_review: returnToReview ? "true" : "false",
    items_summary: savedSummary,
    provisional_subtotal: subtotalText,
  };
}

function articleScreen(draft, options) {
  const data = draftData(draft, options);
  return { screen: articleScreenId(Number(data.item_index)), data };
}

function formatIssuedAtLocal(date) {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Africa/Ouagadougou", dateStyle: "long", timeStyle: "medium",
  }).format(date);
}

function calculationSubmission(draft) {
  return {
    client: draft.client,
    items: draft.items,
    invoice_subject: draft.client?.invoice_subject,
    transaction_date: null,
    ...Object.fromEntries(Object.entries(draft.options || {}).filter(([key]) => key !== "add_stamp" && key !== "finalization")),
  };
}

function reviewData(draft, calculation, issuerProfile = null) {
  const value = calculation?.ok === true ? calculation.value : calculation;
  const items = draft.items.map((item, index) => {
    const total = Number(item.quantity) * Number(item.unit_price);
    return `${index + 1}. ${item.description} — ${item.quantity} × ${item.unit} × ${Number(item.unit_price).toLocaleString("fr-FR")} FCFA = ${total.toLocaleString("fr-FR")} FCFA`;
  });
  const subtotal = draft.items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_price), 0);
  return {
    draft_id: draft.draft_id,
    issuer_name: issuerProfile?.name || "Profil entreprise non renseigné",
    client_type: draft.client?.type === "professional" ? "Professionnel" : "Particulier",
    client_name: draft.client?.name || "Non renseigné",
    client_phone: draft.client?.phone ? `••••${String(draft.client.phone).slice(-4)}` : "Non renseigné",
    client_address: draft.client?.address || "Non renseignée",
    items_summary: items.length ? items.join("\n") : "Aucun article",
    subtotal_text: `${subtotal.toLocaleString("fr-FR")} FCFA`,
    discount_text: `${Number(draft.options?.discount_amount || 0).toLocaleString("fr-FR")} FCFA`,
    tax_text: draft.options?.tax_status === "taxable" ? "Taxe selon le taux saisi" : "Aucune taxe",
    total_text: Number(value?.amount_fcfa ?? subtotal).toLocaleString("fr-FR") + " FCFA",
    payment_terms: draft.options?.payment_terms || "Non renseignées",
    note: draft.options?.note || "Aucune note",
    due_date: draft.options?.due_date || "Aucune échéance",
  };
}

function normalizeOptionValue(value, fallback) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
}

function initialScreenData(targetScreen, draft, flowToken, { returnToReview = false } = {}) {
  if (targetScreen === "CLIENT") return { flow_token: flowToken, draft_id: draft.draft_id };
  if (targetScreen === "ARTICLE_ENTRY") return articleEntryData(draft, flowToken, { returnToReview });
  if (targetScreen === "OPTIONS") return optionsData(draft, flowToken);
  if (targetScreen === "REVIEW_INVOICE_DRAFT") return shortSessionReviewData(draft, flowToken);
  if (targetScreen === "EDIT_CLIENT") return editClientData(draft, flowToken);
  if (targetScreen === "EDIT_ITEMS") return editItemsData(draft, flowToken);
  if (targetScreen === "EDIT_OPTIONS") return editOptionsData(draft, flowToken);
  return null;
}

function createInvoiceFlowEndpoint({ cartService, ownerResolver = null, flowSessionService = null, issuerResolver = null, cryptoConfig = null, webhookOrchestration = false } = {}) {
  if (!cartService || (typeof ownerResolver !== "function" && typeof flowSessionService?.resolveInvoiceFlowSession !== "function")) throw new TypeError("FLOW_ENDPOINT_DEPENDENCIES_REQUIRED");

  async function handle(decryptedBody, requestContext = {}) {
    const body = safeRecord(decryptedBody);
    if (!body || !ACTIONS.has(body.action)) return { ok: false, status: 400, error: "FLOW_REQUEST_INVALID" };
    if (body.action === "ping") return { ok: true, value: { data: { status: "active" } }, stage: "action_ping" };
    if (typeof body.flow_token !== "string") return { ok: false, status: 400, error: "FLOW_TOKEN_INVALID" };

    let ownerRef = null;
    let sessionDraftId = null;
    let sessionTargetScreen = null;
    let sessionReturnToReview = false;
    if (flowSessionService) {
      const session = await flowSessionService.resolveInvoiceFlowSession(body.flow_token);
      if (!session.ok) return { ok: false, status: 427, error: session.error };
      ownerRef = session.value.ownerRef;
      sessionDraftId = session.value.draftId;
      sessionTargetScreen = session.value.targetScreen;
      sessionReturnToReview = session.value.returnToReview === true;
      requestContext.logger?.(requestContext.requestId, { stage: "flow_session_valid", status_code: 0 });
    } else {
      ownerRef = await ownerResolver(requestContext);
      if (typeof ownerRef !== "string" || !ownerRef) return { ok: false, status: 403, error: "FLOW_CONTEXT_INVALID" };
    }

    if (body.action === "INIT") {
      if (flowSessionService) {
        const loaded = await cartService.loadOwned(sessionDraftId, ownerRef, body.flow_token);
        if (!loaded.ok) return { ok: false, status: 400, error: loaded.error };
        const data = initialScreenData(sessionTargetScreen, loaded.value, body.flow_token, { returnToReview: sessionReturnToReview });
        if (!data) return { ok: false, status: 427, error: "FLOW_SESSION_TARGET_INVALID" };
        return {
          ok: true,
          value: { screen: sessionTargetScreen, data },
          draft: loaded.value,
          stage: "action_init",
        };
      }
      const created = sessionDraftId
        ? await cartService.loadOwned(sessionDraftId, ownerRef, body.flow_token)
        : await cartService.createDraft({ ownerRef, flowToken: body.flow_token });
      if (!created.ok) return { ok: false, status: 400, error: created.error };
      return { ok: true, value: { screen: "CLIENT", data: { flow_token: body.flow_token, draft_id: created.value.draft_id } }, draft: created.value, stage: "action_init" };
    }

    if (webhookOrchestration) {
      return { ok: false, status: 409, error: "FLOW_WEBHOOK_ORCHESTRATION_REQUIRED", stage: "action_data_exchange" };
    }

    const data = safeRecord(body.data);
    if (!data || !INTENTS.has(data.intent)) return { ok: false, status: 400, error: "FLOW_DATA_INVALID" };
    const common = { draftId: sessionDraftId || data.draft_id, ownerRef, flowToken: body.flow_token };

    if (data.intent === "save_client") {
      const client = {
        type: data.client_type,
        name: data.client_name,
        phone: data.client_phone,
        address: data.client_address,
        ifu: data.client_ifu,
        registry_number: data.client_registry_number,
        invoice_subject: data.invoice_subject,
        transaction_date: null,
      };
      const updated = await cartService.setClient({ ...common, actionKey: actionKey(body, `client:${common.draftId}`), client });
      if (!updated.ok) return { ok: false, status: 400, error: updated.error };
      return { ok: true, value: data.return_to_review === "true"
        ? { screen: "REVIEW_INVOICE_DRAFT", data: reviewData(updated.value, null) }
        : articleScreen(updated.value), stage: "action_data_exchange" };
    }
    if (data.intent === "submit_article") {
      const article = normalizeArticleSubmission(data);
      const decision = article.article_decision === "add" || article.article_decision === "add_another" ? "add_another"
        : article.article_decision === "finish" || article.article_decision === "finish_items" ? "finish_items"
          : null;
      if (!decision) {
        return { ok: false, status: 400, error: "ARTICLE_ACTION_INVALID" };
      }
      const item = { description: article.designation, quantity: article.quantity, unit: article.unit, unit_price: article.unit_price };
      const submissionId = typeof data.submission_id === "string" && data.submission_id.trim()
        ? data.submission_id.trim().slice(0, 64)
        : itemSubmissionId(body, data, article, common.draftId);
      const updated = await cartService.addItem({ ...common, actionKey: actionKey(body, `item:${submissionId}`), item });
      if (!updated.ok) return { ok: false, status: 400, error: updated.error };
      if (decision === "add_another") {
        return { ok: true, value: articleScreen(updated.value, { returnToReview: data.return_to_review === "true" }), stage: "action_data_exchange" };
      }
      const finished = await cartService.finishItems({ ...common, actionKey: actionKey(body, `finish-items:${submissionId}`) });
      if (!finished.ok) return { ok: false, status: 400, error: finished.error };
      const itemCount = finished.value.items.length;
      return { ok: true, value: { screen: data.return_to_review === "true" ? "REVIEW_INVOICE_DRAFT" : "OPTIONS", data: data.return_to_review === "true" ? reviewData(finished.value, null) : { draft_id: finished.value.draft_id, item_count: String(itemCount), return_to_review: "false" } }, stage: "action_data_exchange" };
    }
    if (data.intent === "save_options") {
      const options = {
        tax_status: normalizeOptionValue(data.tax_status, "not_applicable"),
        tax_rate: data.tax_rate,
        discount_amount: data.discount_amount,
        amount_paid: data.amount_paid,
        due_date: data.due_date,
        payment_method: data.payment_method,
        payment_terms: data.payment_terms,
        note: data.note,
      };
      const updated = await cartService.setOptions({ ...common, actionKey: actionKey(body, "options"), options });
      if (!updated.ok) return { ok: false, status: 400, error: updated.error };
      const issuerProfile = typeof issuerResolver === "function"
        ? await issuerResolver(requestContext)
        : null;
      const calculated = calculateInvoiceFlowDraft(calculationSubmission(updated.value), issuerProfile);
      if (!calculated.ok) return { ok: false, status: 400, error: calculated.error };
      return { ok: true, value: { screen: "REVIEW_INVOICE_DRAFT", data: reviewData(updated.value, calculated, issuerProfile) }, stage: "action_data_exchange" };
    }
    if (data.intent === "review_action") {
      const loaded = await cartService.loadOwned(common.draftId, ownerRef, body.flow_token, { allowConfirmed: data.review_action === "confirm_generate" });
      if (!loaded.ok) return { ok: false, status: 400, error: loaded.error };
      if (data.review_action === "modify_client") return { ok: true, value: { screen: "CLIENT", data: { draft_id: loaded.value.draft_id, return_to_review: "true", client_type: loaded.value.client?.type || "", client_name: loaded.value.client?.name || "", client_phone: loaded.value.client?.phone || "", client_address: loaded.value.client?.address || "", client_ifu: loaded.value.client?.ifu || "", client_registry_number: loaded.value.client?.registry_number || "", invoice_subject: loaded.value.client?.invoice_subject || "" } }, stage: "action_data_exchange" };
      if (data.review_action === "modify_items") return { ok: true, value: articleScreen(loaded.value, { returnToReview: true }), stage: "action_data_exchange" };
      if (data.review_action === "modify_options") return { ok: true, value: { screen: "OPTIONS", data: { draft_id: loaded.value.draft_id, item_count: String(loaded.value.items.length), return_to_review: "true", tax_status: loaded.value.options?.tax_status || "not_applicable", tax_rate: loaded.value.options?.tax_rate_basis_points ? String(loaded.value.options.tax_rate_basis_points / 100) : "", discount_amount: String(loaded.value.options?.discount_amount || 0), amount_paid: String(loaded.value.options?.amount_paid || 0), payment_terms: loaded.value.options?.payment_terms || "", note: loaded.value.options?.note || "" } }, stage: "action_data_exchange" };
      if (data.review_action === "confirm_generate") {
        const issuerProfile = typeof issuerResolver === "function"
          ? await issuerResolver(requestContext)
          : null;
        const calculated = calculateInvoiceFlowDraft(calculationSubmission(loaded.value), issuerProfile);
        if (!calculated.ok) return { ok: false, status: 400, error: calculated.error };
        const issuedAt = new Date();
        const finalization = { issued_at_utc: issuedAt.toISOString(), issued_at_timezone: "Africa/Ouagadougou", issued_at_local: formatIssuedAtLocal(issuedAt), issued_at_source: "server", finalized_at: new Date().toISOString() };
        const finalized = await cartService.finalizeDraft({ ...common, actionKey: actionKey(body, "confirm_generate"), finalization });
        if (!finalized.ok) return { ok: false, status: 400, error: finalized.error };
        return { ok: true, value: { screen: "DRAFT_SAVED", data: {
          flow_token: body.flow_token,
          draft_id: finalized.value.draft_id,
        } }, stage: "action_data_exchange" };
      }
      return { ok: false, status: 400, error: "REVIEW_ACTION_INVALID" };
    }
    if (data.intent === "update_item" || data.intent === "delete_item") {
      const itemIndex = Number(data.item_index);
      const article = normalizeArticleSubmission(data);
      const result = data.intent === "update_item"
        ? await cartService.updateItem({ ...common, itemIndex, actionKey: actionKey(body, `update-item:${itemIndex}`), item: { description: article.designation, quantity: article.quantity, unit: article.unit, unit_price: article.unit_price } })
        : await cartService.deleteItem({ ...common, itemIndex, actionKey: actionKey(body, `delete-item:${itemIndex}`) });
      if (!result.ok) return { ok: false, status: 400, error: result.error };
      return { ok: true, value: { screen: "REVIEW_INVOICE_DRAFT", data: reviewData(result.value, null) }, stage: "action_data_exchange" };
    }
    return { ok: false, status: 400, error: "FLOW_DATA_INVALID" };
  }

  async function handleEncrypted(envelope, requestContext = {}) {
    if (requestContext.production === true && requestContext.https !== true) {
      return { ok: false, status: 400, error: "FLOW_HTTPS_REQUIRED" };
    }
    const decrypted = decryptFlowRequest(envelope, cryptoConfig || {}, {
      requestId: requestContext.requestId,
      logger: requestContext.cryptoLogger,
    });
    if (!decrypted.ok) return { ok: false, status: decrypted.error === "FLOW_PRIVATE_KEY_MISMATCH" ? 421 : 400, error: decrypted.error };
    requestContext.logger?.(requestContext.requestId, { stage: "decrypt_valid", status_code: 0 });
    const response = await handle(decrypted.value, requestContext);
    requestContext.logger?.(requestContext.requestId, { stage: response.stage || "action_data_exchange", status_code: response.ok ? 0 : response.status || 400, error_code: response.ok ? undefined : response.error });
    const payload = response.ok ? response.value : { error_msg: "Le formulaire n’est plus disponible." };
    const encrypted = encryptFlowResponse(payload, decrypted.context);
    if (encrypted.ok) {
      requestContext.logger?.(requestContext.requestId, { stage: response.ok ? "business_response_ready" : "failed", status_code: response.ok ? 0 : response.status || 427, error_code: response.ok ? undefined : response.error });
      requestContext.logger?.(requestContext.requestId, { stage: "response_encrypted", status_code: response.ok ? 200 : response.status || 427 });
    }
    return encrypted.ok
      ? { ok: true, status: response.ok ? 200 : response.status || 427, content_type: "text/plain", value: encrypted.value, error: response.ok ? undefined : response.error }
      : { ok: false, status: 500, error: encrypted.error };
  }

  async function handleEncryptedRaw(rawBody, requestContext = {}) {
    const parsed = parseEncryptedEnvelopeJson(rawBody);
    return parsed.ok ? handleEncrypted(parsed.value, requestContext) : { ok: false, status: 400, error: parsed.error };
  }

  return Object.freeze({ handle, handleEncrypted, handleEncryptedRaw });
}

module.exports = { ACTIONS, INTENTS, articleScreenId, createInvoiceFlowEndpoint, initialScreenData, normalizeArticleSubmission, safeRecord };
