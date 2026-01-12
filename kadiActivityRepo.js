// kadiActivityRepo.js
"use strict";

const { supabase } = require("./supabaseClient");

/**
 * Enregistre l'activité user (wa_id) de manière atomique via RPC.
 * - crée l'user si absent
 * - incrémente messages_count
 * - met à jour last_seen
 */
async function recordActivity(waId) {
  const w = String(waId || "").trim();
  if (!w) return;

  const { error } = await supabase.rpc("kadi_record_activity", { p_wa_id: w });
  if (error) throw error;
}

/**
 * Statistiques Users basées sur kadi_activity (pas seulement documents)
 */
async function getUsersStats() {
  const { count: totalUsers, error: e1 } = await supabase
    .from("kadi_activity")
    .select("*", { count: "exact", head: true });

  if (e1) throw e1;

  const since7 = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  const { count: active7, error: e2 } = await supabase
    .from("kadi_activity")
    .select("*", { count: "exact", head: true })
    .gte("last_seen", since7);

  if (e2) throw e2;

  const { count: active30, error: e3 } = await supabase
    .from("kadi_activity")
    .select("*", { count: "exact", head: true })
    .gte("last_seen", since30);

  if (e3) throw e3;

  return {
    totalUsers: totalUsers || 0,
    active7: active7 || 0,
    active30: active30 || 0,
  };
}

module.exports = {
  recordActivity,
  getUsersStats,
};