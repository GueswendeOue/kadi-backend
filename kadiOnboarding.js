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

const KADI_DEMO_VIDEO_URL = String(
  process.env.KADI_DEMO_VIDEO_URL || ""
).trim();

const WELCOME_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const _WELCOME_CACHE = new Map();

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

function toNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function resolveBalanceValue(res) {
  return toNum(
    res?.balance ??
      res?.data?.balance ??
      res?.credits ??
      res?.wallet?.balance ??
      0,
    0
  );
}

function isDemoUrlUsable(url = "") {
  const value = String(url || "").trim();
  if (!value) return false;
  if (value.includes("/DEMO")) return false;
  return true;
}

function getDemoLine() {
  if (!isDemoUrlUsable(KADI_DEMO_VIDEO_URL)) return "";
  return `\n\n📹 Démo rapide : ${KADI_DEMO_VIDEO_URL}`;
}

function pickExample(waId = "") {
  const examples = Object.values(PROFESSION_EXAMPLES);
  const idx =
    String(waId)
      .split("")
      .reduce((acc, c) => acc + c.charCodeAt(0), 0) % examples.length;

  return examples[idx] || PROFESSION_EXAMPLES.default;
}

function detectProfessionCategory(text = "") {
  const t = norm(text);

  if (
    t.includes("soudeur") ||
    t.includes("maçon") ||
    t.includes("macon") ||
    t.includes("btp") ||
    t.includes("chantier") ||
    t.includes("plombier") ||
    t.includes("électricien") ||
    t.includes("electricien") ||
    t.includes("menuisier")
  ) {
    return "btp";
  }

  if (
    t.includes("boutique") ||
    t.includes("commerce") ||
    t.includes("vendeur") ||
    t.includes("vente") ||
    t.includes("épicerie") ||
    t.includes("epicerie")
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
    t.includes("mécanicien") ||
    t.includes("mecanicien") ||
    t.includes("coiffeur") ||
    t.includes("coiffeuse") ||
    t.includes("couturier") ||
    t.includes("couturiere") ||
    t.includes("couturière") ||
    t.includes("réparation") ||
    t.includes("reparation") ||
    t.includes("services")
  ) {
    return "services";
  }

  return null;
}

function buildProfessionExample(category) {
  return PROFESSION_EXAMPLES[category] || PROFESSION_EXAMPLES.default;
}

function getZeroDocSegment(daysSinceSignup = 0) {
  const d = Number(daysSinceSignup || 0);

  if (d < 7) return "A";
  if (d <= 30) return "B";
  return "C";
}

function getWelcomeCacheTs(waId) {
  return _WELCOME_CACHE.get(String(waId || "").trim()) || 0;
}

function setWelcomeCacheTs(waId) {
  _WELCOME_CACHE.set(String(waId || "").trim(), Date.now());
}

function isWelcomeRecentlyChecked(waId) {
  const ts = getWelcomeCacheTs(waId);
  return !!ts && Date.now() - ts < WELCOME_CACHE_TTL_MS;
}

async function safeUpdateProfile(waId, patch = {}) {
  try {
    await updateProfile(waId, patch);
  } catch (e) {
    console.warn("⚠️ updateProfile:", e?.message || e);
  }
}

async function safeMarkOnboardingDone(waId) {
  try {
    await markOnboardingDone(waId, 1);
    return;
  } catch (_) {}

  await safeUpdateProfile(waId, { onboarding_done: true });
}

async function sendPrimaryDocActions(from, options = {}) {
  const includeOcr = options.includeOcr !== false;
  const includeProfile = options.includeProfile === true;

  const buttons = [{ id: "HOME_DOCS", title: "📄 Créer doc" }];

  if (includeOcr) {
    buttons.push({ id: "HOME_OCR", title: "📷 Envoyer photo" });
  } else if (includeProfile) {
    buttons.push({ id: "HOME_PROFILE", title: "👤 Profil" });
  } else {
    buttons.push({ id: "BACK_HOME", title: "🏠 Menu" });
  }

  if (includeOcr) {
    buttons.push({ id: "BACK_HOME", title: "🏠 Menu" });
  }

  await sendButtons(from, "Choisissez une action 👇", buttons);
}

