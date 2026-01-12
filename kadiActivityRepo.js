// kadiActivityRepo.js
"use strict";

const { supabase } = require("./supabaseClient");

/**
 * Enregistre une activité simple pour calculer "Actifs 7j/30j"
 * Table: kadi_activity( id, wa_id, event_type, meta, created_at )
 */
async function recordActivity(waId, eventType = "message", meta = {}) {
  try {
    const payload = {
      wa_id: String(waId || ""),
      event_type: String(eventType || "message"),
      meta: meta && typeof meta === "object" ? meta : {},
    };

    const { error } = await supabase.from("kadi_activity").insert(payload);
    if (error) throw error;
    return true;
  } catch (e) {
    // On ne casse jamais le bot pour une stat
    console.warn("⚠️ recordActivity error:", e?.message);
    return false;
  }
}

module.exports = { recordActivity };