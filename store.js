"use strict";

const { supabase } = require("./supabaseClient");

async function getOrCreateProfile(userId) {
  const { data, error } = await supabase
    .from("business_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    const { data: created, error: e2 } = await supabase
      .from("business_profiles")
      .insert([{ user_id: userId }])
      .select("*")
      .single();
    if (e2) throw e2;
    return created;
  }

  return data;
}

async function updateProfile(userId, patch) {
  const { data, error } = await supabase
    .from("business_profiles")
    .update(patch)
    .eq("user_id", userId)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

module.exports = { getOrCreateProfile, updateProfile };