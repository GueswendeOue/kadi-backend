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

// Cache pour éviter de redétecter 100 fois
const _ID_COL_CACHE = new Map();

/**
 * Détecte si une table utilise "wa_id" ou "user_id"
 */
async function detectIdCol(table) {
  if (_ID_COL_CACHE.has(table)) return _ID_COL_CACHE.get(table);

  const candidates = ["wa_id", "user_id"];
  for (const col of candidates) {
    const { error } = await supabase.from(table).select(col, { head: true, count: "exact" });
    if (!error) {
      _ID_COL_CACHE.set(table, col);
      return col;
    }
  }

  // fallback (au cas où)
  _ID_COL_CACHE.set(table, "user_id");
  return "user_id";
}

/**
 * Somme d'un champ numeric via Supabase:
 * on récupère les lignes et on somme côté Node (simple & fiable)
 */
async function sumField({ table, field, fromISO, selectExtra = [], filterFn }) {
  const cols = [field].concat(selectExtra).join(",");

  let q = supabase.from(table).select(cols);
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

/**
 * Count distinct ids (wa_id/user_id) avec filtre possible
 */
async function distinctCount({ table, filterCol, fromISO }) {
  const idCol = await detectIdCol(table);

  let q = supabase.from(table).select(idCol);
  if (filterCol && fromISO) q = q.gte(filterCol, fromISO);

  const { data, error } = await q;
  if (error) throw error;

  const set = new Set();
  for (const r of data || []) {
    const v = r?.[idCol];
    if (v) set.add(String(v));
  }
  return set.size;
}

// -------- main --------

/**
 * getStats:
 * - total users = business_profiles (tous)
 * - actifs = kadi_activity (last_seen)
 * - docs = kadi_documents (created_at)
 * - credits = kadi_credit_tx (created_at)
 * - revenue = UNIQUEMENT tags de paiement réels (sinon 0)
 */
async function getStats({ packCredits = 25, packPriceFcfa = 2000 } = {}) {
  const from7 = isoDaysAgo(7);
  const from30 = isoDaysAgo(30);

  // USERS (TOTAL)
  const bpIdCol = await detectIdCol("business_profiles");
  const { count: totalUsers, error: eUsers } = await supabase
    .from("business_profiles")
    .select(bpIdCol, { count: "exact", head: true });

  if (eUsers) throw eUsers;

  // USERS ACTIVE (via kadi_activity.last_seen)
  // (kadi_activity peut être en wa_id OU user_id -> auto detect)
  const active7 = await distinctCount({ table: "kadi_activity", filterCol: "last_seen", fromISO: from7 });
  const active30 = await distinctCount({ table: "kadi_activity", filterCol: "last_seen", fromISO: from30 });

  // DOCS
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

  // CREDITS (7j)
  const added7 = await sumField({
    table: "kadi_credit_tx",
    field: "delta",
    fromISO: from7,
    filterFn: (r) => Number(r?.delta) > 0,
  });

  const consumed7 = Math.abs(
    await sumField({
      table: "kadi_credit_tx",
      field: "delta",
      fromISO: from7,
      filterFn: (r) => Number(r?.delta) < 0,
    })
  );

  /**
   * REVENUE (30j)
   * Très important: ne PAS compter welcome/admin/tests.
   * On compte UNIQUEMENT si reason est clairement un paiement:
   * - "payment:" , "om_payment:" , "paid:" , "orange_money:" etc.
   *
   * (Si tu veux considérer "redeem" comme revenu plus tard, on l’ajoute,
   * mais pour l’instant tu as dit: personne n’a payé => revenu doit rester 0)
   */
  const paidCredits30 = await sumField({
    table: "kadi_credit_tx",
    field: "delta",
    fromISO: from30,
    selectExtra: ["reason"],
    filterFn: (r) => {
      const d = Number(r?.delta);
      if (!(d > 0)) return false;

      const reason = String(r?.reason || "").toLowerCase().trim();

      // Exclusions
      if (reason.startsWith("welcome")) return false;
      if (reason.startsWith("admin:")) return false;
      if (reason.includes("test")) return false;

      // Inclusions paiement ONLY
      if (reason.startsWith("payment")) return true;
      if (reason.startsWith("paid")) return true;
      if (reason.startsWith("om_payment")) return true;
      if (reason.startsWith("orange_money")) return true;
      if (reason.startsWith("orange")) return true;

      return false;
    },
  });

  const est30 = Math.round((Number(paidCredits30 || 0) / Number(packCredits || 25)) * Number(packPriceFcfa || 2000));

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
      consumed7: Math.round(consumed7 || 0),
      added7: Math.round(added7 || 0),
      addedPaid30: Math.round(paidCredits30 || 0),
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