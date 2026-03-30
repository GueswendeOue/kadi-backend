"use strict";

const { supabase } = require("./supabaseClient");

function cleanPatchObject(patch) {
  return Object.fromEntries(
    Object.entries(patch || {}).filter(([, v]) => v !== undefined)
  );
}

async function getProfileByWaId(waId) {
  if (!waId) return null;

  const { data, error } = await supabase
    .from("business_profiles")
    .select("*")
    .eq("wa_id", waId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getProfileByBsuid(bsuid) {
  if (!bsuid) return null;

  const { data, error } = await supabase
    .from("business_profiles")
    .select("*")
    .eq("bsuid", bsuid)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function createProfile({
  waId = null,
  bsuid = null,
  parentBsuid = null,
  whatsappUsername = null,
  ownerName = null,
} = {}) {
  const payload = {
    wa_id: waId,
    bsuid,
    parent_bsuid: parentBsuid,
    whatsapp_username: whatsappUsername,
    owner_name: ownerName,
    welcome_credits_granted: false,
    onboarding_done: false,
    onboarding_version: 1,
  };

  const { data, error } = await supabase
    .from("business_profiles")
    .insert([payload])
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function getOrCreateProfile(waId, meta = {}) {
  const bsuid = meta?.bsuid || null;
  const parentBsuid = meta?.parentBsuid || null;
  const whatsappUsername = meta?.username || null;
  const ownerName = meta?.profileName || null;

  let profile = null;

  if (bsuid) {
    profile = await getProfileByBsuid(bsuid);
  }

  if (!profile && waId) {
    profile = await getProfileByWaId(waId);
  }

  if (!profile) {
    return await createProfile({
      waId,
      bsuid,
      parentBsuid,
      whatsappUsername,
      ownerName,
    });
  }

  const patch = {};

  if (waId && profile.wa_id !== waId) patch.wa_id = waId;
  if (bsuid && profile.bsuid !== bsuid) patch.bsuid = bsuid;
  if (parentBsuid && profile.parent_bsuid !== parentBsuid) {
    patch.parent_bsuid = parentBsuid;
  }
  if (whatsappUsername && profile.whatsapp_username !== whatsappUsername) {
    patch.whatsapp_username = whatsappUsername;
  }
  if (ownerName && !profile.owner_name) {
    patch.owner_name = ownerName;
  }

  if (Object.keys(patch).length) {
    profile = await updateProfileById(profile.id, patch);
  }

  return profile;
}

async function updateProfileById(profileId, patch) {
  const cleanPatch = cleanPatchObject(patch);

  const { data, error } = await supabase
    .from("business_profiles")
    .update(cleanPatch)
    .eq("id", profileId)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function updateProfile(waId, patch) {
  const cleanPatch = cleanPatchObject(patch);

  const { data, error } = await supabase
    .from("business_profiles")
    .update(cleanPatch)
    .eq("wa_id", waId)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function updateProfileByIdentity({ waId = null, bsuid = null }, patch) {
  const cleanPatch = cleanPatchObject(patch);

  if (bsuid) {
    const { data, error } = await supabase
      .from("business_profiles")
      .update(cleanPatch)
      .eq("bsuid", bsuid)
      .select("*")
      .maybeSingle();

    if (error) throw error;
    if (data) return data;
  }

  if (waId) {
    const { data, error } = await supabase
      .from("business_profiles")
      .update(cleanPatch)
      .eq("wa_id", waId)
      .select("*")
      .single();

    if (error) throw error;
    return data;
  }

  throw new Error("updateProfileByIdentity requires waId or bsuid");
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
  getProfileByWaId,
  getProfileByBsuid,
  createProfile,
  getOrCreateProfile,
  updateProfile,
  updateProfileById,
  updateProfileByIdentity,
  markOnboardingDone,
};