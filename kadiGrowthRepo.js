"use strict";

const { supabase } = require("./supabaseClient");

// ===============================
// Utils
// ===============================
function ensureArray(v) {
  return Array.isArray(v) ? v : [];
}

function toNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function isoDaysAgo(days) {
  const d = new Date(Date.now() - Number(days || 0) * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function diffDays(fromDate) {
  if (!fromDate) return 9999;
  const t = new Date(fromDate).getTime();
  if (!Number.isFinite(t)) return 9999;
  return Math.max(0, Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000)));
}

function normalizeProfessionCategory(profile = {}) {
  return profile?.business_sector || null;
}

function growthPct(current, previous) {
  const c = toNum(current, 0);
  const p = toNum(previous, 0);

  if (p <= 0) return c > 0 ? 100 : 0;
  return Math.round(((c - p) / p) * 100);
}

function lowerReason(row) {
  return String(row?.reason || "").trim().toLowerCase();
}

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

function isPdfTx(row) {
  const reason = lowerReason(row);
  const delta = toNum(row?.delta, 0);

  if (!(delta < 0)) return false;

  return (
    reason === "pdf" ||
    reason === "ocr_pdf" ||
    reason === "decharge_pdf" ||
    reason === "pdf_stamp_once" ||
    reason.startsWith("pdf_") ||
    reason.startsWith("ocr_pdf_") ||
    reason.startsWith("decharge_pdf_")
  );
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

async function getUnifiedCreditEvents() {
  const [legacyTx, ledgerTx] = await Promise.all([
    fetchRows(
      "kadi_credit_tx",
      "wa_id, delta, reason, created_at",
      [],
      "created_at",
      false
    ).catch(() => []),
    fetchRows(
      "kadi_credit_ledger",
      "profile_id, delta, reason, created_at",
      [],
      "created_at",
      false
    ).catch(() => []),
  ]);

  const normalizedLegacy = ensureArray(legacyTx).map((row) => ({
    source_table: "legacy_tx",
    wa_id: String(row?.wa_id || "").trim(),
    profile_id: null,
    delta: toNum(row?.delta, 0),
    reason: String(row?.reason || "").trim(),
    created_at: row?.created_at || null,
  }));

  const normalizedLedger = ensureArray(ledgerTx).map((row) => ({
    source_table: "ledger",
    wa_id: "",
    profile_id: row?.profile_id || null,
    delta: toNum(row?.delta, 0),
    reason: String(row?.reason || "").trim(),
    created_at: row?.created_at || null,
  }));

  return [...normalizedLegacy, ...normalizedLedger].sort((a, b) =>
    String(b.created_at || "").localeCompare(String(a.created_at || ""))
  );
}

// ===============================
// GROWTH METRICS
// ===============================
async function getDocsGrowth7d() {
  const from7 = isoDaysAgo(7);
  const from14 = isoDaysAgo(14);

  const events = await getUnifiedCreditEvents();

  const current = events.filter((r) => {
    const created = String(r.created_at || "");
    return created >= from7 && isPdfTx(r);
  }).length;

  const previous = events.filter((r) => {
    const created = String(r.created_at || "");
    return created >= from14 && created < from7 && isPdfTx(r);
  }).length;

  return growthPct(current, previous);
}

async function getRevenueGrowth30d({
  packCredits = 25,
  packPriceFcfa = 2000,
} = {}) {
  const from30 = isoDaysAgo(30);
  const from60 = isoDaysAgo(60);

  const events = await getUnifiedCreditEvents();

  const credits30 = events
    .filter((r) => {
      const created = String(r.created_at || "");
      return created >= from30 && isPaidCreditTx(r);
    })
    .reduce((acc, r) => acc + toNum(r.delta, 0), 0);

  const creditsPrev30 = events
    .filter((r) => {
      const created = String(r.created_at || "");
      return created >= from60 && created < from30 && isPaidCreditTx(r);
    })
    .reduce((acc, r) => acc + toNum(r.delta, 0), 0);

  const revenue30 = Math.round(
    (credits30 / Math.max(1, packCredits)) * packPriceFcfa
  );
  const revenuePrev30 = Math.round(
    (creditsPrev30 / Math.max(1, packCredits)) * packPriceFcfa
  );

  return growthPct(revenue30, revenuePrev30);
}

async function getUserGrowth30d() {
  const from30 = isoDaysAgo(30);
  const from60 = isoDaysAgo(60);

  const current = await countDistinct("business_profiles", "wa_id", [
    { op: "gte", column: "created_at", value: from30 },
  ]).catch(() => 0);

  const previous = await countDistinct("business_profiles", "wa_id", [
    { op: "gte", column: "created_at", value: from60 },
    { op: "lt", column: "created_at", value: from30 },
  ]).catch(() => 0);

  return growthPct(current, previous);
}

// ===============================
// ZERO DOC USERS
// ===============================
async function getZeroDocUsersBySegment(segment = "A", limit = 20) {
  const seg = String(segment || "A").toUpperCase();
  const max = Math.min(Math.max(Number(limit || 20), 1), 200);

  const { data: profiles, error: profilesError } = await supabase
    .from("business_profiles")
    .select(
      [
        "id",
        "wa_id",
        "created_at",
        "onboarding_done",
        "business_sector",
        "owner_name",
        "business_name",
      ].join(",")
    )
    .not("wa_id", "is", null)
    .order("created_at", { ascending: false });

  if (profilesError) throw profilesError;

  const { data: docs, error: docsError } = await supabase
    .from("kadi_documents")
    .select("wa_id");

  if (docsError) throw docsError;

  const docWaIds = new Set(
    ensureArray(docs)
      .map((r) => String(r?.wa_id || "").trim())
      .filter(Boolean)
  );

  const zeroDocProfiles = ensureArray(profiles)
    .filter((p) => {
      const waId = String(p?.wa_id || "").trim();
      return waId && !docWaIds.has(waId);
    })
    .map((p) => {
      const daysSinceSignup = diffDays(p.created_at);
      return {
        wa_id: String(p.wa_id || "").trim(),
        days_since_signup: daysSinceSignup,
        profession_category: normalizeProfessionCategory(p),
        created_at: p.created_at || null,
        business_name: p.business_name || null,
        owner_name: p.owner_name || null,
        onboarding_done: p.onboarding_done === true,
      };
    });

  let filtered = zeroDocProfiles;

  if (seg === "A") {
    filtered = zeroDocProfiles.filter((u) => u.days_since_signup < 7);
  } else if (seg === "B") {
    filtered = zeroDocProfiles.filter(
      (u) => u.days_since_signup >= 7 && u.days_since_signup <= 30
    );
  } else if (seg === "C") {
    filtered = zeroDocProfiles.filter((u) => u.days_since_signup > 30);
  }

  return filtered
    .sort((a, b) => a.days_since_signup - b.days_since_signup)
    .slice(0, max);
}

// ===============================
// INACTIVE USERS
// ===============================
async function getInactiveUsers(minDaysInactive = 30, limit = 20) {
  const minDays = Math.min(Math.max(Number(minDaysInactive || 30), 1), 365);
  const max = Math.min(Math.max(Number(limit || 20), 1), 200);
  const cutoff = isoDaysAgo(minDays);

  const { data: docs, error } = await supabase
    .from("kadi_documents")
    .select("wa_id, created_at")
    .not("wa_id", "is", null)
    .order("created_at", { ascending: false });

  if (error) throw error;

  const latestByWaId = new Map();

  for (const row of ensureArray(docs)) {
    const waId = String(row?.wa_id || "").trim();
    if (!waId) continue;

    const createdAt = row?.created_at || null;
    if (!latestByWaId.has(waId)) {
      latestByWaId.set(waId, createdAt);
    }
  }

  const inactiveWaIds = Array.from(latestByWaId.entries())
    .filter(([, lastDate]) => {
      if (!lastDate) return false;
      return new Date(lastDate).toISOString() < cutoff;
    })
    .map(([waId, lastDate]) => ({
      wa_id: waId,
      last_doc_at: lastDate,
      days_inactive: diffDays(lastDate),
      last_activity_at: lastDate,
    }))
    .slice(0, max * 3);

  if (!inactiveWaIds.length) return [];

  const waIds = inactiveWaIds.map((u) => u.wa_id);

  const { data: profiles, error: profilesError } = await supabase
    .from("business_profiles")
    .select(
      "wa_id, business_sector, business_name, owner_name"
    )
    .in("wa_id", waIds);

  if (profilesError) throw profilesError;

  const profileMap = new Map(
    ensureArray(profiles).map((p) => [String(p.wa_id || "").trim(), p])
  );

  return inactiveWaIds
    .map((u) => {
      const p = profileMap.get(u.wa_id) || {};
      return {
        wa_id: u.wa_id,
        last_doc_at: u.last_doc_at,
        last_activity_at: u.last_activity_at,
        days_inactive: u.days_inactive,
        profession_category: normalizeProfessionCategory(p),
        business_name: p.business_name || null,
        owner_name: p.owner_name || null,
      };
    })
    .sort((a, b) => b.days_inactive - a.days_inactive)
    .slice(0, max);
}

module.exports = {
  getDocsGrowth7d,
  getRevenueGrowth30d,
  getUserGrowth30d,
  getZeroDocUsersBySegment,
  getInactiveUsers,
};
