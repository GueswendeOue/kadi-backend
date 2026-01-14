"use strict";

const { supabase } = require("./supabaseClient");

// -------- utils --------
function money(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x)) return "0";
  return Math.round(x).toLocaleString("fr-FR");
}

function isoDaysAgo(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

async function distinctCount({ table, col, filterCol, fromISO }) {
  let q = supabase.from(table).select(col);
  if (fromISO && filterCol) q = q.gte(filterCol, fromISO);

  const { data, error } = await q;
  if (error) throw error;

  const set = new Set();
  for (const r of data || []) {
    const v = r?.[col];
    if (v) set.add(String(v));
  }
  return set.size;
}

async function sumDelta({ fromISO, onlyPaid = false }) {
  let q = supabase.from("kadi_credit_tx").select("delta,reason,created_at");
  if (fromISO) q = q.gte("created_at", fromISO);

  const { data, error } = await q;
  if (error) throw error;

  let sum = 0;
  for (const r of data || []) {
    const d = Number(r?.delta);
    if (!Number.isFinite(d)) continue;
    if (d <= 0) continue; // seulement ajouts

    if (onlyPaid) {
      const reason = String(r?.reason || "").trim().toLowerCase();
      // ✅ STRICT: seul "redeem:" ou "payment:" compte comme revenu
      if (!(reason.startsWith("redeem:") || reason.startsWith("payment:"))) continue;
    }

    sum += d;
  }
  return sum;
}

async function sumNegativeDeltaAbs({ fromISO }) {
  let q = supabase.from("kadi_credit_tx").select("delta,created_at");
  if (fromISO) q = q.gte("created_at", fromISO);

  const { data, error } = await q;
  if (error) throw error;

  let sum = 0;
  for (const r of data || []) {
    const d = Number(r?.delta);
    if (!Number.isFinite(d)) continue;
    if (d >= 0) continue;
    sum += Math.abs(d);
  }
  return sum;
}

// -------- main --------
async function getStats({ packCredits = 25, packPriceFcfa = 2000 } = {}) {
  const from7 = isoDaysAgo(7);
  const from30 = isoDaysAgo(30);

  // USERS total = distinct business_profiles.wa_id
  const totalUsers = await distinctCount({
    table: "business_profiles",
    col: "wa_id",
    filterCol: null,
    fromISO: null,
  });

  // ACTIVE users = distinct kadi_activity.wa_id by last_seen
  const active7 = await distinctCount({
    table: "kadi_activity",
    col: "wa_id",
    filterCol: "last_seen",
    fromISO: from7,
  });

  const active30 = await distinctCount({
    table: "kadi_activity",
    col: "wa_id",
    filterCol: "last_seen",
    fromISO: from30,
  });

  // DOCS counts
  const { count: docsTotal, error: eDocsTotal } = await supabase
    .from("kadi_documents")
    .select("id", { count: "exact", head: true });
  if (eDocsTotal) throw eDocsTotal;

  const { count: docs7, error: eDocs7 } = await supabase
    .from("kadi_documents")
    .select("id", { count: "exact", head: true })
    .gte("created_at", from7);
  if (eDocs7) throw eDocs7;

  const { count: docs30, error: eDocs30 } = await supabase
    .from("kadi_documents")
    .select("id", { count: "exact", head: true })
    .gte("created_at", from30);
  if (eDocs30) throw eDocs30;

  // CREDITS 7j
  const added7 = await sumDelta({ fromISO: from7, onlyPaid: false });
  const consumed7 = await sumNegativeDeltaAbs({ fromISO: from7 });

  // REVENUE 30j: STRICT paid only
  const addedPaid30 = await sumDelta({ fromISO: from30, onlyPaid: true });
  const est30 = Math.round((addedPaid30 / Number(packCredits || 25)) * Number(packPriceFcfa || 2000));

  return {
    users: {
      totalUsers: Number(totalUsers || 0),
      active7: Number(active7 || 0),
      active30: Number(active30 || 0),
    },
    docs: {
      total: Number(docsTotal || 0),
      last7: Number(docs7 || 0),
      last30: Number(docs30 || 0),
    },
    credits: {
      consumed7: Math.round(consumed7 || 0),
      added7: Math.round(added7 || 0),
      addedPaid30: Math.round(addedPaid30 || 0),
    },
    revenue: {
      est30: Math.max(0, Math.round(est30 || 0)),
      packCredits,
      packPriceFcfa,
    },
  };
}

// TOP clients (docs)
async function getTopClients({ days = 30, limit = 5 } = {}) {
  const fromISO = isoDaysAgo(days);

  const { data, error } = await supabase
    .from("kadi_documents")
    .select("client,total,created_at")
    .gte("created_at", fromISO);

  if (error) throw error;

  const map = new Map();
  for (const r of data || []) {
    const client = String(r?.client || "-").trim() || "-";
    const total = Number(r?.total || 0);
    const cur = map.get(client) || { client, doc_count: 0, total_sum: 0 };
    cur.doc_count += 1;
    if (Number.isFinite(total)) cur.total_sum += total;
    map.set(client, cur);
  }

  return Array.from(map.values())
    .sort((a, b) => b.doc_count - a.doc_count || b.total_sum - a.total_sum)
    .slice(0, limit);
}

// Export docs
async function getDocsForExport({ days = 30 } = {}) {
  const fromISO = isoDaysAgo(days);

  const { data, error } = await supabase
    .from("kadi_documents")
    .select("created_at,wa_id,doc_number,doc_type,facture_kind,client,date,total,items")
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
