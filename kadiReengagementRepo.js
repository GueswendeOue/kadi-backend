"use strict";

const { supabase } = require("./supabaseClient");

// ===============================
// UTILS
// ===============================
function uniqWaRows(rows = []) {
  const map = new Map();

  for (const row of rows || []) {
    const waId = String(row?.wa_id || "").trim();
    if (!waId) continue;

    if (!map.has(waId)) {
      map.set(waId, {
        wa_id: waId,
        owner_name: row?.owner_name || null,
        created_at: row?.created_at || null,
      });
    }
  }

  return Array.from(map.values());
}

function splitAB(waId, variant = "A") {
  const digits = String(waId || "").replace(/\D/g, "");
  const last = digits ? Number(digits[digits.length - 1]) : 0;

  if (String(variant).toUpperCase() === "B") {
    return last % 2 === 1;
  }

  if (String(variant).toUpperCase() === "C") {
    return last % 3 === 0;
  }

  return last % 2 === 0;
}

function daysSince(date) {
  if (!date) return 9999;

  const ts = new Date(date).getTime();
  if (!Number.isFinite(ts) || ts <= 0) return 9999;

  return Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000));
}

function compareIsoAsc(a, b) {
  const ta = a ? new Date(a).getTime() : null;
  const tb = b ? new Date(b).getTime() : null;

  if (ta == null && tb == null) return 0;
  if (ta == null) return -1;
  if (tb == null) return 1;

  return ta - tb;
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
      .map((v) => String(v || "").trim())
      .filter(Boolean)
  );
}

// ===============================
// RE-ENGAGEMENT MEMORY
// ===============================
async function getReengagementStatsByWaIds(waIds = []) {
  const ids = Array.from(
    new Set(
      (Array.isArray(waIds) ? waIds : [])
        .map((v) => String(v || "").trim())
        .filter(Boolean)
    )
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
      const waId = String(row?.wa_id || "").trim();
      const sentAt = row?.sent_at || row?.created_at || null;
      if (!waId || !sentAt) continue;

      const current = map.get(waId) || {
        last_reengagement_at: null,
        reengagement_count: 0,
      };

      current.reengagement_count += 1;

      if (
        !current.last_reengagement_at ||
        new Date(sentAt).getTime() > new Date(current.last_reengagement_at).getTime()
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
    const waId = String(u?.wa_id || "").trim();
    if (!waId) return false;
    if (excluded.has(waId)) return false;

    const lastAt = u?.last_reengagement_at || null;
    if (!lastAt) return true;

    return daysSince(lastAt) >= safeCooldown;
  });
}

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

    const bySignupFreshness =
      Number(a.days_since_signup || 9999) - Number(b.days_since_signup || 9999);
    if (bySignupFreshness !== 0) return bySignupFreshness;

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

    const byRecentlyLost =
      Number(a.days_inactive || 9999) - Number(b.days_inactive || 9999);
    if (byRecentlyLost !== 0) return byRecentlyLost;

    return String(a.wa_id).localeCompare(String(b.wa_id));
  });
}

async function logReengagementSend({
  waId,
  campaignType,
  templateName = null,
  messageMode = null,
  status = "sent",
  cycleKey = null,
  meta = {},
}) {
  const safeWaId = String(waId || "").trim();
  if (!safeWaId) throw new Error("REENGAGEMENT_WA_ID_REQUIRED");

  const { error } = await supabase.from("kadi_reengagement_log").insert([
    {
      wa_id: safeWaId,
      campaign_type: String(campaignType || "").trim() || "unknown",
      template_name: templateName ? String(templateName).trim() : null,
      message_mode: messageMode ? String(messageMode).trim() : null,
      status: String(status || "sent").trim(),
      cycle_key: cycleKey ? String(cycleKey).trim() : null,
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
  const fetchLimit = Math.min(Math.max(safeLimit * 20, 200), 5000);

  const { data: profiles, error: profilesError } = await supabase
    .from("business_profiles")
    .select("wa_id, owner_name, onboarding_done, created_at")
    .not("wa_id", "is", null)
    .eq("onboarding_done", true)
    .order("created_at", { ascending: false })
    .limit(fetchLimit);

  if (profilesError) throw profilesError;

  const users = uniqWaRows(profiles || []);
  if (!users.length) return [];

  const waIds = users.map((u) => u.wa_id);

  const { data: docs, error: docsError } = await supabase
    .from("kadi_documents")
    .select("wa_id")
    .in("wa_id", waIds);

  if (docsError) throw docsError;

  const docUsers = new Set(
    (docs || []).map((d) => String(d?.wa_id || "").trim()).filter(Boolean)
  );

  const filtered = users
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
  const fetchLimit = Math.min(Math.max(safeLimit * 20, 200), 5000);

  const cutoff = new Date(
    Date.now() - safeDays * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data: profiles, error: profilesError } = await supabase
    .from("business_profiles")
    .select("wa_id, owner_name, onboarding_done, created_at")
    .not("wa_id", "is", null)
    .eq("onboarding_done", true)
    .order("created_at", { ascending: false })
    .limit(fetchLimit);

  if (profilesError) throw profilesError;

  const users = uniqWaRows(profiles || []);
  if (!users.length) return [];

  const waIds = users.map((u) => u.wa_id);

  const { data: activity, error: activityError } = await supabase
    .from("kadi_activity")
    .select("wa_id, created_at")
    .in("wa_id", waIds)
    .order("created_at", { ascending: false });

  if (activityError) throw activityError;

  const lastActivityByWa = new Map();

  for (const row of activity || []) {
    const waId = String(row?.wa_id || "").trim();
    const createdAt = row?.created_at || null;

    if (!waId || !createdAt) continue;
    if (!lastActivityByWa.has(waId)) {
      lastActivityByWa.set(waId, createdAt);
    }
  }

  const inactive = users
    .map((u) => {
      const last = lastActivityByWa.get(u.wa_id) || null;

      return {
        wa_id: u.wa_id,
        owner_name: u.owner_name,
        created_at: u.created_at || null,
        last_activity_at: last,
        days_inactive: last ? daysSince(last) : 9999,
      };
    })
    .filter((u) => {
      if (!u.last_activity_at) return true;
      return String(u.last_activity_at) < cutoff;
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

module.exports = {
  getZeroDocUsersBySegment,
  getInactiveUsers,
  logReengagementSend,
};