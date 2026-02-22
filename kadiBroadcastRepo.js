// kadiBroadcastRepo.js
"use strict";

const { supabase } = require("./supabaseClient");

// Cache la colonne ID détectée par table
const _ID_COL_CACHE = new Map();

async function detectIdCol(table) {
  if (_ID_COL_CACHE.has(table)) return _ID_COL_CACHE.get(table);

  // On tente wa_id puis user_id
  const candidates = ["wa_id", "user_id"];
  for (const col of candidates) {
    const { error } = await supabase.from(table).select(col, { head: true, count: "exact" });
    if (!error) {
      _ID_COL_CACHE.set(table, col);
      return col;
    }
  }

  // fallback
  _ID_COL_CACHE.set(table, "user_id");
  return "user_id";
}

/**
 * Retourne la liste WA IDs à broadcast
 * - base: distinct IDs dans kadi_activity
 * - filtre: business_profiles.broadcast_optout=true (si champ existe)
 */
async function getBroadcastRecipients({ limit = 5000 } = {}) {
  const idColAct = await detectIdCol("kadi_activity");
  const idColBp = await detectIdCol("business_profiles");

  // 1) activity
  const { data: act, error: e1 } = await supabase.from("kadi_activity").select(`${idColAct}`).limit(limit);
  if (e1) throw e1;

  const ids = new Set();
  for (const r of act || []) {
    const v = r?.[idColAct];
    if (v) ids.add(String(v));
  }

  const arr = Array.from(ids);
  if (!arr.length) return [];

  // 2) filtre opt-out si colonne existe
  const { data: bps, error: e2 } = await supabase
    .from("business_profiles")
    .select(`${idColBp},broadcast_optout`)
    .in(idColBp, arr);

  // si pas d'erreur et champ existe => filtre
  if (!e2 && Array.isArray(bps)) {
    const ok = [];
    for (const r of bps) {
      const id = r?.[idColBp];
      if (!id) continue;
      if (r.broadcast_optout === true) continue;
      ok.push(String(id));
    }
    return ok;
  }

  // sinon retourne tout
  return arr;
}

module.exports = { getBroadcastRecipients };