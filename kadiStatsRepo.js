// kadiStatsRepo.js — V2 analytics-grade
"use strict";

const { supabase } = require("./supabaseClient");

// ===============================
// Utils
// ===============================
function money(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x)) return "0";
  return Math.round(x).toLocaleString("fr-FR");
}

function isoDaysAgo(days) {
  const d = new Date(Date.now() - Number(days || 0) * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function toNum(v, def = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : def;
}

function safeStr(v, def = "unknown") {
  const t = String(v || "").trim();
  return t || def;
}

function normalizeClientName(raw) {
  const t = String(raw || "").trim();
  if (!t) return { key: "-", display: "-" };
  return {
    key: t.toLowerCase(),
    display: t,
  };
}

async function fetchSingleView(tableName) {
  const { data, error } = await supabase
    .from(tableName)
    .select("*")
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function fetchAll(tableName, orderBy = null, ascending = true) {
  let q = supabase.from(tableName).select("*");
  if (orderBy) q = q.order(orderBy, { ascending });

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

function aggregateBy(rows, keyGetter, valueGetter = null) {
  const map = new Map();

  for (const row of rows || []) {
    const key = keyGetter(row);
    const cur = map.get(key) || {
      key,
      count: 0,
      total: 0,
    };

    cur.count += 1;
    if (typeof valueGetter === "function") {
      cur.total += toNum(valueGetter(row), 0);
    }

    map.set(key, cur);
  }

  return Array.from(map.values()).sort((a, b) => b.count - a.count || b.total - a.total);
}

// ===============================
// Main stats
// ===============================
async function getStats({ packCredits = 25, packPriceFcfa = 2000 } = {}) {
  const result = {
    users: {
      totalUsers: 0,
      active1d: 0,
      active7: 0,
      active30: 0,
      usersWithDocs: 0,
      onboardedUsers: 0,
      usersWithWallet: 0,
      usersRecharged: 0,
    },

    docs: {
      total: 0,
      last7: 0,
      last30: 0,
      sumAll: 0,
      sum7: 0,
      sum30: 0,
      avgAll: 0,
      avg30: 0,
      byType: [],
      byFactureKind: [],
      bySource: [],
      bySector: [],
      byCountry: [],
      daily30d: [],
      ocrDocs: 0,
      manualDocs: 0,
      geminiParsedDocs: 0,
      stampedDocs: 0,
    },

    credits: {
      totalBalance: 0,
      totalTx: 0,
      creditsConsumed: 0,
      creditsAdded: 0,
      added7: 0,
      consumed7: 0,
      addedPaid30: 0,
      daily30d: [],
      byReason30: [],
    },

    revenue: {
      est30: 0,
      creditsPaid: 0,
      packCredits,
      packPriceFcfa,
    },

    retention: [],
    codes: {
      codesCreated: 0,
      codesRedeemed: 0,
      redeemRatePct: 0,
      creditsRedeemed: 0,
    },

    topConsumers: [],
  };

  // ===============================
  // 1) Views first
  // ===============================
  const [
    adoptionKpis,
    docsByType,
    docsDaily30d,
    factureKinds,
    creditsKpis,
    creditsDaily30d,
    revenueEstimate,
    retentionWeekly,
    codesStats,
    topConsumers,
  ] = await Promise.all([
    fetchAll("kadi_stats_by_sector").catch(() => []),
    fetchSingleView("kadi_stats_adoption_kpis").catch(() => null),
    fetchAll("kadi_stats_docs_by_type").catch(() => []),
    fetchAll("kadi_stats_docs_daily_30d", "day", true).catch(() => []),
    fetchAll("kadi_stats_facture_kinds").catch(() => []),
    fetchSingleView("kadi_stats_credits_kpis").catch(() => null),
    fetchAll("kadi_stats_credits_daily_30d", "day", true).catch(() => []),
    fetchSingleView("kadi_stats_revenue_estimate").catch(() => null),
    fetchAll("kadi_stats_retention_weekly", "first_week", false).catch(() => []),
    fetchSingleView("kadi_stats_codes").catch(() => null),
    fetchAll("kadi_stats_top_consumers").catch(() => []),
  ]);

  if (adoptionKpis) {
    result.docs.total = toNum(adoptionKpis.total_docs, 0);
    result.users.totalUsers = toNum(adoptionKpis.total_users, 0);
    result.users.active1d = toNum(adoptionKpis.active_users_1d, 0);
    result.users.active7 = toNum(adoptionKpis.active_users_7d, 0);
    result.users.active30 = toNum(adoptionKpis.active_users_30d, 0);
    result.users.usersWithDocs = toNum(adoptionKpis.users_with_docs, 0);
    result.users.onboardedUsers = toNum(adoptionKpis.onboarded_users, 0);
  }

  result.docs.byType = (docsByType || []).map((r) => ({
    doc_type: safeStr(r.doc_type),
    docs: toNum(r.docs, 0),
    users: toNum(r.users, 0),
    total_fcfa: Math.round(toNum(r.total_fcfa, 0)),
  }));

  result.docs.daily30d = (docsDaily30d || []).map((r) => ({
    day: r.day,
    docs: toNum(r.docs, 0),
    users: toNum(r.users, 0),
    total_fcfa: Math.round(toNum(r.total_fcfa, 0)),
  }));

  result.docs.byFactureKind = (factureKinds || []).map((r) => ({
    facture_kind: safeStr(r.facture_kind),
    docs: toNum(r.docs, 0),
    users: toNum(r.users, 0),
    total_fcfa: Math.round(toNum(r.total_fcfa, 0)),
  }));

  if (creditsKpis) {
    result.credits.totalBalance = toNum(creditsKpis.total_balance, 0);
    result.users.usersWithWallet = toNum(creditsKpis.users_with_wallet, 0);
    result.users.usersRecharged = toNum(creditsKpis.users_recharged, 0);
    result.credits.totalTx = toNum(creditsKpis.total_tx, 0);
    result.credits.creditsConsumed = toNum(creditsKpis.credits_consumed, 0);
    result.credits.creditsAdded = toNum(creditsKpis.credits_added, 0);
  }

  result.credits.daily30d = (creditsDaily30d || []).map((r) => ({
    day: r.day,
    consumed: toNum(r.consumed, 0),
    added: toNum(r.added, 0),
    users: toNum(r.users, 0),
  }));

  if (revenueEstimate) {
    result.revenue.creditsPaid = toNum(revenueEstimate.credits_paid, 0);
    result.revenue.est30 = Math.round(toNum(revenueEstimate.estimated_revenue_fcfa, 0));
  }

  result.retention = (retentionWeekly || []).map((r) => ({
    first_week: r.first_week,
    new_users: toNum(r.new_users, 0),
    retained_w1: toNum(r.retained_w1, 0),
    retained_w2: toNum(r.retained_w2, 0),
  }));

  if (codesStats) {
    result.codes.codesCreated = toNum(codesStats.codes_created, 0);
    result.codes.codesRedeemed = toNum(codesStats.codes_redeemed, 0);
    result.codes.redeemRatePct = toNum(codesStats.redeem_rate_pct, 0);
    result.codes.creditsRedeemed = toNum(codesStats.credits_redeemed, 0);
  }

  result.topConsumers = (topConsumers || []).map((r) => ({
    wa_id: safeStr(r.wa_id, ""),
    consumed: toNum(r.consumed, 0),
    added: toNum(r.added, 0),
    last_tx: r.last_tx || null,
  }));

  // ===============================
  // 2) Direct metrics / advanced analytics
  // ===============================
  const from7 = isoDaysAgo(7);
  const from30 = isoDaysAgo(30);

  const [
    docs7CountRes,
    docs30CountRes,
    docs7SumRes,
    docs30SumRes,
    docsAllSumRes,
    docsAnalyticsRes,
    tx7Res,
    tx30PaidRes,
    tx30AllRes,
  ] = await Promise.all([
    supabase.from("kadi_documents").select("id", { count: "exact", head: true }).gte("created_at", from7),
    supabase.from("kadi_documents").select("id", { count: "exact", head: true }).gte("created_at", from30), // will normalize below
    supabase.from("kadi_documents").select("total").gte("created_at", from7),
    supabase.from("kadi_documents").select("total").gte("created_at", from30),
    supabase.from("kadi_documents").select("total"),
    supabase
      .from("kadi_documents")
      .select(
        [
          "total",
          "doc_type",
          "facture_kind",
          "source",
          "used_ocr",
          "used_gemini_parse",
          "used_stamp",
          "business_sector",
          "wa_country_code",
          "wa_country_guess",
          "created_at",
        ].join(",")
      ),
    supabase.from("kadi_credit_tx").select("delta,reason").gte("created_at", from7),
    supabase.from("kadi_credit_tx").select("delta,reason").gte("created_at", from30).eq("reason", "payment_om"),
    supabase.from("kadi_credit_tx").select("delta,reason").gte("created_at", from30),
  ]);

  const docs30Count = docs30CountRes?.count ?? docs30CountRes?.data?.length ?? 0;

  if (docs7CountRes.error) throw docs7CountRes.error;
  if (docs30CountRes.error) throw docs30CountRes.error;
  if (docs7SumRes.error) throw docs7SumRes.error;
  if (docs30SumRes.error) throw docs30SumRes.error;
  if (docsAllSumRes.error) throw docsAllSumRes.error;
  if (docsAnalyticsRes.error) throw docsAnalyticsRes.error;
  if (tx7Res.error) throw tx7Res.error;
  if (tx30PaidRes.error) throw tx30PaidRes.error;
  if (tx30AllRes.error) throw tx30AllRes.error;

  result.docs.last7 = toNum(docs7CountRes.count, 0);
  result.docs.last30 = toNum(docs30Count, 0);

  result.docs.sum7 = Math.round((docs7SumRes.data || []).reduce((a, r) => a + toNum(r.total, 0), 0));
  result.docs.sum30 = Math.round((docs30SumRes.data || []).reduce((a, r) => a + toNum(r.total, 0), 0));
  result.docs.sumAll = Math.round((docsAllSumRes.data || []).reduce((a, r) => a + toNum(r.total, 0), 0));

  result.docs.avgAll = result.docs.total > 0 ? Math.round(result.docs.sumAll / result.docs.total) : 0;
  result.docs.avg30 = result.docs.last30 > 0 ? Math.round(result.docs.sum30 / result.docs.last30) : 0;

  const docsAnalytics = docsAnalyticsRes.data || [];

  // OCR / manual / Gemini / stamp
  result.docs.ocrDocs = docsAnalytics.filter((r) => r.source === "ocr" || r.used_ocr === true).length;
  result.docs.manualDocs = docsAnalytics.filter((r) => (r.source || "product") !== "ocr").length;
  result.docs.geminiParsedDocs = docsAnalytics.filter((r) => r.used_gemini_parse === true).length;
  result.docs.stampedDocs = docsAnalytics.filter((r) => r.used_stamp === true).length;

  // By source
  result.docs.bySource = aggregateBy(
    docsAnalytics,
    (r) => safeStr(r.source || (r.used_ocr ? "ocr" : "product")),
    (r) => r.total
  ).map((r) => ({
    source: r.key,
    docs: r.count,
    total_fcfa: Math.round(r.total),
  }));

  // By business sector
  result.docs.bySector = aggregateBy(
    docsAnalytics,
    (r) => safeStr(r.business_sector, "unknown"),
    (r) => r.total
  ).map((r) => ({
    business_sector: r.key,
    docs: r.count,
    total_fcfa: Math.round(r.total),
  }));

  // By country
 result.docs.bySector = (docsBySector || []).map((r) => ({
    business_sector: safeStr(r.business_sector, "unknown"),
    docs: toNum(r.docs, 0),
    users: toNum(r.users, 0),
    total_fcfa: Math.round(toNum(r.total_fcfa, 0)),
  }));

  // Credits 7d
  const tx7 = tx7Res.data || [];
  result.credits.added7 = Math.round(
    tx7.filter((r) => toNum(r.delta, 0) > 0).reduce((a, r) => a + toNum(r.delta, 0), 0)
  );
  result.credits.consumed7 = Math.round(
    Math.abs(tx7.filter((r) => toNum(r.delta, 0) < 0).reduce((a, r) => a + toNum(r.delta, 0), 0))
  );

  // Paid 30d
  result.credits.addedPaid30 = Math.round(
    (tx30PaidRes.data || []).reduce((a, r) => a + toNum(r.delta, 0), 0)
  );

  // By reason 30d
  const reasonMap = new Map();
  for (const row of tx30AllRes.data || []) {
    const reason = safeStr(row.reason, "unknown");
    const delta = toNum(row.delta, 0);

    const cur = reasonMap.get(reason) || {
      reason,
      added: 0,
      consumed: 0,
      tx_count: 0,
    };

    cur.tx_count += 1;
    if (delta > 0) cur.added += delta;
    if (delta < 0) cur.consumed += Math.abs(delta);

    reasonMap.set(reason, cur);
  }

  result.credits.byReason30 = Array.from(reasonMap.values()).sort(
    (a, b) => (b.added + b.consumed) - (a.added + a.consumed)
  );

  if (!result.revenue.est30 && result.credits.addedPaid30 > 0) {
    result.revenue.creditsPaid = result.credits.addedPaid30;
    result.revenue.est30 = Math.round(
      (result.credits.addedPaid30 / Math.max(1, packCredits)) * packPriceFcfa
    );
  }

const onboardingRate =
    result.users.totalUsers > 0
      ? Math.round((result.users.onboardedUsers / result.users.totalUsers) * 100)
      : 0;

  const activationRate =
    result.users.totalUsers > 0
      ? Math.round((result.users.usersWithDocs / result.users.totalUsers) * 100)
      : 0;

  const paymentConversion =
    result.users.active30 > 0
      ? Math.round((result.users.usersRecharged / result.users.active30) * 100)
      : 0;

  result.kpis = {
    onboardingRate,
    activationRate,
    paymentConversion,
  };

  return result;
}

// ===============================
// Top clients
// ===============================
async function getTopClients({ days = 30, limit = 5 } = {}) {
  const fromISO = isoDaysAgo(days);

  const { data, error } = await supabase
    .from("kadi_documents")
    .select("client,total,created_at")
    .gte("created_at", fromISO);

  if (error) throw error;

  const map = new Map();

  for (const r of data || []) {
    const { key, display } = normalizeClientName(r?.client);
    const total = toNum(r?.total, 0);

    const cur = map.get(key) || {
      client: display,
      doc_count: 0,
      total_sum: 0,
    };

    cur.doc_count += 1;
    cur.total_sum += total;
    map.set(key, cur);
  }

  return Array.from(map.values())
    .sort((a, b) => b.doc_count - a.doc_count || b.total_sum - a.total_sum)
    .slice(0, limit)
    .map((r) => ({
      client: r.client,
      doc_count: r.doc_count,
      total_sum: Math.round(r.total_sum),
    }));
}

// ===============================
// Export docs
// ===============================
async function getDocsForExport({ days = 30 } = {}) {
  const wantAll = days === 0 || String(days).toLowerCase() === "all";

  let q = supabase
    .from("kadi_documents")
    .select(
      [
        "created_at",
        "wa_id",
        "wa_country_code",
        "wa_country_guess",
        "doc_number",
        "doc_type",
        "facture_kind",
        "client",
        "date",
        "subtotal",
        "discount",
        "net",
        "vat",
        "total",
        "deposit",
        "due",
        "paid",
        "payment_method",
        "motif",
        "source",
        "items_count",
        "used_ocr",
        "used_gemini_parse",
        "used_stamp",
        "credits_consumed",
        "business_sector",
        "status",
        "items",
      ].join(",")
    )
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