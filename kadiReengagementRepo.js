"use strict";

const { supabase } = require("./supabaseClient");

function uniqWaRows(rows = []) {
  const map = new Map();

  for (const row of rows || []) {
    const waId = String(row?.wa_id || "").trim();
    if (!waId) continue;

    if (!map.has(waId)) {
      map.set(waId, { wa_id: waId });
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

  return last % 2 === 0;
}

async function getZeroDocUsersBySegment(limit = 50, variant = "A") {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));

  const { data: profiles, error: profilesError } = await supabase
    .from("business_profiles")
    .select("wa_id, onboarding_done, created_at")
    .not("wa_id", "is", null)
    .eq("onboarding_done", true)
    .order("created_at", { ascending: false })
    .limit(safeLimit * 6);

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

  const filtered = users.filter((u) => !docUsers.has(u.wa_id));
  const segmented = filtered.filter((u) => splitAB(u.wa_id, variant));

  return segmented.slice(0, safeLimit);
}

async function getInactiveUsers(days = 7, limit = 50) {
  const safeDays = Math.max(1, Number(days) || 7);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
  const cutoff = new Date(
    Date.now() - safeDays * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data: profiles, error: profilesError } = await supabase
    .from("business_profiles")
    .select("wa_id, onboarding_done, created_at")
    .not("wa_id", "is", null)
    .eq("onboarding_done", true)
    .order("created_at", { ascending: false })
    .limit(safeLimit * 8);

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

  const inactive = users.filter((u) => {
    const last = lastActivityByWa.get(u.wa_id);
    if (!last) return true;
    return String(last) < cutoff;
  });

  return inactive.slice(0, safeLimit);
}

module.exports = {
  getZeroDocUsersBySegment,
  getInactiveUsers,
};