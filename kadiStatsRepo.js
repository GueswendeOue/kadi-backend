// kadiStatsRepo.js
"use strict";

const { supabase } = require("./supabaseClient");

/**
 * RPC: kadi_stats(p_days7 int, p_days30 int) -> jsonb
 */
async function getKadiStats({ days7 = 7, days30 = 30 } = {}) {
  const { data, error } = await supabase.rpc("kadi_stats", {
    p_days7: Number(days7) || 7,
    p_days30: Number(days30) || 30,
  });
  if (error) throw error;
  return data; // jsonb
}

/**
 * RPC: kadi_top_clients(p_days int, p_limit int) -> table
 */
async function getTopClients({ days = 30, limit = 5 } = {}) {
  const { data, error } = await supabase.rpc("kadi_top_clients", {
    p_days: Number(days) || 30,
    p_limit: Number(limit) || 5,
  });
  if (error) throw error;
  return data || [];
}

/**
 * Trace activité (table: kadi_activity)
 */
async function recordActivity({ waId, event, meta = null }) {
  if (!waId || !event) return;
  const payload = {
    wa_id: String(waId),
    event: String(event),
    meta: meta ? meta : null,
  };
  const { error } = await supabase.from("kadi_activity").insert(payload);
  if (error) {
    // on ne casse jamais le bot pour l’analytics
    console.warn("recordActivity warn:", error.message);
  }
}

module.exports = {
  getKadiStats,
  getTopClients,
  recordActivity,
};