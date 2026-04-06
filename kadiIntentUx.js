"use strict";

// ===============================
// MESSAGE PRINCIPAL
// ===============================
function buildIntentMessage(intent) {
  let msg = "🎤 D’accord, voici ce que j’ai compris 👇\n\n";

  if (intent.client) {
    msg += `👤 Client : ${intent.client}\n`;
  }

  if (intent.items.length > 0) {
    msg += `📦 Produits :\n`;

    intent.items.forEach((i) => {
      msg += `• ${i.label} x${i.qty}`;
      if (i.unitPrice) msg += ` — ${i.unitPrice} FCFA`;
      msg += "\n";
    });
  }

  if (intent.missing.includes("price")) {
    msg += "\n💰 Il manque certains prix.";
  }

  if (intent.missing.includes("client")) {
    msg += "\n👤 Il manque le nom du client.";
  }

  return msg;
}

// ===============================
// QUESTION GUIDÉE
// ===============================
function getNextQuestion(intent) {
  if (intent.missing.includes("client")) {
    return "👤 Quel est le nom du client ?";
  }

  if (intent.missing.includes("price")) {
    const item = intent.items.find((i) => !i.unitPrice);
    return `💰 Quel est le prix pour : ${item.label} ?`;
  }

  return null;
}

module.exports = {
  buildIntentMessage,
  getNextQuestion,
};