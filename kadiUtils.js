"use strict";

function safe(v) {
  return String(v || "").trim();
}

function norm(v) {
  return String(v || "").trim();
}

function isValidWhatsAppId(id) {
  return /^\d+$/.test(id) && id.length >= 8 && id.length <= 15;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
}

function formatDateISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDaysArg(text, defDays) {
  const m = String(text || "").trim().match(/(?:\s+)(\d{1,3})\b/);
  if (!m) return defDays;

  const d = Number(m[1]);
  if (!Number.isFinite(d) || d <= 0) return defDays;

  return Math.min(d, 365);
}

function guessExtFromMime(mime) {
  const t = String(mime || "").toLowerCase();
  if (t.includes("png")) return "png";
  if (t.includes("webp")) return "webp";
  if (t.includes("gif")) return "gif";
  return "jpg";
}

function resetAdminBroadcastState(session) {
  if (!session) return;
  session.adminPendingAction = null;
  session.broadcastCaption = null;
}

module.exports = {
  safe,
  norm,
  isValidWhatsAppId,
  isValidEmail,
  formatDateISO,
  sleep,
  parseDaysArg,
  guessExtFromMime,
  resetAdminBroadcastState,
};