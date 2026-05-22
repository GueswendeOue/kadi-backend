"use strict";

const { supabase } = require("./supabaseClient");

// ===============================
// UTILS
// ===============================
function safeText(v, def = "") {
  const s = String(v || "").trim();
  return s || def;
}

function uniq(arr = []) {
  return Array.from(new Set(arr));
}

function toDateMs(value) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

function minIso(a, b) {
  const ta = toDateMs(a);
  const tb = toDateMs(b);

  if (ta == null && tb == null) return null;
  if (ta == null) return b || null;
  if (tb == null) return a || null;

  return ta <= tb ? a : b;
}

function maxIso(a, b) {
  const ta = toDateMs(a);
  const tb = toDateMs(b);

  if (ta == null && tb == null) return null;
  if (ta == null) return b || null;
  if (tb == null) return a || null;

  return ta >= tb ? a : b;
}

function compareIsoAsc(a, b) {
  const ta = toDateMs(a);
  const tb = toDateMs(b);

  if (ta == null && tb == null) return 0;
  if (ta == null) return -1;
  if (tb == null) return 1;

  return ta - tb;
}

function daysSince(date) {
  const ts = toDateMs(date);
  if (ts == null) return 9999;
  return Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000));
}

function chunkArray(arr = [], size = 200) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function normalizeExcludeSet(excludeWaIds = []) {
  return new Set(
    (Array.isArray(excludeWaIds) ? excludeWaIds : [])
      .map((v) => safeText(v))
      .filter(Boolean)
  );
}

function splitEnvWaIds(value = "") {
  return String(value || "")
    .split(/[,\s;]+/)
    .map((v) => safeText(v))
    .filter(Boolean);
}

function getDefaultExcludedWaIds() {
  return uniq([
    process.env.KADI_ADMIN_WA,
    process.env.ADMIN_WA_ID,
    ...splitEnvWaIds(process.env.KADI_REENGAGEMENT_EXCLUDE_WA_IDS),
    ...splitEnvWaIds(process.env.KADI_TEST_WA_IDS),
  ]).filter(Boolean);
}

function splitAB(waId, variant = "A") {
  const digits = String(waId || "").replace(/\D/g, "");
  const last = digits ? Number(digits[digits.length - 1]) : 0;
  const v = String(variant || "A").toUpperCase();

  if (v === "B") return last % 2 === 1;
  if (v === "C") return last % 3 === 0;
  return last % 2 === 0;
}

function isSentLikeStatus(status) {
  const s = safeText(status).toLowerCase();
  return s === "sent" || s === "template_sent" || s === "success";
}

function lowerReason(row) {
  return safeText(row?.reason).toLowerCase();
}

function toNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function isValidWaId(waId) {
  const s = safeText(waId);
  return /^\d{8,15}$/.test(s);
}

