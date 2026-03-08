// kadiBroadcast.js
"use strict";

const fs = require("fs");
const path = require("path");
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
 * Récupère toute l'audience depuis business_profiles
 * Ajuste ici si un jour tu veux filtrer seulement les users "actifs"
 */
async function getAudience() {
  const all = [];
  let from = 0;

  while (true) {
    const to = from + BROADCAST_BATCH - 1;

    const { data, error } = await supabase
      .from("business_profiles")
      .select("wa_id")
      .range(from, to);

    if (error) {
      throw new Error(`Erreur audience: ${error.message}`);
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
async function broadcastToAll({ adminWaId, message }) {
  const msg = String(message || "").trim();
  if (!msg) {
    throw new Error("broadcastToAll: message vide");
  }

  const audience = await getAudience();

  let sent = 0;
  let failed = 0;
  const failedIds = [];

  for (const waId of audience) {
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
    total: audience.length,
    sent,
    failed,
    failedIds,
  };

  await sendBroadcastSummary(adminWaId, result);
  return result;
}

/**
 * Broadcast image depuis un mediaId déjà reçu sur WhatsApp
 * -> on télécharge l'image reçue
 * -> on la ré-upload UNE seule fois
 * -> on l'envoie à tous
 */
async function broadcastImageToAll({
  adminWaId,
  imageBuffer,
  mimeType = "image/jpeg",
  filename = "broadcast.jpg",
  caption = "",
}) {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
    throw new Error("broadcastImageToAll: imageBuffer invalide");
  }

  const audience = await getAudience();

  // Upload une seule fois sur WhatsApp
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

  for (const waId of audience) {
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
    total: audience.length,
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