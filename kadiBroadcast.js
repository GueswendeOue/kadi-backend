// kadiBroadcast.js
"use strict";

const { createClient } = require("@supabase/supabase-js");

const {
  sendText,
  uploadMediaBuffer,
  sendImage,
} = require("./whatsappApi");

// ================= Config =================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants dans .env");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const BROADCAST_DELAY_MS = Number(process.env.BROADCAST_DELAY_MS || 450);
const BROADCAST_BATCH = Number(process.env.BROADCAST_BATCH || 25);

// ================= Utils =================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidWhatsAppId(id) {
  return /^\d+$/.test(String(id || "").trim()) &&
    String(id || "").trim().length >= 8 &&
    String(id || "").trim().length <= 15;
}

function uniqueWaIds(rows = []) {
  const set = new Set();

  for (const row of rows) {
    const waId = String(row?.wa_id || "").trim();
    if (isValidWhatsAppId(waId)) set.add(waId);
  }

  return Array.from(set);
}

/**
 * audience:
 * - "all_known"  => vue kadi_all_known_users
 * - "active_30d" => vue kadi_active_users_30d
 */
async function getAudience(audience = "all_known") {
  const source =
    audience === "active_30d"
      ? "kadi_active_users_30d"
      : "kadi_all_known_users";

  const all = [];
  let from = 0;

  while (true) {
    const to = from + BROADCAST_BATCH - 1;

    const { data, error } = await supabase
      .from(source)
      .select("wa_id")
      .range(from, to);

    if (error) {
      throw new Error(`Erreur audience (${source}): ${error.message}`);
    }

    if (!data || !data.length) break;

    all.push(...data);

    if (data.length < BROADCAST_BATCH) break;
    from += BROADCAST_BATCH;
  }

  return uniqueWaIds(all);
}

async function sendBroadcastSummary(adminWaId, result) {
  if (!adminWaId) return;

  const lines = [
    "✅ Broadcast terminé",
    `👥 Audience: ${result.total}`,
    `📤 Envoyés: ${result.sent}`,
    `❌ Échecs: ${result.failed}`,
    `🎯 Cible: ${result.audience}`,
  ];

  if (result.failedIds?.length) {
    lines.push("");
    lines.push("Exemples d'échecs :");
    lines.push(result.failedIds.slice(0, 10).join(", "));
  }

  await sendText(adminWaId, lines.join("\n"));
}

/**
 * Broadcast texte
 */
async function broadcastToAll({
  adminWaId,
  message,
  audience = "all_known",
}) {
  const msg = String(message || "").trim();
  if (!msg) {
    throw new Error("broadcastToAll: message vide");
  }

  const recipients = await getAudience(audience);

  let sent = 0;
  let failed = 0;
  const failedIds = [];

  for (const waId of recipients) {
    try {
      await sendText(waId, msg);
      sent++;
    } catch (e) {
      failed++;
      failedIds.push(waId);
      console.warn("[BROADCAST/TEXT] send fail:", waId, e?.message);
    }

    await sleep(BROADCAST_DELAY_MS);
  }

  const result = {
    audience,
    total: recipients.length,
    sent,
    failed,
    failedIds,
  };

  await sendBroadcastSummary(adminWaId, result);
  return result;
}

/**
 * Broadcast image
 */
async function broadcastImageToAll({
  adminWaId,
  imageBuffer,
  mimeType = "image/jpeg",
  filename = "broadcast.jpg",
  caption = "",
  audience = "all_known",
}) {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
    throw new Error("broadcastImageToAll: imageBuffer invalide");
  }

  const recipients = await getAudience(audience);

  const up = await uploadMediaBuffer({
    buffer: imageBuffer,
    filename,
    mimeType,
  });

  if (!up?.id) {
    throw new Error("broadcastImageToAll: upload média échoué");
  }

  let sent = 0;
  let failed = 0;
  const failedIds = [];

  for (const waId of recipients) {
    try {
      await sendImage({
        to: waId,
        mediaId: up.id,
        caption: String(caption || ""),
      });
      sent++;
    } catch (e) {
      failed++;
      failedIds.push(waId);
      console.warn("[BROADCAST/IMAGE] send fail:", waId, e?.message);
    }

    await sleep(BROADCAST_DELAY_MS);
  }

  const result = {
    audience,
    total: recipients.length,
    sent,
    failed,
    failedIds,
  };

  await sendBroadcastSummary(adminWaId, result);
  return result;
}

module.exports = {
  getAudience,
  broadcastToAll,
  broadcastImageToAll,
};