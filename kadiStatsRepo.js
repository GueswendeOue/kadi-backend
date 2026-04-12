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

async function fetchRows(
  tableName,
  columns = "*",
  filters = [],
  orderBy = null,
  ascending = true
) {
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

function lowerReason(row) {
  return safeStr(row?.reason, "").toLowerCase();
}

function isPdfTx(row) {
  const reason = lowerReason(row);
  const delta = toNum(row?.delta, 0);

  if (!(delta < 0)) return false;

  return (
    reason === "pdf" ||
    reason === "pdf_simple" ||
    reason.includes("pdf_simple") ||
    reason.includes("generate_pdf") ||
    reason.includes("document_pdf")
  );
}

function isOcrTx(row) {
  const reason = lowerReason(row);
  const delta = toNum(row?.delta, 0);

  if (!(delta < 0)) return false;
  return reason.includes("ocr");
}

function isStampTx(row) {
  const reason = lowerReason(row);
  const delta = toNum(row?.delta, 0);

  if (!(delta < 0)) return false;
  return reason.includes("stamp");
}

function isPaidCreditTx(row) {
  const reason = lowerReason(row);
  const delta = toNum(row?.delta, 0);

  if (!(delta > 0)) return false;

  return [
    "payment_om",
    "manual_om_topup",
    "payment",
    "recharge",
    "topup",
  ].some((r) => reason.includes(r));
}

// ===============================
// Main stats
// ===============================
async function getStats({ packCredits = 25, packPriceFcfa = 2000 } = {}) {
  const from1 = isoDaysAgo(1);
  const from7 = isoDaysAgo(7);
  const from14 = isoDaysAgo(14);
  const from30 = isoDaysAgo(30);
  const from60 = isoDaysAgo(60);

  // ===============================
  // USERS
  // ===============================
  const totalKnownUsers = await safeTableExistsFetch(
    () => countDistinct("kadi_all_known_users", "wa_id"),
    null
  );

  const totalBusinessProfilesDistinct = await safeTableExistsFetch(
    () => countDistinct("business_profiles", "wa_id"),
    0
  );

  const totalUsers =
    totalBusinessProfilesDistinct > 0
      ? totalBusinessProfilesDistinct
      : totalKnownUsers != null
      ? totalKnownUsers
      : 0;

  const active1d = await safeTableExistsFetch(
    () =>
      countDistinct("kadi_activity", "wa_id", [
        { op: "gte", column: "created_at", value: from1 },
      ]),
    0
  );

  const active7 = await safeTableExistsFetch(
    () =>
      countDistinct("kadi_activity", "wa_id", [
        { op: "gte", column: "created_at", value: from7 },
      ]),
    0
  );

  const active30 = await safeTableExistsFetch(
    () =>
      countDistinct("kadi_activity", "wa_id", [
        { op: "gte", column: "created_at", value: from30 },
      ]),
    0
  );

  // ===============================
  // CREDIT TX = SOURCE OF TRUTH
  // ===============================
  const creditTxAll = await safeTableExistsFetch(
    () =>
      fetchRows(
        "kadi_credit_tx",
        "wa_id, delta, reason, created_at",
        [],
        "created_at",
        false
      ),
    []
  );

  const tx1 = creditTxAll.filter((r) => String(r.created_at || "") >= from1);
  const tx7 = creditTxAll.filter((r) => String(r.created_at || "") >= from7);
  const tx30 = creditTxAll.filter((r) => String(r.created_at || "") >= from30);
  const txPrev7 = creditTxAll.filter((r) => {
    const created = String(r.created_at || "");
    return created >= from14 && created < from7;
  });
  const txPrev30 = creditTxAll.filter((r) => {
    const created = String(r.created_at || "");
    return created >= from60 && created < from30;
  });

  // ===============================
  // DOCS / OCR / STAMP FROM CREDIT TX
  // ===============================
  const docsGenerated = creditTxAll.filter(isPdfTx).length;
  const docsCreated = docsGenerated;

  const docs1 = tx1.filter(isPdfTx).length;
  const docs7 = tx7.filter(isPdfTx).length;
  const docs30 = tx30.filter(isPdfTx).length;
  const docsPrev7 = txPrev7.filter(isPdfTx).length;

  const ocrDocsAll = creditTxAll.filter(isOcrTx).length;
  const ocrDocs30 = tx30.filter(isOcrTx).length;

  const stampedDocsAll = creditTxAll.filter(isStampTx).length;
  const stampedDocs30 = tx30.filter(isStampTx).length;

  // ===============================
  // DOCUMENT ROWS FOR VALUE / TOPS
  // ===============================
  const docsRows30 = await safeTableExistsFetch(
    () =>
      fetchRows(
        "kadi_documents",
        "wa_id, client, total, created_at, doc_type, source",
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
        "wa_id, client, total, created_at, doc_type, source",
        [],
        "created_at",
        false
      ),
    []
  );

  const revenueMonthDirect = Math.round(sumBy(docsRows30, (r) => r.total));

  // ===============================
  // TOP CLIENTS
  // ===============================
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

  // ===============================
  // TOP USERS
  // ===============================
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

  // ===============================
  // REVENUE / PAYING USERS
  // ===============================
  let creditsPaid30 = 0;
  const paidUsersSet = new Set();

  for (const row of tx30) {
    if (isPaidCreditTx(row)) {
      creditsPaid30 += toNum(row.delta, 0);

      const waId = safeStr(row?.wa_id, "");
      if (waId) paidUsersSet.add(waId);
    }
  }

  const paidUsers = paidUsersSet.size;

  const revenueFromCredits30 = Math.round(
    (creditsPaid30 / Math.max(1, packCredits)) * packPriceFcfa
  );

  let creditsPaidPrev30 = 0;
  for (const row of txPrev30) {
    if (isPaidCreditTx(row)) {
      creditsPaidPrev30 += toNum(row.delta, 0);
    }
  }

  const revenuePrev30 = Math.round(
    (creditsPaidPrev30 / Math.max(1, packCredits)) * packPriceFcfa
  );

  // Tant qu’aucun pack n’a été payé, CA = 0
  const revenueMonth = revenueFromCredits30;

  // ===============================
  // FUNNEL
  // ===============================
  const signupToActive30Rate = pct(active30, totalUsers);
  const activeToCreatedRate = pct(docsCreated, active30);
  const createdToGeneratedRate = pct(docsGenerated, docsCreated);
  const generatedToPaidRate = pct(paidUsers, docsGenerated);

  // ===============================
  // GROWTH
  // ===============================
  const docs7Growth = growthPct(docs7, docsPrev7);
  const revenue30Growth = growthPct(revenueMonth, revenuePrev30);

  // ===============================
  // EXTRA USER COUNTS
  // ===============================
  const usersWithDocs = await safeTableExistsFetch(
    () => countDistinct("kadi_documents", "wa_id"),
    0
  );

  const usersWithWallet = await safeTableExistsFetch(
    () => countDistinct("kadi_credits", "wa_id"),
    0
  );

  // ===============================
  // ALERTS
  // ===============================
  const alerts = [];

  if (docs7Growth < 0) {
    alerts.push(`• Baisse docs 7j: ${docs7Growth}%`);
  }

  if (createdToGeneratedRate < 60 && docsCreated > 20) {
    alerts.push(
      `• Conversion création→PDF faible: ${createdToGeneratedRate}%`
    );
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
      usersWithDocs,
      onboardedUsers: 0,
      usersWithWallet,
      usersRecharged: paidUsers,
    },

    docs: {
      created: docsCreated,
      generated: docsGenerated,
      creationToPdfRate: pct(docsGenerated, docsCreated),
      last1: docs1,
      last7: docs7,
      last30: docs30,
      total: docsGenerated,
      sumAll: Math.round(sumBy(docsRowsAll, (r) => r.total)),
      sum30: Math.round(sumBy(docsRows30, (r) => r.total)),
      ocrDocs: ocrDocsAll,
      ocrDocs30,
      stampedDocs: stampedDocsAll,
      stampedDocs30,
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
      activationRate: pct(usersWithDocs, totalUsers),
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