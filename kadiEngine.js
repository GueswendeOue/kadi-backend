// kadiEngine.js
"use strict";

/**
 * KADI ENGINE — COMPLET (Docs + Crédit + Profil + Onboarding + OCR photo->PDF + Décharge)
 *
 * Dépendances attendues:
 * - ./kadiState (getSession)
 * - ./kadiCounter (nextDocNumber)
 * - ./kadiPdf (buildPdfBuffer)  // devis/facture/reçu
 * - ./kadiDechargePdf (buildDechargePdfBuffer) // ✅ à créer (je te le donne après)
 * - ./kadiRepo (saveDocument)   // on ne touche pas
 * - ./store (getOrCreateProfile, updateProfile, markOnboardingDone, isProfileBasicComplete)
 * - ./supabaseStorage (uploadLogoBuffer, getSignedLogoUrl, downloadSignedUrlToBuffer)
 * - ./kadiOcr (ocrImageBuffer)
 * - ./whatsappApi (sendText, sendButtons, getMediaInfo, downloadMediaToBuffer, uploadMediaBuffer, sendDocument)
 * - ./kadiCreditsRepo (getBalance, consumeCredit, createRechargeCodes, redeemCode, addCredits)
 * - ./kadiActivityRepo (recordActivity)
 * - ./kadiStatsRepo (getStats, getTopClients, getDocsForExport, money)
 */

const { getSession } = require("./kadiState");
const { nextDocNumber } = require("./kadiCounter");
const { buildPdfBuffer } = require("./kadiPdf");
let buildDechargePdfBuffer = null;
try {
  buildDechargePdfBuffer = require("./kadiDechargePdf").buildDechargePdfBuffer;
} catch (_) {
  buildDechargePdfBuffer = null; // on gère proprement si pas encore ajouté
}

const { saveDocument } = require("./kadiRepo");
const {
  getOrCreateProfile,
  updateProfile,
  markOnboardingDone,
  isProfileBasicComplete,
} = require("./store");

const {
  uploadLogoBuffer,
  getSignedLogoUrl,
  downloadSignedUrlToBuffer,
} = require("./supabaseStorage");

const {
  sendText,
  sendButtons,
  getMediaInfo,
  downloadMediaToBuffer,
  uploadMediaBuffer,
  sendDocument,
} = require("./whatsappApi");

const {
  getBalance,
  consumeCredit,
  createRechargeCodes,
  redeemCode,
  addCredits,
} = require("./kadiCreditsRepo");

const { recordActivity } = require("./kadiActivityRepo");
const { getStats, getTopClients, getDocsForExport, money } = require("./kadiStatsRepo");

const { ocrImageBuffer } = require("./kadiOcr");

// ---------------- Config ----------------
const ADMIN_WA_ID = process.env.ADMIN_WA_ID || "";
const OM_NUMBER = process.env.OM_NUMBER || "76894642";
const OM_NAME = process.env.OM_NAME || "GUESWENDE Ouedraogo";
const PRICE_LABEL = process.env.CREDITS_PRICE_LABEL || "2000F = 25 crédits";
const WELCOME_CREDITS = Number(process.env.WELCOME_CREDITS || 50);

const PACK_CREDITS = Number(process.env.PACK_CREDITS || 25);
const PACK_PRICE_FCFA = Number(process.env.PACK_PRICE_FCFA || 2000);

const OCR_CREDITS_COST = Number(process.env.OCR_CREDITS_COST || 2); // ✅ photo->pdf plus cher
const TEXT_CREDITS_COST = Number(process.env.TEXT_CREDITS_COST || 1);

const OCR_LANG = process.env.OCR_LANG || "fra"; // "fra" ou "eng+fra"

const _WELCOME_CACHE = new Set();

// ---------------- Utils ----------------
function norm(s) {
  return String(s || "").trim();
}

function isYes(s) {
  const t = String(s || "").trim().toLowerCase();
  return t === "oui" || t === "yes" || t === "ok" || t === "d'accord" || t === "daccord";
}

