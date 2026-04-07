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
  return (
    profile?.profession_category ||
    profile?.business_sector ||
    null
  );
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
        "profession_category",
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
// Users ayant au moins 1 doc mais pas d’activité récente
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
    }))
    .slice(0, max * 3); // buffer avant enrichissement profil

  if (!inactiveWaIds.length) return [];

  const waIds = inactiveWaIds.map((u) => u.wa_id);

  const { data: profiles, error: profilesError } = await supabase
    .from("business_profiles")
    .select("wa_id, profession_category, business_sector, business_name, owner_name")
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
  getZeroDocUsersBySegment,
  getInactiveUsers,
};