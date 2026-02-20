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

/**
 * ✅ getStats:
 * - priorité RPC SQL (rapide + vrai)
 * - fallback: requêtes directes (si RPC pas dispo)
 */
async function getStats({ packCredits = 25, packPriceFcfa = 2000 } = {}) {
  // 1) RPC (recommandé)
  try {
    const { data, error } = await supabase.rpc("kadi_get_stats", {
      p_pack_credits: Number(packCredits || 25),
      p_pack_price_fcfa: Number(packPriceFcfa || 2000),
    });
    if (!error && data) return data;
  } catch (_) {
    // ignore -> fallback
  }

  // 2) FALLBACK
  const from7 = isoDaysAgo(7);
  const from30 = isoDaysAgo(30);

  // USERS
  const { count: totalUsers, error: eU } = await supabase
    .from("business_profiles")
    .select("wa_id", { count: "exact", head: true });
  if (eU) throw eU;

  const { data: act7, error: eA7 } = await supabase
    .from("kadi_activity")
    .select("wa_id")
    .gte("last_seen", from7);
  if (eA7) throw eA7;

  const { data: act30, error: eA30 } = await supabase
    .from("kadi_activity")
    .select("wa_id")
    .gte("last_seen", from30);
  if (eA30) throw eA30;

  const active7 = new Set((act7 || []).map((r) => String(r.wa_id))).size;
  const active30 = new Set((act30 || []).map((r) => String(r.wa_id))).size;

  // DOCS
  const { count: docsTotal, error: eD } = await supabase
    .from("kadi_documents")
    .select("id", { count: "exact", head: true });
  if (eD) throw eD;

  const { count: docs7, error: eD7 } = await supabase
    .from("kadi_documents")
    .select("id", { count: "exact", head: true })
    .gte("created_at", from7);
  if (eD7) throw eD7;

  const { count: docs30, error: eD30 } = await supabase
    .from("kadi_documents")
    .select("id", { count: "exact", head: true })
    .gte("created_at", from30);
  if (eD30) throw eD30;

  // sum totals (fallback)
  async function sumTotals(fromISO) {
    let q = supabase.from("kadi_documents").select("total");
    if (fromISO) q = q.gte("created_at", fromISO);
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).reduce((acc, r) => acc + (Number(r.total) || 0), 0);
  }

  const docsSumAll = await sumTotals(null);
  const docsSum7 = await sumTotals(from7);
  const docsSum30 = await sumTotals(from30);

  // docs by type
  const { data: docsType, error: eDT } = await supabase
    .from("kadi_documents")
    .select("doc_type,total");
  if (eDT) throw eDT;

  const map = new Map();
  for (const r of docsType || []) {
    const t = String(r.doc_type || "unknown").trim() || "unknown";
    const cur = map.get(t) || { doc_type: t, count: 0, total_sum: 0 };
    cur.count += 1;
    cur.total_sum += Number(r.total) || 0;
    map.set(t, cur);
  }
  const byType = Array.from(map.values()).sort((a, b) => b.count - a.count);

  // credits 7d + paid 30d
  const { data: tx7, error: eTX7 } = await supabase
    .from("kadi_credit_tx")
    .select("delta,reason,created_at")
    .gte("created_at", from7);
  if (eTX7) throw eTX7;

  const { data: tx30, error: eTX30 } = await supabase
    .from("kadi_credit_tx")
    .select("delta,reason,created_at")
    .gte("created_at", from30);
  if (eTX30) throw eTX30;

  const added7 = (tx7 || []).filter((r) => Number(r.delta) > 0).reduce((a, r) => a + Number(r.delta || 0), 0);
  const consumed7 = Math.abs((tx7 || []).filter((r) => Number(r.delta) < 0).reduce((a, r) => a + Number(r.delta || 0), 0));

  // NOTE: addedAll/consumedAll -> laisse au RPC (sinon gros fetch)
  const addedAll = null;
  const consumedAll = null;

  // Paid credits (30d) => dépend de ton "reason" lors des paiements réels
  // Tant que tu n'écris pas "om_payment:..." / "payment:..." -> revenue restera 0 et c'est normal
  const paidCredits30 = (tx30 || [])
    .filter((r) => {
      const d = Number(r.delta);
      if (!(d > 0)) return false;
      const reason = String(r.reason || "").toLowerCase().trim();
      return (
        reason.startsWith("payment:") ||
        reason.startsWith("paid:") ||
        reason.startsWith("om_payment:") ||
        reason.startsWith("orange_money:") ||
        reason.startsWith("orange:")
      );
    })
    .reduce((a, r) => a + Number(r.delta || 0), 0);

  const est30 = Math.max(0, Math.round((paidCredits30 / Math.max(1, packCredits)) * packPriceFcfa));

  return {
    users: { totalUsers: Number(totalUsers || 0), active7, active30 },
    docs: {
      total: Number(docsTotal || 0),
      last7: Number(docs7 || 0),
      last30: Number(docs30 || 0),
      sumAll: Math.round(docsSumAll || 0),
      sum7: Math.round(docsSum7 || 0),
      sum30: Math.round(docsSum30 || 0),
      byType,
    },
    credits: {
      added7: Math.round(added7 || 0),
      consumed7: Math.round(consumed7 || 0),
      addedAll,
      consumedAll,
      addedPaid30: Math.round(paidCredits30 || 0),
    },
    revenue: { est30, packCredits, packPriceFcfa },
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
  const wantAll = days === 0 || String(days).toLowerCase() === "all";

  let q = supabase
    .from("kadi_documents")
    .select("created_at,wa_id,doc_number,doc_type,facture_kind,client,date,total,items")
    .order("created_at", { ascending: false });

  if (!wantAll) {
    const fromISO = isoDaysAgo(Number(days || 30));
    q = q.gte("created_at", fromISO);
  }

  const { data, error } = await q;
  if (error) throw error;

  return data || [];
}

module.exports = {
  getStats,
  getTopClients,
  getDocsForExport,
  money,
};