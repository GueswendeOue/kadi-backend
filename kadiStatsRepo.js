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

function sumBy(rows, getter) {
  return ensureArray(rows).reduce((acc, row) => acc + toNum(getter(row), 0), 0);
}

function lowerReason(row) {
  return safeStr(row?.reason, "").toLowerCase();
}

function uniqStrings(values = []) {
  return Array.from(
    new Set(
      ensureArray(values)
        .map((v) => String(v || "").trim())
        .filter(Boolean)
    )
  );
}

function chunkArray(arr = [], size = 200) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function maskWaId(waId = "") {
  const digits = String(waId || "").replace(/\D/g, "");

  if (!digits) return "inconnu";
  if (digits.length <= 4) return digits;
  if (digits.length <= 8) {
    return `${digits.slice(0, 2)}****${digits.slice(-2)}`;
  }

  return `${digits.slice(0, 4)}****${digits.slice(-3)}`;
}

function buildUserDisplayName(profile = null, waId = "") {
  const businessName = safeStr(profile?.business_name, "");
  if (businessName) return businessName;

  const ownerName = safeStr(profile?.owner_name, "");
  if (ownerName) return ownerName;

  const profileName = safeStr(profile?.profile_name, "");
  if (profileName) return profileName;

  return `User ${maskWaId(waId)}`;
}

// ===============================
// Supabase helpers with pagination
// ===============================
function applyFilters(q, filters = []) {
  let query = q;

  for (const f of filters) {
    if (f.op === "gte") query = query.gte(f.column, f.value);
    if (f.op === "gt") query = query.gt(f.column, f.value);
    if (f.op === "lte") query = query.lte(f.column, f.value);
    if (f.op === "lt") query = query.lt(f.column, f.value);
    if (f.op === "eq") query = query.eq(f.column, f.value);
    if (f.op === "in") query = query.in(f.column, f.value);
    if (f.op === "not.is") query = query.not(f.column, "is", f.value);
  }

  return query;
}

