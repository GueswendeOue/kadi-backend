// kadiStatsRepo.js
"use strict";

const { supabase } = require("./supabaseClient");

const PACK_CREDITS = Number(process.env.PACK_CREDITS || 25);
const PACK_PRICE_FCFA = Number(process.env.PACK_PRICE_FCFA || 2000);

function isoSinceDays(days) {
  const d = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function uniqCount(list, key = "wa_id") {
  const s = new Set();
  for (const r of list || []) {
    const v = r?.[key];
    if (v) s.add(v);
  }
  return s.size;
}

function sumDeltas(list) {
  let added = 0;
  let consumed = 0;
  for (const r of list || []) {
    const d = Number(r?.delta || 0);
    if (!Number.isFinite(d)) continue;
    if (d > 0) added += d;
    if (d < 0) consumed += -d;
  }
  return { added, consumed };
}

async function countRows(tableName) {
  const { count, error } = await supabase
    .from(tableName)
    .select("*", { count: "exact", head: true });
  if (error) throw error;
  return count || 0;
}

async function countRowsSince(tableName, sinceIso) {
  const { count, error } = await supabase
    .from(tableName)
    .select("*", { count: "exact", head: true })
    .gte("created_at", sinceIso);
  if (error) throw error;
  return count || 0;
}

async function usersTotal() {
  const { count, error } = await supabase
    .from("business_profiles")
    .select("*", { count: "exact", head: true });

  if (error) throw error;
  return count || 0;
}

async function activeUsersSince(sinceIso) {
  const { data, error } = await supabase
    .from("kadi_activity")
    .select("wa_id")
    .gte("created_at", sinceIso)
    .limit(10000);

  if (error) throw error;
  return uniqCount(data, "wa_id");
}

async function docsByTypeSince(sinceIso) {
  const { data, error } = await supabase
    .from("kadi_documents")
    .select("doc_type")
    .gte("created_at", sinceIso)
    .limit(10000);

  if (error) throw error;

  const map = new Map();
  for (const r of data || []) {
    const k = (r.doc_type || "unknown").toLowerCase();
    map.set(k, (map.get(k) || 0) + 1);
  }
  return Object.fromEntries(map.entries());
}

async function factureKindsSince(sinceIso) {
  const { data, error } = await supabase
    .from("kadi_documents")
    .select("facture_kind, doc_type")
    .gte("created_at", sinceIso)
    .limit(10000);

  if (error) throw error;

  const map = new Map();
  for (const r of data || []) {
    if ((r.doc_type || "").toLowerCase() !== "facture") continue;
    const k = (r.facture_kind || "unknown").toLowerCase();
    map.set(k, (map.get(k) || 0) + 1);
  }
  return Object.fromEntries(map.entries());
}

async function creditsStatsSince(sinceIso) {
  const { data, error } = await supabase
    .from("kadi_credit_tx")
    .select("delta, reason, created_at")
    .gte("created_at", sinceIso)
    .limit(20000);

  if (error) throw error;

  const { added, consumed } = sumDeltas(data);

  let welcomeAdded = 0;
  let adminAdded = 0;

  for (const r of data || []) {
    const d = Number(r?.delta || 0);
    if (!(d > 0)) continue;
    const reason = String(r?.reason || "").toLowerCase();
    if (reason === "welcome") welcomeAdded += d;
    if (reason.startsWith("admin:")) adminAdded += d;
  }

  return { added, consumed, welcomeAdded, adminAdded };
}

async function paidCreditsAddedSince(sinceIso) {
  const { data, error } = await supabase
    .from("kadi_credit_tx")
    .select("delta, reason, created_at")
    .gte("created_at", sinceIso)
    .gt("delta", 0)
    .neq("reason", "welcome")
    .not("reason", "ilike", "admin:%")
    .limit(20000);

  if (error) throw error;

  let sum = 0;
  for (const r of data || []) {
    const d = Number(r?.delta || 0);
    if (Number.isFinite(d) && d > 0) sum += d;
  }
  return sum;
}

function estimateRevenueFcfa(paidCreditsAdded) {
  const packCredits = PACK_CREDITS || 25;
  const packPrice = PACK_PRICE_FCFA || 2000;
  return Math.round((paidCreditsAdded / packCredits) * packPrice);
}

async function getKadiStats() {
  const since7 = isoSinceDays(7);
  const since30 = isoSinceDays(30);

  const todayIso = new Date().toISOString().slice(0, 10);
  const todayStart = `${todayIso}T00:00:00.000Z`;

  const users_total = await usersTotal();
  const users_active_7d = await activeUsersSince(since7);
  const users_active_30d = await activeUsersSince(since30);

  const docs_total = await countRows("kadi_documents");
  const docs_7d = await countRowsSince("kadi_documents", since7);
  const docs_30d = await countRowsSince("kadi_documents", since30);
  const docs_today = await countRowsSince("kadi_documents", todayStart);

  const docs_by_type_30d = await docsByTypeSince(since30);
  const facture_kinds_30d = await factureKindsSince(since30);

  const credits_7d = await creditsStatsSince(since7);

  const paid_added_30d = await paidCreditsAddedSince(since30);
  const revenue_estimate_30d = estimateRevenueFcfa(paid_added_30d);

  return {
    users: { total: users_total, active_7d: users_active_7d, active_30d: users_active_30d },
    documents: {
      total: docs_total,
      d7: docs_7d,
      d30: docs_30d,
      today: docs_today,
      by_type_30d: docs_by_type_30d,
      facture_kinds_30d: facture_kinds_30d,
    },
    credits: { d7: credits_7d, paid_added_30d },
    revenue: {
      estimate_30d_fcfa: revenue_estimate_30d,
      pack_credits: PACK_CREDITS,
      pack_price_fcfa: PACK_PRICE_FCFA,
    },
    meta: { generated_at: new Date().toISOString() },
  };
}

module.exports = { getKadiStats, estimateRevenueFcfa };