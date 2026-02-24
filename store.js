// store.js
"use strict";
const { supabase } = require("./supabaseClient");

async function getOrCreateProfile(waId) {
  const { data, error } = await supabase
    .from("business_profiles")
    .select("*")
    .eq("wa_id", waId)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    const { data: created, error: e2 } = await supabase
      .from("business_profiles")
      .insert([
        {
          wa_id: waId,
          welcome_credits_granted: false,
          onboarding_done: false,
          onboarding_version: 1,
        },
      ])
      .select("*")
      .single();

    if (e2) throw e2;
    return created;
  }

  return data;
}

async function updateProfile(waId, patch) {
  const cleanPatch = Object.fromEntries(
    Object.entries(patch || {}).filter(([, v]) => v !== undefined)
  );

  const { data, error } = await supabase
    .from("business_profiles")
    .update(cleanPatch)
    .eq("wa_id", waId)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function markOnboardingDone(waId, version = 1) {
  try {
    return await updateProfile(waId, {
      onboarding_done: true,
      onboarding_version: Number(version) || 1,
    });
  } catch (_) {
    return null;
  }
}

module.exports = {
  getOrCreateProfile,
  updateProfile,
  markOnboardingDone,
};