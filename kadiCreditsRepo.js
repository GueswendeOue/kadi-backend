"use strict";

const crypto = require("crypto");
const { supabase } = require("./supabaseClient");

const CREDIT_COSTS = {
  pdf: 1,
  ocr_pdf: 2,
  decharge_pdf: 2,
  stamp_addon: 15,
  stamp_logo: 15,
};

function toInt(n, def = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.trunc(x) : def;
}

function cleanText(v) {
  const s = String(v || "").trim();
  return s || null;
}

function normalizeIdentity(input) {
  if (typeof input === "string") {
    return {
      waId: cleanText(input),
      bsuid: null,
      username: null,
      parentBsuid: null,
      profileName: null,
    };
  }

  const src = input || {};
  return {
    waId: cleanText(src.waId || src.wa_id),
    bsuid: cleanText(src.bsuid),
    username: cleanText(src.username),
    parentBsuid: cleanText(src.parentBsuid || src.parent_bsuid),
    profileName: cleanText(src.profileName || src.profile_name),
  };
}

function ensureOperationKey(operationKey, prefix = "op") {
  const clean = cleanText(operationKey);
  return clean || `${prefix}:${crypto.randomUUID()}`;
}

async function resolveProfile(identityInput) {
  const identity = normalizeIdentity(identityInput);

  const { data, error } = await supabase.rpc("kadi_resolve_profile_v2", {
    p_wa_id: identity.waId,
    p_bsuid: identity.bsuid,
    p_username: identity.username,
    p_parent_bsuid: identity.parentBsuid,
    p_profile_name: identity.profileName,
  });

  if (error) throw error;

  return {
    profileId: data?.profile_id || null,
    waId: data?.wa_id || identity.waId || null,
    bsuid: data?.bsuid || identity.bsuid || null,
    username: data?.username || identity.username || null,
  };
}

async function getBalance(identityInput) {
  const resolved = await resolveProfile(identityInput);

  const { data, error } = await supabase
    .from("kadi_wallets")
    .select("balance, profile_id")
    .eq("profile_id", resolved.profileId)
    .maybeSingle();

  if (error) throw error;

  return {
    ok: true,
    profileId: resolved.profileId,
    balance: toInt(data?.balance, 0),
  };
}

async function consumeCredit(
  identityInput,
  amount = 1,
  reason = "pdf",
  operationKey = null,
  meta = {}
) {
  const identity = normalizeIdentity(identityInput);
  const amt = toInt(amount, 0);
  const cleanReason = cleanText(reason) || "consume";
  const opKey = ensureOperationKey(operationKey, `consume:${cleanReason}`);

  if (amt <= 0) throw new Error("amount invalid");
  if (!identity.waId && !identity.bsuid && !identity.username) {
    throw new Error("identity invalid");
  }

  const { data, error } = await supabase.rpc("kadi_consume_credits_v2", {
    p_wa_id: identity.waId,
    p_bsuid: identity.bsuid,
    p_username: identity.username,
    p_parent_bsuid: identity.parentBsuid,
    p_profile_name: identity.profileName,
    p_amount: amt,
    p_reason: cleanReason,
    p_operation_key: opKey,
    p_meta: meta || {},
  });

  if (error) {
    console.error("[consumeCredit:v2] rpc error:", error.message, {
      identity,
      amount: amt,
      reason: cleanReason,
      operationKey: opKey,
    });
    throw error;
  }

  return {
    ok: !!data?.ok,
    balance: toInt(data?.balance, 0),
    profileId: data?.profile_id || null,
    idempotent: !!data?.idempotent,
    operationKey: opKey,
  };
}

async function addCredits(
  identityInput,
  amount,
  reason = "admin",
  operationKey = null,
  meta = {}
) {
  const identity = normalizeIdentity(identityInput);
  const amt = toInt(amount, 0);
  const cleanReason = cleanText(reason) || "add";
  const opKey = ensureOperationKey(operationKey, `add:${cleanReason}`);

  if (amt <= 0) throw new Error("amount invalid");
  if (!identity.waId && !identity.bsuid && !identity.username) {
    throw new Error("identity invalid");
  }

  const { data, error } = await supabase.rpc("kadi_add_credits_v2", {
    p_wa_id: identity.waId,
    p_bsuid: identity.bsuid,
    p_username: identity.username,
    p_parent_bsuid: identity.parentBsuid,
    p_profile_name: identity.profileName,
    p_amount: amt,
    p_reason: cleanReason,
    p_operation_key: opKey,
    p_meta: meta || {},
  });

  if (error) {
    console.error("[addCredits:v2] rpc error:", error.message, {
      identity,
      amount: amt,
      reason: cleanReason,
      operationKey: opKey,
    });
    throw error;
  }

  return {
    ok: !!data?.ok,
    balance: toInt(data?.balance, 0),
    profileId: data?.profile_id || null,
    idempotent: !!data?.idempotent,
    operationKey: opKey,
  };
}

async function consumeFeature(
  identityInput,
  featureKey = "pdf",
  operationKey = null,
  meta = {}
) {
  const key = String(featureKey || "pdf").toLowerCase();
  const cost = CREDIT_COSTS[key];

  if (!cost) throw new Error(`Unknown featureKey: ${featureKey}`);

  const opKey = ensureOperationKey(operationKey, `feature:${key}`);

  return consumeCredit(identityInput, cost, key, opKey, {
    featureKey: key,
    cost,
    ...meta,
  });
}

function makeCode() {
  const raw = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `KDI-${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

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

async function redeemCode(identityInput, code) {
  const identity = normalizeIdentity(identityInput);
  const cleanCode = String(code || "").trim().toUpperCase();

  if (!cleanCode) throw new Error("code invalid");
  if (!identity.waId && !identity.bsuid && !identity.username) {
    throw new Error("identity invalid");
  }

  const { data, error } = await supabase.rpc("kadi_redeem_code_v2", {
    p_code: cleanCode,
    p_wa_id: identity.waId,
    p_bsuid: identity.bsuid,
    p_username: identity.username,
    p_parent_bsuid: identity.parentBsuid,
    p_profile_name: identity.profileName,
  });

  if (error) {
    console.error("[redeemCode:v2] rpc error:", error.message, {
      identity,
      code: cleanCode,
    });
    throw error;
  }

  return {
    ok: !!data?.ok,
    error: data?.error || null,
    added: toInt(data?.added, 0),
    balance: toInt(data?.balance, 0),
    idempotent: !!data?.idempotent,
  };
}

module.exports = {
  CREDIT_COSTS,
  resolveProfile,
  getBalance,
  addCredits,
  consumeCredit,
  consumeFeature,
  createRechargeCodes,
  redeemCode,
};