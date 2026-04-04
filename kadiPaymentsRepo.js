"use strict";

const { supabase } = require("./supabaseClient");

async function createTopup(payload) {
  const { data, error } = await supabase
    .from("kadi_topups")
    .insert(payload)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function getTopupById(id) {
  const { data, error } = await supabase
    .from("kadi_topups")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function updateTopup(id, patch) {
  const { data, error } = await supabase
    .from("kadi_topups")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function getPendingTopupByWaId(waId) {
  const { data, error } = await supabase
    .from("kadi_topups")
    .select("*")
    .eq("wa_id", waId)
    .in("status", ["pending", "pending_review"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

module.exports = {
  createTopup,
  getTopupById,
  updateTopup,
  getPendingTopupByWaId,
};