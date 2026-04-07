"use strict";

// ===============================
// FORMAT MONEY
// ===============================
function formatMoney(n) {
  if (n == null) return null;

  return Number(n)
    .toLocaleString("fr-FR")
    .replace(/\s/g, " ") + " FCFA";
}

// ===============================
// DOC LABEL
// ===============================
function getDocLabel(intent) {
  switch (intent.docType) {
    case "facture":
      return intent.factureKind === "proforma"
        ? "📄 Facture proforma"
        : "📄 Facture";
    case "recu":
      return "🧾 Reçu";
    case "decharge":
      return "📝 Décharge";
    default:
      return "📋 Devis";
  }
}

// ===============================
// MESSAGE PRINCIPAL
// ===============================
function buildIntentMessage(intent) {
  let msg = `🎤 *${getDocLabel(intent)}*\n\n`;
  msg += "Voici ce que j’ai compris 👇\n\n";

  // CLIENT
  if (intent.client) {
    msg += `👤 *Client* : ${intent.client}\n\n`;
  }

  // ITEMS
  if (intent.items.length > 0) {
    msg += "📦 *Détails* :\n";

    intent.items.forEach((i) => {
      msg += `• ${i.label} × ${i.qty}`;
      if (i.unitPrice != null) {
        msg += ` — ${formatMoney(i.unitPrice)}`;
      }
      msg += "\n";
    });

    msg += "\n";
  }

  // FEEDBACK SMART (pas robot)
  if (intent.missing.length === 0) {
    msg += "✅ Tout est prêt.\n";
  } else {
    msg += "⚠️ Quelques infos manquent :\n";

    if (intent.missing.includes("client")) {
      msg += "• Nom du client\n";
    }

    if (intent.missing.includes("price")) {
      msg += "• Prix de certains éléments\n";
    }

    msg += "\n";
  }

  return msg.trim();
}

// ===============================
// QUESTION GUIDÉE
// ===============================
function getNextQuestion(intent) {
  // CLIENT
  if (intent.missing.includes("client")) {
    return "👤 Quel est le nom du client ?";
  }

  // PRICE
  if (intent.missing.includes("price")) {
    const item = intent.items.find((i) => i.unitPrice == null);

    if (item) {
      return `💰 Quel est le prix pour *${item.label}* ?\n\nEx: 5000`;
    }

    return "💰 Quel est le prix ?";
  }

  return null;
}

module.exports = {
  buildIntentMessage,
  getNextQuestion,
};