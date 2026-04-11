"use strict";

function toNum(v, def = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : def;
}

function daysBetween(dateIso) {
  if (!dateIso) return 9999;
  const ts = new Date(dateIso).getTime();
  if (!Number.isFinite(ts)) return 9999;
  return Math.floor((Date.now() - ts) / 86400000);
}

function classifyUser({
  profile = null,
  activity = null,
  docsCreated = 0,
  docsGenerated = 0,
  hasPaid = false,
}) {
  const sinceLastSeen = daysBetween(activity?.last_seen || profile?.created_at);
  const sinceCreated = daysBetween(profile?.created_at);

  if (hasPaid && docsGenerated >= 3) {
    return "paying_user";
  }

  if (docsGenerated >= 10) {
    return "power_user";
  }

  if (docsCreated > 0 && docsGenerated === 0) {
    return "stuck_before_pdf";
  }

  if (docsGenerated >= 1 && sinceLastSeen <= 7) {
    return "activated";
  }

  if (docsGenerated >= 1 && sinceLastSeen > 7 && sinceLastSeen <= 30) {
    return "at_risk";
  }

  if (sinceLastSeen > 30 && (docsCreated > 0 || docsGenerated > 0)) {
    return "churn_risk";
  }

  if (sinceCreated <= 7 && docsGenerated === 0) {
    return "new_user";
  }

  return "inactive";
}

module.exports = {
  classifyUser,
};