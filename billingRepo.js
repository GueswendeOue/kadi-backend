"use strict";

const { supabase } = require("./supabaseClient");

async function getWallet(waId) {
  const { data, error } = await supabase
    .from("kadi_wallets")
    .select("wa_id, credits")
    .eq("wa_id", waId)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    const { data: created, error: e2 } = await supabase
      .from("kadi_wallets")
      .insert([{ wa_id: waId, credits: 0 }])
      .select("wa_id, credits")
      .single();
    if (e2) throw e2;
    return created;
  }

  return data;
}

async function decrementOneCredit(waId) {
  const { data, error } = await supabase.rpc("kadi_decrement_credit", { p_wa_id: waId });
  if (error) throw error;
  return data?.[0] || { ok: false, credits_left: 0, message: "rpc_error" };
}

async function applyVoucher(waId, code) {
  const { data, error } = await supabase.rpc("kadi_apply_voucher", {
    p_wa_id: waId,
    p_code: code,
  });
  if (error) throw error;
  return data?.[0] || { ok: false, credits_new: 0, message: "rpc_error" };
}

module.exports = { getWallet, decrementOneCredit, applyVoucher };