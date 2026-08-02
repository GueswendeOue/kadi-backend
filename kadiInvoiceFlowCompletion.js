"use strict";

const crypto = require("node:crypto");
const { parseInvoiceFlowReply } = require("./kadiInvoiceFlowContract");
const { buildDraftInvoiceFlowMessage } = require("./kadiWhatsAppFlowPayload");
const {
  articleEntryData,
  editClientData,
  editItemsData,
  editOptionsData,
  formatFcfa,
  optionsData,
  reviewData,
  subtotalAmount,
} = require("./kadiInvoiceFlowScreens");

function messageRef(value) {
  return crypto.createHash("sha256").update(String(value || "missing"), "utf8").digest("hex").slice(0, 12);
}

function actionKey(messageId, payload, suffix) {
  const stable = [messageId, payload.draft_id, payload.submission_id, payload.current_item_id, payload.flow_token, suffix]
    .map((value) => String(value || "")).join("\u001f");
  return `flow-completion:${crypto.createHash("sha256").update(stable, "utf8").digest("hex")}`;
}

function clientFromPayload(payload) {
  return {
    type: payload.client_type,
    name: payload.client_name,
    phone: payload.client_phone,
    address: payload.client_address,
    ifu: payload.client_ifu,
    registry_number: payload.client_registry_number,
    invoice_subject: payload.invoice_subject,
    transaction_date: null,
  };
}

function optionsFromPayload(payload) {
  return {
    tax_status: payload.tax_status || "not_applicable",
    tax_rate: payload.tax_rate,
    discount_amount: payload.discount_amount || 0,
    amount_paid: payload.amount_paid || 0,
    due_date: payload.due_date,
    payment_method: payload.payment_method,
    payment_terms: payload.payment_terms,
    note: payload.invoice_note,
  };
}

