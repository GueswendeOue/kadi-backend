"use strict";

const { supabase } = require("./supabaseClient");

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n));
}

function isoSinceDays(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

async function getStats({ packCredits = 25, packPriceFcfa = 2000 } = {}) {
  const since7 = isoSinceDays(7);
  const since30 = isoSinceDays(30);

  // ---- Users (from kadi_activity)
  const usersTotal = await supabase
    .from("kadi_activity")
    .select("wa_id", { count: "exact", head: true });

  const users7 = await supabase
    .from("kadi_activity")
    .select("wa_id", { count: "exact", head: true })
    .gte("last_seen", since7);

  const users30 = await supabase
    .from("kadi_activity")
    .select("wa_id", { count: "exact", head: true })
    .gte("last_seen", since30);

  // ---- Docs
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

  // ---- Credits (7j)
  const tx7 = await supabase
    .from("kadi_credit_tx")
    .select("delta")
    .gte("created_at", since7);

  const deltas7 = (tx7.data || []).map((r) => Number(r.delta) || 0);
  const added7 = deltas7.filter((d) => d > 0).reduce((a, b) => a + b, 0);
  const consumed7 = deltas7.filter((d) => d < 0).reduce((a, b) => a + (-b), 0);

  // ---- Revenue estimate (30j) based on added credits
  const tx30 = await supabase
    .from("kadi_credit_tx")
    .select("delta")
    .gte("created_at", since30);

  const deltas30 = (tx30.data || []).map((r) => Number(r.delta) || 0);
  const added30 = deltas30.filter((d) => d > 0).reduce((a, b) => a + b, 0);
  const estRevenue = Math.round((added30 / (packCredits || 25)) * (packPriceFcfa || 2000));

  return {
    users: {
      totalUsers: usersTotal.count || 0,
      active7: users7.count || 0,
      active30: users30.count || 0,
    },
    docs: {
      total: docsTotal.count || 0,
      last7: docs7.count || 0,
      last30: docs30.count || 0,
    },
    credits: {
      added7: Math.round(added7),
      consumed7: Math.round(consumed7),
    },
    revenue: {
      est30: Math.round(estRevenue),
      packCredits: Number(packCredits || 25),
      packPriceFcfa: Number(packPriceFcfa || 2000),
    },
  };
}

async function getTopClients({ days = 30, limit = 5 } = {}) {
  // Si tu as la RPC, c'est plus rapide, sinon fallback JS
  const { data, error } = await supabase.rpc("kadi_top_clients", {
    p_days: Number(days || 30),
    p_limit: Number(limit || 5),
  });

  if (!error && Array.isArray(data)) return data;

  // fallback
  const since = isoSinceDays(days);
  const { data: docs } = await supabase
    .from("kadi_documents")
    .select("client,total,created_at")
    .gte("created_at", since)
    .limit(5000);

  const map = new Map();
  for (const r of docs || []) {
    const key = String(r.client || "—").trim() || "—";
    const prev = map.get(key) || { doc_count: 0, total_sum: 0 };
    prev.doc_count += 1;
    prev.total_sum += Number(r.total) || 0;
    map.set(key, prev);
  }

  return [...map.entries()]
    .map(([client, v]) => ({ client, doc_count: v.doc_count, total_sum: v.total_sum }))
    .sort((a, b) => (b.doc_count - a.doc_count) || (b.total_sum - a.total_sum))
    .slice(0, limit);
}

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