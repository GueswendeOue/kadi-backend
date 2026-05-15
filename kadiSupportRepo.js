"use strict";

const { supabase } = require("./supabaseClient");

function safeText(value = "", maxLen = null) {
  let out = String(value || "").trim();
  if (Number.isFinite(maxLen) && maxLen > 0) out = out.slice(0, maxLen);
  return out;
}

function normalizeWaId(value = "") {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 8) digits = `226${digits}`;
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

function nowIso() {
  return new Date().toISOString();
}

async function getOpenSupportSession(waId) {
  const id = normalizeWaId(waId);
  if (!id) return null;

  const { data, error } = await supabase
    .from("kadi_support_sessions")
    .select("*")
    .eq("wa_id", id)
    .eq("status", "open")
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function openSupportSession({ waId, reason = null, lastUserMessage = null }) {
  const id = normalizeWaId(waId);
  if (!id) throw new Error("wa_id invalide");

  const existing = await getOpenSupportSession(id);
  const ts = nowIso();

  if (existing?.id) {
    const { data, error } = await supabase
      .from("kadi_support_sessions")
      .update({
        reason: safeText(reason, 120) || existing.reason || null,
        last_user_message:
          safeText(lastUserMessage, 1000) || existing.last_user_message || null,
        updated_at: ts,
      })
      .eq("id", existing.id)
      .select("*")
      .single();

    if (error) throw error;
    return { session: data, created: false };
  }

  const { data, error } = await supabase
    .from("kadi_support_sessions")
    .insert({
      wa_id: id,
      status: "open",
      reason: safeText(reason, 120) || null,
      last_user_message: safeText(lastUserMessage, 1000) || null,
      opened_at: ts,
      created_at: ts,
      updated_at: ts,
    })
    .select("*")
    .single();

  if (error) throw error;
  return { session: data, created: true };
}

async function updateOpenSupportSessionMessage(waId, lastUserMessage) {
  const existing = await getOpenSupportSession(waId);
  if (!existing?.id) return null;

  const { data, error } = await supabase
    .from("kadi_support_sessions")
    .update({
      last_user_message: safeText(lastUserMessage, 1000) || null,
      updated_at: nowIso(),
    })
    .eq("id", existing.id)
    .select("*")
    .single();

  if (error) throw error;
  return data || null;
}

async function closeSupportSession(waId, closedBy = null) {
  const existing = await getOpenSupportSession(waId);
  if (!existing?.id) return null;

  const ts = nowIso();
  const { data, error } = await supabase
    .from("kadi_support_sessions")
    .update({
      status: "closed",
      closed_at: ts,
      closed_by: normalizeWaId(closedBy) || safeText(closedBy, 80) || null,
      updated_at: ts,
    })
    .eq("id", existing.id)
    .select("*")
    .single();

  if (error) throw error;
  return data || null;
}

async function getSupportSessionStatus(waId) {
  const id = normalizeWaId(waId);
  if (!id) return null;

  const { data, error } = await supabase
    .from("kadi_support_sessions")
    .select("*")
    .eq("wa_id", id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function listOpenSupportSessions(limit = 20) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const { data, error } = await supabase
    .from("kadi_support_sessions")
    .select("*")
    .eq("status", "open")
    .order("opened_at", { ascending: true })
    .limit(safeLimit);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function listActiveSupportAgents() {
  const { data, error } = await supabase
    .from("kadi_support_agents")
    .select("*")
    .eq("is_active", true)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function addSupportAgent({ waId, name, role = "support", priority = 100 }) {
  const id = normalizeWaId(waId);
  if (!id) throw new Error("wa_id invalide");

  const ts = nowIso();
  const { data, error } = await supabase
    .from("kadi_support_agents")
    .upsert(
      {
        wa_id: id,
        name: safeText(name, 120) || id,
        role: safeText(role, 60) || "support",
        is_active: true,
        priority: Number.isFinite(Number(priority)) ? Number(priority) : 100,
        updated_at: ts,
      },
      { onConflict: "wa_id" }
    )
    .select("*")
    .single();

  if (error) throw error;
  return data || null;
}

async function disableSupportAgent(waId) {
  const id = normalizeWaId(waId);
  if (!id) throw new Error("wa_id invalide");

  const { data, error } = await supabase
    .from("kadi_support_agents")
    .update({ is_active: false, updated_at: nowIso() })
    .eq("wa_id", id)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

module.exports = {
  normalizeWaId,
  getOpenSupportSession,
  openSupportSession,
  updateOpenSupportSessionMessage,
  closeSupportSession,
  getSupportSessionStatus,
  listOpenSupportSessions,
  listActiveSupportAgents,
  addSupportAgent,
  disableSupportAgent,
};
