"use strict";

const axios = require("axios");
const { supabase } = require("./supabaseClient");

const BUCKET = process.env.SUPABASE_BUCKET_LOGOS || "kadi-logos";
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

async function uploadAnyBuffer({ userId, buffer, mimeType, filename }) {
  ensureBuffer(buffer);
  const ext = extFromMime(mimeType);
  const filePath = `${userId}/${filename}.${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(filePath, buffer, {
      contentType: mimeType || "image/jpeg",
      upsert: true,
    });

  if (error) throw error;
  return { filePath };
}

// --- Logo ---
async function uploadLogoBuffer({ userId, buffer, mimeType }) {
  return uploadAnyBuffer({ userId, buffer, mimeType, filename: "logo" });
}

// --- Signature ---
async function uploadSignatureBuffer({ userId, buffer, mimeType }) {
  // On force png si c’est une image (sinon jpg ok)
  return uploadAnyBuffer({ userId, buffer, mimeType: mimeType || "image/png", filename: "signature" });
}

// --- Tampon ---
async function uploadStampBuffer({ userId, buffer }) {
  // Tampon est généré en PNG, on garde png
  return uploadAnyBuffer({ userId, buffer, mimeType: "image/png", filename: "stamp" });
}

// Signed URL générique
async function getSignedUrl(filePath) {
  if (!filePath) return null;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(filePath, TTL);

  if (error) throw error;
  return data?.signedUrl || null;
}

// Compat (ancien nom)
async function getSignedLogoUrl(logoPath) {
  return getSignedUrl(logoPath);
}

async function downloadSignedUrlToBuffer(signedUrl) {
  if (!signedUrl) return null;
  const resp = await axios.get(signedUrl, { responseType: "arraybuffer", timeout: 30000 });
  return Buffer.from(resp.data);
}

module.exports = {
  // uploads
  uploadLogoBuffer,
  uploadSignatureBuffer,
  uploadStampBuffer,

  // signed urls
  getSignedUrl,
  getSignedLogoUrl, // compat

  // download
  downloadSignedUrlToBuffer,
};