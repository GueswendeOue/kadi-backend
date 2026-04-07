"use strict";

function safe(v, maxLen = null) {
  let out = String(v ?? "").trim();

  if (typeof maxLen === "number" && maxLen > 0) {
    out = out.slice(0, maxLen);
  }

  return out;
}

/**
 * Normalisation forte pour commandes / matching.
 * Ex:
 *  " Menu " -> "menu"
 *  "Crédits" -> "credits"
 *  "  BONJOUR   " -> "bonjour"
 */
function norm(v) {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Normalisation douce pour texte utilisateur.
 * Garde la casse d'origine, nettoie juste les espaces.
 */
function normalizeText(v) {
  return String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function isValidWhatsAppId(id) {
  const s = String(id ?? "").trim();
  return /^\d{8,15}$/.test(s);
}

function isValidEmail(email) {
  const s = String(email ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function formatDateISO(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);

  if (Number.isNaN(d.getTime())) {
    const fallback = new Date();
    const yyyy = fallback.getFullYear();
    const mm = String(fallback.getMonth() + 1).padStart(2, "0");
    const dd = String(fallback.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function sleep(ms) {
  const delay = Number(ms);
  return new Promise((resolve) =>
    setTimeout(resolve, Number.isFinite(delay) && delay > 0 ? delay : 0)
  );
}

function parseDaysArg(text, defDays = 7) {
  const s = String(text ?? "").trim();
  const m = s.match(/(?:\s+)(\d{1,3})\b/);

  if (!m) return defDays;

  const d = Number(m[1]);
  if (!Number.isFinite(d) || d <= 0) return defDays;

  return Math.min(d, 365);
}

function guessExtFromMime(mime) {
  const t = String(mime ?? "").toLowerCase();

  if (t.includes("png")) return "png";
  if (t.includes("webp")) return "webp";
  if (t.includes("gif")) return "gif";
  if (t.includes("pdf")) return "pdf";
  if (t.includes("heic")) return "heic";
  if (t.includes("heif")) return "heif";

  return "jpg";
}

function guessAudioExtFromMime(mime) {
  const t = String(mime ?? "").toLowerCase();

  if (t.includes("ogg")) return "ogg";
  if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
  if (t.includes("wav")) return "wav";
  if (t.includes("webm")) return "webm";
  if (t.includes("mp4") || t.includes("m4a")) return "m4a";

  return "ogg";
}

function cleanPhoneLike(value) {
  return String(value ?? "").replace(/[^\d+]/g, "").trim();
}

function truncate(value, maxLen = 120) {
  const s = String(value ?? "");
  if (!Number.isFinite(maxLen) || maxLen <= 0) return "";
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function resetAdminBroadcastState(session) {
  if (!session || typeof session !== "object") return;

  session.adminPendingAction = null;
  session.broadcastCaption = null;
  session.broadcastMediaId = null;
  session.broadcastMediaMimeType = null;
  session.broadcastMediaFilename = null;
}

module.exports = {
  safe,
  norm,
  normalizeText,
  isValidWhatsAppId,
  isValidEmail,
  formatDateISO,
  sleep,
  parseDaysArg,
  guessExtFromMime,
  guessAudioExtFromMime,
  cleanPhoneLike,
  truncate,
  resetAdminBroadcastState,
};