async function fetchRows(
  tableName,
  columns = "*",
  filters = [],
  orderBy = null,
  ascending = true
) {
  const PAGE_SIZE = 1000;
  let from = 0;
  const allRows = [];

  while (true) {
    let q = supabase.from(tableName).select(columns);
    q = applyFilters(q, filters);

    if (orderBy) {
      q = q.order(orderBy, { ascending });
    }

    q = q.range(from, from + PAGE_SIZE - 1);

    const { data, error } = await q;
    if (error) throw error;

    const page = ensureArray(data);
    allRows.push(...page);

    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return allRows;
}

async function countDistinct(tableName, column = "wa_id", filters = []) {
  const rows = await fetchRows(tableName, column, filters);
  const set = new Set();

  for (const row of rows) {
    const value = String(row?.[column] || "").trim();
    if (value) set.add(value);
  }

  return set.size;
}

async function safeTableExistsFetch(fn, fallback = null) {
  try {
    return await fn();
  } catch (_) {
    return fallback;
  }
}

async function fetchBusinessProfilesByWaIds(waIds = []) {
  const ids = uniqStrings(waIds);
  const map = new Map();

  if (!ids.length) return map;

  for (const batch of chunkArray(ids, 200)) {
    const rows = await safeTableExistsFetch(
      () =>
        fetchRows(
          "business_profiles",
          "*",
          [{ op: "in", column: "wa_id", value: batch }],
          "created_at",
          false
        ),
      []
    );

    for (const row of ensureArray(rows)) {
      const waId = safeStr(row?.wa_id, "");
      if (!waId) continue;

      if (!map.has(waId)) {
        map.set(waId, row);
      }
    }
  }

  return map;
}

// ===============================
// Unified credit events
// ===============================
async function getUnifiedCreditEvents() {
  const [legacyTx, ledgerTx] = await Promise.all([
    safeTableExistsFetch(
      () =>
        fetchRows(
          "kadi_credit_tx",
          "wa_id, delta, reason, created_at",
          [],
          "created_at",
          false
        ),
      []
    ),
    safeTableExistsFetch(
      () =>
        fetchRows(
          "kadi_credit_ledger",
          "profile_id, delta, reason, created_at, meta",
          [],
          "created_at",
          false
        ),
      []
    ),
  ]);

  const normalizedLegacy = ensureArray(legacyTx).map((row) => ({
    source_table: "legacy_tx",
    wa_id: safeStr(row?.wa_id, ""),
    profile_id: null,
    delta: toNum(row?.delta, 0),
    reason: safeStr(row?.reason, ""),
    created_at: row?.created_at || null,
    meta: null,
  }));

  const normalizedLedger = ensureArray(ledgerTx).map((row) => ({
    source_table: "ledger",
    wa_id: "",
    profile_id: row?.profile_id || null,
    delta: toNum(row?.delta, 0),
    reason: safeStr(row?.reason, ""),
    created_at: row?.created_at || null,
    meta: row?.meta || null,
  }));

  return [...normalizedLegacy, ...normalizedLedger].sort((a, b) =>
    String(b.created_at || "").localeCompare(String(a.created_at || ""))
  );
}

// ===============================
// Transaction classifiers
// ===============================
function isPdfTx(row) {
  const reason = lowerReason(row);
  const delta = toNum(row?.delta, 0);

  if (!(delta < 0)) return false;

  return (
    reason === "pdf" ||
    reason === "pdf_simple" ||
    reason === "decharge_pdf" ||
    reason === "ocr_pdf" ||
    reason.startsWith("pdf_") ||
    reason.startsWith("ocr_pdf_") ||
    reason.startsWith("decharge_pdf_") ||
    reason.includes("pdf_simple") ||
    reason.includes("generate_pdf") ||
    reason.includes("document_pdf")
  );
}

function isOcrTx(row) {
  const reason = lowerReason(row);
  const delta = toNum(row?.delta, 0);

  if (!(delta < 0)) return false;
  return (
    reason === "ocr_pdf" ||
    reason.startsWith("ocr_pdf_") ||
    reason.includes("ocr")
  );
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

  return (
    reason.includes("payment") ||
    reason.includes("topup") ||
    reason.includes("recharge")
  );
}

// ===============================
// Ranking helpers
// ===============================
function buildTopClientsFromRows(rows = [], limit = 5) {
  const topClientsMap = new Map();

  for (const row of ensureArray(rows)) {
    const { key, display } = normalizeClientName(row?.client);
    if (key === "-") continue;

    const cur = topClientsMap.get(key) || {
      client: display,
      docs: 0,
      total_fcfa: 0,
    };

    cur.docs += 1;
    cur.total_fcfa += toNum(row?.total, 0);
    topClientsMap.set(key, cur);
  }

  return Array.from(topClientsMap.values())
    .sort((a, b) => b.docs - a.docs || b.total_fcfa - a.total_fcfa)
    .slice(0, limit)
    .map((row) => ({
      client: row.client,
      docs: row.docs,
      total_fcfa: Math.round(row.total_fcfa),
    }));
}

async function buildTopUsersFromRows(rows = [], limit = 5) {
  const topUsersMap = new Map();

  for (const row of ensureArray(rows)) {
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

  const ranked = Array.from(topUsersMap.values())
    .sort((a, b) => b.docs - a.docs || b.total_fcfa - a.total_fcfa)
    .slice(0, limit);

  const profileMap = await fetchBusinessProfilesByWaIds(
    ranked.map((row) => row.wa_id)
  );

  return ranked.map((row) => {
    const profile = profileMap.get(row.wa_id) || null;

    return {
      wa_id: row.wa_id,
      user: buildUserDisplayName(profile, row.wa_id),
      business_name: safeStr(profile?.business_name, "") || null,
      owner_name: safeStr(profile?.owner_name, "") || null,
      docs: row.docs,
      total_fcfa: Math.round(row.total_fcfa),
    };
  });
}

// ===============================
// Insights builder
// ===============================
function buildYcInsights({
  totalUsers,
  active7,
  active30,
  docs7,
  docs30,
  docsGenerated,
  usersWithDocs,
  paidUsers,
  revenueMonth,
  usersZeroCredits,
  docs7Growth,
  signupToActive30Rate,
  activeToCreatedRate,
  generatedToPaidRate,
}) {
  const alerts = [];
  const insights = [];

  if (docs7Growth < 0) {
    alerts.push(`• Baisse docs 7j: ${docs7Growth}%`);
  }

  if (generatedToPaidRate < 5 && docsGenerated > 20) {
    alerts.push(`• Conversion Doc→Payé faible: ${generatedToPaidRate}%`);
  }

  if (active30 > 0 && active7 < Math.round(active30 * 0.15)) {
    alerts.push("• Faible activité récente sur 7 jours");
  }

  if (activeToCreatedRate <= 10) {
    insights.push(
      "Les utilisateurs actifs passent encore trop peu à la création de documents."
    );
  }

  if (paidUsers === 0 && docsGenerated > 50) {
    insights.push(
      "Le produit est utilisé, mais la monétisation n’est pas encore déclenchée."
    );
  }

  if (usersZeroCredits > 0) {
    insights.push(
      `${usersZeroCredits} utilisateur(s) ont épuisé leurs crédits: pipeline chaud de conversion.`
    );
  }

  if (signupToActive30Rate < 25) {
    insights.push(
      "L’activation globale reste faible: l’arrivée dans le produit doit être simplifiée."
    );
  }

  if (docs30 > 0 && docs7 === 0) {
    insights.push(
      "L’usage existe sur 30 jours mais ralentit fortement sur 7 jours."
    );
  }

  const priorityAction =
    paidUsers === 0
      ? "Activer immédiatement le flow de recharge au moment où les crédits arrivent à zéro."
      : activeToCreatedRate <= 10
      ? "Augmenter la conversion vers le premier document avec des entrées plus directes."
      : "Travailler la rétention 7 jours et la réactivation des utilisateurs récents.";

  return {
    alerts,
    insights,
    priorityAction,
    summary:
      insights[0] ||
      "Le produit montre un usage réel, mais la conversion business doit maintenant devenir prioritaire.",
  };
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
        { op: "gte", column: "last_seen", value: from1 },
      ]),
    0
  );

  const active7 = await safeTableExistsFetch(
    () =>
      countDistinct("kadi_activity", "wa_id", [
        { op: "gte", column: "last_seen", value: from7 },
      ]),
    0
  );

  const active30 = await safeTableExistsFetch(
    () =>
      countDistinct("kadi_activity", "wa_id", [
        { op: "gte", column: "last_seen", value: from30 },
      ]),
    0
  );

  const activePrev30 = await safeTableExistsFetch(
    () =>
      countDistinct("kadi_activity", "wa_id", [
        { op: "gte", column: "last_seen", value: from60 },
        { op: "lt", column: "last_seen", value: from30 },
      ]),
    0
  );

  // ===============================
  // UNIFIED CREDIT EVENTS
  // ===============================
  const creditEventsAll = await getUnifiedCreditEvents();

  const tx1 = creditEventsAll.filter((r) => String(r.created_at || "") >= from1);
  const tx7 = creditEventsAll.filter((r) => String(r.created_at || "") >= from7);
  const tx30 = creditEventsAll.filter((r) => String(r.created_at || "") >= from30);

  const txPrev7 = creditEventsAll.filter((r) => {
    const created = String(r.created_at || "");
    return created >= from14 && created < from7;
  });

  const txPrev30 = creditEventsAll.filter((r) => {
    const created = String(r.created_at || "");
    return created >= from60 && created < from30;
  });

  // ===============================
  // DOCS / OCR / STAMP FROM UNIFIED EVENTS
  // ===============================
  const docsGenerated = creditEventsAll.filter(isPdfTx).length;
  const docsCreated = docsGenerated;

  const docs1 = tx1.filter(isPdfTx).length;
  const docs7 = tx7.filter(isPdfTx).length;
  const docs30 = tx30.filter(isPdfTx).length;
  const docsPrev7 = txPrev7.filter(isPdfTx).length;

  const ocrDocsAll = creditEventsAll.filter(isOcrTx).length;
  const ocrDocs30 = tx30.filter(isOcrTx).length;

  const stampedDocsAll = creditEventsAll.filter(isStampTx).length;
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

  // ===============================
  // TOPS
  // ===============================
  const topUsers = await buildTopUsersFromRows(docsRows30, 5);
  const topClients = buildTopClientsFromRows(docsRows30, 5);

  // ===============================
  // REVENUE / PAYING USERS
  // ===============================
  let creditsPaid30 = 0;
  const paidProfileUsersSet = new Set();

  for (const row of tx30) {
    if (isPaidCreditTx(row)) {
      creditsPaid30 += toNum(row.delta, 0);

      const profileId = safeStr(row?.profile_id, "");
      if (profileId) paidProfileUsersSet.add(profileId);
    }
  }

  const paidUsers = paidProfileUsersSet.size;

  let creditsPaidPrev30 = 0;
  for (const row of txPrev30) {
    if (isPaidCreditTx(row)) {
      creditsPaidPrev30 += toNum(row.delta, 0);
    }
  }

  const revenueMonth = Math.round(
    (creditsPaid30 / Math.max(1, packCredits)) * packPriceFcfa
  );

  const revenuePrev30 = Math.round(
    (creditsPaidPrev30 / Math.max(1, packCredits)) * packPriceFcfa
  );

  // ===============================
  // FUNNEL
  // ===============================
  const usersWithDocs = await safeTableExistsFetch(
    () => countDistinct("kadi_documents", "wa_id"),
    0
  );

  const signupToActive30Rate = pct(active30, totalUsers);
  const activeToCreatedRate = pct(usersWithDocs, active30);
  const createdToGeneratedRate = 100;
  const generatedToPaidRate = pct(paidUsers, docsGenerated);

  // ===============================
  // GROWTH
  // ===============================
  const docs7Growth = growthPct(docs7, docsPrev7);
  const revenue30Growth = growthPct(revenueMonth, revenuePrev30);
  const user30Growth = growthPct(active30, activePrev30);

  // ===============================
  // WALLET / PIPELINE (ledger only)
  // ===============================
  const ledgerRows = await safeTableExistsFetch(
    () =>
      fetchRows(
        "kadi_credit_ledger",
        "profile_id, delta, reason, created_at",
        [],
        "created_at",
        false
      ),
    []
  );

  const balanceByProfile = new Map();
  for (const row of ledgerRows) {
    const profileId = safeStr(row?.profile_id, "");
    if (!profileId) continue;

    const cur = balanceByProfile.get(profileId) || 0;
    balanceByProfile.set(profileId, cur + toNum(row?.delta, 0));
  }

  let usersZeroCredits = 0;
  let usersLowCredits = 0;

  for (const balance of balanceByProfile.values()) {
    if (balance <= 0) usersZeroCredits += 1;
    else if (balance > 0 && balance <= 2) usersLowCredits += 1;
  }

  const usersWithWallet = balanceByProfile.size;

  // ===============================
  // Derived YC metrics
  // ===============================
  const docsPerTotalUser =
    totalUsers > 0 ? Number((docsGenerated / totalUsers).toFixed(2)) : 0;

  const docsPerActive30User =
    active30 > 0 ? Number((docs30 / active30).toFixed(2)) : 0;

  const docsPerActive7User =
    active7 > 0 ? Number((docs7 / active7).toFixed(2)) : 0;

  const active30Rate = pct(active30, totalUsers);
  const active7Rate = pct(active7, totalUsers);

  const estimatedNewUsers30 = Math.max(totalUsers - active30, 0);

  const retention7Approx = active30 > 0 ? pct(active7, active30) : 0;

  const insights = buildYcInsights({
    totalUsers,
    active7,
    active30,
    docs7,
    docs30,
    docsGenerated,
    usersWithDocs,
    paidUsers,
    revenueMonth,
    usersZeroCredits,
    docs7Growth,
    signupToActive30Rate,
    activeToCreatedRate,
    generatedToPaidRate,
  });

  return {
    growth: {
      totalUsers,
      estimatedNewUsers30,
      active1d,
      active7,
      active30,
      active7Rate,
      active30Rate,
    },

    usage: {
      docsTotal: docsGenerated,
      docs1d: docs1,
      docs7d: docs7,
      docs30d: docs30,
      docsPerTotalUser,
      docsPerActive30User,
      docsPerActive7User,
      usersWithDocs,
      ocrDocsTotal: ocrDocsAll,
      ocrDocs30d: ocrDocs30,
      stampedDocsTotal: stampedDocsAll,
      stampedDocs30d: stampedDocs30,
      totalDocumentValueAll: Math.round(sumBy(docsRowsAll, (r) => r.total)),
      totalDocumentValue30d: Math.round(sumBy(docsRows30, (r) => r.total)),
    },

    monetization: {
      revenue30d: revenueMonth,
      revenueGrowth30d: revenue30Growth,
      payingUsers: paidUsers,
      creditsPaid30d: creditsPaid30,
      packCredits,
      packPriceFcfa,
      usersZeroCredits,
      usersLowCredits,
      usersWithWallet,
      arpu30d: paidUsers > 0 ? Math.round(revenueMonth / paidUsers) : 0,
    },

    funnel: {
      signupToActive30Rate,
      activeToCreatedRate,
      createdToGeneratedRate,
      generatedToPaidRate,
    },

    retention: {
      active7,
      active30,
      retention7Approx,
    },

    comparisons: {
      docs7Growth,
      revenue30Growth,
      user30Growth,
    },

    topUsers,
    topClients,

    alerts: insights.alerts,
    insights: insights.insights,
    priorityAction: insights.priorityAction,
    summary: insights.summary,

    // legacy compatibility
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
      creationToPdfRate: 100,
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

    revenue: {
      month: revenueMonth,
      est30: revenueMonth,
      creditsPaid: creditsPaid30,
      packCredits,
      packPriceFcfa,
    },

    conversion: {
      usersZeroCredits,
      usersLowCredits,
    },

    kpis: {
      onboardingRate: 0,
      activationRate: pct(usersWithDocs, totalUsers),
      paymentConversion: pct(paidUsers, active30),
      docsPerWeek: docs7,
      docsPerMonth: docs30,
    },
  };
}

