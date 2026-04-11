"use strict";

const { supabase } = require("./supabaseClient");

// ===============================
// Utils
// ===============================
function ensureArray(v) {
  return Array.isArray(v) ? v : [];
}

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

function pct(part, total) {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round((part / total) * 100);
}

function growthPct(current, previous) {
  const c = toNum(current, 0);
  const p = toNum(previous, 0);

  if (p <= 0) {
    if (c > 0) return 100;
    return 0;
  }

  return Math.round(((c - p) / p) * 100);
}

async function countDistinct(tableName, column = "wa_id", filters = []) {
  let q = supabase.from(tableName).select(column);

  for (const f of filters) {
    if (f.op === "gte") q = q.gte(f.column, f.value);
    if (f.op === "gt") q = q.gt(f.column, f.value);
    if (f.op === "lte") q = q.lte(f.column, f.value);
    if (f.op === "lt") q = q.lt(f.column, f.value);
    if (f.op === "eq") q = q.eq(f.column, f.value);
    if (f.op === "in") q = q.in(f.column, f.value);
    if (f.op === "not.is") q = q.not(f.column, "is", f.value);
  }

  const { data, error } = await q;
  if (error) throw error;

  const set = new Set();
  for (const row of ensureArray(data)) {
    const value = String(row?.[column] || "").trim();
    if (value) set.add(value);
  }
  return set.size;
}

async function fetchRows(tableName, columns = "*", filters = [], orderBy = null, ascending = true) {
  let q = supabase.from(tableName).select(columns);

  for (const f of filters) {
    if (f.op === "gte") q = q.gte(f.column, f.value);
    if (f.op === "gt") q = q.gt(f.column, f.value);
    if (f.op === "lte") q = q.lte(f.column, f.value);
    if (f.op === "lt") q = q.lt(f.column, f.value);
    if (f.op === "eq") q = q.eq(f.column, f.value);
    if (f.op === "in") q = q.in(f.column, f.value);
    if (f.op === "not.is") q = q.not(f.column, "is", f.value);
  }

  if (orderBy) q = q.order(orderBy, { ascending });

  const { data, error } = await q;
  if (error) throw error;

  return ensureArray(data);
}

async function countRows(tableName, filters = []) {
  let q = supabase.from(tableName).select("id", { count: "exact", head: true });

  for (const f of filters) {
    if (f.op === "gte") q = q.gte(f.column, f.value);
    if (f.op === "gt") q = q.gt(f.column, f.value);
    if (f.op === "lte") q = q.lte(f.column, f.value);
    if (f.op === "lt") q = q.lt(f.column, f.value);
    if (f.op === "eq") q = q.eq(f.column, f.value);
    if (f.op === "in") q = q.in(f.column, f.value);
    if (f.op === "not.is") q = q.not(f.column, "is", f.value);
  }

  const { count, error } = await q;
  if (error) throw error;
  return toNum(count, 0);
}

async function safeTableExistsFetch(fn, fallback = null) {
  try {
    return await fn();
  } catch (_) {
    return fallback;
  }
}

function sumBy(rows, getter) {
  return ensureArray(rows).reduce((acc, row) => acc + toNum(getter(row), 0), 0);
}

