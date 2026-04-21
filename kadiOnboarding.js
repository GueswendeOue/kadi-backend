"use strict";

const {
  getOrCreateProfile,
  markOnboardingDone,
  updateProfile,
} = require("./store");
const { getBalance, addCredits } = require("./kadiCreditsRepo");
const { sendText, sendButtons } = require("./kadiMessaging");
const { norm } = require("./kadiUtils");

const WELCOME_CREDITS = Number(process.env.WELCOME_CREDITS || 5);
const PDF_SIMPLE_CREDITS = Number(process.env.PDF_SIMPLE_CREDITS || 1);
const REONBOARDING_BONUS_CREDITS = Number(
  process.env.REONBOARDING_BONUS_CREDITS || 0
);

const KADI_DEMO_VIDEO_URL =
  process.env.KADI_DEMO_VIDEO_URL || "https://www.tiktok.com/@kadi/video/DEMO";

const WELCOME_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ONBOARDING_PROMPT_TTL_MS = 12 * 60 * 60 * 1000;

const _WELCOME_CACHE = new Map();
const _ONBOARDING_PROMPT_CACHE = new Map();

const PROFESSION_EXAMPLES = {
  btp: `_"Devis pour Moussa, 2 portes à 25 000F"_`,
  commerce: `_"Facture pour Aminata, 5 pagnes à 3 000F"_`,
  restauration: `_"Reçu pour Adama, plat du jour 5 000F"_`,
  services: `_"Facture pour Traoré, réparation moto 15 000F"_`,
  default: `_"Devis pour Kaboré, 3 sacs de ciment à 7 500F"_`,
};

function isValidWhatsAppId(id) {
  return /^\d+$/.test(String(id || "")) && String(id || "").length >= 8;
}

function nowMs() {
  return Date.now();
}

function isFreshCache(cache, key, ttlMs) {
  const value = cache.get(String(key || ""));
  return Number.isFinite(value) && nowMs() - value < ttlMs;
}

function touchCache(cache, key) {
  cache.set(String(key || ""), nowMs());
}

function parseBalanceResult(res) {
  const balance =
    res?.balance ??
    res?.data?.balance ??
    res?.credits ??
    res?.data?.credits ??
    null;

  const n = Number(balance);
  return Number.isFinite(n) ? n : null;
}

async function readSafeBalance(waId) {
  try {
    const res = await getBalance({ waId });
    const n = parseBalanceResult(res);
    if (n != null) return n;
  } catch (_) {}

  try {
    const res = await getBalance(waId);
    const n = parseBalanceResult(res);
    if (n != null) return n;
  } catch (_) {}

  return 0;
}

async function safeMarkOnboardingDone(waId) {
  try {
    await markOnboardingDone(waId, 1);
  } catch (_) {}
}

function pickExample(waId = "") {
  const examples = Object.values(PROFESSION_EXAMPLES);
  const idx =
    String(waId)
      .split("")
      .reduce((acc, c) => acc + c.charCodeAt(0), 0) % examples.length;

  return examples[idx];
}

function detectProfessionCategory(text = "") {
  const t = norm(text);

  if (
    t.includes("soudeur") ||
    t.includes("macon") ||
    t.includes("maçon") ||
    t.includes("btp") ||
    t.includes("chantier") ||
    t.includes("plombier") ||
    t.includes("electricien") ||
    t.includes("électricien") ||
    t.includes("menuisier")
  ) {
    return "btp";
  }

  if (
    t.includes("boutique") ||
    t.includes("commerce") ||
    t.includes("vendeur") ||
    t.includes("vente") ||
    t.includes("epicerie") ||
    t.includes("épicerie")
  ) {
    return "commerce";
  }

  if (
    t.includes("restaurant") ||
    t.includes("restauration") ||
    t.includes("maquis") ||
    t.includes("cuisine") ||
    t.includes("fast food")
  ) {
    return "restauration";
  }

  if (
    t.includes("mecanicien") ||
    t.includes("mécanicien") ||
    t.includes("coiffeur") ||
    t.includes("coiffeuse") ||
    t.includes("couturier") ||
    t.includes("couturiere") ||
    t.includes("couturière") ||
    t.includes("reparation") ||
    t.includes("réparation") ||
    t.includes("services")
  ) {
    return "services";
  }

  return null;
}

