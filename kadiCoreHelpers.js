"use strict";

function money(v) {
  const n = Number(v || 0);
  return new Intl.NumberFormat("fr-FR").format(n);
}

function ensureAdmin(identityInput) {
  const raw =
    typeof identityInput === "string"
      ? identityInput
      : identityInput?.wa_id ||
        identityInput?.waId ||
        identityInput?.from ||
        "";

  const from = String(raw || "").trim();
  const adminWaId = String(process.env.ADMIN_WA_ID || "").trim();

  return !!from && !!adminWaId && from === adminWaId;
}

function parseNumberSmart(input) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return null;

  let s = raw.replace(/\s/g, "").replace(/fcfa/g, "").replace(/f$/g, "");
  let multiplier = 1;

  if (s.endsWith("k")) {
    multiplier = 1000;
    s = s.slice(0, -1);
  } else if (s.endsWith("m")) {
    multiplier = 1000000;
    s = s.slice(0, -1);
  }

  s = s.replace(/,/g, ".");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;

  return Math.round(n * multiplier);
}

module.exports = {
  money,
  ensureAdmin,
  parseNumberSmart,
};