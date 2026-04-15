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
        owner_name: row?.owner_name || null, // ✅ IMPORTANT
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
  return Math.floor((Date.now() - new Date(date).getTime()) / (24 * 60 * 60 * 1000));
}

// ===============================
// ZERO DOC USERS (🔥 HIGH VALUE)
// ===============================
async function getZeroDocUsersBySegment(variant = "A", limit = 50) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));

  const { data: profiles, error: profilesError } = await supabase
    .from("business_profiles")
    .select("wa_id, owner_name, onboarding_done, created_at")
    .not("wa_id", "is", null)
    .eq("onboarding_done", true)
    .order("created_at", { ascending: false })
    .limit(safeLimit * 10);

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

  // 🔥 filtre + scoring
  const filtered = users
    .filter((u) => !docUsers.has(u.wa_id))
    .map((u) => ({
      ...u,
      days_since_signup: daysSince(u.created_at),
    }));

  // 🔥 PRIORITÉ nouveaux users (GROWTH)
  filtered.sort((a, b) => a.days_since_signup - b.days_since_signup);

  const segmented = filtered.filter((u) => splitAB(u.wa_id, variant));

  return segmented.slice(0, safeLimit);
}

// ===============================
// INACTIVE USERS
// ===============================
async function getInactiveUsers(days = 7, limit = 50) {
  const safeDays = Math.max(1, Number(days) || 7);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
  const cutoff = new Date(
    Date.now() - safeDays * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data: profiles, error: profilesError } = await supabase
    .from("business_profiles")
    .select("wa_id, owner_name, onboarding_done, created_at")
    .not("wa_id", "is", null)
    .eq("onboarding_done", true)
    .limit(safeLimit * 10);

  if (profilesError) throw profilesError;

  const users = uniqWaRows(profiles || []);
  if (!users.length) return [];

  const waIds = users.map((u) => u.wa_id);

  const { data: activity, error: activityError } = await supabase
    .from("kadi_activity")
    .select("wa_id, created_at") // ✅ FIX IMPORTANT
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
        last_activity_at: last,
        days_inactive: last ? daysSince(last) : 9999,
      };
    })
    .filter((u) => {
      if (!u.last_activity_at) return true;
      return String(u.last_activity_at) < cutoff;
    });

  // 🔥 PRIORITÉ users récemment perdus (meilleur retour)
  inactive.sort((a, b) => a.days_inactive - b.days_inactive);

  return inactive.slice(0, safeLimit);
}

module.exports = {
  getZeroDocUsersBySegment,
  getInactiveUsers,
};