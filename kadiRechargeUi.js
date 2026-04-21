"use strict";

const { sendText, sendButtons, sendList } = require("./kadiMessaging");
const { getRechargeOffers } = require("./kadiRechargeConfig");

const OM_NUMBER = process.env.OM_NUMBER || "22676894642";
const OM_NAME = process.env.OM_NAME || "KADI";
const PISPI_ENABLED =
  String(process.env.PISPI_ENABLED || "false").toLowerCase() === "true";

function safeText(value, fallback = "") {
  const s = String(value ?? "").trim();
  return s || fallback;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatMoney(value) {
  return `${Math.round(toNum(value, 0)).toLocaleString("fr-FR")}F`;
}

function getSortedOffers() {
  const raw = getRechargeOffers?.() || {};
  return Object.values(raw)
    .filter((offer) => Number.isFinite(Number(offer?.amountFcfa)))
    .sort((a, b) => Number(a.amountFcfa) - Number(b.amountFcfa));
}

function getOfferId(offer = {}) {
  return safeText(offer.id, `PACK_${toNum(offer.amountFcfa, 0)}`);
}

function getDisplayOmNumber() {
  return safeText(OM_NUMBER, "22676894642");
}

function getLocalOmNumberForUssd() {
  const digits = getDisplayOmNumber().replace(/\D/g, "");
  if (digits.length >= 8) return digits.slice(-8);
  return digits || "76894642";
}

function buildUssdCode(amountFcfa) {
  const localNumber = getLocalOmNumberForUssd();
  const amount = Math.max(0, Math.round(toNum(amountFcfa, 0)));
  return `*144*2*1*${localNumber}*${amount}#`;
}

function getPackTag(offer = {}, index = 0, total = 0) {
  const amount = toNum(offer.amountFcfa, 0);

  if (index === 0) return "Idéal pour commencer";
  if (total >= 2 && index === 1) return "Meilleur choix";
  if (index === total - 1) return "Pour usage fréquent";

  if (amount <= 1000) return "Idéal pour commencer";
  if (amount <= 2000) return "Bon équilibre";
  return "Pour usage fréquent";
}

function buildPackDescription(offer = {}, index = 0, total = 0) {
  const credits = toNum(offer.credits, 0);
  const tag = getPackTag(offer, index, total);
  return `${credits} crédits • ${tag}`.slice(0, 72);
}

function buildRechargePacksText(offers = []) {
  const lines = [
    "💳 *Recharger vos crédits KADI*",
    "",
    "Rechargez maintenant pour continuer sans interrompre votre document.",
    "",
    "📄 *Repères utiles*",
    "• PDF simple = 1 crédit",
    "• Tampon (optionnel) = +1 crédit",
  ];

  if (offers.length) {
    lines.push("", "📦 *Packs disponibles*");
    for (const offer of offers) {
      lines.push(
        `• ${formatMoney(offer.amountFcfa)} = ${toNum(offer.credits, 0)} crédits`
      );
    }
  }

  lines.push("", "✅ Après validation, vous reprenez votre document.");
  return lines.join("\n");
}

async function sendRechargePacksMenu(to) {
  const offers = getSortedOffers();

  if (typeof sendList === "function" && offers.length) {
    return sendList(to, {
      header: "Recharge KADI",
      body:
        "Choisissez un pack pour continuer sans interrompre votre document.",
      footer: "Après validation, vous reprenez votre document",
      buttonText: "Choisir",
      sections: [
        {
          title: "Packs",
          rows: offers.slice(0, 10).map((offer, index) => ({
            id: getOfferId(offer),
            title: safeText(formatMoney(offer.amountFcfa), "Pack"),
            description: buildPackDescription(offer, index, offers.length),
          })),
        },
      ],
    });
  }

  const text = buildRechargePacksText(offers);

  const fallbackButtons = offers.length
    ? offers.slice(0, 3).map((offer, index) => ({
        id: getOfferId(offer),
        title:
          index === 0
            ? clipButtonTitle(`🔥 ${formatMoney(offer.amountFcfa)}`)
            : clipButtonTitle(formatMoney(offer.amountFcfa)),
      }))
    : [
        { id: "PACK_1000", title: "🔥 1000F" },
        { id: "PACK_2000", title: "2000F" },
        { id: "PACK_5000", title: "5000F" },
      ];

  return sendButtons(to, text, fallbackButtons);
}

function clipButtonTitle(value = "") {
  return String(value || "").trim().slice(0, 20);
}

async function sendRechargePaymentMethodMenu(to, offer) {
  const amount = formatMoney(offer?.amountFcfa);
  const credits = toNum(offer?.credits, 0);

  const text =
    `💳 *Pack ${amount}*\n\n` +
    `Crédits : *${credits}*\n\n` +
    `Mode conseillé : *Orange Money*\n` +
    `✅ Après validation, vous reprenez votre document.`;

  if (PISPI_ENABLED) {
    return sendButtons(to, text, [
      { id: `PAY_OM_${toNum(offer?.amountFcfa, 0)}`, title: "🟠 Orange Money" },
      { id: `PAY_PISPI_${toNum(offer?.amountFcfa, 0)}`, title: "PI-SPI" },
      { id: "CREDITS_RECHARGE", title: "⬅️ Packs" },
    ]);
  }

  return sendButtons(to, text, [
    { id: `PAY_OM_${toNum(offer?.amountFcfa, 0)}`, title: "🟠 Orange Money" },
    { id: "CREDITS_RECHARGE", title: "⬅️ Packs" },
    { id: "BACK_HOME", title: "🏠 Menu" },
  ]);
}

async function sendOrangeMoneyInstructions(to, offer) {
  const amountFcfa = toNum(offer?.amountFcfa, 0);
  const credits = toNum(offer?.credits, 0);
  const displayNumber = getDisplayOmNumber();
  const ussdCode = buildUssdCode(amountFcfa);

  const text =
    "🟠 *Paiement via Orange Money*\n\n" +
    `Montant : *${formatMoney(amountFcfa)}*\n` +
    `Crédits : *${credits}*\n` +
    `Numéro : *${displayNumber}*\n` +
    `Nom : *${safeText(OM_NAME, "KADI")}*\n\n` +
    "Tapez ce code sur votre téléphone :\n" +
    `\`${ussdCode}\`\n\n` +
    "Si besoin, vous pouvez aussi envoyer manuellement le même montant au numéro ci-dessus.\n\n" +
    "Après paiement, envoyez ici :\n" +
    "• le message de confirmation\n" +
    "OU\n" +
    "• une capture d’écran\n\n" +
    "✅ Dès validation, vos crédits sont ajoutés et vous reprenez votre document.";

  return sendButtons(to, text, [
    { id: `OM_PAID_${amountFcfa}`, title: "✅ J’ai payé" },
    { id: `OM_SEND_PROOF_${amountFcfa}`, title: "📎 Preuve" },
    { id: "CREDITS_RECHARGE", title: "⬅️ Packs" },
  ]);
}

async function sendPispiInstructions(to, offer) {
  if (!PISPI_ENABLED) {
    await sendText(
      to,
      "⚠️ PI-SPI n’est pas disponible pour le moment.\n\nUtilisez plutôt Orange Money."
    );
    return sendRechargePaymentMethodMenu(to, offer);
  }

  const amountFcfa = toNum(offer?.amountFcfa, 0);
  const credits = toNum(offer?.credits, 0);

  const text =
    "🔶 *Paiement via PI-SPI*\n\n" +
    `Montant : *${formatMoney(amountFcfa)}*\n` +
    `Crédits : *${credits}*\n\n` +
    "1️⃣ Finalisez le paiement dans l’application compatible\n" +
    "2️⃣ Revenez ici pour vérifier le statut\n\n" +
    "✅ Après validation, vous reprenez votre document.";

  return sendButtons(to, text, [
    { id: `PISPI_CHECK_${amountFcfa}`, title: "✅ Vérifier" },
    { id: "CREDITS_RECHARGE", title: "⬅️ Packs" },
    { id: "BACK_HOME", title: "🏠 Menu" },
  ]);
}

module.exports = {
  sendRechargePacksMenu,
  sendRechargePaymentMethodMenu,
  sendOrangeMoneyInstructions,
  sendPispiInstructions,
};