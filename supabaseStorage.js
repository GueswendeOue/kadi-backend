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

async function uploadLogoBuffer({ userId, buffer, mimeType }) {
  const ext = extFromMime(mimeType);
  const filePath = `${userId}/logo.${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(filePath, buffer, {
      contentType: mimeType || "image/jpeg",
      upsert: true,
    });

  if (error) throw error;
  return { filePath };
}

async function getSignedLogoUrl(logoPath) {
  if (!logoPath) return null;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(logoPath, TTL);

  if (error) throw error;
  return data?.signedUrl || null;
}

async function downloadSignedUrlToBuffer(signedUrl) {
  if (!signedUrl) return null;
  const resp = await axios.get(signedUrl, { responseType: "arraybuffer", timeout: 30000 });
  return Buffer.from(resp.data);
}

module.exports = {
  uploadLogoBuffer,
  getSignedLogoUrl,
  downloadSignedUrlToBuffer,
};