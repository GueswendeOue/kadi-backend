"use strict";

const axios = require("axios");
const { supabase } = require("./supabaseClient");

const LOGO_BUCKET = process.env.SUPABASE_BUCKET_LOGOS || "kadi-logos";
const CAMPAIGN_BUCKET = process.env.SUPABASE_BUCKET_CAMPAIGNS || "campaigns";
const TTL = Number(process.env.SUPABASE_LOGO_SIGNED_URL_TTL || 604800); // 7 jours

function extFromMime(mime) {
  if (!mime) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  return "jpg";
}

function ensureBuffer(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) throw new Error("buffer invalide");
}

async function uploadAnyBuffer({ bucket, userId, buffer, mimeType, filename }) {
  ensureBuffer(buffer);
  const ext = extFromMime(mimeType);
  const filePath = userId ? `${userId}/${filename}.${ext}` : `${filename}.${ext}`;

  const { error } = await supabase.storage
    .from(bucket)
    .upload(filePath, buffer, {
      contentType: mimeType || "image/jpeg",
      upsert: true,
    });

  if (error) throw error;
  return { filePath };
}

// --- Logo ---
async function uploadLogoBuffer({ userId, buffer, mimeType }) {
  return uploadAnyBuffer({
    bucket: LOGO_BUCKET,
    userId,
    buffer,
    mimeType,
    filename: "logo",
  });
}

// --- Signature ---
async function uploadSignatureBuffer({ userId, buffer, mimeType }) {
  return uploadAnyBuffer({
    bucket: LOGO_BUCKET,
    userId,
    buffer,
    mimeType: mimeType || "image/png",
    filename: "signature",
  });
}

// --- Tampon ---
async function uploadStampBuffer({ userId, buffer }) {
  return uploadAnyBuffer({
    bucket: LOGO_BUCKET,
    userId,
    buffer,
    mimeType: "image/png",
    filename: "stamp",
  });
}

// --- Campaign image ---
async function uploadCampaignImageBuffer({ buffer, mimeType, filename }) {
  return uploadAnyBuffer({
    bucket: CAMPAIGN_BUCKET,
    userId: null,
    buffer,
    mimeType: mimeType || "image/jpeg",
    filename: filename || `campaign-${Date.now()}`,
  });
}

// Signed URL générique
async function getSignedUrl(filePath, bucket = LOGO_BUCKET) {
  if (!filePath) return null;

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(filePath, TTL);

  if (error) throw error;
  return data?.signedUrl || null;
}

// Compat logo
async function getSignedLogoUrl(logoPath) {
  return getSignedUrl(logoPath, LOGO_BUCKET);
}

// Campaign signed URL
async function getSignedCampaignUrl(filePath) {
  return getSignedUrl(filePath, CAMPAIGN_BUCKET);
}

async function downloadSignedUrlToBuffer(signedUrl) {
  if (!signedUrl) return null;
  const resp = await axios.get(signedUrl, { responseType: "arraybuffer", timeout: 30000 });
  return Buffer.from(resp.data);
}

module.exports = {
  uploadLogoBuffer,
  uploadSignatureBuffer,
  uploadStampBuffer,
  uploadCampaignImageBuffer,
  getSignedUrl,
  getSignedLogoUrl,
  getSignedCampaignUrl,
  downloadSignedUrlToBuffer,
};