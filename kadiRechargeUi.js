"use strict";

const { sendButtons, sendText } = require("./whatsappApi");
const { OM_NUMBER, OM_NAME } = process.env;

async function sendRechargePacksMenu(to) {
  const text =
    "💳 *Recharger vos crédits Kadi*\n\n" +
    "Choisissez un pack :";

  await sendButtons(to, text, [
    { id: "PACK_1000", title: "1000F = 10 crédits" },
    { id: "PACK_2000", title: "2000F = 25 crédits" },
    { id: "PACK_5000", title: "5000F = 50 + Tampon" },
  ]);
}

async function sendRechargePaymentMethodMenu(to, offer) {
  const text =
    `💳 *${offer.label}*\n\n` +
    `Montant : *${offer.amountFcfa} FCFA*\n` +
    `Crédits : *${offer.credits}*\n` +
    (offer.includesStamp ? `🎁 Tampon illimité offert\n` : "") +
    `\nChoisissez un mode de paiement :`;

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
    `2️⃣ Au numéro : *${OM_NUMBER}*\n` +
    `3️⃣ Nom : *${OM_NAME}*\n\n` +
    "📌 Important :\n" +
    "Après paiement, envoyez ici :\n" +
    "• le message de confirmation (copier/coller)\n" +
    "OU\n" +
    "• une capture d’écran\n\n" +
    "👉 Cela permet de valider rapidement votre recharge.";

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