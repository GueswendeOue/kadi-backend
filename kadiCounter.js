// kadiCounter.js
"use strict";

const { supabase } = require("./supabaseClient");

/**
 * Pad numérique
 * ex: pad(1) => 0001
 */
function pad(n, size = 4) {
  const s = String(n);
  return s.length >= size ? s : "0".repeat(size - s.length) + s;
}

/**
 * Mois FR (codes courts, cohérents compta)
 */
function monthCodeFR(monthIndex1to12) {
  const arr = ["JAN", "FEV", "MAR", "AVR", "MAI", "JUN", "JUL", "AOU", "SEP", "OCT", "NOV", "DEC"];
  return arr[(monthIndex1to12 - 1) % 12] || "UNK";
}

/**
 * Préfixe de base selon type de document
 */
function basePrefixForMode(mode, factureKind) {
  const m = String(mode || "").toLowerCase();

  if (m === "devis") return "DEV";
  if (m === "recu" || m === "reçu") return "RCU";

  if (m === "facture") {
    return factureKind === "proforma" ? "PRO" : "FAC";
  }

  // ✅ NOUVEAU : décharge
  if (m === "decharge" || m === "décharge") return "DCH";

  return "DOC";
}

/**
 * Parse date ISO YYYY-MM-DD
 */
function parseDateISO(dateISO) {
  const s = String(dateISO || "").trim();
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(s);
  return ok ? new Date(`${s}T00:00:00Z`) : new Date();
}

/**
 * Préfixe final
 * ex: FAC-2026-JAN
 */
function prefixFor(mode, factureKind, dateISO) {
  const d = parseDateISO(dateISO);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const monthCode = monthCodeFR(month);
  const base = basePrefixForMode(mode, factureKind);
  return `${base}-${year}-${monthCode}`;
}

/**
 * Numéro de document suivant
 * ex: FAC-2026-JAN-0001
 *
 * Requiert la RPC Supabase:
 * kadi_next_doc_number(p_wa_id, p_prefix)
 */
async function nextDocNumber({ waId, mode, factureKind = null, dateISO }) {
  const wa = String(waId || "").trim();
  if (!wa) throw new Error("waId manquant");

  const pfx = prefixFor(mode, factureKind, dateISO);

  const { data, error } = await supabase.rpc("kadi_next_doc_number", {
    p_wa_id: wa,
    p_prefix: pfx,
  });

  if (error) throw error;

  // cas standard (RPC retourne directement la string)
  if (typeof data === "string") return data;

  // fallback si RPC évolue
  if (data && data.doc_number) return data.doc_number;

  const n = Number(data?.next_number || 1);
  return `${pfx}-${pad(n)}`;
}

module.exports = {
  nextDocNumber,
  prefixFor,
  basePrefixForMode,
  monthCodeFR,
};