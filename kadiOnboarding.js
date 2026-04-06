"use strict";

const { getOrCreateProfile, markOnboardingDone } = require("./store");
const { getBalance, addCredits } = require("./kadiCreditsRepo");
const { sendText, sendButtons } = require("./kadiMessaging");

const WELCOME_CREDITS = Number(process.env.WELCOME_CREDITS || 10);
const PDF_SIMPLE_CREDITS = Number(process.env.PDF_SIMPLE_CREDITS || 1);
const KADI_E164 = process.env.KADI_E164 || "22679239027";

const _WELCOME_CACHE = new Map();

function isValidWhatsAppId(id) {
  return /^\d+$/.test(String(id || "")) && String(id || "").length >= 8;
}

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
      `🎁 Bienvenue sur KADI !\nVous recevez *${WELCOME_CREDITS} crédits gratuits*.\n📄 PDF simple = ${PDF_SIMPLE_CREDITS} crédit`
    );
  } catch (e) {
    console.warn("⚠️ ensureWelcomeCredits:", e?.message);
  }
}

async function maybeSendOnboarding(from) {
  try {
    const p = await getOrCreateProfile(from);
    if (p?.onboarding_done === true) return;

    const msg =
      `👋 Bonjour, je suis *KADI*.\n\n` +
      `Je vous aide à créer rapidement :\n` +
      `📄 *Devis*\n` +
      `🧾 *Factures*\n` +
      `💰 *Reçus*\n\n` +
      `⚡ Tout se fait directement ici sur *WhatsApp*.\n\n` +
      `📷 Vous pouvez aussi envoyer une *photo d'un document* et je le transforme en PDF propre.\n\n` +
      `🎁 Vous avez *${WELCOME_CREDITS} crédits gratuits* pour essayer.\n\n` +
      `👇 Choisissez une action pour commencer :`;

    await sendButtons(from, msg, [
      { id: "HOME_DOCS", title: "📄 Créer document" },
      { id: "HOME_PROFILE", title: "👤 Profil" },
      { id: "HOME_CREDITS", title: "💳 Crédits" },
    ]);

    try {
      await markOnboardingDone(from, 1);
    } catch (_) {}
  } catch (e) {
    console.warn("⚠️ onboarding:", e?.message);
  }
}

module.exports = {
  ensureWelcomeCredits,
  maybeSendOnboarding,
};