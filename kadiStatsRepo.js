// kadiStatsRepo.js
"use strict";

const { supabase } = require("./supabaseClient");

/**
 * ⚙️ Config pricing (pour estimation revenue)
 */
const PACK_CREDITS = Number(process.env.PACK_CREDITS || 25);
const PACK_PRICE_FCFA = Number(process.env.PACK_PRICE_FCFA || 2000);

/**
 * Helper: get a "count" using head:true
 */
async function countRows(table, filters = (q) => q) {
  const q = filters(supabase.from(table).select("*", { count: "exact", head: true }));
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
}

/**
 * Helper: run a SQL query (returns rows)
 */
async function sql(query, params = {}) {
  // Supabase SQL Editor is for console; in code we use RPC.
  // So here: keep a helper that expects you've created an RPC if needed.
  // For simple stats, we DON'T need sql().
  throw new Error("sql() not implemented. Use direct supabase queries below.");
}

/**
 * Detect which column exists on business_profiles for user id.
 * You have shown "user_id" exists, and sometimes you might have "wa_id".
 */
async function detectBusinessProfilesIdColumn() {
  // Try "wa_id" first
  let { error: e1 } = await supabase
    .from("business_profiles")
    .select("wa_id", { head: true, count: "exact" })
    .limit(1);

  if (!e1) return "wa_id";

  // Fallback to "user_id"
  let { error: e2 } = await supabase
    .from("business_profiles")
    .select("user_id", { head: true, count: "exact" })
    .limit(1);

  if (!e2) return "user_id";

  // Last fallback
  return null;
}

/**
 * ✅ Users total = ALL business_profiles rows
 */
async function getUsersTotal() {
  const idCol = await detectBusinessProfilesIdColumn();
  if (!idCol) {
    // fallback: just count rows
    return countRows("business_profiles");
  }
  // count all rows (not distinct) = your "all users"
  // If you want distinct, use .select(idCol) then Set on client — but countRows is enough if 1 row per user.
  return countRows("business_profiles");
}

/**
 * ✅ Active users = users with at least one document in the last X days
 */
async function getActiveUsers(days) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("kadi_documents")
    .select("wa_id")
    .gte("created_at", since)
    .limit(50000);

  if (error) throw error;
  const uniq = new Set((data || []).map((r) => r.wa_id).filter(Boolean));
  return uniq.size;
}

/**
 * ✅ Docs counts
 */
async function getDocsCounts() {
  const now = new Date();
  const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const [total, d7, d30, today] = await Promise.all([
    countRows("kadi_documents"),
    countRows("kadi_documents", (q) => q.gte("created_at", since7)),
    countRows("kadi_documents", (q) => q.gte("created_at", since30)),
    countRows("kadi_documents", (q) => q.gte("created_at", todayStart.toISOString())),
  ]);

  return { total, d7, d30, today };
}

/**
 * ✅ Credits stats (7d) using delta
 * - added_7d = sum(delta>0)
 * - consumed_7d = sum(-delta<0)
 */
async function getCredits7d() {
  const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("kadi_credit_tx")
    .select("delta")
    .gte("created_at", since7)
    .limit(50000);

  if (error) throw error;

  let added = 0;
  let consumed = 0;

  for (const r of data || []) {
    const d = Number(r.delta) || 0;
    if (d > 0) added += d;
    else if (d < 0) consumed += -d;
  }

  return { added, consumed };
}

/**
 * ✅ Welcome bonus total (all time)
 */
async function getWelcomeBonusTotal() {
  const { data, error } = await supabase
    .from("kadi_credit_tx")
    .select("delta,reason")
    .eq("reason", "welcome")
    .limit(50000);

  if (error) throw error;
  let sum = 0;
  for (const r of data || []) sum += Math.max(0, Number(r.delta) || 0);
  return sum;
}

/**
 * ✅ Credits paid (30d) = delta > 0 excluding welcome + admin
 * (Adapt filters to your business rules)
 */