function buildProfessionExample(category) {
  return PROFESSION_EXAMPLES[category] || PROFESSION_EXAMPLES.default;
}

function buildBestExample(profile = null, waId = "") {
  const category = String(profile?.profession_category || "").trim();
  if (category) return buildProfessionExample(category);
  return pickExample(waId);
}

function getZeroDocSegment(daysSinceSignup = 0) {
  const d = Number(daysSinceSignup || 0);

  if (d < 7) return "A";
  if (d <= 30) return "B";
  return "C";
}

async function sendActionFirstButtons(to) {
  await sendButtons(to, "Choisissez comment commencer 👇", [
    { id: "DOC_DEVIS", title: "📋 Créer devis" },
    { id: "DOC_FACTURE_MENU", title: "📄 Créer facture" },
    { id: "HOME_OCR", title: "📷 Envoyer photo" },
  ]);
}

// ─────────────────────────────────────────────────────────────
// 🎁 WELCOME CREDITS
// ─────────────────────────────────────────────────────────────
async function ensureWelcomeCredits(waId) {
  try {
    if (!isValidWhatsAppId(waId)) return;

    if (isFreshCache(_WELCOME_CACHE, waId, WELCOME_CACHE_TTL_MS)) {
      return;
    }

    const p = await getOrCreateProfile(waId);

    if (p?.welcome_credits_granted === true) {
      touchCache(_WELCOME_CACHE, waId);
      return;
    }

    const balance = await readSafeBalance(waId);

    if (balance > 0) {
      touchCache(_WELCOME_CACHE, waId);
      return;
    }

    await addCredits(waId, WELCOME_CREDITS, "welcome");

    try {
      await updateProfile(waId, {
        welcome_credits_granted: true,
      });
    } catch (profileErr) {
      console.warn(
        "⚠️ ensureWelcomeCredits:updateProfile:",
        profileErr?.message || profileErr
      );
    }

    touchCache(_WELCOME_CACHE, waId);

    await sendText(
      waId,
      `🎁 Bienvenue sur *KADI*\n\n` +
        `Vous recevez *${WELCOME_CREDITS} crédits gratuits* pour commencer.\n` +
        `📄 1 PDF = ${PDF_SIMPLE_CREDITS} crédit.\n\n` +
        `Vous pouvez déjà créer votre premier document maintenant.`
    );
  } catch (e) {
    console.warn("⚠️ ensureWelcomeCredits:", e?.message || e);
  }
}

