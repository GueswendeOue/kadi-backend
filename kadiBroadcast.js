// kadiBroadcast.js
"use strict";

const { getBroadcastRecipients } = require("./kadiBroadcastRepo");
const { sendText } = require("./whatsappApi");

const BROADCAST_BATCH = Number(process.env.BROADCAST_BATCH || 20);
const BROADCAST_DELAY_MS = Number(process.env.BROADCAST_DELAY_MS || 900);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isValidWhatsAppId(id) {
  return /^\d+$/.test(String(id || "")) && String(id).length >= 8 && String(id).length <= 15;
}

async function broadcastToAll({ adminWaId, message, limit = 5000 } = {}) {
  const msg = String(message || "").trim();
  if (!msg) throw new Error("broadcastToAll: message vide");

  const recipients = await getBroadcastRecipients({ limit });
  const targets = recipients.filter(isValidWhatsAppId);

  // feedback admin
  if (adminWaId) {
    await sendText(
      adminWaId,
      `📢 *Broadcast*\nDestinataires: ${targets.length}\nBatch=${BROADCAST_BATCH} • Delay=${BROADCAST_DELAY_MS}ms\n\n✅ Lancement...`
    );
  }

  let sent = 0;
  let failed = 0;

  // envoi par batch
  for (let i = 0; i < targets.length; i += BROADCAST_BATCH) {
    const chunk = targets.slice(i, i + BROADCAST_BATCH);

    // envoi séquentiel (plus safe pour WA)
    for (const to of chunk) {
      try {
        await sendText(to, msg);
        sent += 1;
      } catch (e) {
        failed += 1;
        // on continue
      }
      await sleep(250); // micro-delay par message (réduit le risque de rate-limit)
    }

    // pause entre batches
    await sleep(BROADCAST_DELAY_MS);

    if (adminWaId) {
      await sendText(adminWaId, `📢 Progress: ${Math.min(i + BROADCAST_BATCH, targets.length)}/${targets.length} (OK=${sent} • KO=${failed})`);
    }
  }

  if (adminWaId) {
    await sendText(adminWaId, `✅ Broadcast terminé.\nOK=${sent} • KO=${failed}`);
  }

  return { ok: true, sent, failed, total: targets.length };
}

module.exports = { broadcastToAll };