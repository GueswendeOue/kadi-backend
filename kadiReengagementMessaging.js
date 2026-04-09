"use strict";

const { sendText } = require("./kadiMessaging");

async function sendZeroDocReOnboarding(user, variant = "A") {
  const waId = String(user?.wa_id || "").trim();
  if (!waId) return false;

  const v = String(variant || "A").toUpperCase();

  const text =
    v === "B"
      ? [
          "Tu peux parler à KADI maintenant 👀",
          "",
          'Envoie juste un vocal comme :',
          '"2 sacs de ciment à 5000 pour Adama"',
          "",
          "Et ton document est prêt.",
          "",
          "Plus besoin d’écrire.",
        ].join("\n")
      : [
          "🎤 Nouveau sur KADI",
          "",
          "Tu peux maintenant créer un devis juste en parlant 👇",
          "",
          "Exemple :",
          '"Devis pour Moussa, 2 portes à 25000"',
          "",
          "Et KADI fait tout automatiquement ⚡",
          "",
          "👉 Essaye maintenant : envoie un message vocal",
        ].join("\n");

  await sendText(waId, text);
  return true;
}

async function sendReactivationNudge(user, days = 7) {
  const waId = String(user?.wa_id || "").trim();
  if (!waId) return false;

  const safeDays = Number(days) || 7;

  const text =
    safeDays >= 30
      ? [
          "🔥 KADI a évolué.",
          "",
          "Tu peux maintenant :",
          "🎤 parler",
          "📷 envoyer une photo",
          "✍️ écrire normalement",
          "",
          "Teste maintenant 👇",
        ].join("\n")
      : [
          "📄 Tu fais encore tes documents à la main ?",
          "",
          "Avec KADI :",
          "🎤 tu parles",
          "📄 c’est prêt",
          "",
          "Essaie maintenant 👇",
        ].join("\n");

  await sendText(waId, text);
  return true;
}

module.exports = {
  sendZeroDocReOnboarding,
  sendReactivationNudge,
};