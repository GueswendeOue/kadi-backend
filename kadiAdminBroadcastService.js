"use strict";

function makeKadiAdminBroadcastService(deps) {
  const {
    sendText,
    broadcastToAllKnownUsers,
  } = deps;

  async function handleBroadcastCommand(from, rawText) {
    const msg = String(rawText || "").slice(11).trim();

    if (!msg) {
      await sendText(from, "❌ Message vide.");
      return true;
    }

    await sendText(from, "📡 Envoi en cours...");
    await broadcastToAllKnownUsers(from, msg);
    await sendText(from, "✅ Broadcast envoyé.");
    return true;
  }

  return {
    handleBroadcastCommand,
  };
}

module.exports = {
  makeKadiAdminBroadcastService,
};