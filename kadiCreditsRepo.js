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

async function consumeCredit(waId, amount = 1, reason = "pdf") {
  const cleanWaId = String(waId || "").trim();
  const amt = toInt(amount, 1);
  const cleanReason = String(reason || "consume");

  if (!cleanWaId) throw new Error("waId invalid");
  if (!Number.isFinite(amt) || amt <= 0) throw new Error("amount invalid");

  // 1) Essai RPC (recommandé)
  try {
    const { data, error } = await supabase.rpc("kadi_consume_credits", {
      p_wa_id: cleanWaId,
      p_amount: amt,
      p_reason: cleanReason,
    });

    if (error) {
      console.error("[consumeCredit] rpc error:", error.message, {
        waId: cleanWaId,
        amount: amt,
        reason: cleanReason,
      });
    } else if (data && typeof data === "object") {
      return {
        ok: !!data.ok,
        balance: toInt(data.balance, 0),
      };
    } else {
      console.warn("[consumeCredit] rpc returned unexpected payload:", data);
    }
  } catch (err) {
    console.error("[consumeCredit] rpc failed:", err?.message, {
      waId: cleanWaId,
      amount: amt,
      reason: cleanReason,
    });
  }

  // 2) Fallback non atomique (moins safe)
  await ensureRow(cleanWaId);

  const current = await getBalance(cleanWaId);
  if (current < amt) {
    return { ok: false, balance: current };
  }

  const next = current - amt;

  const { error: e1 } = await supabase
    .from("kadi_credits")
    .upsert({ wa_id: cleanWaId, balance: next }, { onConflict: "wa_id" });

  if (e1) {
    console.error("[consumeCredit] fallback wallet update failed:", e1.message, {
      waId: cleanWaId,
      current,
      next,
      amount: amt,
      reason: cleanReason,
    });
    throw e1;
  }

  const { error: e2 } = await supabase.from("kadi_credit_tx").insert({
    wa_id: cleanWaId,
    delta: -amt,
    reason: cleanReason,
  });

  if (e2) {
    console.error("[consumeCredit] fallback tx insert failed:", e2.message, {
      waId: cleanWaId,
      current,
      next,
      amount: amt,
      reason: cleanReason,
    });
    throw e2;
  }

  console.log("[consumeCredit] fallback ok", {
    waId: cleanWaId,
    before: current,
    delta: -amt,
    after: next,
    reason: cleanReason,
  });

  return { ok: true, balance: next };
}

async function addCredits(waId, amount, reason = "admin") {
  const cleanWaId = String(waId || "").trim();
  const amt = toInt(amount, 0);
  const cleanReason = String(reason || "add");

  if (!cleanWaId) throw new Error("waId invalid");
  if (!Number.isFinite(amt) || amt <= 0) throw new Error("amount invalid");

  // 1) Essai RPC (recommandé)
  try {
    const { data, error } = await supabase.rpc("kadi_add_credits", {
      p_wa_id: cleanWaId,
      p_amount: amt,
      p_reason: cleanReason,
    });

    if (error) {
      console.error("[addCredits] rpc error:", error.message, {
        waId: cleanWaId,
        amount: amt,
        reason: cleanReason,
      });
    } else if (data != null) {
      const next = toInt(data, 0);

      console.log("[addCredits] rpc ok", {
        waId: cleanWaId,
        delta: amt,
        after: next,
        reason: cleanReason,
      });

      return next;
    } else {
      console.warn("[addCredits] rpc returned unexpected payload:", data);
    }
  } catch (err) {
    console.error("[addCredits] rpc failed:", err?.message, {
      waId: cleanWaId,
      amount: amt,
      reason: cleanReason,
    });
  }

  // 2) Fallback non atomique (moins safe)
  await ensureRow(cleanWaId);

  const current = await getBalance(cleanWaId);
  const next = current + amt;

  const { error: e1 } = await supabase
    .from("kadi_credits")
    .upsert({ wa_id: cleanWaId, balance: next }, { onConflict: "wa_id" });

  if (e1) {
    console.error("[addCredits] fallback wallet update failed:", e1.message, {
      waId: cleanWaId,
      current,
      next,
      amount: amt,
      reason: cleanReason,
    });
    throw e1;
  }

  const { error: e2 } = await supabase.from("kadi_credit_tx").insert({
    wa_id: cleanWaId,
    delta: amt,
    reason: cleanReason,
  });

  if (e2) {
    console.error("[addCredits] fallback tx insert failed:", e2.message, {
      waId: cleanWaId,
      current,
      next,
      amount: amt,
      reason: cleanReason,
    });
    throw e2;
  }

  console.log("[addCredits] fallback ok", {
    waId: cleanWaId,
    before: current,
    delta: amt,
    after: next,
    reason: cleanReason,
  });

  return next;
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

  const newBal = await addCredits(waId, data.credits, "code_redeem");
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