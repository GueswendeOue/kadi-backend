// store.js
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
      .insert([
        {
          user_id: userId,
          welcome_credits_granted: false,
          onboarding_done: false,
          onboarding_version: 1,

          // ✅ si colonnes existent, ça passera; sinon Supabase ignorera pas -> donc on ne met pas ici.
          // stamp_paid: false,
        },
      ])
      .select("*")
      .single();

    if (e2) throw e2;
    return created;
  }

  return data;
}

async function updateProfile(userId, patch) {
  const cleanPatch = Object.fromEntries(
    Object.entries(patch || {}).filter(([, v]) => v !== undefined)
  );

  const { data, error } = await supabase
    .from("business_profiles")
    .update(cleanPatch)
    .eq("user_id", userId)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

/**
 * ✅ NEW: Onboarding flag helper
 */
async function markOnboardingDone(userId, version = 1) {
  try {
    return await updateProfile(userId, {
      onboarding_done: true,
      onboarding_version: Number(version) || 1,
    });
  } catch (e) {
    return null;
  }
}

/**
 * ✅ NEW: Profil "suffisant" pour personnaliser un PDF
 */
function isProfileBasicComplete(p) {
  if (!p) return false;
  const hasName = String(p.business_name || "").trim().length > 0;
  const hasPhoneOrEmail =
    String(p.phone || "").trim().length > 0 || String(p.email || "").trim().length > 0;
  return hasName && hasPhoneOrEmail;
}

/**
 * ✅ NEW: helpers paiement tampon (paiement unique)
 */
function isStampPaid(profile) {
  return profile?.stamp_paid === true;
}

async function markStampPaid(userId, plan = "stamp_logo") {
  // plan est optionnel (si tu ajoutes stamp_paid_plan en DB)
  const patch = {
    stamp_paid: true,
    stamp_paid_at: new Date().toISOString(),
  };

  // si tu as créé la colonne stamp_paid_plan, tu peux décommenter :
  // patch.stamp_paid_plan = String(plan || "stamp_logo");

  return updateProfile(userId, patch);
}

module.exports = {
  getOrCreateProfile,
  updateProfile,
  markOnboardingDone,
  isProfileBasicComplete,

  // ✅ new exports
  isStampPaid,
  markStampPaid,
};