// ─────────────────────────────────────────────────────────────
// 🚀 ONBOARDING PRINCIPAL
// ─────────────────────────────────────────────────────────────
async function maybeSendOnboarding(from) {
  try {
    const p = await getOrCreateProfile(from);

    if (p?.onboarding_done === true) return false;

    if (
      isFreshCache(_ONBOARDING_PROMPT_CACHE, from, ONBOARDING_PROMPT_TTL_MS)
    ) {
      return false;
    }

    const example = buildBestExample(p, from);

    await sendText(
      from,
      `👋 Bienvenue sur *KADI*\n\n` +
        `Créez vos *devis, factures, reçus et décharges* directement sur WhatsApp.\n\n` +
        `Exemple :\n${example}`
    );

    await sendText(
      from,
      `🎤 Vous pouvez aussi envoyer un *vocal*.\n` +
        `📷 Vous pouvez aussi envoyer une *photo*.\n\n` +
        `Écrivez aussi votre métier pour recevoir un exemple adapté.\n` +
        `Exemples :\n• "Je suis soudeur"\n• "Je suis mécanicien"\n• "Je fais commerce"`
    );

    await sendActionFirstButtons(from);
    touchCache(_ONBOARDING_PROMPT_CACHE, from);

    return true;
  } catch (e) {
    console.warn("⚠️ onboarding:", e?.message || e);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// 🧠 DÉTECTION TEXTE MÉTIER
// ─────────────────────────────────────────────────────────────
async function tryHandleProfessionIntro(from, text) {
  try {
    const category = detectProfessionCategory(text);
    if (!category) return false;

    await updateProfile(from, {
      profession_text: String(text || "").trim().slice(0, 80),
      profession_category: category,
    });

    await safeMarkOnboardingDone(from);
    touchCache(_ONBOARDING_PROMPT_CACHE, from);

    const example = buildProfessionExample(category);

    await sendText(
      from,
      `Parfait 👌\n\n` +
        `Essayez maintenant en écrivant :\n\n${example}\n\n` +
        `Ou envoyez le même besoin en vocal 🎤`
    );

    await sendActionFirstButtons(from);
    return true;
  } catch (e) {
    console.warn("⚠️ tryHandleProfessionIntro:", e?.message || e);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// 🔘 RÉPONSES BOUTONS ONBOARDING MÉTIER
// ─────────────────────────────────────────────────────────────
async function handleOnboardingReply(from, replyId) {
  try {
    let category = null;

    if (replyId === "ONBOARDING_PRO_BTP") category = "btp";
    if (replyId === "ONBOARDING_PRO_COMMERCE") category = "commerce";
    if (replyId === "ONBOARDING_PRO_RESTO") category = "restauration";
    if (replyId === "ONBOARDING_PRO_SERVICES") category = "services";

    if (!category) return false;

    await updateProfile(from, {
      profession_category: category,
    });

    await safeMarkOnboardingDone(from);
    touchCache(_ONBOARDING_PROMPT_CACHE, from);

    const example = buildProfessionExample(category);

    await sendText(
      from,
      `Parfait 👌\n\n` +
        `Essayez maintenant en écrivant :\n\n${example}\n\n` +
        `Ou envoyez le même besoin en vocal 🎤`
    );

    await sendActionFirstButtons(from);
    return true;
  } catch (e) {
    console.warn("⚠️ handleOnboardingReply:", e?.message || e);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// 🔁 RE-ONBOARDING USERS SANS DOCUMENT
// ─────────────────────────────────────────────────────────────
async function sendZeroDocReOnboarding(from, options = {}) {
  try {
    const daysSinceSignup = Number(options.daysSinceSignup || 0);
    const professionCategory = options.professionCategory || null;
    const segment = getZeroDocSegment(daysSinceSignup);
    const example =
      buildProfessionExample(professionCategory) || pickExample(from);

    if (segment === "A") {
      await sendText(
        from,
        `👋 Vous avez rejoint *KADI* il y a quelques jours mais vous n’avez pas encore créé de document.\n\n` +
          `Essayez simplement ceci :\n\n${example}\n\n` +
          `Ou envoyez le même besoin en vocal 🎤`
      );

      await sendActionFirstButtons(from);
      return true;
    }

    if (segment === "B") {
      let bonusLine = "";
      if (REONBOARDING_BONUS_CREDITS > 0) {
        bonusLine =
          `\n🎁 Bonus retour : *${REONBOARDING_BONUS_CREDITS} crédit(s)* quand vous créez votre premier document.`;
      }

      await sendText(
        from,
        `👋 Beaucoup d’utilisateurs créent déjà leurs documents avec *KADI* sur WhatsApp.\n\n` +
          `Vous aussi vous pouvez commencer en quelques secondes :\n\n${example}${bonusLine}`
      );

      await sendActionFirstButtons(from);
      return true;
    }

    await sendText(
      from,
      `👋 *KADI* s’est amélioré depuis votre inscription.\n\n` +
        `Nouveau : décharges, vocal et lecture de photo.\n\n` +
        `Essayez maintenant :\n\n${example}\n\n` +
        `📹 Démo rapide : ${KADI_DEMO_VIDEO_URL}`
    );

    await sendActionFirstButtons(from);
    return true;
  } catch (e) {
    console.warn("⚠️ sendZeroDocReOnboarding:", e?.message || e);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// 🔁 RELANCES EXISTANTS
// ─────────────────────────────────────────────────────────────
async function sendActivationJ1(from) {
  try {
    const p = await getOrCreateProfile(from);
    const example = buildBestExample(p, from);

    await sendText(
      from,
      `👋 Vous n’avez pas encore créé votre premier document sur *KADI*.\n\n` +
        `Essayez simplement ceci :\n\n${example}\n\n` +
        `Ou envoyez votre demande en vocal 🎤`
    );

    await sendActionFirstButtons(from);
  } catch (e) {
    console.warn("⚠️ activationJ1:", e?.message || e);
  }
}

async function sendActivationJ7(from) {
  try {
    await sendButtons(
      from,
      `👋 Vous pouvez aussi utiliser *KADI* pour :\n\n` +
        `📷 Transformer une photo en document\n` +
        `🎤 Envoyer un vocal\n` +
        `👤 Compléter votre profil pour des documents plus pros\n\n` +
        `Choisissez une action 👇`,
      [
        { id: "HOME_OCR", title: "📷 Envoyer photo" },
        { id: "DOC_DEVIS", title: "📋 Créer devis" },
        { id: "HOME_PROFILE", title: "👤 Mon profil" },
      ]
    );
  } catch (e) {
    console.warn("⚠️ activationJ7:", e?.message || e);
  }
}

async function sendReactivationNudge(from, options = {}) {
  try {
    const daysInactive = Number(options.daysInactive || 0);
    const professionCategory = options.professionCategory || null;
    const example =
      buildProfessionExample(professionCategory) || pickExample(from);

    let intro = `👋 Cela fait un moment.\n\n`;
    if (daysInactive >= 30) {
      intro = `👋 Cela fait quelque temps que vous n’avez pas utilisé *KADI*.\n\n`;
    }

    await sendText(
      from,
      intro +
        `Essayez simplement :\n\n${example}\n\n` +
        `Ou envoyez votre demande en vocal 🎤\n` +
        `📹 Démo : ${KADI_DEMO_VIDEO_URL}`
    );

    await sendActionFirstButtons(from);
    return true;
  } catch (e) {
    console.warn("⚠️ sendReactivationNudge:", e?.message || e);
    return false;
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
        `Rechargez maintenant pour continuer sans interruption 👇`,
      [
        { id: "RECHARGE_1000", title: "1 000F" },
        { id: "RECHARGE_2000", title: "2 000F" },
        { id: "HOME_CREDITS", title: "💳 Voir packs" },
      ]
    );
  } catch (e) {
    console.warn("⚠️ lowCreditsAlert:", e?.message || e);
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
        `Rechargez maintenant pour continuer à générer vos documents 👇`,
      [
        { id: "RECHARGE_1000", title: "1 000F" },
        { id: "RECHARGE_2000", title: "2 000F" },
        { id: "HOME_CREDITS", title: "💳 Voir packs" },
      ]
    );
  } catch (e) {
    console.warn("⚠️ zeroCreditsBlock:", e?.message || e);
  }
}

module.exports = {
  ensureWelcomeCredits,
  maybeSendOnboarding,
  tryHandleProfessionIntro,
  handleOnboardingReply,
  sendZeroDocReOnboarding,
  sendActivationJ1,
  sendActivationJ7,
  sendReactivationNudge,
  sendLowCreditsAlert,
  sendZeroCreditsBlock,
};