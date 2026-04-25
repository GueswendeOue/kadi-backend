"use strict";

function buildZeroDocMessageA() {
  return (
    "👋 Vous n’avez pas encore créé votre premier document KADI.\n\n" +
    "Essayez maintenant avec un exemple simple :\n\n" +
    "Client : Moussa\n" +
    "2 portes à 25000\n" +
    "Main d’œuvre à 50000\n\n" +
    "Ou écrivez en une seule phrase :\n" +
    "Devis pour Moussa, 2 portes à 25000, main d’œuvre 50000\n\n" +
    "KADI prépare le document directement sur WhatsApp."
  );
}

function buildZeroDocMessageB() {
  return (
    "🎤 Vous pouvez aussi créer un document avec un vocal.\n\n" +
    "Dites simplement :\n" +
    "Devis pour Moussa, 2 portes à 25000, main d’œuvre 50000\n\n" +
    "Ou envoyez une photo d’un ancien devis/reçu.\n\n" +
    "KADI transforme ça en document propre."
  );
}

function buildInactiveMessage(days = 30) {
  const safeDays = Number(days) || 30;

  if (safeDays >= 30) {
    return (
      "⏳ Cela fait un moment que vous n’avez pas utilisé KADI.\n\n" +
      "Vous pouvez créer rapidement un devis, une facture ou un reçu ici sur WhatsApp.\n\n" +
      "Exemple :\n" +
      "Facture pour Awa, 5 sacs de riz à 25000, livraison 5000\n\n" +
      "Répondez directement avec votre document à créer."
    );
  }

  return (
    "📄 Vous pouvez reprendre KADI à tout moment.\n\n" +
    "Écrivez simplement :\n" +
    "Devis pour Moussa, 2 portes à 25000\n\n" +
    "Ou envoyez un vocal avec le client, les éléments et les prix."
  );
}

function getZeroDocMessageByVariant(variant = "A") {
  return String(variant || "A").toUpperCase() === "B"
    ? buildZeroDocMessageB()
    : buildZeroDocMessageA();
}

module.exports = {
  buildZeroDocMessageA,
  buildZeroDocMessageB,
  buildInactiveMessage,
  getZeroDocMessageByVariant,
};