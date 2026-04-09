"use strict";

function buildZeroDocMessageA() {
  return (
    "👋 Vous n’avez pas encore créé votre premier document.\n\n" +
    "Essayez maintenant 👇\n\n" +
    "Exemple :\n" +
    "Devis pour Moussa, 2 portes à 25000"
  );
}

function buildZeroDocMessageB() {
  return (
    "🎤 Nouveau : vous pouvez créer un document juste en écrivant naturellement.\n\n" +
    "Exemple :\n" +
    "Facture pour Ibrahim, 3 chaises à 5000"
  );
}

function buildInactiveMessage(days = 30) {
  const safeDays = Number(days) || 30;

  if (safeDays >= 30) {
    return (
      "⏳ Cela fait un moment.\n\n" +
      "KADI peut toujours vous aider à créer rapidement vos devis, factures et reçus.\n\n" +
      "Répondez simplement ici pour reprendre."
    );
  }

  return (
    "📄 Vous pouvez reprendre vos documents à tout moment.\n\n" +
    "Dites-moi simplement ce que vous voulez créer 👇"
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