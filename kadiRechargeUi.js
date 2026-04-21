"use strict";

const { sendButtons } = require("./whatsappApi");

const OM_NUMBER = String(process.env.OM_NUMBER || "").trim();
const OM_NAME = String(process.env.OM_NAME || "").trim();

function toNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function money(n) {
  const x = toNum(n, 0);
  return Math.round(x).toLocaleString("fr-FR");
}

function normalizeOffer(offer) {
  if (!offer || typeof offer !== "object") return null;

  const amountFcfa = toNum(offer.amountFcfa, 0);
  const credits = toNum(offer.credits, 0);

  if (amountFcfa <= 0 || credits <= 0) return null;

  return {
    id: String(offer.id || "").trim() || null,
    amountFcfa,
    credits,
    label:
      String(offer.label || "").trim() ||
      `${money(amountFcfa)} FCFA = ${credits} crédits`,
  };
}

function buildRechargePacksText() {
  return (
    "💳 *Recharger vos crédits KADI*\n\n" +
    "Continuez à créer vos documents sans interruption.\n\n" +
    "📦 *Packs disponibles*\n" +
    "• 1000F = 10 crédits\n" +
    "• 2000F = 25 crédits\n" +
    "• 5000F = 70 crédits\n\n" +
    "📄 *Repère simple*\n" +
    "• 1 PDF simple = 1 crédit\n\n" +
    "Choisissez un pack 👇"
  );
}

async function sendRechargePacksMenu(to) {
  await sendButtons(to, buildRechargePacksText(), [
    { id: "RECHARGE_1000", title: "1000F" },
    { id: "RECHARGE_2000", title: "2000F" },
    { id: "RECHARGE_5000", title: "5000F" },
  ]);
}

async function sendRechargePaymentMethodMenu(to, offer) {
  const normalized = normalizeOffer(offer);

  if (!normalized) {
    await sendButtons(
      to,
      "⚠️ Je n’ai pas retrouvé ce pack.\n\nChoisissez un pack valide 👇",
      [
        { id: "RECHARGE_1000", title: "1000F" },
        { id: "RECHARGE_2000", title: "2000F" },
        { id: "RECHARGE_5000", title: "5000F" },
      ]
    );
    return;
  }

  const text =
    "💳 *Pack sélectionné*\n\n" +
    `Montant : *${money(normalized.amountFcfa)} FCFA*\n` +
    `Crédits : *${normalized.credits}*\n\n` +
    "Choisissez un mode de paiement 👇";

  await sendButtons(to, text, [
    { id: `PAY_OM_${normalized.amountFcfa}`, title: "Orange Money" },
    { id: `PAY_PISPI_${normalized.amountFcfa}`, title: "PI-SPI" },
    { id: "CREDITS_RECHARGE", title: "⬅️ Retour" },
  ]);
}

async function sendOrangeMoneyInstructions(to, offer) {
  const normalized = normalizeOffer(offer);

  if (!normalized) {
    return sendRechargePacksMenu(to);
  }

  if (!OM_NUMBER || !OM_NAME) {
    await sendButtons(
      to,
      "⚠️ Le paiement Orange Money n’est pas disponible pour le moment.\n\nChoisissez un autre mode ou revenez au menu recharge.",
      [
        { id: `PAY_PISPI_${normalized.amountFcfa}`, title: "PI-SPI" },
        { id: "CREDITS_RECHARGE", title: "⬅️ Retour" },
      ]
    );
    return;
  }

  const text =
    "🟠 *Paiement via Orange Money*\n\n" +
    `Montant : *${money(normalized.amountFcfa)} FCFA*\n` +
    `Crédits : *${normalized.credits}*\n\n` +
    `1️⃣ Envoyez le paiement au numéro : *${OM_NUMBER}*\n` +
    `2️⃣ Nom : *${OM_NAME}*\n\n` +
    "📎 Ensuite, envoyez ici :\n" +
    "• le message de confirmation\n" +
    "ou\n" +
    "• une capture d’écran\n\n" +
    "✅ Après validation, vos crédits sont ajoutés.";

  await sendButtons(to, text, [
    { id: `OM_PAID_${normalized.amountFcfa}`, title: "J’ai payé" },
    { id: `OM_SEND_PROOF_${normalized.amountFcfa}`, title: "Envoyer preuve" },
    { id: "CREDITS_RECHARGE", title: "⬅️ Retour" },
  ]);
}

async function sendPispiInstructions(to, offer) {
  const normalized = normalizeOffer(offer);

  if (!normalized) {
    return sendRechargePacksMenu(to);
  }

  const text =
    "🔶 *Paiement via PI-SPI*\n\n" +
    `Montant : *${money(normalized.amountFcfa)} FCFA*\n` +
    `Crédits : *${normalized.credits}*\n\n` +
    "⚠️ Mode test pour le moment.\n\n" +
    "1️⃣ Lancez le paiement dans l’application compatible\n" +
    "2️⃣ Revenez ici pour vérifier\n\n" +
    "✅ Dès confirmation, vous pourrez reprendre votre document.";

  await sendButtons(to, text, [
    { id: `PISPI_CHECK_${normalized.amountFcfa}`, title: "Vérifier paiement" },
    { id: "CREDITS_RECHARGE", title: "⬅️ Retour" },
  ]);
}

module.exports = {
  buildRechargePacksText,
  sendRechargePacksMenu,
  sendRechargePaymentMethodMenu,
  sendOrangeMoneyInstructions,
  sendPispiInstructions,
};