function formatDateISO(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseDaysArg(text, defDays) {
  const m = String(text || "").trim().match(/(?:\s+)(\d{1,3})\b/);
  if (!m) return defDays;
  const d = Number(m[1]);
  if (!Number.isFinite(d) || d <= 0) return defDays;
  return Math.min(d, 365);
}

function cleanNumber(str) {
  if (str == null) return null;
  let s = String(str).trim();
  if (!s) return null;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if (hasComma && !hasDot) {
    const parts = s.split(",");
    if (parts.length === 2 && parts[1].length !== 3) s = `${parts[0]}.${parts[1]}`;
    else s = s.replace(/,/g, "");
  } else {
    s = s.replace(/,/g, "");
  }

  s = s.replace(/\s/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function extractNumbersSmart(text) {
  const t = String(text || "");
  const digitTokens = t.match(/\d+/g) || [];

  if (digitTokens.length === 0) {
    const dec = t.match(/\d+(?:[.,]\d+)?/g) || [];
    return dec.map(cleanNumber).filter((n) => typeof n === "number");
  }

  const merged = [];
  for (let i = 0; i < digitTokens.length; i++) {
    const cur = digitTokens[i];
    const next = digitTokens[i + 1];

    if (cur.length <= 3 && next && next.length === 3) {
      let acc = cur;
      let j = i + 1;
      while (j < digitTokens.length && digitTokens[j].length === 3) {
        acc += digitTokens[j];
        j++;
      }
      merged.push(acc);
      i = j - 1;
      continue;
    }

    merged.push(cur);
  }

  return merged.map(cleanNumber).filter((n) => typeof n === "number");
}

// vitrier / dimension: 44x34 cm etc.
function hasDimensionPattern(raw) {
  const s = String(raw || "").toLowerCase();

  if (/\b\d+(?:[.,]\d+)?\s*(cm|mm|m)\s*[x×]\s*\d+(?:[.,]\d+)?\s*(cm|mm|m)?\b/.test(s)) return true;

  const m = s.match(/\b(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\b/);
  if (m) {
    const a = cleanNumber(m[1]);
    const b = cleanNumber(m[2]);
    if (a != null && b != null) {
      if (a <= 500 && b <= 500) return true;
    }
  }
  return false;
}

// Format structuré D/Q/PU
function parseStructuredItemLine(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;

  const getField = (key) => {
    const re = new RegExp(`\\b${key}\\b\\s*[:=]\\s*([^|;,]+)`, "i");
    const m = raw.match(re);
    return m ? m[1].trim() : null;
  };

  const d = getField("d") || getField("designation") || getField("désignation");
  const qStr =
    getField("q") ||
    getField("qty") ||
    getField("qte") ||
    getField("qté") ||
    getField("quantite") ||
    getField("quantité");
  const puStr = getField("pu") || getField("prix") || getField("prixunitaire") || getField("unitprice");

  if (!d && !qStr && !puStr) return null;

  const qty = cleanNumber(qStr) ?? 1;
  const unitPrice = cleanNumber(puStr) ?? 0;
  const label = d || raw;
  const amount = Number(qty) * Number(unitPrice || 0);

  return {
    label,
    qty: Number(qty) || 1,
    unitPrice: Number(unitPrice) || 0,
    amount: Number.isFinite(amount) ? amount : 0,
    raw,
  };
}

// Parse “libre” universel
function parseItemLine(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;

  const isDim = hasDimensionPattern(raw);
  let qty = null;

  if (!isDim) {
    const xAfter = raw.match(/(?:^|\s)x\s*(\d{1,3})\b/i); // x2
    const xBefore = raw.match(/(?:^|\s)(\d{1,3})\s*x\b/i); // 2x
    if (xAfter) qty = Number(xAfter[1]);
    else if (xBefore) qty = Number(xBefore[1]);
  }

  const numbers = extractNumbersSmart(raw).filter((n) => Number.isFinite(n));

  let unitPrice = 0;
  if (numbers.length === 1) unitPrice = numbers[0];
  else if (numbers.length >= 2) {
    const nonYear = numbers.filter((n) => !(n >= 1900 && n <= 2100));
    const pool = nonYear.length ? nonYear : numbers;

    if (isDim) {
      const bigs = pool.filter((n) => n >= 500);
      unitPrice = bigs.length ? Math.max(...bigs) : Math.max(...pool);
    } else {
      unitPrice = Math.max(...pool);
    }
  }

  if (!qty) {
    const smalls = numbers.filter((n) => Number.isInteger(n) && n > 0 && n <= 100);
    qty = smalls.length ? smalls[0] : 1;
  }

  let label = raw;
  if (!isDim) {
    label = label
      .replace(/(?:^|\s)(\d{1,3})\s*x\b/gi, " ")
      .replace(/(?:^|\s)x\s*(\d{1,3})\b/gi, " ");
  }
  label = label.replace(/[-:]+/g, " ").replace(/\s+/g, " ").trim() || raw;

  const amount = Number(qty) * Number(unitPrice || 0);

  return {
    label,
    qty: Number(qty) || 1,
    unitPrice: Number(unitPrice) || 0,
    amount: Number.isFinite(amount) ? amount : 0,
    raw,
  };
}

function sumItems(items) {
  let sum = 0;
  for (const it of items || []) {
    const a = Number(it?.amount);
    if (Number.isFinite(a)) sum += a;
  }
  return sum;
}

function computeFinance(doc) {
  const subtotal = sumItems(doc.items || []);
  const gross = subtotal;
  return { subtotal, gross };
}

function guessDocTypeFromText(ocrText) {
  const t = String(ocrText || "").toLowerCase();
  if (!t) return null;

  if (t.includes("décharge") || t.includes("decharge")) return "decharge";
  if (t.includes("reçu") || t.includes("recu")) return "recu";
  if (t.includes("facture")) return "facture";
  if (t.includes("devis")) return "devis";

  // heuristiques légères
  if (t.includes("pro forma") || t.includes("proforma")) return "facture";
  return null;
}

// ---------------- Welcome credits ----------------
async function ensureWelcomeCredits(waId) {
  try {
    if (_WELCOME_CACHE.has(waId)) return;

    const p = await getOrCreateProfile(waId);

    if (p && p.welcome_credits_granted === true) {
      _WELCOME_CACHE.add(waId);
      return;
    }

    const bal = await getBalance(waId);
    if (bal > 0) {
      _WELCOME_CACHE.add(waId);
      try {
        await updateProfile(waId, { welcome_credits_granted: true });
      } catch (_) {}
      return;
    }

    await addCredits(waId, WELCOME_CREDITS, "welcome");
    _WELCOME_CACHE.add(waId);

    try {
      await updateProfile(waId, { welcome_credits_granted: true });
    } catch (_) {}

    await sendText(
      waId,
      `🎁 Bienvenue sur KADI !\nVous recevez *${WELCOME_CREDITS} crédits gratuits*.\n📄 Texte → PDF = ${TEXT_CREDITS_COST} crédit\n📸 Photo → PDF = ${OCR_CREDITS_COST} crédits`
    );
  } catch (e) {
    console.warn("⚠️ ensureWelcomeCredits error:", e?.message);
  }
}

// ---------------- Onboarding (simple + captivant) ----------------
async function maybeRunOnboarding(from) {
  const p = await getOrCreateProfile(from);

  // si onboarding déjà fait -> rien
  if (p && p.onboarding_done === true) return;

  // Onboarding ultra simple (3 messages max)
  await sendText(
    from,
    `👋 *Bienvenue sur KADI*\n\nJe transforme tes messages WhatsApp en *PDF pro* :\n✅ Devis • Factures • Reçus • Décharges\n\n👉 Tape *MENU* pour commencer.`
  );

  await sendText(
    from,
    `⚡ *2 façons d’utiliser*\n\n1) ✍️ *Texte* : écris tes lignes → PDF (${TEXT_CREDITS_COST} crédit)\n2) 📸 *Photo* : envoie une photo → KADI extrait → PDF (${OCR_CREDITS_COST} crédits)\n\nAstuce : configure ton *Profil* pour mettre ton nom & contacts sur le PDF.`
  );

  await sendText(
    from,
    `🏢 *Pour personnaliser tes documents*\nVa dans *Profil* et mets au moins :\n• Nom entreprise\n• Téléphone ou Email\n• (optionnel) Logo\n\n✅ Ensuite KADI mettra tout automatiquement sur tes PDF.`
  );

  // marque onboarding done (si colonnes existent)
  await markOnboardingDone(from, 1);
}

// ---------------- Menus ----------------
async function sendHomeMenu(to) {
  return sendButtons(to, "👋 Menu KADI — Choisis :", [
    { id: "HOME_DOCS", title: "Documents" },
    { id: "HOME_CREDITS", title: "Crédits" },
    { id: "HOME_PROFILE", title: "Profil" },
  ]);
}

async function sendDocsMenu(to) {
  return sendButtons(to, "📄 Quel document veux-tu créer ?", [
    { id: "DOC_DEVIS", title: "Devis" },
    { id: "DOC_FACTURE", title: "Facture" },
    { id: "DOC_RECU", title: "Reçu" },
  ]);
}

// ✅ bouton décharge séparé (sinon limite 3 boutons)
async function sendDocsMenu2(to) {
  return sendButtons(to, "📄 Suite documents :", [
    { id: "DOC_DECHARGE", title: "Décharge" },
    { id: "DOC_PHOTO", title: "Photo → PDF" },
    { id: "BACK_HOME", title: "Menu" },
  ]);
}

async function sendFactureKindMenu(to) {
  return sendButtons(to, "🧾 Quel type de facture ?", [
    { id: "FAC_PROFORMA", title: "Pro forma" },
    { id: "FAC_DEFINITIVE", title: "Définitive" },
    { id: "BACK_DOCS", title: "Retour" },
  ]);
}

async function sendCreditsMenu(to) {
  return sendButtons(to, "💳 Crédits KADI", [
    { id: "CREDITS_SOLDE", title: "Voir solde" },
    { id: "CREDITS_RECHARGE", title: "Recharger" },
    { id: "BACK_HOME", title: "Menu" },
  ]);
}

async function sendProfileMenu(to) {
  return sendButtons(to, "🏢 Profil entreprise", [
    { id: "PROFILE_EDIT", title: "Configurer" },
    { id: "PROFILE_VIEW", title: "Voir" },
    { id: "BACK_HOME", title: "Menu" },
  ]);
}

async function sendAfterPreviewMenu(to) {
  return sendButtons(to, "✅ Vérifie l’aperçu. Tu fais quoi ?", [
    { id: "DOC_CONFIRM", title: "Confirmer (PDF)" },
    { id: "DOC_RESTART", title: "Recommencer" },
    { id: "BACK_HOME", title: "Menu" },
  ]);
}

async function sendAfterDechargePreviewMenu(to) {
  return sendButtons(to, "✅ Décharge prête. Tu fais quoi ?", [
    { id: "DCH_CONFIRM", title: "Confirmer (PDF)" },
    { id: "DCH_CONFIRM_WA", title: "Confirmer WhatsApp" },
    { id: "BACK_HOME", title: "Menu" },
  ]);
}

async function sendOcrDocTypeMenu(to) {
  return sendButtons(to, "📸 Photo reçue. Quel type de document ?", [
    { id: "OCR_DEVIS", title: "Devis" },
    { id: "OCR_FACTURE", title: "Facture" },
    { id: "OCR_RECU", title: "Reçu" },
  ]);
}

async function sendOcrDocTypeMenu2(to) {
  return sendButtons(to, "📸 Suite :", [
    { id: "OCR_DECHARGE", title: "Décharge" },
    { id: "OCR_CANCEL", title: "Annuler" },
    { id: "BACK_HOME", title: "Menu" },
  ]);
}

// ---------------- Profil ----------------
async function startProfileFlow(from) {
  const s = getSession(from);
  s.step = "profile";
  s.profileStep = "business_name";
  await getOrCreateProfile(from);

  await sendText(
    from,
    "🏢 *Profil entreprise*\n\n1/7 — Nom de l’entreprise ?\nEx: GUESWENDE Technologies\n\n📌 Tape 0 pour ignorer un champ."
  );
}

async function handleProfileAnswer(from, text) {
  const s = getSession(from);
  if (s.step !== "profile" || !s.profileStep) return false;

  const t = norm(text);
  const skip = t === "0";
  const step = s.profileStep;

  if (step === "business_name") {
    await updateProfile(from, { business_name: skip ? null : t });
    s.profileStep = "address";
    await sendText(from, "2/7 — Adresse ? (ou 0)");
    return true;
  }
  if (step === "address") {
    await updateProfile(from, { address: skip ? null : t });
    s.profileStep = "phone";
    await sendText(from, "3/7 — Téléphone pro ? (ou 0)");
    return true;
  }
  if (step === "phone") {
    await updateProfile(from, { phone: skip ? null : t });
    s.profileStep = "email";
    await sendText(from, "4/7 — Email ? (ou 0)");
    return true;
  }
  if (step === "email") {
    await updateProfile(from, { email: skip ? null : t });
    s.profileStep = "ifu";
    await sendText(from, "5/7 — IFU ? (ou 0)");
    return true;
  }
  if (step === "ifu") {
    await updateProfile(from, { ifu: skip ? null : t });
    s.profileStep = "rccm";
    await sendText(from, "6/7 — RCCM ? (ou 0)");
    return true;
  }
  if (step === "rccm") {
    await updateProfile(from, { rccm: skip ? null : t });
    s.profileStep = "logo";
    await sendText(from, "7/7 — Envoie ton logo en *image* (ou tape 0)");
    return true;
  }
  if (step === "logo") {
    if (skip) {
      s.step = "idle";
      s.profileStep = null;
      await sendText(from, "✅ Profil enregistré (sans logo).");
      await sendHomeMenu(from);
      return true;
    }
    await sendText(from, "⚠️ Pour le logo, envoie une *image*. Ou tape 0.");
    return true;
  }
  return false;
}

// ---------------- Recharge + preuve ----------------
async function replyRechargeInfo(from) {
  const s = getSession(from);
  s.step = "recharge_proof";

  await sendText(
    from,
    `💰 *Recharger vos crédits KADI*\n\n✅ Orange Money\n📌 Numéro : *${OM_NUMBER}*\n👤 Nom : *${OM_NAME}*\n💳 Offre : *${PRICE_LABEL}*\n\n📎 Après paiement, envoyez ici une *preuve* (capture d’écran).\n\n🔑 Si vous avez un code: *CODE KDI-XXXX-XXXX*`
  );
}

async function handleRechargeProofImage(from, msg) {
  try {
    if (!ADMIN_WA_ID) {
      await sendText(from, "✅ Preuve reçue. Le support vous contactera.");
      return;
    }

    const mediaId = msg?.image?.id;
    if (!mediaId) {
      await sendText(from, "❌ Preuve reçue mais sans media_id. Réessayez.");
      return;
    }

    const info = await getMediaInfo(mediaId);
    const mime = info.mime_type || "image/jpeg";
    const buf = await downloadMediaToBuffer(info.url);

    const filename = `preuve-${from}-${Date.now()}.jpg`;
    const up = await uploadMediaBuffer({ buffer: buf, filename, mimeType: mime });

    if (up?.id) {
      await sendDocument({
        to: ADMIN_WA_ID,
        mediaId: up.id,
        filename,
        caption:
          `🧾 *Preuve de paiement reçue*\nClient WA: ${from}\nOffre: ${PRICE_LABEL}\n\n✅ Action admin:\nADMIN ADD ${from} ${PACK_CREDITS}`,
      });
    } else {
      await sendText(ADMIN_WA_ID, `🧾 Preuve paiement reçue (upload fail). Client: ${from}`);
    }

    await sendText(from, "✅ Merci. Preuve transmise au support. ⏳");
    const s = getSession(from);
    s.step = "idle";
    await sendHomeMenu(from);
  } catch (e) {
    console.error("handleRechargeProofImage error:", e?.message);
    await sendText(from, "❌ Désolé, la preuve n’a pas pu être traitée. Réessayez.");
  }
}

// ---------------- Image router (logo / recharge proof / OCR photo) ----------------
async function handleIncomingImage(from, msg) {
  const s = getSession(from);

  // 1) preuve paiement
  if (s.step === "recharge_proof") return handleRechargeProofImage(from, msg);

  // 2) logo (uniquement si on est dans l’étape logo du profil)
  if (s.step === "profile" && s.profileStep === "logo") return handleLogoImage(from, msg);

  // 3) sinon => photo->pdf (OCR)
  return handleOcrImage(from, msg);
}

async function handleLogoImage(from, msg) {
  const mediaId = msg?.image?.id;
  if (!mediaId) {
    await sendText(from, "❌ Image reçue mais sans media_id. Réessayez.");
    return;
  }

  const info = await getMediaInfo(mediaId);
  const mime = info.mime_type || "image/jpeg";
  const buf = await downloadMediaToBuffer(info.url);

  const { filePath } = await uploadLogoBuffer({ userId: from, buffer: buf, mimeType: mime });
  await updateProfile(from, { logo_path: filePath });

  const s = getSession(from);
  if (s.step === "profile" && s.profileStep === "logo") {
    s.step = "idle";
    s.profileStep = null;
    await sendText(from, "✅ Logo enregistré. Profil terminé.");
    await sendHomeMenu(from);
    return;
  }

  await sendText(from, "✅ Logo enregistré.");
}

// ---------------- OCR: Photo -> Draft ----------------
async function startPhotoMode(from) {
  const s = getSession(from);
  s.step = "photo_mode";
  await sendText(
    from,
    `📸 *Photo → PDF*\n\nEnvoie une photo (devis/facture/reçu/décharge).\nKADI va extraire le texte et générer un PDF.\n💳 Coût: *${OCR_CREDITS_COST} crédits*`
  );
}

async function handleOcrImage(from, msg) {
  const mediaId = msg?.image?.id;
  if (!mediaId) {
    await sendText(from, "❌ Image reçue mais sans media_id. Réessayez.");
    return;
  }

  await sendText(from, "📸 Photo reçue… je lis le document (OCR) ⏳");

  const info = await getMediaInfo(mediaId);
  const buf = await downloadMediaToBuffer(info.url);

  let ocrText = "";
  try {
    ocrText = await ocrImageBuffer(buf, OCR_LANG);
  } catch (e) {
    console.error("OCR error:", e?.message);
    await sendText(
      from,
      "❌ OCR impossible pour le moment.\nVérifie que Tesseract est installé sur l’hébergeur, puis réessaie."
    );
    return;
  }

  const guessed = guessDocTypeFromText(ocrText);

  const s = getSession(from);
  s.step = "awaiting_ocr_doc_type";
  s.ocrText = ocrText;
  s.ocrGuessed = guessed;

  // si on devine, on propose direct “OK” via bouton
  if (guessed) {
    const label =
      guessed === "facture" ? "Facture" : guessed === "devis" ? "Devis" : guessed === "recu" ? "Reçu" : "Décharge";
    await sendButtons(from, `✅ Je pense que c’est un *${label}*.\nConfirmer ?`, [
      { id: `OCR_USE_${guessed.toUpperCase()}`, title: "Oui" },
      { id: "OCR_CHOOSE", title: "Choisir type" },
      { id: "OCR_CANCEL", title: "Annuler" },
    ]);
    return;
  }

  // sinon menus type
  await sendOcrDocTypeMenu(from);
  await sendOcrDocTypeMenu2(from);
}

function buildDraftFromOcrText({ type, factureKind, ocrText }) {
  // On réutilise la logique “texte” => lignes
  const draft = {
    type,
    factureKind: factureKind || null,
    source: "ocr",
    docNumber: null,
    date: formatDateISO(),
    client: null,
    items: [],
    finance: null,
    rawOcr: ocrText || "",
  };

  const lines = String(ocrText || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const m = line.match(/^client\s*[:\-]\s*(.+)$/i);
    if (m && !draft.client) {
      draft.client = m[1].trim() || null;
      continue;
    }

    if (/\d/.test(line) && !/^client\s*[:\-]/i.test(line)) {
      const itStructured = parseStructuredItemLine(line);
      const it = itStructured || parseItemLine(line);
      if (it) draft.items.push(it);
    }
  }

  draft.finance = computeFinance(draft);
  return draft;
}

// ---------------- Crédits ----------------
async function replyBalance(from) {
  const bal = await getBalance(from);
  await sendText(
    from,
    `💳 *Votre solde KADI* : ${bal} crédit(s)\n📄 Texte → PDF = ${TEXT_CREDITS_COST}\n📸 Photo → PDF = ${OCR_CREDITS_COST}`
  );
}

// ---------------- Documents (texte) ----------------
async function startDocFlow(from, mode, factureKind = null) {
  const s = getSession(from);
  s.step = "collecting_doc";
  s.mode = mode;
  s.factureKind = factureKind;

  s.lastDocDraft = {
    type: mode,
    factureKind,
    source: "text",
    docNumber: null,
    date: formatDateISO(),
    client: null,
    items: [],
    finance: null,
  };

  const prefix =
    mode === "facture"
      ? factureKind === "proforma"
        ? "🧾 Facture Pro forma"
        : "🧾 Facture Définitive"
      : mode === "devis"
      ? "📝 Devis"
      : "🧾 Reçu";

  await sendText(
    from,
    `${prefix}\n\n✅ Écris comme tu veux, KADI comprend.\n\nEx:\nClient: Awa\nDesign logo x1 30000\nImpression x2 5000\n\nFormat conseillé (encore plus précis):\nD: Verre clair 44x34 cm | Q: 2 | PU: 7120\nD: Silicone | Q: 1 | PU: 12000\n\n📌 Astuce: termine et je t’envoie un aperçu + bouton PDF.`
  );
}

async function buildPreviewMessage({ profile, doc }) {
  const bp = profile || {};
  const f = computeFinance(doc);

  const header = [
    bp.business_name ? `🏢 ${bp.business_name}` : null,
    bp.address ? `📍 ${bp.address}` : null,
    bp.phone ? `📞 ${bp.phone}` : null,
    bp.email ? `✉️ ${bp.email}` : null,
    bp.ifu ? `IFU: ${bp.ifu}` : null,
    bp.rccm ? `RCCM: ${bp.rccm}` : null,
    bp.logo_path ? `🖼️ Logo: OK ✅` : `🖼️ Logo: 0`,
  ]
    .filter(Boolean)
    .join("\n");

  const title =
    doc.type === "facture"
      ? doc.factureKind === "proforma"
        ? "FACTURE PRO FORMA"
        : "FACTURE DÉFINITIVE"
      : String(doc.type || "").toUpperCase();

  const lines = (doc.items || [])
    .map(
      (it, idx) =>
        `${idx + 1}) ${it.label} | Qté:${money(it.qty)} | PU:${money(it.unitPrice)} | Montant:${money(it.amount)}`
    )
    .join("\n");

  return [
    header,
    "",
    `📄 *${title}*`,
    `Date : ${doc.date || "—"}`,
    `Client : ${doc.client || "—"}`,
    "",
    "*Lignes :*",
    lines || "0",
    "",
    `Total : ${money(f.gross)} FCFA`,
  ].join("\n");
}

async function handleDocText(from, text) {
  const s = getSession(from);
  if (s.step !== "collecting_doc" || !s.lastDocDraft) return false;

  const draft = s.lastDocDraft;
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const m = line.match(/^client\s*[:\-]\s*(.+)$/i);
    if (m && !draft.client) {
      draft.client = m[1].trim() || null;
      continue;
    }

    if (/\d/.test(line) && !/^client\s*[:\-]/i.test(line)) {
      const itStructured = parseStructuredItemLine(line);
      const it = itStructured || parseItemLine(line);
      if (it) draft.items.push(it);
    }
  }

  draft.finance = computeFinance(draft);

  const profile = await getOrCreateProfile(from);
  const preview = await buildPreviewMessage({ profile, doc: draft });

  // mini rappel profil si pas complet
  if (!isProfileBasicComplete(profile)) {
    await sendText(
      from,
      `${preview}\n\n💡 *Astuce* : ton profil n’est pas complet.\nVa dans *Profil* pour mettre ton nom + téléphone/email sur le PDF.`
    );
  } else {
    await sendText(from, preview);
  }

  await sendAfterPreviewMenu(from);
  return true;
}

async function confirmAndSendPdf(from) {
  const s = getSession(from);
  const draft = s.lastDocDraft;

  if (!draft) {
    await sendText(from, "❌ Aucun document en cours. Tapez MENU.");
    return;
  }

  const cost = draft.source === "ocr" ? OCR_CREDITS_COST : TEXT_CREDITS_COST;

  const cons = await consumeCredit(from, cost, draft.source === "ocr" ? "pdf_ocr" : "pdf");
  if (!cons.ok) {
    await sendText(
      from,
      `❌ Solde insuffisant.\nVous avez ${cons.balance} crédit(s).\nCoût: ${cost} crédit(s).\n👉 Tapez RECHARGE.`
    );
    return;
  }

  draft.docNumber = await nextDocNumber({
    waId: from,
    mode: draft.type,
    factureKind: draft.factureKind,
    dateISO: draft.date,
  });

  const profile = await getOrCreateProfile(from);

  let logoBuf = null;
  if (profile?.logo_path) {
    try {
      const signed = await getSignedLogoUrl(profile.logo_path);
      logoBuf = await downloadSignedUrlToBuffer(signed);
    } catch (e) {
      console.error("logo download error:", e?.message);
    }
  }

  const title =
    draft.type === "facture"
      ? draft.factureKind === "proforma"
        ? "FACTURE PRO FORMA"
        : "FACTURE DÉFINITIVE"
      : String(draft.type || "").toUpperCase();

  const total = draft.finance?.gross ?? computeFinance(draft).gross;

  const pdfBuf = await buildPdfBuffer({
    docData: {
      type: title,
      docNumber: draft.docNumber,
      date: draft.date,
      client: draft.client,
      items: draft.items || [],
      total,
    },
    businessProfile: profile,
    logoBuffer: logoBuf,
  });

  try {
    await saveDocument({ waId: from, doc: draft });
  } catch (e) {
    console.error("saveDocument error:", e?.message);
  }

  const fileName = `${draft.docNumber}-${formatDateISO()}.pdf`;
  const up = await uploadMediaBuffer({
    buffer: pdfBuf,
    filename: fileName,
    mimeType: "application/pdf",
  });

  if (!up?.id) {
    await sendText(from, "❌ Envoi PDF impossible (upload échoué).");
    return;
  }

  await sendDocument({
    to: from,
    mediaId: up.id,
    filename: fileName,
    caption: `✅ ${title} ${draft.docNumber}\nTotal: ${money(total)} FCFA\nCoût: ${cost} crédit(s)\nSolde: ${cons.balance} crédit(s)`,
  });

  s.step = "idle";
  s.mode = null;
  s.factureKind = null;
  s.lastDocDraft = null;
  s.ocrText = null;
  s.ocrGuessed = null;

  await sendHomeMenu(from);
}

// ---------------- Décharge (flow texte) ----------------
async function startDechargeFlow(from) {
  const s = getSession(from);
  s.step = "collecting_decharge";
  s.dechargeStep = "p1_name";

  s.dechargeDraft = {
    type: "decharge",
    source: "text",
    docNumber: null,
    date: formatDateISO(),
    amount: null,
    reason: null,

    // Partie 1: recevant (celui qui reçoit)
    p1_name: null,
    p1_id: null,
    p1_phone: null,

    // Partie 2: remettant (celui qui remet)
    p2_name: null,
    p2_id: null,
    p2_phone: null,
  };

  await sendText(
    from,
    `🧾 *Décharge*\n\nJe vais te poser 7 questions.\n📌 Tape 0 si tu veux ignorer un champ.\n\n1/7 — *Partie 1* (celui qui reçoit)\nNom complet ?`
  );
}

async function handleDechargeAnswer(from, text) {
  const s = getSession(from);
  if (s.step !== "collecting_decharge" || !s.dechargeStep || !s.dechargeDraft) return false;

  const t = norm(text);
  const skip = t === "0";
  const d = s.dechargeDraft;

  const step = s.dechargeStep;

  if (step === "p1_name") {
    d.p1_name = skip ? null : t;
    s.dechargeStep = "p1_id";
    await sendText(from, "2/7 — Partie 1 : Numéro de pièce (CNIB / Passeport) ? (ou 0)");
    return true;
  }

  if (step === "p1_id") {
    d.p1_id = skip ? null : t;
    s.dechargeStep = "p1_phone";
    await sendText(from, "3/7 — Partie 1 : Téléphone WhatsApp ? (ou 0)");
    return true;
  }

  if (step === "p1_phone") {
    d.p1_phone = skip ? null : t;
    s.dechargeStep = "p2_name";
    await sendText(from, "4/7 — *Partie 2* (celui qui remet)\nNom complet ?");
    return true;
  }

  if (step === "p2_name") {
    d.p2_name = skip ? null : t;
    s.dechargeStep = "p2_id";
    await sendText(from, "5/7 — Partie 2 : Numéro de pièce (CNIB / Passeport) ? (ou 0)");
    return true;
  }

  if (step === "p2_id") {
    d.p2_id = skip ? null : t;
    s.dechargeStep = "p2_phone";
    await sendText(from, "6/7 — Partie 2 : Téléphone WhatsApp ? (ou 0)");
    return true;
  }

  if (step === "p2_phone") {
    d.p2_phone = skip ? null : t;
    s.dechargeStep = "amount";
    await sendText(from, "7/7 — Montant remis (ex: 25000) ?");
    return true;
  }

  if (step === "amount") {
    const n = cleanNumber(t);
    if (!Number.isFinite(n) || n <= 0) {
      await sendText(from, "❌ Montant invalide. Exemple: 25000");
      return true;
    }
    d.amount = n;
    s.dechargeStep = "reason";
    await sendText(from, "📝 Motif (ex: règlement, avance, achat, remboursement) ? (ou 0)");
    return true;
  }

  if (step === "reason") {
    d.reason = skip ? null : t;

    // preview
    const preview =
      `🧾 *APERÇU DÉCHARGE*\n` +
      `Date: ${d.date}\n` +
      `Montant: ${money(d.amount)} FCFA\n` +
      `Motif: ${d.reason || "—"}\n\n` +
      `Partie 1 (reçoit): ${d.p1_name || "—"}\n` +
      `Pièce: ${d.p1_id || "—"}\n` +
      `Tel: ${d.p1_phone || "—"}\n\n` +
      `Partie 2 (remet): ${d.p2_name || "—"}\n` +
      `Pièce: ${d.p2_id || "—"}\n` +
      `Tel: ${d.p2_phone || "—"}\n\n` +
      `✅ Tu peux générer le PDF, ou lancer une confirmation WhatsApp.`;

    await sendText(from, preview);
    await sendAfterDechargePreviewMenu(from);

    // step “attente action”
    s.step = "decharge_ready";
    s.dechargeStep = null;
    return true;
  }

  return false;
}

async function confirmAndSendDechargePdf(from) {
  const s = getSession(from);
  const d = s.dechargeDraft;

  if (!d) {
    await sendText(from, "❌ Aucune décharge en cours. Tape MENU.");
    return;
  }

  if (!buildDechargePdfBuffer) {
    await sendText(from, "❌ Module décharge PDF manquant. Ajoute kadiDechargePdf.js puis réessaie.");
    return;
  }

  const cost = TEXT_CREDITS_COST; // décharge texte: 1 crédit (tu peux changer après)
  const cons = await consumeCredit(from, cost, "decharge_pdf");
  if (!cons.ok) {
    await sendText(from, `❌ Solde insuffisant.\nVous avez ${cons.balance} crédit(s).\nCoût: ${cost}`);
    return;
  }

  d.docNumber = await nextDocNumber({
    waId: from,
    mode: "decharge",
    factureKind: null,
    dateISO: d.date,
  });

  const profile = await getOrCreateProfile(from);

  let logoBuf = null;
  if (profile?.logo_path) {
    try {
      const signed = await getSignedLogoUrl(profile.logo_path);
      logoBuf = await downloadSignedUrlToBuffer(signed);
    } catch (e) {
      console.error("logo download error:", e?.message);
    }
  }

  const pdfBuf = await buildDechargePdfBuffer({
    decharge: d,
    businessProfile: profile,
    logoBuffer: logoBuf,
  });

  try {
    await saveDocument({ waId: from, doc: d });
  } catch (e) {
    console.error("saveDocument error:", e?.message);
  }

  const fileName = `${d.docNumber}-${formatDateISO()}.pdf`;
  const up = await uploadMediaBuffer({
    buffer: pdfBuf,
    filename: fileName,
    mimeType: "application/pdf",
  });

  if (!up?.id) {
    await sendText(from, "❌ Envoi PDF impossible (upload échoué).");
    return;
  }

  await sendDocument({
    to: from,
    mediaId: up.id,
    filename: fileName,
    caption: `✅ DÉCHARGE ${d.docNumber}\nMontant: ${money(d.amount)} FCFA\nSolde: ${cons.balance} crédit(s)`,
  });

  // reset
  s.step = "idle";
  s.dechargeDraft = null;
  s.mode = null;

  await sendHomeMenu(from);
}

async function confirmDechargeByWhatsApp(from) {
  const s = getSession(from);
  const d = s.dechargeDraft;

  if (!d) {
    await sendText(from, "❌ Aucune décharge en cours. Tape MENU.");
    return;
  }

  // stratégie simple: on envoie un texte “déclare…”
  const msgP1 =
    `✅ *Confirmation Décharge*\n\n` +
    `Partie 2 (${d.p2_name || "—"}) déclare vous avoir remis *${money(d.amount)} FCFA*.\n` +
    `Motif: ${d.reason || "—"}\n` +
    `Répondez: *OUI* pour confirmer, ou *NON* pour refuser.`;

  const msgP2 =
    `✅ *Confirmation Décharge*\n\n` +
    `Vous déclarez avoir remis à (${d.p1_name || "—"}) la somme de *${money(d.amount)} FCFA*.\n` +
    `Motif: ${d.reason || "—"}\n` +
    `Répondez: *OUI* pour confirmer, ou *NON* pour refuser.`;

  // si numéros pas fournis -> on explique
  if (!d.p1_phone || !d.p2_phone) {
    await sendText(
      from,
      "⚠️ Pour confirmer par WhatsApp, il faut les téléphones des 2 parties.\nRetourne et mets Partie1 Tel & Partie2 Tel."
    );
    return;
  }

  // normaliser (WhatsApp ID doit être en format international sans + si possible)
  const p1 = String(d.p1_phone).replace(/[^\d]/g, "");
  const p2 = String(d.p2_phone).replace(/[^\d]/g, "");

  if (!p1 || !p2) {
    await sendText(from, "❌ Téléphones invalides pour la confirmation WhatsApp.");
    return;
  }

  // on stocke “attente confirmations”
  s.step = "decharge_wait_confirmations";
  s.dechargeConfirm = {
    p1: { wa: p1, ok: null },
    p2: { wa: p2, ok: null },
  };

  // envoyer aux 2
  await sendText(p1, msgP1);
  await sendText(p2, msgP2);

  await sendText(
    from,
    "📩 J’ai envoyé la demande de confirmation aux 2 parties.\nQuand elles répondent OUI/NON, je te dis."
  );
}

// Si une des 2 parties répond OUI/NON
async function handleDechargeConfirmationReply(from, text) {
  const t = String(text || "").trim().toLowerCase();
  if (!(t === "oui" || t === "non")) return false;

  // ⚠️ IMPORTANT: On ne sait pas à quel “dossier” rattacher si tu as plusieurs décharges simultanées.
  // Version simple (MVP): on rattache au dossier en mémoire de la session du numéro qui initie (pas parfait).
  // => Pour un V2, on génère un code unique et on le met dans le message.

  // MVP: on répond juste
  if (t === "oui") {
    await sendText(from, "✅ Confirmation reçue : OUI");
  } else {
    await sendText(from, "❌ Confirmation reçue : NON");
  }
  return true;
}

// ---------------- Admin ----------------
function ensureAdmin(from) {
  return Boolean(ADMIN_WA_ID && from === ADMIN_WA_ID);
}

async function handleAdmin(from, text) {
  if (!ensureAdmin(from)) return false;

  const t = norm(text);

  const mCodes = t.match(/^ADMIN\s+CODES\s+(\d+)\s+(\d+)$/i);
  if (mCodes) {
    const count = Number(mCodes[1]);
    const creditsEach = Number(mCodes[2]);
    const codes = await createRechargeCodes({ count, creditsEach, createdBy: from });
    const preview = codes.slice(0, 20).map((c) => `${c.code} (${c.credits})`).join("\n");
    await sendText(from, `✅ ${codes.length} codes générés.\n\nAperçu (20):\n${preview}`);
    return true;
  }

  const mAdd = t.match(/^ADMIN\s+ADD\s+(\d+)\s+(\d+)$/i);
  if (mAdd) {
    const wa = mAdd[1];
    const amt = Number(mAdd[2]);
    const bal = await addCredits(wa, amt, `admin:${from}`);
    await sendText(from, `✅ Crédité ${amt} sur ${wa}. Nouveau solde: ${bal}`);
    return true;
  }

  const mSolde = t.match(/^ADMIN\s+SOLDE\s+(\d+)$/i);
  if (mSolde) {
    const wa = mSolde[1];
    const bal = await getBalance(wa);
    await sendText(from, `💳 Solde de ${wa}: ${bal} crédit(s)`);
    return true;
  }

  return false;
}

// ---------------- Interactive ----------------
async function handleInteractiveReply(from, replyId) {
  if (replyId === "BACK_HOME") return sendHomeMenu(from);

  if (replyId === "HOME_DOCS") {
    await sendDocsMenu(from);
    return sendDocsMenu2(from);
  }

  if (replyId === "HOME_CREDITS") return sendCreditsMenu(from);
  if (replyId === "HOME_PROFILE") return sendProfileMenu(from);

  // docs texte
  if (replyId === "DOC_DEVIS") return startDocFlow(from, "devis");
  if (replyId === "DOC_RECU") return startDocFlow(from, "recu");
  if (replyId === "DOC_FACTURE") return sendFactureKindMenu(from);

  if (replyId === "FAC_PROFORMA") return startDocFlow(from, "facture", "proforma");
  if (replyId === "FAC_DEFINITIVE") return startDocFlow(from, "facture", "definitive");
  if (replyId === "BACK_DOCS") {
    await sendDocsMenu(from);
    return sendDocsMenu2(from);
  }

  // décharge
  if (replyId === "DOC_DECHARGE") return startDechargeFlow(from);

  // photo mode
  if (replyId === "DOC_PHOTO") return startPhotoMode(from);

  // profil
  if (replyId === "PROFILE_EDIT") return startProfileFlow(from);
  if (replyId === "PROFILE_VIEW") {
    const p = await getOrCreateProfile(from);
    await sendText(
      from,
      `🏢 Profil\nNom: ${p.business_name || "0"}\nAdresse: ${p.address || "0"}\nTel: ${p.phone || "0"}\nEmail: ${p.email || "0"}\nIFU: ${p.ifu || "0"}\nRCCM: ${p.rccm || "0"}\nLogo: ${p.logo_path ? "OK ✅" : "0"}`
    );
    return;
  }

  // crédits
  if (replyId === "CREDITS_SOLDE") return replyBalance(from);
  if (replyId === "CREDITS_RECHARGE") return replyRechargeInfo(from);

  // confirm PDF (docs)
  if (replyId === "DOC_CONFIRM") return confirmAndSendPdf(from);
  if (replyId === "DOC_RESTART") {
    const s = getSession(from);
    s.step = "idle";
    s.mode = null;
    s.factureKind = null;
    s.lastDocDraft = null;
    await sendText(from, "🔁 OK. Recommençons.");
    await sendDocsMenu(from);
    return sendDocsMenu2(from);
  }

  // décharge actions
  if (replyId === "DCH_CONFIRM") return confirmAndSendDechargePdf(from);
  if (replyId === "DCH_CONFIRM_WA") return confirmDechargeByWhatsApp(from);

  // OCR: choix type
  if (replyId === "OCR_CANCEL") {
    const s = getSession(from);
    s.step = "idle";
    s.ocrText = null;
    s.ocrGuessed = null;
    await sendText(from, "✅ OK, annulé.");
    return sendHomeMenu(from);
  }

  if (replyId === "OCR_CHOOSE") {
    await sendOcrDocTypeMenu(from);
    return sendOcrDocTypeMenu2(from);
  }

  if (replyId === "OCR_DEVIS") return applyOcrAsDoc(from, "devis");
  if (replyId === "OCR_FACTURE") return applyOcrAsDoc(from, "facture");
  if (replyId === "OCR_RECU") return applyOcrAsDoc(from, "recu");
  if (replyId === "OCR_DECHARGE") return applyOcrAsDoc(from, "decharge");

  if (replyId.startsWith("OCR_USE_")) {
    const kind = replyId.replace("OCR_USE_", "").toLowerCase(); // devis/facture/recu/decharge
    return applyOcrAsDoc(from, kind);
  }

  await sendText(from, "⚠️ Action non reconnue. Tape MENU.");
}

async function applyOcrAsDoc(from, kind) {
  const s = getSession(from);
  const txt = s.ocrText;

  if (!txt) {
    await sendText(from, "❌ OCR manquant. Renvoie la photo.");
    return;
  }

  // décharge via OCR: pour l’instant on ne “reconstruit” pas automatiquement (ça dépend du modèle).
  // -> MVP: on lance le flow décharge manuel + on met l’OCR en note.
  if (kind === "decharge") {
    await sendText(
      from,
      "🧾 Décharge (photo)\nJ’ai extrait du texte, mais pour la décharge je préfère te poser les infos (plus fiable).\nOn y va."
    );
    // reset OCR stash
    s.ocrText = null;
    s.ocrGuessed = null;
    return startDechargeFlow(from);
  }

  // facture: demander proforma/definitive ? MVP: on laisse definitive par défaut
  let factureKind = null;
  if (kind === "facture") factureKind = "definitive";

  const draft = buildDraftFromOcrText({ type: kind, factureKind, ocrText: txt });
  s.lastDocDraft = draft;
  s.step = "collecting_doc"; // on réutilise le flow confirm PDF

  // reset OCR stash
  s.ocrText = null;
  s.ocrGuessed = null;

  const profile = await getOrCreateProfile(from);
  const preview = await buildPreviewMessage({ profile, doc: draft });

  await sendText(
    from,
    `${preview}\n\n📸 *Source: Photo (OCR)*\nCoût PDF: ${OCR_CREDITS_COST} crédits`
  );
  await sendAfterPreviewMenu(from);
}

// ---------------- Main entry ----------------
async function handleIncomingMessage(value) {
  try {
    if (!value) return;
    if (value.statuses?.length) return;
    if (!value.messages?.length) return;

    const msg = value.messages[0];
    const from = msg.from;

    try {
      await recordActivity(from);
    } catch (e) {
      console.warn("⚠️ recordActivity error:", e?.message);
    }

    await ensureWelcomeCredits(from);

    // onboarding (soft)
    try {
      await maybeRunOnboarding(from);
    } catch (_) {}

    // interactive
    if (msg.type === "interactive") {
      const replyId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
      if (replyId) return handleInteractiveReply(from, replyId);
    }

    // image
    if (msg.type === "image") return handleIncomingImage(from, msg);

    // text
    const text = norm(msg.text?.body);
    if (!text) return;

    const lower = text.toLowerCase();

    // si confirmation décharge (MVP)
    if (await handleDechargeConfirmationReply(from, text)) return;

    // stats admin
    if (lower === "/stats" || lower === "stats") {
      if (!ensureAdmin(from)) return sendText(from, "❌ Commande réservée à l’administrateur.");

      try {
        const stats = await getStats({ packCredits: PACK_CREDITS, packPriceFcfa: PACK_PRICE_FCFA });

        const msgTxt =
          `📊 *KADI — STATISTIQUES*\n\n` +
          `👥 *Utilisateurs*\n` +
          `• Total : ${stats.users.totalUsers}\n` +
          `• Actifs 7j : ${stats.users.active7}\n` +
          `• Actifs 30j : ${stats.users.active30}\n\n` +
          `📄 *Documents*\n` +
          `• Total : ${stats.docs.total}\n` +
          `• 7 derniers jours : ${stats.docs.last7}\n` +
          `• 30 derniers jours : ${stats.docs.last30}\n\n` +
          `💳 *Crédits (7j)*\n` +
          `• Consommés : ${stats.credits.consumed7}\n` +
          `• Ajoutés : ${stats.credits.added7}\n\n` +
          `💰 *Revenu estimé (30j)*\n` +
          `• ≈ ${stats.revenue.est30} FCFA\n` +
          `• Base : ${stats.revenue.packPriceFcfa}F / ${stats.revenue.packCredits} crédits`;

        return sendText(from, msgTxt);
      } catch (e) {
        console.error("❌ /stats error:", e?.message, e);
        return sendText(from, "❌ Erreur: impossible de calculer les stats pour le moment.");
      }
    }

    // top admin
    if (lower.startsWith("/top") || lower.startsWith("top")) {
      if (!ensureAdmin(from)) return sendText(from, "❌ Commande réservée à l’administrateur.");

      const days = parseDaysArg(text, 30);
      const top = await getTopClients({ days, limit: 5 });

      if (!top.length) return sendText(from, `🏆 TOP CLIENTS — ${days}j\nAucune donnée.`);

      const lines = top
        .map((r, i) => `${i + 1}) ${r.client} — ${r.doc_count} doc • ${money(r.total_sum)} FCFA`)
        .join("\n");
      return sendText(from, `🏆 *TOP 5 CLIENTS* — ${days} jours\n\n${lines}`);
    }

    // export admin
    if (lower.startsWith("/export") || lower.startsWith("export")) {
      if (!ensureAdmin(from)) return sendText(from, "❌ Commande réservée à l’administrateur.");

      const days = parseDaysArg(text, 30);
      const rows = await getDocsForExport({ days });

      const header = [
        "created_at",
        "wa_id",
        "doc_number",
        "doc_type",
        "facture_kind",
        "client",
        "date",
        "total",
        "items_count",
      ];

      const csvLines = [header.join(",")].concat(
        rows.map((r) => {
          const vals = [
            r.created_at || "",
            r.wa_id || "",
            r.doc_number || "",
            r.doc_type || "",
            r.facture_kind || "",
            String(r.client || "").replace(/"/g, '""'),
            r.date || "",
            String(r.total ?? ""),
            String(Array.isArray(r.items) ? r.items.length : 0),
          ];
          return vals.map((v) => (/[",\n]/.test(v) ? `"${v}"` : v)).join(",");
        })
      );

      const buf = Buffer.from(csvLines.join("\n"), "utf8");
      const fileName = `kadi-export-${days}j-${formatDateISO()}.csv`;

      const up = await uploadMediaBuffer({ buffer: buf, filename: fileName, mimeType: "text/csv" });
      if (!up?.id) return sendText(from, "❌ Export: upload échoué.");

      return sendDocument({
        to: from,
        mediaId: up.id,
        filename: fileName,
        caption: `📤 Export CSV (${days} jours)\nLignes: ${rows.length}`,
      });
    }

    // admin commands
    if (await handleAdmin(from, text)) return;

    // profil flow
    if (await handleProfileAnswer(from, text)) return;

    // décharge flow
    if (await handleDechargeAnswer(from, text)) return;

    // short commands
    if (lower === "solde" || lower === "credits" || lower === "crédits" || lower === "balance") return replyBalance(from);
    if (lower === "recharge") return replyRechargeInfo(from);

    // code recharge
    const mCode = text.match(/^CODE\s+([A-Z0-9\-]+)$/i);
    if (mCode) {
      const result = await redeemCode({ waId: from, code: mCode[1] });
      if (!result.ok) {
        if (result.error === "CODE_DEJA_UTILISE") return sendText(from, "❌ Code déjà utilisé.");
        return sendText(from, "❌ Code invalide.");
      }
      return sendText(from, `✅ Recharge OK : +${result.added} crédits\n💳 Nouveau solde : ${result.balance}`);
    }

    // menu
    if (lower === "menu" || lower === "m") return sendHomeMenu(from);

    // direct keywords
    if (lower === "devis") return startDocFlow(from, "devis");
    if (lower === "recu" || lower === "reçu") return startDocFlow(from, "recu");
    if (lower === "facture") return sendFactureKindMenu(from);
    if (lower === "profil" || lower === "profile") return sendProfileMenu(from);
    if (lower === "decharge" || lower === "décharge") return startDechargeFlow(from);
    if (lower === "photo") return startPhotoMode(from);

    // doc text collecting
    if (await handleDocText(from, text)) return;

    await sendText(from, `Je t’ai lu.\nTape *MENU* pour commencer, ou envoie une *photo* pour PDF.`);
  } catch (e) {
    console.error("❌ handleIncomingMessage error:", e?.message, e);
  }
}

module.exports = { handleIncomingMessage, cleanNumber };