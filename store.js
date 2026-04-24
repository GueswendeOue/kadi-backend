"use strict";

const { supabase } = require("./supabaseClient");

const LOGO_BUCKET = process.env.SUPABASE_LOGO_BUCKET || "logos";

function cleanPatchObject(patch) {
  return Object.fromEntries(
    Object.entries(patch || {}).filter(([, v]) => v !== undefined)
  );
}

function safeText(value = "") {
  return String(value || "").trim();
}

function guessLogoExtension(mimeType = "") {
  const t = String(mimeType || "").toLowerCase();

  if (t.includes("png")) return "png";
  if (t.includes("webp")) return "webp";
  if (t.includes("jpg") || t.includes("jpeg")) return "jpg";
  if (t.includes("svg")) return "svg";

  return "jpg";
}

async function safeReadArrayBuffer(response) {
  try {
    return await response.arrayBuffer();
  } catch {
    return null;
  }
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

  if (!profileId) throw new Error("updateProfileById requires profileId");
  if (!Object.keys(cleanPatch).length) {
    throw new Error("updateProfileById requires non-empty patch");
  }

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

  if (!waId) throw new Error("updateProfile requires waId");
  if (!Object.keys(cleanPatch).length) {
    throw new Error("updateProfile requires non-empty patch");
  }

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

  if (!Object.keys(cleanPatch).length) {
    throw new Error("updateProfileByIdentity requires non-empty patch");
  }

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

async function uploadLogoBuffer({
  waId,
  buffer,
  mimeType = "image/jpeg",
  fileName = null,
  upsert = true,
}) {
  if (!waId) throw new Error("uploadLogoBuffer requires waId");

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("uploadLogoBuffer requires a non-empty buffer");
  }

  const ext = guessLogoExtension(mimeType);
  const finalName = safeText(fileName) || `logo-${Date.now()}.${ext}`;
  const filePath = `${waId}/${finalName}`;

  const { error } = await supabase.storage
    .from(LOGO_BUCKET)
    .upload(filePath, buffer, {
      contentType: mimeType,
      upsert,
    });

  if (error) throw error;

  return {
    bucket: LOGO_BUCKET,
    filePath,
  };
}

async function getSignedLogoUrl(filePath, expiresInSeconds = 3600) {
  if (!safeText(filePath)) {
    throw new Error("getSignedLogoUrl requires filePath");
  }

  const { data, error } = await supabase.storage
    .from(LOGO_BUCKET)
    .createSignedUrl(filePath, expiresInSeconds);

  if (error) throw error;

  const signedUrl = data?.signedUrl;
  if (!signedUrl) {
    throw new Error("SIGNED_LOGO_URL_NOT_FOUND");
  }

  return signedUrl;
}

async function downloadSignedUrlToBuffer(url) {
  if (!safeText(url)) {
    throw new Error("downloadSignedUrlToBuffer requires url");
  }

  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `SIGNED_URL_DOWNLOAD_FAILED (${response.status}): ${
        body || response.statusText
      }`
    );
  }

  const arrayBuffer = await safeReadArrayBuffer(response);

  if (!arrayBuffer) {
    throw new Error("SIGNED_URL_BUFFER_READ_FAILED");
  }

  return Buffer.from(arrayBuffer);
}

async function deleteLogo(filePath) {
  if (!safeText(filePath)) return true;

  const { error } = await supabase.storage
    .from(LOGO_BUCKET)
    .remove([filePath]);

  if (error) throw error;
  return true;
}

async function saveProfileLogoFromBuffer({
  waId,
  buffer,
  mimeType = "image/jpeg",
  fileName = null,
}) {
  if (!waId) throw new Error("saveProfileLogoFromBuffer requires waId");

  const existing = await getProfileByWaId(waId);

  if (!existing) {
    await createProfile({ waId });
  }

  const upload = await uploadLogoBuffer({
    waId,
    buffer,
    mimeType,
    fileName,
    upsert: true,
  });

  const updated = await updateProfile(waId, {
    logo_path: upload.filePath,
  });

  if (existing?.logo_path && existing.logo_path !== upload.filePath) {
    try {
      await deleteLogo(existing.logo_path);
    } catch (e) {
      console.warn("[STORE/LOGO] old logo cleanup failed:", e?.message || e);
    }
  }

  return updated;
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
  uploadLogoBuffer,
  getSignedLogoUrl,
  downloadSignedUrlToBuffer,
  deleteLogo,
  saveProfileLogoFromBuffer,
  markOnboardingDone,
};