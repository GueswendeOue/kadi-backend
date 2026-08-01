"use strict";

const crypto = require("node:crypto");
const { MAX_INVOICE_ITEMS } = require("./kadiInvoiceLimits");
const { normalizeClient, normalizeInvoiceItem, normalizeOptions } = require("./kadiDynamicInvoiceContract");

const DRAFT_STATUSES = Object.freeze([
  "collecting_client", "collecting_items", "collecting_options", "ready_for_quote",
  "quoted", "confirmed", "cancelled", "expired",
]);

function flowTokenReference(token) {
  if (typeof token !== "string" || token.length < 8 || token.length > 512) return null;
  return crypto.createHash("sha256").update(token, "utf8").digest("hex").slice(0, 32);
}

function createInvoiceCartService({ repository, now = () => Date.now(), ttlMs = 30 * 60 * 1000, maxItems = MAX_INVOICE_ITEMS } = {}) {
  if (!repository) throw new TypeError("DRAFT_REPOSITORY_REQUIRED");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError("DRAFT_TTL_INVALID");
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > MAX_INVOICE_ITEMS) {
    throw new TypeError("DRAFT_ITEM_LIMIT_INVALID");
  }

  async function createDraft({ ownerRef, flowToken, client = null }) {
    if (typeof ownerRef !== "string" || !ownerRef.trim()) return { ok: false, error: "OWNER_REQUIRED" };
    const tokenRef = flowTokenReference(flowToken);
    if (!tokenRef) return { ok: false, error: "FLOW_TOKEN_INVALID" };
    const timestamp = now();
    if (typeof repository.findByContext === "function") {
      const existing = await repository.findByContext(ownerRef.trim(), tokenRef);
      if (existing) {
        if (!Number.isFinite(Date.parse(existing.expires_at)) || Date.parse(existing.expires_at) <= timestamp) {
          return { ok: false, error: "DRAFT_EXPIRED" };
        }
        if (["cancelled", "expired", "confirmed"].includes(existing.status)) {
          return { ok: false, error: "DRAFT_CLOSED" };
        }
        return { ok: true, value: existing, duplicate: true };
      }
    }
    const draft = {
      draft_id: crypto.randomUUID(),
      flow_token_ref: tokenRef,
      owner_ref: ownerRef.trim(),
      status: client ? "collecting_items" : "collecting_client",
      client: null,
      items: [],
      options: null,
      processed_action_keys: [],
      created_at: new Date(timestamp).toISOString(),
      updated_at: new Date(timestamp).toISOString(),
      expires_at: new Date(timestamp + ttlMs).toISOString(),
      version: 1,
    };
    if (client) {
      const normalized = normalizeClient(client);
      if (!normalized.ok) return normalized;
      draft.client = normalized.value;
    }
    const created = await repository.create(draft);
    if (created.ok || typeof repository.findByContext !== "function") return created;
    const concurrent = await repository.findByContext(ownerRef.trim(), tokenRef);
    return concurrent ? { ok: true, value: concurrent, duplicate: true } : created;
  }

  async function loadOwned(draftId, ownerRef, flowToken) {
    if (typeof draftId !== "string" || typeof ownerRef !== "string") return { ok: false, error: "DRAFT_ACCESS_DENIED" };
    const draft = await repository.get(draftId);
    if (!draft || draft.owner_ref !== ownerRef || draft.flow_token_ref !== flowTokenReference(flowToken)) {
      return { ok: false, error: "DRAFT_ACCESS_DENIED" };
    }
    if (
      !Array.isArray(draft.items) ||
      !Array.isArray(draft.processed_action_keys) ||
      !Number.isSafeInteger(draft.version)
    ) return { ok: false, error: "DRAFT_INVALID" };
    const expiry = Date.parse(draft.expires_at);
    if (!Number.isFinite(expiry) || expiry <= now()) return { ok: false, error: "DRAFT_EXPIRED" };
    if (["cancelled", "expired", "confirmed"].includes(draft.status)) {
      return { ok: false, error: "DRAFT_CLOSED" };
    }
    return { ok: true, value: draft };
  }

  async function mutate({ draftId, ownerRef, flowToken, actionKey, apply }) {
    if (typeof actionKey !== "string" || !actionKey.trim() || actionKey.length > 200) {
      return { ok: false, error: "ACTION_KEY_INVALID" };
    }
    const loaded = await loadOwned(draftId, ownerRef, flowToken);
    if (!loaded.ok) return loaded;
    const current = loaded.value;
    if (current.processed_action_keys.includes(actionKey)) {
      return { ok: true, value: current, duplicate: true };
    }
    const next = structuredClone(current);
    const applied = apply(next);
    if (!applied.ok) return applied;
    next.processed_action_keys.push(actionKey);
    next.processed_action_keys = next.processed_action_keys.slice(-200);
    next.version = current.version + 1;
    next.updated_at = new Date(now()).toISOString();
    const saved = await repository.save(next, current.version);
    if (saved.ok || saved.error !== "DRAFT_VERSION_CONFLICT") return saved;
    const concurrent = await loadOwned(draftId, ownerRef, flowToken);
    if (concurrent.ok && concurrent.value.processed_action_keys.includes(actionKey)) {
      return { ok: true, value: concurrent.value, duplicate: true };
    }
    return saved;
  }

  function setClient(args) {
    return mutate({ ...args, apply(draft) {
      if (!['collecting_client', 'collecting_items'].includes(draft.status)) return { ok: false, error: "DRAFT_STATE_INVALID" };
      const normalized = normalizeClient(args.client);
      if (!normalized.ok) return normalized;
      draft.client = normalized.value;
      draft.status = "collecting_items";
      return { ok: true };
    }});
  }

  function addItem(args) {
    return mutate({ ...args, apply(draft) {
      if (draft.status !== "collecting_items") return { ok: false, error: "DRAFT_STATE_INVALID" };
      if (draft.items.length >= maxItems) return { ok: false, error: "ITEM_LIMIT_REACHED" };
      const normalized = normalizeInvoiceItem(args.item);
      if (!normalized.ok) return normalized;
      draft.items.push(normalized.value);
      draft.status = "collecting_items";
      return { ok: true };
    }});
  }

  function finishItems(args) {
    return mutate({ ...args, apply(draft) {
      if (draft.status !== "collecting_items") return { ok: false, error: "DRAFT_STATE_INVALID" };
      if (draft.items.length < 1) return { ok: false, error: "ITEMS_REQUIRED" };
      draft.status = "collecting_options";
      return { ok: true };
    }});
  }

  function setOptions(args) {
    return mutate({ ...args, apply(draft) {
      if (!['collecting_options', 'ready_for_quote'].includes(draft.status)) return { ok: false, error: "DRAFT_STATE_INVALID" };
      const normalized = normalizeOptions(args.options);
      if (!normalized.ok) return normalized;
      draft.options = normalized.value;
      draft.status = "ready_for_quote";
      return { ok: true };
    }});
  }

  return Object.freeze({ addItem, createDraft, finishItems, loadOwned, setClient, setOptions, maxItems });
}

module.exports = { DRAFT_STATUSES, createInvoiceCartService, flowTokenReference };
