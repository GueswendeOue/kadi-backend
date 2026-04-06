"use strict";

const { getOrCreateProfile, markOnboardingDone } = require("./store");
const { getBalance, addCredits } = require("./kadiCreditsRepo");
const { sendText, sendButtons } = require("./kadiMessaging");

const WELCOME_CREDITS = Number(process.env.WELCOME_CREDITS || 5);
const PDF_SIMPLE_CREDITS = Number(process.env.PDF_SIMPLE_CREDITS || 1);

const _WELCOME_CACHE = new Map();

const EXAMPLES = [
  `_"Devis pour Kaboré, 3 sacs de ciment à 7 500F"_`,
  `_"Facture pour Traoré, réparation moto 15 000F"_`,
  `_"Reçu loyer pour Aminata, 50 000F"_`,
  `_"Devis chantier pour Moussa, 10 fers à béton à 3 000F"_`,
  `_"Facture pour Adama, coiffure tresses 8 000F"_`,
  `_"Reçu pour Boureima, livraison ciment 25 000F"_`,
];

function isValidWhatsAppId(id) {
  return /^\d+$/.test(String(id || "")) && String(id || "").length >= 8;
}

function pickExample(waId = "") {
  const idx = String(waId)
    .split("")
    .reduce((acc, c) => acc + c.charCodeAt(0), 0) % EXAMPLES.length;

  return EXAMPLES[idx];
}

// ─────────────────────────────────────────────────────────────
// 🎁 WELCOME CREDITS
// ─────────────────────────────────────────────────────────────
async function ensureWelcomeCredits(waId) {
  try {
    if (!isValidWhatsAppId(waId)) return;

    const cached = _WELCOME_CACHE.get(waId);
    if (cached && Date.now() - cached < 24 * 60 * 60 * 1000) return;

    const p = await getOrCreateProfile(waId);

    if (p?.welcome_credits_granted === true) {
      _WELCOME_CACHE.set(waId, Date.now());
      return;
    }

    const balRes = await getBalance(waId);
    const bal = balRes?.balance || 0;

    if (bal > 0) {
      _WELCOME_CACHE.set(waId, Date.now());
      return;
    }

    await addCredits(waId, WELCOME_CREDITS, "welcome");
    _WELCOME_CACHE.set(waId, Date.now());

    await sendText(
      waId,
      `🎁 Bienvenue sur *KADI*\n` +
        `Vous recevez *${WELCOME_CREDITS} crédits gratuits* pour commencer.\n` +
        `📄 1 PDF = ${PDF_SIMPLE_CREDITS} crédit.`
    );
  } catch (e) {
    console.warn("⚠️ ensureWelcomeCredits:", e?.message);
  }
}

// ─────────────────────────────────────────────────────────────
// 🚀 ONBOARDING PRINCIPAL (YC VERSION)
// ─────────────────────────────────────────────────────────────
async function maybeSendOnboarding(from) {
  try {
    const p = await getOrCreateProfile(from);
    if (p?.onboarding_done === true) return;

    const example = pickExample(from);

    // Message 1 — Valeur claire
    await sendText(
      from,
      `👋 Bienvenue sur *KADI*\n\n` +
        `Je crée vos *devis, factures, reçus et décharges* directement sur WhatsApp.\n\n` +
        `📄 PDF propre avec tampon\n` +
        `⚡ En quelques secondes\n\n` +
        `Vous pouvez écrire, envoyer un vocal ou une photo.`
    );

    // Message 2 — Activation immédiate
    await sendText(
      from,
      `⚡ *Essayez maintenant en écrivant simplement :*\n\n` +
        `${example}\n\n` +
        `Ou choisissez une action ci-dessous 👇`
    );

    // Boutons — focus action
    await sendButtons(from, "Choisissez une action :", [
      { id: "HOME_DOCS", title: "📄 Créer doc" },
      { id: "HOME_OCR", title: "📷 Transformer photo" },
      { id: "HOME_TUTORIAL", title: "📚 Exemples" },
    ]);

    try {
      await markOnboardingDone(from, 1);
    } catch (_) {}
  } catch (e) {
    console.warn("⚠️ onboarding:", e?.message);
  }
}

// ─────────────────────────────────────────────────────────────
// 🔁 ACTIVATION J+1
// ─────────────────────────────────────────────────────────────
async function sendActivationJ1(from) {
  try {
    const example = pickExample(from);

    await sendText(
      from,
      `👋 Vous n’avez pas encore créé votre premier document sur *KADI*.\n\n` +
        `Essayez simplement ceci :\n\n` +
        `${example}\n\n` +
        `Je m’occupe du reste en quelques secondes ⚡`
    );
  } catch (e) {
    console.warn("⚠️ activationJ1:", e?.message);
  }
}

// ─────────────────────────────────────────────────────────────
// 🔁 ACTIVATION J+7
// ─────────────────────────────────────────────────────────────
async function sendActivationJ7(from) {
  try {
    await sendButtons(
      from,
      `👋 Vous pouvez aussi utiliser *KADI* pour :\n\n` +
        `📷 Transformer une photo en document\n` +
        `🧾 Créer un reçu rapidement\n` +
        `📄 Retrouver vos anciens documents\n\n` +
        `Choisissez une action 👇`,
      [
        { id: "HOME_OCR", title: "📷 Transformer photo" },
        { id: "HOME_DOCS", title: "📄 Créer doc" },
        { id: "HOME_HISTORY", title: "📚 Historique" },
      ]
    );
  } catch (e) {
    console.warn("⚠️ activationJ7:", e?.message);
  }
}

// ─────────────────────────────────────────────────────────────
// ⚠️ CRÉDITS BAS
// ─────────────────────────────────────────────────────────────
async function sendLowCreditsAlert(from, balance = 0) {
  try {
    await sendButtons(
      from,
      `⚠️ Il vous reste *${balance} crédit${balance > 1 ? "s" : ""}*.\n\n` +
        `Rechargez maintenant pour continuer 👇`,
      [
        { id: "RECHARGE_1000", title: "1 000F" },
        { id: "RECHARGE_2000", title: "2 000F" },
        { id: "HOME_CREDITS", title: "💳 Voir packs" },
      ]
    );
  } catch (e) {
    console.warn("⚠️ lowCreditsAlert:", e?.message);
  }
}

// ─────────────────────────────────────────────────────────────
// 🔴 CRÉDITS ÉPUISÉS
// ─────────────────────────────────────────────────────────────
async function sendZeroCreditsBlock(from) {
  try {
    await sendButtons(
      from,
      `🔴 *Crédits épuisés.*\n\n` +
        `Rechargez pour continuer à générer vos documents 👇`,
      [
        { id: "RECHARGE_1000", title: "1 000F" },
        { id: "RECHARGE_2000", title: "2 000F" },
        { id: "HOME_CREDITS", title: "💳 Voir packs" },
      ]
    );
  } catch (e) {
    console.warn("⚠️ zeroCreditsBlock:", e?.message);
  }
}

module.exports = {
  ensureWelcomeCredits,
  maybeSendOnboarding,
  sendActivationJ1,
  sendActivationJ7,
  sendLowCreditsAlert,
  sendZeroCreditsBlock,
};