function isDocumentConsumptionTx(row) {
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

function isExcludedCreditEvent(row) {
  const reason = lowerReason(row);
  const meta = row?.meta || {};

  if (meta?.isTestCredit === true) return true;
  if (meta?.excludeFromRevenue === true) return true;

  return (
    reason === "admin_test_credit" ||
    reason === "demo_reset" ||
    reason === "rollback_pdf_failed" ||
    reason.includes("bonus") ||
    reason.includes("grant")
  );
}

function isRealRechargeTx(row) {
  const reason = lowerReason(row);
  const delta = toNum(row?.delta, 0);

  if (!(delta > 0)) return false;
  if (isExcludedCreditEvent(row)) return false;

  return (
    reason.includes("payment") ||
    reason.includes("topup") ||
    reason.includes("recharge")
  );
}

async function safeSelectRows(builders = []) {
  for (const build of builders) {
    try {
      const { data, error } = await build();
      if (error) throw error;
      return Array.isArray(data) ? data : [];
    } catch (_) {}
  }
  return [];
}

// ===============================
// CANDIDATE SOURCES
// ===============================
async function fetchBusinessProfiles(fetchLimit = 1000) {
  return safeSelectRows([
    () =>
      supabase
        .from("business_profiles")
        .select("wa_id, owner_name, onboarding_done, created_at")
        .not("wa_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(fetchLimit),
    () =>
      supabase
        .from("business_profiles")
        .select("wa_id, owner_name, created_at")
        .not("wa_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(fetchLimit),
    () =>
      supabase
        .from("business_profiles")
        .select("wa_id, created_at")
        .not("wa_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(fetchLimit),
    () =>
      supabase
        .from("business_profiles")
        .select("wa_id")
        .not("wa_id", "is", null)
        .limit(fetchLimit),
  ]);
}

async function fetchKnownUsers(fetchLimit = 1000) {
  return safeSelectRows([
    () =>
      supabase
        .from("kadi_all_known_users")
        .select("wa_id, owner_name, created_at")
        .not("wa_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(fetchLimit),
    () =>
      supabase
        .from("kadi_all_known_users")
        .select("wa_id, created_at")
        .not("wa_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(fetchLimit),
    () =>
      supabase
        .from("kadi_all_known_users")
        .select("wa_id")
        .not("wa_id", "is", null)
        .limit(fetchLimit),
  ]);
}

async function fetchActivityRows(fetchLimit = 1000) {
  return safeSelectRows([
    () =>
      supabase
        .from("kadi_activity")
        .select("wa_id, last_seen, created_at")
        .not("wa_id", "is", null)
        .order("last_seen", { ascending: false })
        .limit(fetchLimit),
    () =>
      supabase
        .from("kadi_activity")
        .select("wa_id, created_at")
        .not("wa_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(fetchLimit),
    () =>
      supabase
        .from("kadi_activity")
        .select("wa_id")
        .not("wa_id", "is", null)
        .limit(fetchLimit),
  ]);
}

function mergeCandidateRow(target, row = {}, source = "unknown") {
  const waId = safeText(row?.wa_id);
  if (!waId) return target;

  const current = target.get(waId) || {
    wa_id: waId,
    owner_name: null,
    created_at: null,
    last_seen: null,
    onboarding_done: false,
    source_flags: {
      business_profile: false,
      known_user: false,
      activity: false,
    },
  };

  const ownerName = safeText(row?.owner_name, null);
  const createdAt = row?.created_at || null;
  const lastSeen = row?.last_seen || row?.created_at || null;

  if (!current.owner_name && ownerName) {
    current.owner_name = ownerName;
  }

  current.created_at = minIso(current.created_at, createdAt) || current.created_at;
  current.last_seen = maxIso(current.last_seen, lastSeen) || current.last_seen;
  current.onboarding_done =
    current.onboarding_done || row?.onboarding_done === true;

  if (source === "business_profile") {
    current.source_flags.business_profile = true;
  }
  if (source === "known_user") {
    current.source_flags.known_user = true;
  }
  if (source === "activity") {
    current.source_flags.activity = true;
  }

  target.set(waId, current);
  return target;
}

async function buildCandidatePool(fetchLimit = 1000) {
  const [profiles, knownUsers, activityRows] = await Promise.all([
    fetchBusinessProfiles(fetchLimit),
    fetchKnownUsers(fetchLimit),
    fetchActivityRows(fetchLimit),
  ]);

  const map = new Map();

  for (const row of profiles || []) {
    mergeCandidateRow(map, row, "business_profile");
  }

  for (const row of knownUsers || []) {
    mergeCandidateRow(map, row, "known_user");
  }

  for (const row of activityRows || []) {
    mergeCandidateRow(map, row, "activity");
  }

  return Array.from(map.values());
}

// ===============================
// DOC LOOKUP
// ===============================
async function getDocumentUsersSet(waIds = []) {
  const ids = uniq(
    (Array.isArray(waIds) ? waIds : [])
      .map((v) => safeText(v))
      .filter(Boolean)
  );

  const set = new Set();
  if (!ids.length) return set;

  for (const batch of chunkArray(ids, 200)) {
    const { data, error } = await supabase
      .from("kadi_documents")
      .select("wa_id")
      .in("wa_id", batch);

    if (error) throw error;

    for (const row of data || []) {
      const waId = safeText(row?.wa_id);
      if (waId) set.add(waId);
    }
  }

  return set;
}

// ===============================
// CREDIT EVENT LOOKUP
// ===============================
async function fetchBusinessProfileMapsByWaIds(waIds = []) {
  const ids = uniq(
    (Array.isArray(waIds) ? waIds : [])
      .map((v) => safeText(v))
      .filter(Boolean)
  );

  const byId = new Map();
  if (!ids.length) return byId;

  for (const batch of chunkArray(ids, 200)) {
    const rows = await safeSelectRows([
      () =>
        supabase
          .from("business_profiles")
          .select("id, wa_id")
          .in("wa_id", batch),
    ]);

    for (const row of rows || []) {
      const profileId = safeText(row?.id);
      const waId = safeText(row?.wa_id);
      if (profileId && waId) byId.set(profileId, waId);
    }
  }

  return byId;
}

async function fetchCreditEventsByWaIds(waIds = []) {
  const ids = uniq(
    (Array.isArray(waIds) ? waIds : [])
      .map((v) => safeText(v))
      .filter(Boolean)
  );

  if (!ids.length) return [];

  const events = [];
  const profileWaIdById = await fetchBusinessProfileMapsByWaIds(ids);
  const profileIds = Array.from(profileWaIdById.keys());

  for (const batch of chunkArray(ids, 200)) {
    const legacyRows = await safeSelectRows([
      () =>
        supabase
          .from("kadi_credit_tx")
          .select("wa_id, delta, reason, created_at")
          .in("wa_id", batch),
    ]);

    for (const row of legacyRows || []) {
      events.push({
        source_table: "legacy_tx",
        wa_id: safeText(row?.wa_id),
        delta: toNum(row?.delta, 0),
        reason: safeText(row?.reason),
        created_at: row?.created_at || null,
        meta: null,
      });
    }
  }

  for (const batch of chunkArray(profileIds, 200)) {
    const ledgerRows = await safeSelectRows([
      () =>
        supabase
          .from("kadi_credit_ledger")
          .select("profile_id, delta, reason, created_at, meta")
          .in("profile_id", batch),
    ]);

    for (const row of ledgerRows || []) {
      const profileId = safeText(row?.profile_id);
      const waId = profileWaIdById.get(profileId) || "";
      if (!waId) continue;

      events.push({
        source_table: "ledger",
        wa_id: waId,
        delta: toNum(row?.delta, 0),
        reason: safeText(row?.reason),
        created_at: row?.created_at || null,
        meta: row?.meta || null,
      });
    }
  }

  return events.filter((row) => row.wa_id && row.created_at);
}

// ===============================
// RE-ENGAGEMENT MEMORY
// ===============================
async function getReengagementStatsByWaIds(waIds = []) {
  const ids = uniq(
    (Array.isArray(waIds) ? waIds : [])
      .map((v) => safeText(v))
      .filter(Boolean)
  );

  const map = new Map();
  if (!ids.length) return map;

  for (const batch of chunkArray(ids, 200)) {
    const { data, error } = await supabase
      .from("kadi_reengagement_log")
      .select("wa_id, campaign_type, sent_at, created_at, status")
      .in("wa_id", batch)
      .order("sent_at", { ascending: false });

    if (error) throw error;

    for (const row of data || []) {
      const waId = safeText(row?.wa_id);
      const sentAt = row?.sent_at || row?.created_at || null;
      const status = row?.status || null;

      if (!waId || !sentAt) continue;
      if (!isSentLikeStatus(status)) continue;

      const current = map.get(waId) || {
        last_reengagement_at: null,
        reengagement_count: 0,
      };

      current.reengagement_count += 1;

      if (
        !current.last_reengagement_at ||
        toDateMs(sentAt) > toDateMs(current.last_reengagement_at)
      ) {
        current.last_reengagement_at = sentAt;
      }

      map.set(waId, current);
    }
  }

  return map;
}

async function getReengagementStatsByWaIdsAndCampaign(
  waIds = [],
  campaignType = null
) {
  const ids = uniq(
    (Array.isArray(waIds) ? waIds : [])
      .map((v) => safeText(v))
      .filter(Boolean)
  );
  const safeCampaignType = safeText(campaignType);

  const map = new Map();
  if (!ids.length || !safeCampaignType) return map;

  for (const batch of chunkArray(ids, 200)) {
    const { data, error } = await supabase
      .from("kadi_reengagement_log")
      .select("wa_id, campaign_type, sent_at, created_at, status")
      .in("wa_id", batch)
      .eq("campaign_type", safeCampaignType)
      .order("sent_at", { ascending: false });

    if (error) throw error;

    for (const row of data || []) {
      const waId = safeText(row?.wa_id);
      const sentAt = row?.sent_at || row?.created_at || null;
      const status = row?.status || null;

      if (!waId || !sentAt) continue;
      if (!isSentLikeStatus(status)) continue;

      const current = map.get(waId) || {
        last_reengagement_at: null,
        reengagement_count: 0,
      };

      current.reengagement_count += 1;

      if (
        !current.last_reengagement_at ||
        toDateMs(sentAt) > toDateMs(current.last_reengagement_at)
      ) {
        current.last_reengagement_at = sentAt;
      }

      map.set(waId, current);
    }
  }

  return map;
}

function enrichUsersWithRotationStats(users = [], reengagementMap = new Map()) {
  return (Array.isArray(users) ? users : []).map((u) => {
    const stats = reengagementMap.get(u.wa_id) || null;
    const lastAt = stats?.last_reengagement_at || null;

    return {
      ...u,
      last_reengagement_at: lastAt,
      reengagement_count: Number(stats?.reengagement_count || 0),
      days_since_reengagement: lastAt ? daysSince(lastAt) : 9999,
    };
  });
}

function applyRotationFilters(
  users = [],
  { cooldownDays = 7, excludeWaIds = [] } = {}
) {
  const excluded = normalizeExcludeSet(excludeWaIds);
  const safeCooldown = Math.max(0, Number(cooldownDays) || 0);

  return (Array.isArray(users) ? users : []).filter((u) => {
    const waId = safeText(u?.wa_id);
    if (!waId) return false;
    if (excluded.has(waId)) return false;

    const lastAt = u?.last_reengagement_at || null;
    if (!lastAt) return true;

    return daysSince(lastAt) >= safeCooldown;
  });
}

// ===============================
// RANKING
// ===============================
function rankZeroDocUsers(users = []) {
  return [...(Array.isArray(users) ? users : [])].sort((a, b) => {
    const aNever = !a.last_reengagement_at;
    const bNever = !b.last_reengagement_at;

    if (aNever !== bNever) return aNever ? -1 : 1;

    const byOldestReengagement = compareIsoAsc(
      a.last_reengagement_at,
      b.last_reengagement_at
    );
    if (byOldestReengagement !== 0) return byOldestReengagement;

    const byRecentSignup =
      Number(a.days_since_signup || 9999) - Number(b.days_since_signup || 9999);
    if (byRecentSignup !== 0) return byRecentSignup;

    return String(a.wa_id).localeCompare(String(b.wa_id));
  });
}

function rankInactiveUsers(users = []) {
  return [...(Array.isArray(users) ? users : [])].sort((a, b) => {
    const aNever = !a.last_reengagement_at;
    const bNever = !b.last_reengagement_at;

    if (aNever !== bNever) return aNever ? -1 : 1;

    const byOldestReengagement = compareIsoAsc(
      a.last_reengagement_at,
      b.last_reengagement_at
    );
    if (byOldestReengagement !== 0) return byOldestReengagement;

    const byMoreRecentlyInactive =
      Number(a.days_inactive || 9999) - Number(b.days_inactive || 9999);
    if (byMoreRecentlyInactive !== 0) return byMoreRecentlyInactive;

    return String(a.wa_id).localeCompare(String(b.wa_id));
  });
}

function rankRecentActiveZeroDocUsers(users = []) {
  return [...(Array.isArray(users) ? users : [])].sort((a, b) => {
    const aNever = !a.last_reengagement_at;
    const bNever = !b.last_reengagement_at;

    if (aNever !== bNever) return aNever ? -1 : 1;

    const byOldestReengagement = compareIsoAsc(
      a.last_reengagement_at,
      b.last_reengagement_at
    );
    if (byOldestReengagement !== 0) return byOldestReengagement;

    const byRecentActivity = compareIsoAsc(
      b.last_activity_at,
      a.last_activity_at
    );
    if (byRecentActivity !== 0) return byRecentActivity;

    return String(a.wa_id).localeCompare(String(b.wa_id));
  });
}

function rankExhaustedCreditUsers(users = []) {
  return [...(Array.isArray(users) ? users : [])].sort((a, b) => {
    const aNever = !a.last_reengagement_at;
    const bNever = !b.last_reengagement_at;

    if (aNever !== bNever) return aNever ? -1 : 1;

    const byOldestReengagement = compareIsoAsc(
      a.last_reengagement_at,
      b.last_reengagement_at
    );
    if (byOldestReengagement !== 0) return byOldestReengagement;

    const byRecentExhaustion = compareIsoAsc(b.exhausted_at, a.exhausted_at);
    if (byRecentExhaustion !== 0) return byRecentExhaustion;

    return String(a.wa_id).localeCompare(String(b.wa_id));
  });
}

function buildExhaustedCreditCandidate(user, events = []) {
  const sorted = [...(Array.isArray(events) ? events : [])].sort((a, b) =>
    compareIsoAsc(a.created_at, b.created_at)
  );

  let balance = 0;
  let hasDocumentConsumption = false;
  let exhaustedAt = null;
  let rechargedAfterExhaustion = false;

  for (const row of sorted) {
    if (isExcludedCreditEvent(row)) continue;

    const before = balance;
    const delta = toNum(row?.delta, 0);
    balance += delta;

    if (isDocumentConsumptionTx(row)) {
      hasDocumentConsumption = true;
      if (before > 0 && balance === 0) {
        exhaustedAt = row.created_at || null;
        rechargedAfterExhaustion = false;
      }
    }

    if (
      exhaustedAt &&
      row.created_at &&
      String(row.created_at) > String(exhaustedAt) &&
      isRealRechargeTx(row)
    ) {
      rechargedAfterExhaustion = true;
    }
  }

  if (balance !== 0) return null;
  if (!hasDocumentConsumption) return null;
  if (!exhaustedAt) return null;
  if (rechargedAfterExhaustion) return null;

  return {
    wa_id: user.wa_id,
    owner_name: user.owner_name || null,
    created_at: user.created_at || null,
    last_activity_at: user.last_seen || user.created_at || null,
    exhausted_at: exhaustedAt,
    balance,
  };
}

// ===============================
// LOGGING
// ===============================
async function logReengagementSend({
  waId,
  campaignType,
  templateName = null,
  messageMode = null,
  status = "sent",
  cycleKey = null,
  meta = {},
}) {
  const safeWaId = safeText(waId);
  if (!safeWaId) throw new Error("REENGAGEMENT_WA_ID_REQUIRED");

  const { error } = await supabase.from("kadi_reengagement_log").insert([
    {
      wa_id: safeWaId,
      campaign_type: safeText(campaignType, "unknown"),
      template_name: templateName ? safeText(templateName) : null,
      message_mode: messageMode ? safeText(messageMode) : null,
      status: safeText(status, "sent"),
      cycle_key: cycleKey ? safeText(cycleKey) : null,
      sent_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      meta: meta && typeof meta === "object" ? meta : {},
    },
  ]);

  if (error) throw error;
  return true;
}

// ===============================
// ZERO DOC USERS
// ===============================
async function getZeroDocUsersBySegment(
  variant = "A",
  limit = 50,
  options = {}
) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
  const cooldownDays = Math.max(0, Number(options?.cooldownDays) || 7);
  const excludeWaIds = Array.isArray(options?.excludeWaIds)
    ? options.excludeWaIds
    : [];
  const fetchLimit = Math.min(Math.max(safeLimit * 25, 300), 5000);

  const candidates = await buildCandidatePool(fetchLimit);
  if (!candidates.length) return [];

  const docUsers = await getDocumentUsersSet(candidates.map((u) => u.wa_id));

  const filtered = candidates
    .filter((u) => !docUsers.has(u.wa_id))
    .filter((u) => splitAB(u.wa_id, variant))
    .map((u) => ({
      ...u,
      days_since_signup: daysSince(u.created_at),
    }));

  if (!filtered.length) return [];

  const reengagementMap = await getReengagementStatsByWaIds(
    filtered.map((u) => u.wa_id)
  );

  const enriched = enrichUsersWithRotationStats(filtered, reengagementMap);
  const eligible = applyRotationFilters(enriched, {
    cooldownDays,
    excludeWaIds,
  });

  return rankZeroDocUsers(eligible).slice(0, safeLimit);
}

// ===============================
// INACTIVE USERS
// ===============================
async function getInactiveUsers(days = 7, limit = 50, options = {}) {
  const safeDays = Math.max(1, Number(days) || 7);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
  const cooldownDays = Math.max(0, Number(options?.cooldownDays) || 7);
  const excludeWaIds = Array.isArray(options?.excludeWaIds)
    ? options.excludeWaIds
    : [];
  const fetchLimit = Math.min(Math.max(safeLimit * 25, 300), 5000);

  const cutoffMs = Date.now() - safeDays * 24 * 60 * 60 * 1000;

  const candidates = await buildCandidatePool(fetchLimit);
  if (!candidates.length) return [];

  const inactive = candidates
    .map((u) => {
      const lastActivityAt = u.last_seen || u.created_at || null;
      const lastActivityMs = toDateMs(lastActivityAt);

      return {
        wa_id: u.wa_id,
        owner_name: u.owner_name || null,
        created_at: u.created_at || null,
        onboarding_done: u.onboarding_done === true,
        last_activity_at: lastActivityAt,
        days_inactive: lastActivityAt ? daysSince(lastActivityAt) : 9999,
      };
    })
    .filter((u) => {
      const ts = toDateMs(u.last_activity_at);
      if (ts == null) return true;
      return ts < cutoffMs;
    });

  if (!inactive.length) return [];

  const reengagementMap = await getReengagementStatsByWaIds(
    inactive.map((u) => u.wa_id)
  );

  const enriched = enrichUsersWithRotationStats(inactive, reengagementMap);
  const eligible = applyRotationFilters(enriched, {
    cooldownDays,
    excludeWaIds,
  });

  return rankInactiveUsers(eligible).slice(0, safeLimit);
}

// ===============================
// RECENT ACTIVE ZERO DOC USERS
// ===============================
async function getRecentActiveZeroDocUsers(limit = 20, options = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 20));
  const activeDays = Math.max(1, Number(options?.activeDays) || 30);
  const cooldownDays = Math.max(0, Number(options?.cooldownDays) || 7);
  const excludeWaIds = Array.isArray(options?.excludeWaIds)
    ? options.excludeWaIds
    : [];
  const fetchLimit = Math.min(Math.max(safeLimit * 50, 300), 5000);
  const cutoffMs = Date.now() - activeDays * 24 * 60 * 60 * 1000;

  const activityRows = await fetchActivityRows(fetchLimit);
  if (!activityRows.length) return [];

  const recentActive = activityRows
    .map((row) => {
      const waId = safeText(row?.wa_id);
      const lastActivityAt = row?.last_seen || row?.created_at || null;

      return {
        wa_id: waId,
        owner_name: row?.owner_name || null,
        created_at: row?.created_at || null,
        last_activity_at: lastActivityAt,
        days_since_activity: lastActivityAt ? daysSince(lastActivityAt) : 9999,
      };
    })
    .filter((u) => {
      const ts = toDateMs(u.last_activity_at);
      return isValidWaId(u.wa_id) && ts != null && ts >= cutoffMs;
    });

  if (!recentActive.length) return [];

  const docUsers = await getDocumentUsersSet(recentActive.map((u) => u.wa_id));
  const zeroDoc = recentActive.filter((u) => !docUsers.has(u.wa_id));

  if (!zeroDoc.length) return [];

  const reengagementMap = await getReengagementStatsByWaIds(
    zeroDoc.map((u) => u.wa_id)
  );

  const enriched = enrichUsersWithRotationStats(zeroDoc, reengagementMap);
  const eligible = applyRotationFilters(enriched, {
    cooldownDays,
    excludeWaIds,
  });

  return rankRecentActiveZeroDocUsers(eligible).slice(0, safeLimit);
}

// ===============================
// EXHAUSTED CREDIT USERS
// ===============================
async function getExhaustedCreditUsers(limit = 10, options = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 500));
  const cooldownDays = Math.max(0, Number(options?.cooldownDays) || 7);
  const excludeWaIds = uniq([
    ...getDefaultExcludedWaIds(),
    ...(Array.isArray(options?.excludeWaIds) ? options.excludeWaIds : []),
  ]);
  const fetchLimit = Math.min(Math.max(safeLimit * 50, 300), 5000);

  const candidates = (await buildCandidatePool(fetchLimit)).filter((u) =>
    isValidWaId(u.wa_id)
  );

  if (!candidates.length) return [];

  const events = await fetchCreditEventsByWaIds(candidates.map((u) => u.wa_id));
  if (!events.length) return [];

  const eventsByWaId = new Map();
  for (const row of events) {
    const waId = safeText(row?.wa_id);
    if (!waId) continue;
    const rows = eventsByWaId.get(waId) || [];
    rows.push(row);
    eventsByWaId.set(waId, rows);
  }

  const exhausted = candidates
    .map((user) =>
      buildExhaustedCreditCandidate(user, eventsByWaId.get(user.wa_id) || [])
    )
    .filter(Boolean);

  if (!exhausted.length) return [];

  const reengagementMap = await getReengagementStatsByWaIdsAndCampaign(
    exhausted.map((u) => u.wa_id),
    "exhausted_credits"
  );

  const enriched = enrichUsersWithRotationStats(exhausted, reengagementMap);
  const eligible = applyRotationFilters(enriched, {
    cooldownDays,
    excludeWaIds,
  });

  return rankExhaustedCreditUsers(eligible).slice(0, safeLimit);
}

module.exports = {
  getZeroDocUsersBySegment,
  getInactiveUsers,
  getRecentActiveZeroDocUsers,
  getExhaustedCreditUsers,
  logReengagementSend,
  _private: {
    buildExhaustedCreditCandidate,
    getDefaultExcludedWaIds,
    isDocumentConsumptionTx,
    isExcludedCreditEvent,
    isRealRechargeTx,
  },
};
