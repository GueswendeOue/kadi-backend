"use strict";

const { supabase } = require("./supabaseClient");

/**
 * Upsert utilisateur + incrémente messages_count + update last_seen
 * Table: public.kadi_activity
 * Colonnes attendues:
 * - wa_id (text) PK
 * - first_seen (timestamptz)
 * - last_seen (timestamptz)
 * - messages_count (int)
 * - created_at (timestamptz)
 */
async function recordActivity(waId) {
  const wa = String(waId || "").trim();
  if (!wa) return null;

  const now = new Date().toISOString();

  // On fait upsert "soft" puis increment via RPC (plus safe).
  // Si tu n'as pas la RPC, on fait fallback simple.
  const { data, error } = await supabase.rpc("kadi_record_activity", {
    p_wa_id: wa,
  });

  if (!error) {
    // data peut être null ou la ligne
    return data;
  }

  // fallback (si RPC pas créée)
  // 1) upsert row
  await supabase
    .from("kadi_activity")
    .upsert(
      {
        wa_id: wa,
        first_seen: now,
        last_seen: now,
        messages_count: 1,
        created_at: now,
      },
      { onConflict: "wa_id" }
    );

  // 2) update last_seen + messages_count = messages_count + 1
  // (on ne peut pas faire increment atomique sans RPC, donc on lit puis update)
  const { data: row } = await supabase
    .from("kadi_activity")
    .select("messages_count")
    .eq("wa_id", wa)
    .maybeSingle();

  const next = Number(row?.messages_count || 1) + 1;

  await supabase
    .from("kadi_activity")
    .update({ last_seen: now, messages_count: next })
    .eq("wa_id", wa);

  return { wa_id: wa, last_seen: now, messages_count: next };
}

module.exports = { recordActivity };