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

module.exports = {
  createTopup,
  getTopupById,
  updateTopup,
};