// ===============================
// Top users
// ===============================
async function getTopUsers({ days = 30, limit = 5 } = {}) {
  const fromISO = isoDaysAgo(days);

  const rows = await fetchRows(
    "kadi_documents",
    "wa_id,total,created_at",
    [{ op: "gte", column: "created_at", value: fromISO }]
  );

  return buildTopUsersFromRows(rows, limit);
}

// ===============================
// Top clients
// ===============================
async function getTopClients({ days = 30, limit = 5 } = {}) {
  const fromISO = isoDaysAgo(days);

  const rows = await fetchRows(
    "kadi_documents",
    "client,total,created_at",
    [{ op: "gte", column: "created_at", value: fromISO }]
  );

  const ranked = buildTopClientsFromRows(rows, limit);

  return ranked.map((row) => ({
    client: row.client,
    doc_count: row.docs,
    total_sum: Math.round(row.total_fcfa),
  }));
}

// ===============================
// Export docs
// ===============================
async function getDocsForExport({ days = 30 } = {}) {
  const wantAll = days === 0 || String(days).toLowerCase() === "all";

  const filters = [];
  if (!wantAll) {
    filters.push({
      op: "gte",
      column: "created_at",
      value: isoDaysAgo(Number(days || 30)),
    });
  }

  return fetchRows(
    "kadi_documents",
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
    ].join(","),
    filters,
    "created_at",
    false
  );
}

module.exports = {
  getStats,
  getTopUsers,
  getTopClients,
  getDocsForExport,
  money,
};