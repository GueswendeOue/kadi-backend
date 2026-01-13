// kadiStatsRepo.js
"use strict";

const { supabase } = require("./supabaseClient");

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n));
}

function asInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

async function getStats({ packCredits = 25, packPriceFcfa = 2000 } = {}) {
  const { data, error } = await supabase.rpc("kadi_stats", {
    p_days7: 7,
    p_days30: 30,
  });

  if (error) throw error;

  const users = data?.users || {};
  const docs = data?.docs || {};
  const credits = data?.credits || {};

  const added30 = asInt(credits.added30);
  const estRevenue = Math.round((added30 / (packCredits || 25)) * (packPriceFcfa || 2000));

  return {
    users: {
      totalUsers: asInt(users.total),
      active7: asInt(users.active7),
      active30: asInt(users.active30),
    },
    docs: {
      total: asInt(docs.total),
      last7: asInt(docs.last7),
      last30: asInt(docs.last30),
    },
    credits: {
      added7: asInt(credits.added7),
      consumed7: asInt(credits.consumed7),
      added30,
    },
    revenue: {
      est30: asInt(estRevenue),
      packCredits: asInt(packCredits),
      packPriceFcfa: asInt(packPriceFcfa),
    },
  };
}

async function getTopClients({ days = 30, limit = 5 } = {}) {
  const { data, error } = await supabase.rpc("kadi_top_clients", {
    p_days: asInt(days),
    p_limit: asInt(limit),
  });

  // Si tu n’as pas encore la RPC kadi_top_clients, fallback JS plus bas
  if (!error && Array.isArray(data)) return data;

  // ---- fallback sans RPC
  const since = new Date(Date.now() - asInt(days) * 24 * 60 * 60 * 1000).toISOString();

  const q = await supabase
    .from("kadi_documents")
    .select("client,total,created_at")
    .gte("created_at", since)
    .limit(5000);

  if (q.error) throw q.error;

  const map = new Map();
  for (const r of q.data || []) {
    const key = String(r.client || "—").trim() || "—";
    const prev = map.get(key) || { doc_count: 0, total_sum: 0 };
    prev.doc_count += 1;
    prev.total_sum += Number(r.total) || 0;
    map.set(key, prev);
  }

  return [...map.entries()]
    .map(([client, v]) => ({ client, doc_count: v.doc_count, total_sum: v.total_sum }))
    .sort((a, b) => (b.doc_count - a.doc_count) || (b.total_sum - a.total_sum))
    .slice(0, asInt(limit));
}

async function getDocsForExport({ days = 30 } = {}) {
  const since = new Date(Date.now() - asInt(days) * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("kadi_documents")
    .select("created_at,wa_id,doc_number,doc_type,facture_kind,client,date,total,items")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) throw error;
  return data || [];
}

module.exports = { getStats, getTopClients, getDocsForExport, money };