// ===============================
// Main stats
// ===============================
async function getStats({ packCredits = 25, packPriceFcfa = 2000 } = {}) {
  const from7 = isoDaysAgo(7);
  const from14 = isoDaysAgo(14);
  const from30 = isoDaysAgo(30);
  const from60 = isoDaysAgo(60);

  // -------------------------------
  // USERS
  // -------------------------------
  const totalKnownUsers = await safeTableExistsFetch(
    () => countDistinct("kadi_all_known_users", "wa_id"),
    null
  );

  const totalBusinessProfilesDistinct = await safeTableExistsFetch(
    () => countDistinct("business_profiles", "wa_id"),
    0
  );

  const totalUsers =
    totalKnownUsers != null ? totalKnownUsers : totalBusinessProfilesDistinct;

  const active7 = await safeTableExistsFetch(
    () => countDistinct("kadi_activity", "wa_id", [{ op: "gte", column: "created_at", value: from7 }]),
    0
  );

  const active30 = await safeTableExistsFetch(
    () => countDistinct("kadi_activity", "wa_id", [{ op: "gte", column: "created_at", value: from30 }]),
    0
  );

  const active1d = await safeTableExistsFetch(
    () => countDistinct("kadi_activity", "wa_id", [{ op: "gte", column: "created_at", value: isoDaysAgo(1) }]),
    0
  );

  // -------------------------------
  // DOCS CREATED / GENERATED
  // -------------------------------
  const docsCreated = await safeTableExistsFetch(
    () => countRows("kadi_doc_counters"),
    await safeTableExistsFetch(() => countRows("kadi_documents"), 0)
  );

  const docsGenerated = await safeTableExistsFetch(
    () => countRows("kadi_documents"),
    0
  );

  const docs7 = await safeTableExistsFetch(
    () => countRows("kadi_documents", [{ op: "gte", column: "created_at", value: from7 }]),
    0
  );

  const docs30 = await safeTableExistsFetch(
    () => countRows("kadi_documents", [{ op: "gte", column: "created_at", value: from30 }]),
    0
  );

  const docsPrev7 = await safeTableExistsFetch(
    () =>
      countRows("kadi_documents", [
        { op: "gte", column: "created_at", value: from14 },
        { op: "lt", column: "created_at", value: from7 },
      ]),
    0
  );

  const docsGenerated30 = docs30;

  // -------------------------------
  // DOC VALUE / TOP CLIENTS / TOP USERS
  // -------------------------------
  const docsRows30 = await safeTableExistsFetch(
    () =>
      fetchRows(
        "kadi_documents",
        "wa_id,client,total,created_at,doc_type,source",
        [{ op: "gte", column: "created_at", value: from30 }],
        "created_at",
        false
      ),
    []
  );

  const docsRowsAll = await safeTableExistsFetch(
    () =>
      fetchRows(
        "kadi_documents",
        "wa_id,client,total,created_at,doc_type,source",
        [],
        "created_at",
        false
      ),
    []
  );

  const revenueMonthDirect = Math.round(sumBy(docsRows30, (r) => r.total));

  const topClientsMap = new Map();
  for (const row of docsRows30) {
    const { key, display } = normalizeClientName(row?.client);
    const cur = topClientsMap.get(key) || {
      client: display,
      docs: 0,
      total_fcfa: 0,
    };
    cur.docs += 1;
    cur.total_fcfa += toNum(row?.total, 0);
    topClientsMap.set(key, cur);
  }

  const topClients = Array.from(topClientsMap.values())
    .sort((a, b) => b.docs - a.docs || b.total_fcfa - a.total_fcfa)
    .slice(0, 5);

  const topUsersMap = new Map();
  for (const row of docsRows30) {
    const waId = safeStr(row?.wa_id, "");
    if (!waId) continue;
    const cur = topUsersMap.get(waId) || {
      wa_id: waId,
      docs: 0,
      total_fcfa: 0,
    };
    cur.docs += 1;
    cur.total_fcfa += toNum(row?.total, 0);
    topUsersMap.set(waId, cur);
  }

  const topUsers = Array.from(topUsersMap.values())
    .sort((a, b) => b.docs - a.docs || b.total_fcfa - a.total_fcfa)
    .slice(0, 5);

  // -------------------------------
  // REVENUE / PAID USERS
  // -------------------------------
  const paidReasons = [
    "payment_om",
    "manual_om_topup",
    "payment",
    "recharge",
    "topup",
  ];

  const paidTx30 = await safeTableExistsFetch(
    () =>
      fetchRows(
        "kadi_credit_tx",
        "wa_id,delta,reason,created_at",
        [{ op: "gte", column: "created_at", value: from30 }],
        "created_at",
        false
      ),
    []
  );

  const paidUsersSet = new Set();
  let creditsPaid30 = 0;

  for (const row of paidTx30) {
    const reason = safeStr(row?.reason, "").toLowerCase();
    const delta = toNum(row?.delta, 0);
    const waId = safeStr(row?.wa_id, "");

    const looksPaid =
      delta > 0 &&
      paidReasons.some((r) => reason.includes(r));

    if (looksPaid) {
      creditsPaid30 += delta;
      if (waId) paidUsersSet.add(waId);
    }
  }

  const paidUsers = paidUsersSet.size;

  const revenueFromCredits = Math.round(
    (creditsPaid30 / Math.max(1, packCredits)) * packPriceFcfa
  );

  const revenueMonth = revenueFromCredits > 0 ? revenueFromCredits : revenueMonthDirect;

  const paidTxPrev30 = await safeTableExistsFetch(
    () =>
      fetchRows(
        "kadi_credit_tx",
        "delta,reason,created_at",
        [
          { op: "gte", column: "created_at", value: from60 },
          { op: "lt", column: "created_at", value: from30 },
        ],
        "created_at",
        false
      ),
    []
  );

  let revenuePrev30 = 0;
  for (const row of paidTxPrev30) {
    const reason = safeStr(row?.reason, "").toLowerCase();
    const delta = toNum(row?.delta, 0);
    const looksPaid =
      delta > 0 &&
      paidReasons.some((r) => reason.includes(r));

    if (looksPaid) revenuePrev30 += delta;
  }

  revenuePrev30 = Math.round(
    (revenuePrev30 / Math.max(1, packCredits)) * packPriceFcfa
  );

  // -------------------------------
  // FUNNEL
  // -------------------------------
  const signupToActive30Rate = pct(active30, totalUsers);
  const activeToCreatedRate = pct(docsCreated, active30);
  const createdToGeneratedRate = pct(docsGenerated, docsCreated);
  const generatedToPaidRate = pct(paidUsers, docsGenerated);

  // -------------------------------
  // COMPARISONS
  // -------------------------------
  const docs7Growth = growthPct(docs7, docsPrev7);
  const revenue30Growth = growthPct(revenueMonth, revenuePrev30);

  // -------------------------------
  // ALERTS
  // -------------------------------
  const alerts = [];

  if (docs7Growth < 0) {
    alerts.push(`• Baisse docs 7j: ${docs7Growth}%`);
  }

  if (createdToGeneratedRate < 60 && docsCreated > 20) {
    alerts.push(`• Conversion création→PDF faible: ${createdToGeneratedRate}%`);
  }

  if (generatedToPaidRate < 5 && docsGenerated > 20) {
    alerts.push(`• Conversion PDF→payé faible: ${generatedToPaidRate}%`);
  }

  if (active30 > 0 && active7 < Math.round(active30 * 0.15)) {
    alerts.push(`• Faible activité récente sur 7 jours`);
  }

  return {
    users: {
      total: totalUsers,
      totalUsers,
      active1d,
      active7,
      active30,
      paid: paidUsers,
      usersWithDocs: await safeTableExistsFetch(
        () => countDistinct("kadi_documents", "wa_id"),
        0
      ),
      onboardedUsers: 0,
      usersWithWallet: await safeTableExistsFetch(
        () => countDistinct("kadi_credits", "wa_id"),
        0
      ),
      usersRecharged: paidUsers,
    },

    docs: {
      created: docsCreated,
      generated: docsGenerated,
      creationToPdfRate: pct(docsGenerated, docsCreated),
      last7: docs7,
      last30: docs30,
      total: docsGenerated,
      sumAll: Math.round(sumBy(docsRowsAll, (r) => r.total)),
      sum30: Math.round(sumBy(docsRows30, (r) => r.total)),
    },

    comparisons: {
      docs7Growth,
      revenue30Growth,
    },

    revenue: {
      month: revenueMonth,
      est30: revenueMonth,
      creditsPaid: creditsPaid30,
      packCredits,
      packPriceFcfa,
    },

    funnel: {
      signupToActive30Rate,
      activeToCreatedRate,
      createdToGeneratedRate,
      generatedToPaidRate,
    },

    topClients,
    topUsers,
    alerts,

    credits: {
      addedPaid30: creditsPaid30,
    },

    kpis: {
      onboardingRate: 0,
      activationRate: pct(
        await safeTableExistsFetch(() => countDistinct("kadi_documents", "wa_id"), 0),
        totalUsers
      ),
      paymentConversion: pct(paidUsers, active30),
    },
  };
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

  for (const r of ensureArray(data)) {
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

  return ensureArray(data);
}

module.exports = {
  getStats,
  getTopClients,
  getDocsForExport,
  money,
};