function createInvoiceFlowCompletionHandler({
  flowSessionService,
  cartService = null,
  flowId = null,
  ttlMinutes = 30,
  sendFlow = null,
  sendText = null,
  logger = console,
  now = () => Date.now(),
} = {}) {
  const seen = new Set();
  const inFlight = new Map();

  async function openNext({ from, ownerRef, draft, currentFlowToken, screen, dataFactory, text, cta }) {
    const expiresAt = new Date(now() + ttlMinutes * 60 * 1000).toISOString();
    const created = await flowSessionService.createInvoiceFlowSession({ ownerRef, draftId: draft.draft_id, expiresAt });
    if (!created.ok) return { ok: false, error: created.error };
    const nextFlowToken = created.value.flow_token;
    try {
      const payload = buildDraftInvoiceFlowMessage({
        to: String(from || "").replace(/[^0-9]/g, ""),
        flowId,
        flowToken: nextFlowToken,
        screen,
        data: dataFactory(nextFlowToken),
        bodyText: text,
        cta,
      });
      if (typeof sendText === "function") await sendText(from, text);
      const sent = await sendFlow(payload);
      if (!sent?.accepted || typeof sent.messageId !== "string" || !sent.messageId.trim()) throw new Error("META_SEND_FAILED");
      await flowSessionService.revokeInvoiceFlowSession(currentFlowToken).catch(() => {});
      return { ok: true, screen, flowToken: nextFlowToken, payload, messageId: sent.messageId };
    } catch {
      await flowSessionService.revokeInvoiceFlowSession(nextFlowToken).catch(() => {});
      return { ok: false, error: "NEXT_FLOW_SEND_FAILED" };
    }
  }

  return async function handle({ from, message, identity } = {}) {
    const messageId = message?.id || null;
    const log = (fields) => logger?.log?.("KADI_FLOW_COMPLETION", {
      message_ref: messageRef(messageId),
      sender_ref: messageRef(from || identity?.wa_id),
      ...fields,
    });
    if (message?.type !== "interactive" || message?.interactive?.type !== "nfm_reply") return { handled: false };
    const parsed = parseInvoiceFlowReply(message);
    if (!parsed.ok) {
      log({ response_json_valid: false, duplicate: false, outcome: "ignored", reason: parsed.error });
      return { handled: true, accepted: false, reason: parsed.error };
    }
    const payload = parsed.value;
    if (typeof payload.flow_token !== "string" || !payload.flow_token.trim()) {
      log({ response_json_valid: true, duplicate: false, outcome: "ignored", reason: "FLOW_TOKEN_MISSING" });
      return { handled: true, accepted: false, reason: "FLOW_TOKEN_MISSING" };
    }
    const messageDedupeKey = messageId ? `message:${messageId}` : null;
    const dedupeKey = actionKey(null, payload, payload.outcome || payload.status);
    if (seen.has(dedupeKey) || (messageDedupeKey && seen.has(messageDedupeKey))) {
      log({ response_json_valid: true, duplicate: true, outcome: "ignored", reason: "DUPLICATE_MESSAGE" });
      return { handled: true, duplicate: true, reason: "DUPLICATE_MESSAGE" };
    }
    if (inFlight.has(dedupeKey)) return inFlight.get(dedupeKey);

    const operation = (async () => {
      const session = await flowSessionService?.resolveInvoiceFlowSession?.(payload.flow_token);
      if (!session?.ok || (payload.draft_id && payload.draft_id !== session.value.draftId)) {
        log({ response_json_valid: true, duplicate: false, outcome: "ignored", reason: "FLOW_SESSION_INVALID" });
        return { handled: true, accepted: false, reason: "FLOW_SESSION_INVALID" };
      }
      if (!payload.outcome || !cartService || !flowId || typeof sendFlow !== "function") {
        seen.add(dedupeKey);
        log({ response_json_valid: true, duplicate: false, outcome: "handled", reason: "FLOW_COMPLETION_ACCEPTED" });
        return { handled: true, outcome: "handled" };
      }

      const common = { draftId: session.value.draftId, ownerRef: session.value.ownerRef, flowToken: payload.flow_token };
      const open = (draft, screen, dataFactory, text, cta) => openNext({
        from, ownerRef: session.value.ownerRef, draft, currentFlowToken: payload.flow_token, screen,
        dataFactory: (token) => dataFactory(draft, token), text, cta,
      });
      let next = null;
      let mutation = null;

      if (payload.outcome === "client_saved" || payload.outcome === "client_corrected") {
        const method = payload.outcome === "client_corrected" ? cartService.correctClient : cartService.setClient;
        mutation = await method({ ...common, actionKey: actionKey(null, payload, payload.outcome), client: clientFromPayload(payload) });
        if (mutation.ok && !mutation.duplicate) next = payload.outcome === "client_saved"
          ? await open(mutation.value, "ARTICLE_ENTRY", articleEntryData, "C’est noté. Qu’ajoutons-nous maintenant ?", "Ajouter le suivant")
          : await open(mutation.value, "REVIEW_INVOICE_DRAFT", reviewData, "C’est noté. Vérifions les informations.", "Vérifier");
      } else if (payload.outcome === "add_another_item" || payload.outcome === "items_finished") {
        const correction = payload.return_to_review === "true";
        const addMethod = correction && typeof cartService.addCorrectionItem === "function" ? cartService.addCorrectionItem : cartService.addItem;
        mutation = await addMethod({
          ...common,
          actionKey: actionKey(null, payload, `add:${payload.submission_id}`),
          itemId: payload.current_item_id,
          item: { description: payload.designation, quantity: payload.quantity, unit: payload.unit, unit_price: payload.unit_price },
        });
        if (mutation.ok) {
          if (mutation.duplicate && payload.outcome === "add_another_item") {
            // A completed add step must never emit the following message twice.
          } else if (correction) {
            if (!mutation.duplicate) next = await open(mutation.value, "REVIEW_INVOICE_DRAFT", reviewData, "C’est noté. Vérifions les informations.", "Vérifier");
          } else if (payload.outcome === "add_another_item" && !mutation.duplicate) {
            next = await open(mutation.value, "ARTICLE_ENTRY", articleEntryData, `C’est noté. J’ai ajouté ${payload.designation}. Qu’ajoutons-nous maintenant ?`, "Ajouter le suivant");
          } else if (payload.outcome === "items_finished") {
            const finished = await cartService.finishItems({ ...common, actionKey: actionKey(null, payload, `finish:${payload.submission_id}`) });
            mutation = finished;
            if (finished.ok && !finished.duplicate) next = await open(finished.value, "OPTIONS", optionsData, "Parfait. J’ai bien enregistré les produits et services. Vérifions maintenant les derniers détails.", "Continuer");
          }
        }
      } else if (payload.outcome === "options_saved" || payload.outcome === "options_corrected") {
        mutation = await cartService.setOptions({ ...common, actionKey: actionKey(null, payload, payload.outcome), options: optionsFromPayload(payload) });
        if (mutation.ok && !mutation.duplicate) next = await open(mutation.value, "REVIEW_INVOICE_DRAFT", reviewData, "C’est noté. Vérifions les informations.", "Vérifier");
      } else if (payload.outcome === "item_corrected") {
        mutation = await cartService.updateCorrectionItem({
          ...common,
          actionKey: actionKey(null, payload, `correct-item:${payload.edit_item_id}`),
          itemId: payload.edit_item_id,
          quantity: payload.edit_quantity,
          unitPrice: payload.edit_unit_price,
        });
        if (mutation.ok && !mutation.duplicate) next = await open(mutation.value, "REVIEW_INVOICE_DRAFT", reviewData, "C’est noté. Vérifions les informations.", "Vérifier");
      } else if (["modify_client", "modify_items", "modify_options", "edit_items_add_item", "edit_items_done"].includes(payload.outcome)) {
        mutation = await cartService.loadOwned(common.draftId, common.ownerRef, common.flowToken);
        if (mutation.ok) {
          if (payload.outcome === "modify_client") next = await open(mutation.value, "EDIT_CLIENT", editClientData, "D’accord, corrigeons les informations du client.", "Corriger");
          if (payload.outcome === "modify_items") next = await open(mutation.value, "EDIT_ITEMS", editItemsData, "D’accord, corrigeons les produits et services.", "Corriger");
          if (payload.outcome === "modify_options") next = await open(mutation.value, "EDIT_OPTIONS", editOptionsData, "D’accord, corrigeons les autres détails.", "Corriger");
          if (payload.outcome === "edit_items_add_item") next = await open(mutation.value, "ARTICLE_ENTRY", (draft, token) => articleEntryData(draft, token, { returnToReview: true }), "D’accord, ajoutons ce qui manque.", "Ajouter");
          if (payload.outcome === "edit_items_done") next = await open(mutation.value, "REVIEW_INVOICE_DRAFT", reviewData, "C’est noté. Vérifions les informations.", "Vérifier");
        }
      } else if (payload.outcome === "finalize_draft") {
        const finalization = { issued_at_utc: new Date(now()).toISOString(), issued_at_timezone: "Africa/Ouagadougou", issued_at_source: "server", finalized_at: new Date(now()).toISOString() };
        mutation = await cartService.finalizeDraft({ ...common, actionKey: actionKey(null, payload, "finalize"), finalization });
        if (mutation.ok && !mutation.duplicate) {
          if (typeof sendText === "function") await sendText(from, "Votre brouillon est bien enregistré. Aucun crédit n’a été débité.");
          await flowSessionService.revokeInvoiceFlowSession(payload.flow_token).catch(() => {});
          next = { ok: true, screen: null };
        }
      } else {
        log({ response_json_valid: true, duplicate: false, outcome: "ignored", reason: "FLOW_OUTCOME_INVALID" });
        return { handled: true, accepted: false, reason: "FLOW_OUTCOME_INVALID" };
      }

      if (!mutation?.ok) {
        log({ response_json_valid: true, duplicate: false, outcome: "failed", reason: mutation?.error || "FLOW_OPERATION_FAILED" });
        return { handled: true, accepted: false, reason: mutation?.error || "FLOW_OPERATION_FAILED" };
      }
      if (mutation.duplicate) {
        seen.add(dedupeKey);
        log({ response_json_valid: true, duplicate: true, outcome: "ignored", reason: "DUPLICATE_OPERATION" });
        return { handled: true, duplicate: true, reason: "DUPLICATE_OPERATION" };
      }
      if (!next?.ok) {
        log({ response_json_valid: true, duplicate: false, outcome: "failed", reason: next?.error || "NEXT_FLOW_SEND_FAILED" });
        return { handled: true, accepted: false, reason: next?.error || "NEXT_FLOW_SEND_FAILED" };
      }
      seen.add(dedupeKey);
      if (messageDedupeKey) seen.add(messageDedupeKey);
      log({ response_json_valid: true, duplicate: false, outcome: payload.outcome, reason: "FLOW_COMPLETION_ACCEPTED" });
      const result = {
        handled: true,
        outcome: payload.outcome,
        draft_id: mutation.value.draft_id,
        submission_id: payload.submission_id || null,
        next_screen: next.screen,
        next_flow_token: next.flowToken || null,
      };
      if (payload.outcome === "add_another_item") result.next_item_number = String(mutation.value.items.length + 1);
      if (payload.outcome === "items_finished") {
        result.item_count = String(mutation.value.items.length);
        result.subtotal_text = formatFcfa(subtotalAmount(mutation.value));
      }
      return result;
    })().finally(() => inFlight.delete(dedupeKey));
    inFlight.set(dedupeKey, operation);
    return operation;
  };
}

module.exports = { actionKey, createInvoiceFlowCompletionHandler, messageRef };
