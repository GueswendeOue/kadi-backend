"use strict";

const { supabase } = require("./supabaseClient");

// -------- utils --------
function money(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x)) return "0";
  return Math.round(x).toLocaleString("fr-FR");
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// Somme sécurisée côté Node
async function sumField({ table, field, fromISO, filterFn }) {
  let q = supabase.from(table).select(field);
  if (fromISO) q = q.gte("created_at", fromISO);

  const { data, error } = await q;
  if (error) throw error;

  let sum = 0;
  for (const r of data || []) {
    if (filterFn && !filterFn(r)) continue;
    const v = Number(r?.[field]);
    if (Number.isFinite(v)) sum += v;
  }
  return sum;
}

// Count distinct wa_id
async function countDistinctWaId({ table, col, whereCol, fromISO }) {
  let q = supabase.from(table).select(col);
  if (fromISO && whereCol) q = q.gte(whereCol, fromISO);

  const { data, error } = await q;
  if (error) throw error;

  const set = new Set();
  for (const r of data || []) {
    if (r?.[col]) set.add(String(r[col]));
  }
  return set.size;
}

// -------- STATS --------
async function getStats({ packCredits = 25, packPriceFcfa = 2000 } = {}) {
  const from7 = isoDaysAgo(7);
  const from30 = isoDaysAgo(30);

  // USERS TOTAL (business_profiles)
  const { count: totalUsers, error: eUsers } = await supabase
    .from("business_profiles")
    .select("wa_id", { count: "exact", head: true });
  if (eUsers) throw eUsers;

  // USERS ACTIFS
  const active7 = await countDistinctWaId({
    table: "kadi_activity",
    col: "wa_id",
    whereCol: "last_seen",
    fromISO: from7,
  });

  const active30 = await countDistinctWaId({
    table: "kadi_activity",
    col: "wa_id",
    whereCol: "last_seen",
    fromISO: from30,
  });

  // DOCUMENTS
  const { count: docsTotal } = await supabase
    .from("kadi_documents")
    .select("id", { count: "exact", head: true });

  const { count: docs7 } = await supabase
    .from("kadi_documents")
    .select("id", { count: "exact", head: true })
    .gte("created_at", from7);

  const { count: docs30 } = await supabase
    .from("kadi_documents")
    .select("id", { count: "exact", head: true })
    .gte("created_at", from30);

  // CREDITS (7j)
  const added7 = await sumField({
    table: "kadi_credit_tx",
    field: "delta",
    fromISO: from7,
    filterFn: (r) => Number(r.delta) > 0,
  });

  const consumed7 = Math.abs(
    await sumField({
      table: "kadi_credit_tx",
      field: "delta",
      fromISO: from7,
      filterFn: (r) => Number(r.delta) < 0,
    })
  );

  // REVENUE PAYÉ UNIQUEMENT (30j)
  const addedPaid30 = await sumField({
    table: "kadi_credit_tx",
    field: "delta",
    fromISO: from30,
    filterFn: (r) => {
      const delta = Number(r.delta);
      if (delta <= 0) return false;

      const reason = String(r.reason || "").toLowerCase();

      if (reason.startsWith("welcome")) return false;
      if (reason.startsWith("admin:")) return false;

      if (
        reason.includes("redeem") ||
        reason.includes("payment") ||
        reason.includes("orange") ||
        reason.includes("om")
      ) {
        return true;
      }
      return false;
    },
  });

  const est30 = Math.round((addedPaid30 / packCredits) * packPriceFcfa);

  return {
    users: {
      totalUsers: Number(totalUsers || 0),
      active7,
      active30,
    },
    docs: {
      total: Number(docsTotal || 0),
      last7: Number(docs7 || 0),
      last30: Number(docs30 || 0),
    },
    credits: {
      added7: Math.round(added7 || 0),
      consumed7: Math.round(consumed7 || 0),
      addedPaid30: Math.round(addedPaid30 || 0),
    },
    revenue: {
      est30: Math.max(0, est30 || 0),
      packCredits,
      packPriceFcfa,
    },
  };
}

// TOP CLIENTS
async function getTopClients({ days = 30, limit = 5 } = {}) {
  const fromISO = isoDaysAgo(days);

  const { data, error } = await supabase
    .from("kadi_documents")
    .select("client,total")
    .gte("created_at", fromISO);

  if (error) throw error;

  const map = new Map();
  for (const r of data || []) {
    const client = String(r.client || "-").trim();
    const total = Number(r.total || 0);

    const cur = map.get(client) || { client, doc_count: 0, total_sum: 0 };
    cur.doc_count += 1;
    cur.total_sum += total;
    map.set(client, cur);
  }

  return Array.from(map.values())
    .sort((a, b) => b.doc_count - a.doc_count || b.total_sum - a.total_sum)
    .slice(0, limit);
}

// EXPORT
async function getDocsForExport({ days = 30 } = {}) {
  const fromISO = isoDaysAgo(days);

  const { data, error } = await supabase
    .from("kadi_documents")
    .select(
      "created_at,wa_id,doc_number,doc_type,facture_kind,client,date,total,items"
    )
    .gte("created_at", fromISO)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data || [];
}

module.exports = {
  getStats,
  getTopClients,
  getDocsForExport,
  money,
};