"use strict";

const crypto = require("crypto");
const { supabase } = require("./supabaseClient");

// ✅ Prix officiels (en crédits)
const CREDIT_COSTS = {
  pdf: 1,
  stamp_standard: 10,
  stamp_logo: 15,
};

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

/**
 * ✅ Consomme des crédits
 * - amount: nombre de crédits à retirer
 * - reason: tag dans kadi_credit_tx (ex: "pdf", "stamp_standard", "stamp_logo")
 */
async function consumeCredit(waId, amount = 1, reason = "pdf") {
  amount = Number(amount || 1);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount invalid");

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

/**
 * ✅ Nouvelle fonction pratique: consommer une feature par nom
 * ex: consumeFeature(waId, "stamp_logo")
 */
async function consumeFeature(waId, featureKey = "pdf") {
  const key = String(featureKey || "pdf").toLowerCase();
  const cost = CREDIT_COSTS[key];

  if (!cost) throw new Error(`Unknown featureKey: ${featureKey}`);
  return consumeCredit(waId, cost, key);
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

  const { error: e2 } = await supabase
    .from("kadi_recharge_codes")
    .update({ redeemed_at: new Date().toISOString(), redeemed_by: waId })
    .eq("code", clean);

  if (e2) throw e2;

  const newBal = await addCredits(waId, data.credits, `code:${clean}`);
  return { ok: true, added: data.credits, balance: newBal };
}

module.exports = {
  CREDIT_COSTS,
  getBalance,
  addCredits,
  consumeCredit,
  consumeFeature,
  createRechargeCodes,
  redeemCode,
};