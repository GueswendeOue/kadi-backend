"use strict";

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function createInMemoryInvoiceDraftRepository() {
  const drafts = new Map();
  return Object.freeze({
    async create(draft) {
      if (drafts.has(draft.draft_id)) return { ok: false, error: "DRAFT_EXISTS" };
      drafts.set(draft.draft_id, clone(draft));
      return { ok: true, value: clone(draft) };
    },
    async get(draftId) {
      return clone(drafts.get(draftId) || null);
    },
    async findByContext(ownerRef, flowTokenRef) {
      const matches = [...drafts.values()]
        .filter((draft) => draft.owner_ref === ownerRef && draft.flow_token_ref === flowTokenRef)
        .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
      return clone(matches[0] || null);
    },
    async save(draft, expectedVersion) {
      const current = drafts.get(draft.draft_id);
      if (!current) return { ok: false, error: "DRAFT_NOT_FOUND" };
      if (current.version !== expectedVersion) return { ok: false, error: "DRAFT_VERSION_CONFLICT" };
      drafts.set(draft.draft_id, clone(draft));
      return { ok: true, value: clone(draft) };
    },
  });
}

function createSupabaseInvoiceDraftRepository(client) {
  if (!client || typeof client.from !== "function") throw new TypeError("SUPABASE_CLIENT_REQUIRED");
  return Object.freeze({
    async create(draft) {
      const { data, error } = await client.from("kadi_invoice_flow_drafts").insert(draft).select().single();
      return error ? { ok: false, error: "DRAFT_CREATE_FAILED" } : { ok: true, value: data };
    },
    async get(draftId) {
      const { data, error } = await client
        .from("kadi_invoice_flow_drafts")
        .select("*")
        .eq("draft_id", draftId)
        .maybeSingle();
      return error ? null : data;
    },
    async findByContext(ownerRef, flowTokenRef) {
      const { data, error } = await client
        .from("kadi_invoice_flow_drafts")
        .select("*")
        .eq("owner_ref", ownerRef)
        .eq("flow_token_ref", flowTokenRef)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return error ? null : data;
    },
    async save(draft, expectedVersion) {
      const { data, error } = await client
        .from("kadi_invoice_flow_drafts")
        .update(draft)
        .eq("draft_id", draft.draft_id)
        .eq("version", expectedVersion)
        .select()
        .maybeSingle();
      if (error) return { ok: false, error: "DRAFT_SAVE_FAILED" };
      return data ? { ok: true, value: data } : { ok: false, error: "DRAFT_VERSION_CONFLICT" };
    },
  });
}

module.exports = {
  createInMemoryInvoiceDraftRepository,
  createSupabaseInvoiceDraftRepository,
};
