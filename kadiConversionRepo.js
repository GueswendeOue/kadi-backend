"use strict";

const { supabase } = require("./supabaseClient");

const CONVERSION_TABLE = "kadi_conversion_events";

function safeText(v, def = null) {
  const s = String(v ?? "").trim();
  return s || def;
}

function clampLimit(limit, min = 1, max = 1000, fallback = 100) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.trunc(n), max));
}

function normalizeMeta(meta = {}) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return {};
  }
  return meta;
}

async function trackConversionEvent({
  waId,
  eventKey,
  requestId = null,
  docType = null,
  docNumber = null,
  source = null,
  meta = {},
}) {
  const payload = {
    wa_id: safeText(waId, null),
    event_key: safeText(eventKey, null),
    request_id: safeText(requestId, null),
    doc_type: safeText(docType, null),
    doc_number: safeText(docNumber, null),
    source: safeText(source, null),
    meta: normalizeMeta(meta),
  };

  if (!payload.wa_id) {
    throw new Error("CONVERSION_WA_ID_REQUIRED");
  }

  if (!payload.event_key) {
    throw new Error("CONVERSION_EVENT_KEY_REQUIRED");
  }

  const { data, error } = await supabase
    .from(CONVERSION_TABLE)
    .insert(payload)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function listConversionEvents({
  waId = null,
  eventKeys = [],
  fromIso = null,
  toIso = null,
  limit = 100,
  ascending = false,
} = {}) {
  let query = supabase
    .from(CONVERSION_TABLE)
    .select("*")
    .order("created_at", { ascending })
    .limit(clampLimit(limit, 1, 1000, 100));

  const safeWaId = safeText(waId, null);
  if (safeWaId) {
    query = query.eq("wa_id", safeWaId);
  }

  const safeEventKeys = Array.isArray(eventKeys)
    ? eventKeys.map((x) => safeText(x, null)).filter(Boolean)
    : [];

  if (safeEventKeys.length) {
    query = query.in("event_key", safeEventKeys);
  }

  const safeFrom = safeText(fromIso, null);
  if (safeFrom) {
    query = query.gte("created_at", safeFrom);
  }

  const safeTo = safeText(toIso, null);
  if (safeTo) {
    query = query.lte("created_at", safeTo);
  }

  const { data, error } = await query;
  if (error) throw error;

  return Array.isArray(data) ? data : [];
}

module.exports = {
  trackConversionEvent,
  listConversionEvents,
};