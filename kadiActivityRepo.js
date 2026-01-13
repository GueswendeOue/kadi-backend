// kadiActivityRepo.js
"use strict";

const { supabase } = require("./supabaseClient");

/**
 * Enregistre / met à jour l'activité d'un utilisateur
 * - crée la ligne si inexistante
 * - incrémente messages_count
 * - update last_seen
 */
async function recordActivity(waId) {
  const id = String(waId || "").trim();
  if (!id) return { ok: false, error: "WA_ID_EMPTY" };

  const { error } = await supabase.rpc("kadi_record_activity", {
    p_wa_id: id,
  });

  if (error) throw error;
  return { ok: true };
}

module.exports = { recordActivity };
