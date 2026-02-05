"use strict";

const crypto = require("crypto");
const { supabase } = require("./supabaseClient");

// (Optionnel) catalogue de coûts si tu utilises consumeFeature() ailleurs
// ⚠️ Le pricing réel est géré côté kadiEngine (base + tampon + ocr + décharge)
const CREDIT_COSTS = {
  pdf: 1,
  ocr_pdf: 2,
  decharge: 2,
  stamp_addon: 15,
  stamp_logo:15,
};

function makeCode() {
  // ex: KDI-AB12-CD34
  const raw = crypto.randomBytes(4).toString("hex").toUpperCase(); // 8 chars
  return `KDI-${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

function toInt(n, def = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.trunc(x) : def;
}

async function ensureRow(waId) {
  // garantit qu'une ligne existe
  const { error } = await supabase
    .from("kadi_credits")
    .upsert({ wa_id: waId, balance: 0 }, { onConflict: "wa_id" });

  if (error) throw error;
}

async function getBalance(waId) {
  const { data, error } = await supabase
    .from("kadi_credits")
    .select("balance")
    .eq("wa_id", waId)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    await ensureRow(waId);
    return 0;
  }

  return toInt(data.balance, 0);
}

/**
 * ✅ Ajout crédits (ATOMIQUE via RPC si dispo)
 * Retourne le nouveau solde (number)
 */
async function addCredits(waId, amount, reason = "admin") {
  const amt = toInt(amount, 0);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error("amount invalid");

  // 1) Essai RPC (recommandé)
  try {
    const { data, error } = await supabase.rpc("kadi_add_credits", {
      p_wa_id: waId,
      p_amount: amt,
      p_reason: String(reason || "add"),
    });

    if (!error && data != null) {
      // data = nouveau solde
      return toInt(data, 0);
    }
  } catch (_) {
    // ignore -> fallback
  }

  // 2) Fallback non atomique (moins safe)
  await ensureRow(waId);
  const current = await getBalance(waId);
  const next = current + amt;

  const { error: e1 } = await supabase
    .from("kadi_credits")
    .upsert({ wa_id: waId, balance: next }, { onConflict: "wa_id" });
  if (e1) throw e1;

  const { error: e2 } = await supabase.from("kadi_credit_tx").insert({
    wa_id: waId,
    delta: amt,
    reason: String(reason || "add"),
  });
  if (e2) throw e2;

  return next;
}

/**
 * ✅ Consomme crédits (ATOMIQUE via RPC si dispo)
 * - amount: nombre de crédits à retirer
 * - reason: tag dans kadi_credit_tx (ex: "pdf", "ocr_pdf", "pdf_with_stamp")
 */
async function consumeCredit(waId, amount = 1, reason = "pdf") {
  const amt = toInt(amount, 1);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error("amount invalid");

  // 1) Essai RPC (recommandé)
  try {
    const { data, error } = await supabase.rpc("kadi_consume_credits", {
      p_wa_id: waId,
      p_amount: amt,
      p_reason: String(reason || "consume"),
    });

    // data attendu: { ok: boolean, balance: number }
    if (!error && data && typeof data === "object") {
      return { ok: !!data.ok, balance: toInt(data.balance, 0) };
    }
  } catch (_) {
    // ignore -> fallback
  }

  // 2) Fallback non atomique (moins safe)
  await ensureRow(waId);
  const current = await getBalance(waId);
  if (current < amt) return { ok: false, balance: current };

  const next = current - amt;

  const { error: e1 } = await supabase
    .from("kadi_credits")
    .upsert({ wa_id: waId, balance: next }, { onConflict: "wa_id" });
  if (e1) throw e1;

  const { error: e2 } = await supabase.from("kadi_credit_tx").insert({
    wa_id: waId,
    delta: -amt,
    reason: String(reason || "consume"),
  });
  if (e2) throw e2;

  return { ok: true, balance: next };
}

/**
 * ✅ Consommer une feature par nom (optionnel)
 * ex: consumeFeature(waId, "stamp_addon")
 */
async function consumeFeature(waId, featureKey = "pdf") {
  const key = String(featureKey || "pdf").toLowerCase();
  const cost = CREDIT_COSTS[key];
  if (!cost) throw new Error(`Unknown featureKey: ${featureKey}`);
  return consumeCredit(waId, cost, key);
}

/**
 * ✅ createRechargeCodes compatible 2 signatures:
 * - createRechargeCodes({ count, creditsEach, createdBy })
 * - createRechargeCodes(count, creditsEach, createdBy)
 */
async function createRechargeCodes(arg1, arg2, arg3) {
  let count, creditsEach, createdBy;

  if (typeof arg1 === "object" && arg1) {
    count = toInt(arg1.count ?? 100, 100);
    creditsEach = toInt(arg1.creditsEach ?? 25, 25);
    createdBy = arg1.createdBy ?? null;
  } else {
    count = toInt(arg1 ?? 100, 100);
    creditsEach = toInt(arg2 ?? 25, 25);
    createdBy = arg3 ?? null;
  }

  if (count <= 0 || count > 5000) throw new Error("count invalid");
  if (creditsEach <= 0) throw new Error("creditsEach invalid");

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