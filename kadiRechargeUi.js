"use strict";

const { sendButtons } = require("./whatsappApi");
const { OM_NUMBER, OM_NAME } = process.env;

function buildRechargePacksText() {
  return (
    "💳 *Recharger vos crédits KADI*\n\n" +
    "Continuez à créer vos documents sans interruption.\n\n" +
    "📦 *Packs disponibles*\n" +
    "• 1000F = 10 crédits\n" +
    "• 2000F = 25 crédits\n" +
    "• 5000F = 70 crédits\n\n" +
    "📄 *Coûts utiles*\n" +
    "• PDF simple = 1 crédit\n" +
    "• Tampon sur un document = +1 crédit"
  );
}

async function sendRechargePacksMenu(to) {
  const text = buildRechargePacksText();

  await sendButtons(to, text, [
    { id: "PACK_1000", title: "1000F = 10 crédits" },
    { id: "PACK_2000", title: "2000F = 25 crédits" },
    { id: "PACK_5000", title: "5000F = 70 crédits" },
  ]);
}

async function sendRechargePaymentMethodMenu(to, offer) {
  const text =
    `💳 *${offer.label}*\n\n` +
    `Montant : *${offer.amountFcfa} FCFA*\n` +
    `Crédits : *${offer.credits}*\n\n` +
    "Choisissez un mode de paiement :";

  await sendButtons(to, text, [
    { id: `PAY_OM_${offer.amountFcfa}`, title: "Orange Money" },
    { id: `PAY_PISPI_${offer.amountFcfa}`, title: "PI-SPI (test)" },
    { id: "CREDITS_RECHARGE", title: "Retour" },
  ]);
}

async function sendOrangeMoneyInstructions(to, offer) {
  const text =
    "🟠 *Paiement via Orange Money*\n\n" +
    `1️⃣ Envoyez : *${offer.amountFcfa} FCFA*\n` +
    `2️⃣ Au numéro : *${OM_NUMBER || "-"}*\n` +
    `3️⃣ Nom : *${OM_NAME || "-"}*\n\n` +
    "📌 Après paiement, envoyez ici :\n" +
    "• le message de confirmation\n" +
    "OU\n" +
    "• une capture d’écran\n\n" +
    "✅ Dès validation, vos crédits seront ajoutés et vous pourrez reprendre votre document.";

  await sendButtons(to, text, [
    { id: `OM_PAID_${offer.amountFcfa}`, title: "J’ai payé" },
    { id: `OM_SEND_PROOF_${offer.amountFcfa}`, title: "Envoyer preuve" },
    { id: "CREDITS_RECHARGE", title: "Annuler" },
  ]);
}

async function sendPispiInstructions(to, offer) {
  const text =
    "🔶 *Paiement via PI-SPI*\n\n" +
    "⚠️ Mode test (sandbox)\n\n" +
    `Montant : *${offer.amountFcfa} FCFA*\n` +
    `Crédits : *${offer.credits}*\n\n` +
    "1️⃣ Scannez le QR PI-SPI avec une application compatible\n" +
    "2️⃣ Finalisez le paiement dans l’application\n\n" +
    "Une fois terminé, revenez ici pour vérifier le statut.";

  await sendButtons(to, text, [
    { id: `PISPI_CHECK_${offer.amountFcfa}`, title: "Vérifier paiement" },
    { id: "CREDITS_RECHARGE", title: "Retour" },
  ]);
}

module.exports = {
  sendRechargePacksMenu,
  sendRechargePaymentMethodMenu,
  sendOrangeMoneyInstructions,
  sendPispiInstructions,
};