async function getCreditsPaid30d() {
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("kadi_credit_tx")
    .select("delta,reason,created_at")
    .gte("created_at", since30)
    .limit(50000);

  if (error) throw error;

  let sum = 0;
  for (const r of data || []) {
    const d = Number(r.delta) || 0;
    if (d <= 0) continue;

    const reason = String(r.reason || "");
    if (reason === "welcome") continue;
    if (reason.startsWith("admin:")) continue;

    // If you also want to exclude recharge codes from "paid":
    // if (reason.startsWith("code:")) continue;

    sum += d;
  }
  return sum;
}

/**
 * ✅ Revenue estimate (30d): creditsPaid30d / packCredits * packPrice
 */
async function getRevenueEstimate30d() {
  const creditsPaid30d = await getCreditsPaid30d();
  const packCredits = PACK_CREDITS || 25;
  const packPrice = PACK_PRICE_FCFA || 2000;

  const revenue = Math.round((creditsPaid30d / packCredits) * packPrice);
  return { creditsPaid30d, revenue };
}

/**
 * ✅ Main: build stats object for /stats
 * Users total = ALL business_profiles users (what you requested)
 */
async function getKadiStats() {
  const [usersTotal, active7, active30, docs, credits7, welcomeBonusTotal, rev] =
    await Promise.all([
      getUsersTotal(),
      getActiveUsers(7),
      getActiveUsers(30),
      getDocsCounts(),
      getCredits7d(),
      getWelcomeBonusTotal(),
      getRevenueEstimate30d(),
    ]);

  return {
    users: {
      total: usersTotal,
      active7,
      active30,
    },
    documents: docs,
    credits: {
      added7: credits7.added,
      consumed7: credits7.consumed,
      welcomeBonusTotal,
      creditsPaid30d: rev.creditsPaid30d,
    },
    revenue: {
      estimate30d: rev.revenue,
      packCredits: PACK_CREDITS || 25,
      packPriceFcfa: PACK_PRICE_FCFA || 2000,
    },
    ts: new Date().toISOString(),
  };
}

/**
 * ✅ Optional: format a WhatsApp message
 */
function formatStatsMessage(stats) {
  const frDate = new Date().toLocaleString("fr-FR");

  return (
    `📊 *KADI — STATISTIQUES*\n\n` +
    `👥 *Utilisateurs*\n` +
    `• Total (business_profiles) : ${stats.users.total}\n` +
    `• Actifs 7j (docs) : ${stats.users.active7}\n` +
    `• Actifs 30j (docs) : ${stats.users.active30}\n\n` +
    `📄 *Documents*\n` +
    `• Total : ${stats.documents.total}\n` +
    `• 7 derniers jours : ${stats.documents.d7}\n` +
    `• 30 derniers jours : ${stats.documents.d30}\n` +
    `• Aujourd’hui : ${stats.documents.today}\n\n` +
    `💳 *Crédits*\n` +
    `• Consommés (7j) : ${stats.credits.consumed7}\n` +
    `• Ajoutés (7j) : ${stats.credits.added7}\n` +
    `• Bonus welcome (total) : ${stats.credits.welcomeBonusTotal}\n` +
    `• Crédits payés (30j) : ${stats.credits.creditsPaid30d}\n\n` +
    `💰 *Revenu estimé (30j)*\n` +
    `• ≈ ${stats.revenue.estimate30d} FCFA\n` +
    `   (Pack: ${stats.revenue.packCredits} crédits = ${stats.revenue.packPriceFcfa} FCFA)\n\n` +
    `🕒 ${frDate}`
  );
}

module.exports = {
  getKadiStats,
  formatStatsMessage,
  // exported helpers if you want:
  getUsersTotal,
  getActiveUsers,
  getDocsCounts,
  getCredits7d,
  getWelcomeBonusTotal,
  getCreditsPaid30d,
  getRevenueEstimate30d,
};