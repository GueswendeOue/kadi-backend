"use strict";

const { supabase } = require("./supabaseClient");

// Upsert "last_seen" + messages_count
async function touchActivity(waId) {
  if (!waId) return;

  // 1) essayer update
  const nowIso = new Date().toISOString();

  // NB: Supabase JS ne fait pas un "increment" simple en update
  // => on fait read minimal + upsert
  const { data: existing, error: e1 } = await supabase
    .from("kadi_activity")
    .select("wa_id, messages_count, first_seen")
    .eq("wa_id", waId)
    .maybeSingle();

  if (e1) throw e1;

  if (!existing) {
    const { error: e2 } = await supabase.from("kadi_activity").insert({
      wa_id: waId,
      first_seen: nowIso,
      last_seen: nowIso,
      messages_count: 1,
    });
    if (e2) throw e2;
    return;
  }

  const nextCount = Number(existing.messages_count || 0) + 1;

  const { error: e3 } = await supabase
    .from("kadi_activity")
    .update({ last_seen: nowIso, messages_count: nextCount })
    .eq("wa_id", waId);

  if (e3) throw e3;
}

module.exports = { touchActivity };