"use strict";

const { supabase } = require("./supabaseClient");

// réutilise ta logique: wa_id OU user_id
const _ID_COL_CACHE = new Map();

async function detectIdCol(table) {
  if (_ID_COL_CACHE.has(table)) return _ID_COL_CACHE.get(table);

  const candidates = ["wa_id", "user_id"];
  for (const col of candidates) {
    const { error } = await supabase.from(table).select(col, { head: true, count: "exact" });
    if (!error) {
      _ID_COL_CACHE.set(table, col);
      return col;
    }
  }
  _ID_COL_CACHE.set(table, "user_id");
  return "user_id";
}

/**
 * Tous ceux qui ont déjà écrit (kadi_activity) - distinct wa_id/user_id
 * Exclut ceux qui ont broadcast_optout=true dans business_profiles (si champ existe)
 */
async function getBroadcastRecipients({ limit = 5000 } = {}) {
  const idColAct = await detectIdCol("kadi_activity");
  const idColBp = await detectIdCol("business_profiles");

  // 1) récupère activity
  const { data: act, error: e1 } = await supabase
    .from("kadi_activity")
    .select(`${idColAct}`)
    .limit(limit);

  if (e1) throw e1;

  const ids = new Set();
  for (const r of act || []) {
    const v = r?.[idColAct];
    if (v) ids.add(String(v));
  }

  // 2) filtre opt-out si champ présent
  // On tente un select, si erreur => pas de champ => on ignore
  const arr = Array.from(ids);
  if (!arr.length) return [];

  const { data: bps, error: e2 } = await supabase
    .from("business_profiles")
    .select(`${idColBp},broadcast_optout`)
    .in(idColBp, arr);

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

  // si pas de champ broadcast_optout => retourne tout
  return arr;
}

module.exports = { getBroadcastRecipients };