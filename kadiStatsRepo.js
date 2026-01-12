// kadiStatsRepo.js
"use strict";

const { supabase } = require("./supabaseClient");
const { getUsersStats } = require("./kadiActivityRepo");

function isoSinceDays(days) {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

function asInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : def;
}

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n));
}

/**
 * Stats globales:
 * - Users (depuis kadi_activity)
 * - Docs (kadi_documents)
 * - Credits (kadi_credit_tx.delta)
 * - Estimation CA (optionnel)
 */
async function getStats({ packCredits = 25, packPriceFcfa = 2000 } = {}) {
  const users = await getUsersStats();

  const since7 = isoSinceDays(7);
  const since30 = isoSinceDays(30);

  // DOCS
  const docsTotal = await supabase
    .from("kadi_documents")
    .select("id", { count: "exact", head: true });

  const docs7 = await supabase
    .from("kadi_documents")
    .select("id", { count: "exact", head: true })
    .gte("created_at", since7);

  const docs30 = await supabase
    .from("kadi_documents")
    .select("id", { count: "exact", head: true })
    .gte("created_at", since30);

  if (docsTotal.error) throw docsTotal.error;
  if (docs7.error) throw docs7.error;
  if (docs30.error) throw docs30.error;

  // CREDITS (delta)
  const tx7 = await supabase
    .from("kadi_credit_tx")
    .select("delta")
    .gte("created_at", since7);

  if (tx7.error) throw tx7.error;

  const deltas7 = (tx7.data || []).map((r) => Number(r.delta) || 0);
  const added7 = deltas7.filter((d) => d > 0).reduce((a, b) => a + b, 0);
  const consumed7 = deltas7.filter((d) => d < 0).reduce((a, b) => a + (-b), 0);

  const tx30 = await supabase
    .from("kadi_credit_tx")
    .select("delta")
    .gte("created_at", since30);

  if (tx30.error) throw tx30.error;

  const deltas30 = (tx30.data || []).map((r) => Number(r.delta) || 0);
  const added30 = deltas30.filter((d) => d > 0).reduce((a, b) => a + b, 0);

  const estRevenue = Math.round((added30 / (packCredits || 25)) * (packPriceFcfa || 2000));

  return {
    users,
    docs: {
      total: docsTotal.count || 0,
      last7: docs7.count || 0,
      last30: docs30.count || 0,
    },
    credits: {
      consumed7: asInt(consumed7),
      added7: asInt(added7),
      added30: asInt(added30),
    },
    revenue: {
      est30: asInt(estRevenue),
      packCredits,
      packPriceFcfa,
    },
  };
}

/**
 * Top clients sur kadi_documents
 */
async function getTopClients({ days = 30, limit = 5 } = {}) {
  const since = isoSinceDays(days);

  const { data, error } = await supabase
    .from("kadi_documents")
    .select("client,total,created_at")
    .gte("created_at", since)
    .limit(5000);

  if (error) throw error;

  const map = new Map();
  for (const r of data || []) {
    const key = (r.client || "—").trim() || "—";
    const prev = map.get(key) || { count: 0, sum: 0 };
    prev.count += 1;
    prev.sum += Number(r.total) || 0;
    map.set(key, prev);
  }

  return [...map.entries()]
    .sort((a, b) => (b[1].count - a[1].count) || (b[1].sum - a[1].sum))
    .slice(0, limit)
    .map(([client, v]) => ({ client, doc_count: v.count, total_sum: v.sum }));
}

/**
 * Export CSV docs (données brutes)
 */
async function getDocsForExport({ days = 30 } = {}) {
  const since = isoSinceDays(days);

  const { data, error } = await supabase
    .from("kadi_documents")
    .select("created_at,wa_id,doc_number,doc_type,facture_kind,client,date,total,items")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) throw error;
  return data || [];
}

module.exports = {
  getStats,
  getTopClients,
  getDocsForExport,
  money,
};