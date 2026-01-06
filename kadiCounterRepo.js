"use strict";

const { supabase } = require("./supabaseClient");

function basePrefixForMode(mode) {
  const m = String(mode || "").toLowerCase();
  if (m === "devis") return "DEV";
  if (m === "facture") return "FAC";
  if (m === "recu" || m === "reçu") return "RCU";
  return "DOC";
}

function yearFromDateISO(dateISO) {
  // dateISO attendu: "YYYY-MM-DD"
  const y = String(dateISO || "").slice(0, 4);
  return /^\d{4}$/.test(y) ? y : String(new Date().getFullYear());
}

function prefixForModeAndYear(mode, dateISO) {
  const base = basePrefixForMode(mode);
  const year = yearFromDateISO(dateISO);
  return `${base}-${year}`; // ex: "FAC-2026"
}

async function nextDocNumber({ waId, mode, dateISO }) {
  const prefix = prefixForModeAndYear(mode, dateISO);

  const { data, error } = await supabase.rpc("kadi_next_doc_number", {
    p_wa_id: waId,
    p_prefix: prefix
  });

  if (error) throw error;
  // data ex: "FAC-2026-0001"
  return data;
}

module.exports = {
  nextDocNumber,
  basePrefixForMode,
  prefixForModeAndYear,
  yearFromDateISO
};