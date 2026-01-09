"use strict";

const crypto = require("crypto");
const { supabase } = require("./supabaseClient");

function makeCode() {
  // ex: KDI-AB12-CD34
  const raw = crypto.randomBytes(4).toString("hex").toUpperCase(); // 8 chars
  return `KDI-${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

async function getBalance(waId) {
  const { data, error } = await supabase
    .from("kadi_credits")
    .select("balance")
    .eq("wa_id", waId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    const { data: created, error: e2 } = await supabase
      .from("kadi_credits")
      .insert({ wa_id: waId, balance: 0 })
      .select("balance")
      .single();
    if (e2) throw e2;
    return created.balance || 0;
  }
  return data.balance || 0;
}

async function addCredits(waId, amount, reason = "admin") {
  amount = Number(amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount invalid");

  // RPC would be best, but simple approach for now:
  const current = await getBalance(waId);
  const next = current + amount;

  const { error } = await supabase
    .from("kadi_credits")
    .upsert({ wa_id: waId, balance: next }, { onConflict: "wa_id" });

  if (error) throw error;

  await supabase.from("kadi_credit_tx").insert({
    wa_id: waId,
    delta: amount,
    reason,
  });

  return next;
}

async function consumeCredit(waId, amount = 1, reason = "pdf") {
  amount = Number(amount || 1);
  const current = await getBalance(waId);
  if (current < amount) return { ok: false, balance: current };

  const next = current - amount;

  const { error } = await supabase
    .from("kadi_credits")
    .upsert({ wa_id: waId, balance: next }, { onConflict: "wa_id" });

  if (error) throw error;

  await supabase.from("kadi_credit_tx").insert({
    wa_id: waId,
    delta: -amount,
    reason,
  });

  return { ok: true, balance: next };
}

async function createRechargeCodes({ count = 100, creditsEach = 25, createdBy }) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      code: makeCode(),
      credits: creditsEach,
      created_by: createdBy || null,
    });
  }

  const { data, error } = await supabase
    .from("kadi_recharge_codes")
    .insert(rows)
    .select("code, credits");

  if (error) throw error;
  return data || [];
}

async function redeemCode({ waId, code }) {
  const clean = String(code || "").trim().toUpperCase();

  const { data, error } = await supabase
    .from("kadi_recharge_codes")
    .select("*")
    .eq("code", clean)
    .maybeSingle();

  if (error) throw error;
  if (!data) return { ok: false, error: "CODE_INVALIDE" };
  if (data.redeemed_at) return { ok: false, error: "CODE_DEJA_UTILISE" };

  // mark redeemed
  const { error: e2 } = await supabase
    .from("kadi_recharge_codes")
    .update({ redeemed_at: new Date().toISOString(), redeemed_by: waId })
    .eq("code", clean);

  if (e2) throw e2;

  const newBal = await addCredits(waId, data.credits, `code:${clean}`);
  return { ok: true, added: data.credits, balance: newBal };
}

module.exports = {
  getBalance,
  addCredits,
  consumeCredit,
  createRechargeCodes,
  redeemCode,
};