// ─────────────────────────────────────────────────────────────
// 🎁 WELCOME CREDITS
// ─────────────────────────────────────────────────────────────
async function ensureWelcomeCredits(waId) {
  try {
    if (!isValidWhatsAppId(waId)) return false;
    if (isWelcomeRecentlyChecked(waId)) return false;

    const profile = await getOrCreateProfile(waId);

    if (profile?.welcome_credits_granted === true) {
      setWelcomeCacheTs(waId);
      return false;
    }

    const balanceRes = await getBalance({ waId });
    const balance = resolveBalanceValue(balanceRes);

    if (balance > 0) {
      await safeUpdateProfile(waId, {
        welcome_credits_granted: true,
      });
      setWelcomeCacheTs(waId);
      return false;
    }

    const opKey = `welcome:${waId}`;
    const addRes = await addCredits(
      { waId },
      WELCOME_CREDITS,
      "welcome",
      opKey,
      {
        welcomeCredits: WELCOME_CREDITS,
      }
    );

    await safeUpdateProfile(waId, {
      welcome_credits_granted: true,
    });

    setWelcomeCacheTs(waId);

    if (addRes?.idempotent) {
      return false;
    }

    await sendText(
      waId,
      `🎁 Bienvenue sur *KADI*\n` +
        `Vous recevez *${WELCOME_CREDITS} crédits gratuits* pour commencer.\n` +
        `📄 1 PDF simple = ${PDF_SIMPLE_CREDITS} crédit.`
    );

    return true;
  } catch (e) {
    console.warn("⚠️ ensureWelcomeCredits:", e?.message || e);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// 🚀 ONBOARDING PRINCIPAL
// ─────────────────────────────────────────────────────────────
async function maybeSendOnboarding(from) {
  try {
    if (!isValidWhatsAppId(from)) return false;

    const p = await getOrCreateProfile(from);
    if (p?.onboarding_done === true) return false;

    const example =
      buildProfessionExample(p?.profession_category) || pickExample(from);

    await sendText(
      from,
      `👋 Bienvenue sur *KADI*\n\n` +
        `Je crée vos *devis, factures, reçus et décharges* directement sur WhatsApp.\n\n` +
        `✍️ Écrivez simplement comme vous parlez.\n` +
        `Exemple :\n${example}`
    );

    await sendText(
      from,
      `🎤 Vous pouvez aussi envoyer un *message vocal*.\n` +
        `📷 Ou envoyer une *photo* pour transformer un document existant.` +
        getDemoLine()
    );

    await sendButtons(from, "Choisissez votre activité 👇", [
      { id: "ONBOARDING_PRO_BTP", title: "🔧 BTP" },
      { id: "ONBOARDING_PRO_COMMERCE", title: "🛒 Commerce" },
      { id: "ONBOARDING_PRO_RESTO", title: "🍽️ Resto" },
    ]);

    await safeMarkOnboardingDone(from);
    return true;
  } catch (e) {
    console.warn("⚠️ maybeSendOnboarding:", e?.message || e);
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

    await safeUpdateProfile(from, {
      profession_text: String(text || "").trim().slice(0, 80),
      profession_category: category,
    });

    const example = buildProfessionExample(category);

    await sendText(
      from,
      `Parfait 👌\n\n` +
        `Essayez maintenant en écrivant :\n\n${example}\n\n` +
        `Ou envoyez la même demande en vocal 🎤`
    );

    await sendPrimaryDocActions(from, { includeOcr: true });
    return true;
  } catch (e) {
    console.warn("⚠️ tryHandleProfessionIntro:", e?.message || e);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// 🔘 RÉPONSES BOUTONS ONBOARDING
// ─────────────────────────────────────────────────────────────
async function handleOnboardingReply(from, replyId) {
  try {
    let category = null;

    if (replyId === "ONBOARDING_PRO_BTP") category = "btp";
    if (replyId === "ONBOARDING_PRO_COMMERCE") category = "commerce";
    if (replyId === "ONBOARDING_PRO_RESTO") category = "restauration";
    if (replyId === "ONBOARDING_PRO_SERVICES") category = "services";

    if (!category) return false;

    await safeUpdateProfile(from, {
      profession_category: category,
    });

    const example = buildProfessionExample(category);

    await sendText(
      from,
      `Parfait 👌\n\n` +
        `Essayez maintenant en écrivant :\n\n${example}\n\n` +
        `Ou envoyez votre besoin en vocal 🎤`
    );

    await sendPrimaryDocActions(from, { includeOcr: true });
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
        `👋 Vous avez rejoint *KADI* récemment mais vous n’avez pas encore créé de document.\n\n` +
          `Essayez simplement :\n\n${example}\n\n` +
          `Ou envoyez-le en vocal 🎤`
      );
    } else if (segment === "B") {
      let bonusLine = "";
      if (REONBOARDING_BONUS_CREDITS > 0) {
        bonusLine =
          `\n🎁 Bonus retour : *${REONBOARDING_BONUS_CREDITS} crédit(s)* après votre premier document.`;
      }

      await sendText(
        from,
        `👋 Beaucoup d’utilisateurs créent déjà leurs documents avec *KADI*.\n\n` +
          `Vous pouvez commencer en quelques secondes :\n\n${example}${bonusLine}`
      );
    } else {
      await sendText(
        from,
        `👋 *KADI* s’est amélioré depuis votre inscription.\n\n` +
          `Nouveau : vocal, OCR photo, décharges.\n\n` +
          `Essayez maintenant :\n\n${example}${getDemoLine()}`
      );
    }

    await sendPrimaryDocActions(from, { includeOcr: true });
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
    const example =
      buildProfessionExample(p?.profession_category) || pickExample(from);

    await sendText(
      from,
      `👋 Vous n’avez pas encore créé votre premier document sur *KADI*.\n\n` +
        `Essayez simplement :\n\n${example}\n\n` +
        `Ou envoyez votre demande en vocal 🎤`
    );

    await sendPrimaryDocActions(from, { includeOcr: false });
  } catch (e) {
    console.warn("⚠️ sendActivationJ1:", e?.message || e);
  }
}

async function sendActivationJ7(from) {
  try {
    await sendButtons(
      from,
      `👋 Vous pouvez aussi utiliser *KADI* pour :\n\n` +
        `📷 Transformer une photo en document\n` +
        `🎤 Envoyer un vocal\n` +
        `👤 Compléter votre profil\n\n` +
        `Choisissez une action 👇`,
      [
        { id: "HOME_OCR", title: "📷 Photo" },
        { id: "HOME_DOCS", title: "📄 Créer doc" },
        { id: "HOME_PROFILE", title: "👤 Profil" },
      ]
    );
  } catch (e) {
    console.warn("⚠️ sendActivationJ7:", e?.message || e);
  }
}

async function sendReactivationNudge(from, options = {}) {
  try {
    const daysInactive = Number(options.daysInactive || 0);
    const professionCategory = options.professionCategory || null;
    const example =
      buildProfessionExample(professionCategory) || pickExample(from);

    const intro =
      daysInactive >= 30
        ? "👋 Cela fait quelque temps que vous n’avez pas utilisé *KADI*.\n\n"
        : "👋 Cela fait un moment.\n\n";

    await sendText(
      from,
      intro +
        `Essayez simplement :\n\n${example}\n\n` +
        `Ou envoyez votre besoin en vocal 🎤` +
        getDemoLine()
    );

    await sendPrimaryDocActions(from, { includeOcr: true });
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
        `Rechargez maintenant pour continuer 👇`,
      [
        { id: "RECHARGE_1000", title: "1000F" },
        { id: "RECHARGE_2000", title: "2000F" },
        { id: "HOME_CREDITS", title: "💳 Packs" },
      ]
    );
  } catch (e) {
    console.warn("⚠️ sendLowCreditsAlert:", e?.message || e);
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
        { id: "RECHARGE_1000", title: "1000F" },
        { id: "RECHARGE_2000", title: "2000F" },
        { id: "HOME_CREDITS", title: "💳 Packs" },
      ]
    );
  } catch (e) {
    console.warn("⚠️ sendZeroCreditsBlock:", e?.message || e);
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