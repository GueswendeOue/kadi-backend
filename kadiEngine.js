// kadiEngine.js — UPDATED (Model B + OCR HYBRID + ADMIN BROADCAST TEXT/IMAGE)
// ✅ Tampon = 15 crédits (paiement UNIQUE), puis GRATUIT sur tous les PDF suivants
// ✅ OCR hybride: Tesseract d'abord, puis Gemini fallback si lecture faible/échoue
// ✅ Broadcast texte: /broadcast Votre message...
// ✅ Broadcast image: /broadcastimage [légende optionnelle] puis envoyer l'image depuis WhatsApp
"use strict";

// ================= Logger =================
const logger = {
  info: (context, message, meta = {}) => console.log(`[KADI/INFO/${context}]`, message, meta),
  warn: (context, message, meta = {}) => console.warn(`[KADI/WARN/${context}]`, message, meta),
  error: (context, error, meta = {}) =>
    console.error(`[KADI/ERROR/${context}]`, error?.message || error, { ...meta, stack: error?.stack }),
  metric: (name, duration, success = true, meta = {}) =>
    console.log(`[KADI/METRIC/${name}] ${duration}ms`, { success, ...meta }),
};

// ================= Optional modules (Tampon/Signature/Broadcast) =================
let kadiStamp = null;
let kadiSignature = null;

try {
  kadiStamp = require("./kadiStamp");
} catch (e) {
  console.warn("⚠️ kadiStamp module not found, stamp will be skipped");
}
try {
  kadiSignature = require("./kadiSignature");
} catch (e) {
  console.warn("⚠️ kadiSignature module not found, signature will be skipped");
}

// Broadcast module optionnel
let kadiBroadcast = null;
try {
  kadiBroadcast = require("./kadiBroadcast");
} catch (e) {
  // ok
}

// ================= Gemini (optional) =================
let GeminiGenAI = null;
try {
  // npm i @google/generative-ai
  GeminiGenAI = require("@google/generative-ai").GoogleGenerativeAI;
} catch (_) {
  // ok
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// ✅ Safer default (v1beta compatibility changes over time)
// Override via env: GEMINI_MODEL=gemini-2.0-flash (or any model you enable)
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash-latest";

const OCR_HYBRID = (process.env.OCR_HYBRID || "1") === "1"; // 1 = tesseract -> gemini fallback
const OCR_GEMINI_MIN_CHARS = Number(process.env.OCR_GEMINI_MIN_CHARS || 20); // si text < 20 => fallback gemini
const OCR_GEMINI_MIN_DIGITS = Number(process.env.OCR_GEMINI_MIN_DIGITS || 2); // ✅ lowered a bit (handwritten often has few digits)

const _geminiClient =
  GEMINI_API_KEY && GeminiGenAI
    ? new GeminiGenAI(GEMINI_API_KEY)
    : null;

async function geminiOcrImageBuffer(imageBuffer, mimeType = "image/jpeg") {
  if (!_geminiClient) throw new Error("Gemini not configured");
  const model = _geminiClient.getGenerativeModel({ model: GEMINI_MODEL });

  const prompt =
    "Tu es un OCR. Extrait tout le texte visible de l'image, en conservant les lignes. " +
    "Ne commente pas. Ne reformule pas. Retourne UNIQUEMENT le texte extrait.";

  const result = await model.generateContent([
    { text: prompt },
    {
      inlineData: {
        mimeType: mimeType || "image/jpeg",
        data: Buffer.from(imageBuffer).toString("base64"),
      },
    },
  ]);

  const text = result?.response?.text?.() || "";
  return String(text).trim();
}

function ocrLooksGood(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (t.length < OCR_GEMINI_MIN_CHARS) return false;

  const digits = (t.match(/\d/g) || []).length;
  if (digits < OCR_GEMINI_MIN_DIGITS) return false;

  // trop de symboles / bruit
  const lettersOrDigits = (t.match(/[a-z0-9]/gi) || []).length;
  const ratio = lettersOrDigits / Math.max(1, t.length);
  if (ratio < 0.25) return false;

  return true;
}

// ================= Imports core =================
const { getSession } = require("./kadiState");
const { nextDocNumber } = require("./kadiCounter");

// ✅ Debug PDF module (optionnel)
const pdfMod = require("./kadiPdf");
if (process.env.KADI_DEBUG_PDF_MODULE === "1") {
  console.log("[KADI] PDF MODULE RESOLVED ✅", require.resolve("./kadiPdf"));
  console.log("[KADI] PDF MODULE KEYS ✅", Object.keys(pdfMod || {}));
}
const { buildPdfBuffer } = pdfMod;

const { saveDocument } = require("./kadiRepo");
const { getOrCreateProfile, updateProfile, markOnboardingDone } = require("./store");

const { uploadLogoBuffer, getSignedLogoUrl, downloadSignedUrlToBuffer } = require("./supabaseStorage");

// ✅ IMPORTANT: ton kadiOcr.js (tesseract+sharp) exporte ocrImageToText
const { ocrImageToText } = require("./kadiOcr");

const {
  sendText,
  sendButtons,
  sendList,
  getMediaInfo,
  downloadMediaToBuffer,
  uploadMediaBuffer,
  sendDocument,
} = require("./whatsappApi");

const {
  getBalance,
  consumeCredit,
  consumeFeature, // ✅ utilisé pour le tampon (paiement unique)
  createRechargeCodes,
  redeemCode,
  addCredits,
} = require("./kadiCreditsRepo");

const { recordActivity } = require("./kadiActivityRepo");
const { getStats, getTopClients, getDocsForExport, money } = require("./kadiStatsRepo");

// ================= Config =================
const ADMIN_WA_ID = process.env.ADMIN_WA_ID || "";
const OM_NUMBER = process.env.OM_NUMBER || "76894642";
const OM_NAME = process.env.OM_NAME || "GUESWENDE Ouedraogo";
const PRICE_LABEL = process.env.CREDITS_PRICE_LABEL || "2000F = 25 crédits";

// ✅ WELCOME = 10 par défaut (tu peux changer via ENV WELCOME_CREDITS)
const WELCOME_CREDITS = Number(process.env.WELCOME_CREDITS || 10);

const PACK_CREDITS = Number(process.env.PACK_CREDITS || 25);
const PACK_PRICE_FCFA = Number(process.env.PACK_PRICE_FCFA || 2000);

// Anti-spam broadcast
const BROADCAST_BATCH = Number(process.env.BROADCAST_BATCH || 25);
const BROADCAST_DELAY_MS = Number(process.env.BROADCAST_DELAY_MS || 450);

// ================= Pricing / Credits =================
// ✅ Règles (Model B):
// - PDF simple (devis/facture/reçu) = 1 crédit
// - OCR (photo -> PDF) = 2 crédits
// - Décharge = 2 crédits (même sans OCR)
// - Tampon = 15 crédits (paiement UNIQUE) puis GRATUIT sur les PDF
const PDF_SIMPLE_CREDITS = Number(process.env.PDF_SIMPLE_CREDITS || 1);
const OCR_PDF_CREDITS = Number(process.env.OCR_PDF_CREDITS || 2);
const DECHARGE_CREDITS = Number(process.env.DECHARGE_CREDITS || 2);
const STAMP_ONE_TIME_COST = Number(process.env.STAMP_ONE_TIME_COST || 15);

// ================= Regex / Limits =================
const REGEX = {
  code: /^code\s+(kdi-[\w-]+)/i,
};

const LIMITS = {
  maxItems: 200,
  maxImageSize: 5 * 1024 * 1024,
  maxOcrRetries: 2,
  maxClientNameLength: 100,
  maxItemLabelLength: 200,
};

const _WELCOME_CACHE = new Map(); // waId -> ts

// ================= Utils =================
function safe(v) {
  return String(v || "").trim();
}
function norm(v) {
  return String(v || "").trim();
}
function isValidWhatsAppId(id) {
  return /^\d+$/.test(id) && id.length >= 8 && id.length <= 15;
}
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
}
function formatDateISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function parseDaysArg(text, defDays) {
  const m = String(text || "").trim().match(/(?:\s+)(\d{1,3})\b/);
  if (!m) return defDays;
  const d = Number(m[1]);
  if (!Number.isFinite(d) || d <= 0) return defDays;
  return Math.min(d, 365);
}
function guessExtFromMime(mime) {
  const t = String(mime || "").toLowerCase();
  if (t.includes("png")) return "png";
  if (t.includes("webp")) return "webp";
  if (t.includes("gif")) return "gif";
  return "jpg";
}
function resetAdminBroadcastState(session) {
  session.adminPendingAction = null;
  session.broadcastCaption = null;
}

function getDocTitle(draft) {
  return draft.type === "facture"
    ? draft.factureKind === "proforma"
      ? "FACTURE PRO FORMA"
      : "FACTURE DÉFINITIVE"
    : draft.type === "decharge"
    ? "DÉCHARGE"
    : String(draft.type || "").toUpperCase();
}

function computeBasePdfCost(draft) {
  if (draft?.source === "ocr") return OCR_PDF_CREDITS;
  if (draft?.type === "decharge") return DECHARGE_CREDITS;
  return PDF_SIMPLE_CREDITS;
}

function formatBaseCostLine(cost) {
  return `💳 Coût: *${cost} crédit(s)*`;
}

// ===============================
// Tampon & Signature (wrapper)
// ===============================
async function applyStampAndSignatureIfAny(pdfBuffer, profile, logoBuffer = null) {
  let buf = pdfBuffer;

  const canStamp = profile?.stamp_enabled === true && profile?.stamp_paid === true;

  if (canStamp && kadiStamp?.applyStampToPdfBuffer) {
    try {
      buf = await kadiStamp.applyStampToPdfBuffer(buf, profile, {
        pages: "last",
        logoBuffer: Buffer.isBuffer(logoBuffer) ? logoBuffer : null,
      });
    } catch (e) {
      logger.warn("stamp", e.message);
    }
  }

  if (kadiSignature?.applySignatureToPdfBuffer) {
    try {
      buf = await kadiSignature.applySignatureToPdfBuffer(buf, profile);
    } catch (e) {
      logger.warn("signature", e.message);
    }
  }

  return buf;
}

// ===============================
// Catalogue documents
// ===============================
const DOC_CATALOG = [
  { id: "DOC_DEVIS", title: "Devis", desc: "Proposition de prix", kind: "devis" },
  { id: "DOC_FACTURE", title: "Facture", desc: "Facture client", kind: "facture" },
  { id: "DOC_RECU", title: "Reçu", desc: "Reçu de paiement", kind: "recu" },
  { id: "DOC_DECHARGE", title: "Décharge", desc: "Décharge simple", kind: "decharge" },
];

// ===============================
// Draft helpers
// ===============================
function computeFinance(doc) {
  let sum = 0;
  for (const it of doc.items || []) sum += Number(it?.amount || 0) || 0;
  return { subtotal: sum, gross: sum };
}

function validateDraft(draft) {
  if (!draft) throw new Error("Draft manquant");
  if (!Array.isArray(draft.items)) draft.items = [];
  if (!draft.date) draft.date = formatDateISO();

  for (let i = 0; i < draft.items.length; i++) {
    const it = draft.items[i] || {};
    if (Number(it.amount) < 0) throw new Error(`Montant négatif ligne ${i + 1}`);
    if (Number(it.qty) <= 0) throw new Error(`Quantité invalide ligne ${i + 1}`);
  }
  return true;
}

function buildPreviewMessage({ doc }) {
  const title = getDocTitle(doc);
  const f = computeFinance(doc);

  const lines = (doc.items || [])
    .slice(0, 50)
    .map((it, idx) => `${idx + 1}) ${it.label} | Qté:${money(it.qty)} | PU:${money(it.unitPrice)} | Mt:${money(it.amount)}`)
    .join("\n");

  return [
    `📄 *APERÇU*`,
    `Type: ${title}`,
    `Date: ${doc.date || "-"}`,
    `Client: ${doc.client || "—"}`,
    ``,
    `Lignes (${(doc.items || []).length})`,
    lines || "—",
    ``,
    `TOTAL: *${money(f.gross)} FCFA*`,
  ].join("\n");
}

function makeItem(label, qty, unitPrice) {
  const q = Number(qty || 0);
  const pu = Number(unitPrice || 0);
  const amt = (Number.isFinite(q) ? q : 0) * (Number.isFinite(pu) ? pu : 0);
  return {
    label: safe(label).slice(0, LIMITS.maxItemLabelLength) || "—",
    qty: Number.isFinite(q) && q > 0 ? q : 1,
    unitPrice: Number.isFinite(pu) && pu >= 0 ? pu : 0,
    amount: Number.isFinite(amt) ? amt : 0,
    raw: "",
  };
}

function parseNumberSmart(s) {
  const t = String(s || "").trim().replace(/\s/g, "");
  if (!t) return null;
  const cleaned = t.replace(/,/g, ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ===============================
// Menus
// ===============================
async function sendHomeMenu(to) {
  return sendButtons(to, "🏠 *Menu KADI* — choisissez :", [
    { id: "HOME_DOCS", title: "Documents" },
    { id: "HOME_CREDITS", title: "Crédits" },
    { id: "HOME_PROFILE", title: "Profil" },
  ]);
}

async function sendDocsMenu(to) {
  const canList = typeof sendList === "function";
  if (!canList) {
    return sendButtons(to, "📄 Quel document voulez-vous créer ?", [
      { id: "DOC_DEVIS", title: "Devis" },
      { id: "DOC_FACTURE", title: "Facture" },
      { id: "DOC_RECU", title: "Reçu" },
      { id: "DOC_DECHARGE", title: "Décharge" },
    ]);
  }

  const rows = DOC_CATALOG.map((d) => ({ id: d.id, title: d.title, description: d.desc || "" }));
  return sendList(to, {
    header: "Documents",
    body: "Quel document voulez-vous créer ?",
    buttonText: "Choisir",
    sections: [{ title: "Création de documents", rows }],
  });
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
    { id: "PROFILE_STAMP", title: "Tampon" },
    { id: "BACK_HOME", title: "Menu" },
  ]);
}

async function sendAfterProductMenu(to) {
  return sendButtons(to, "✅ Produit ajouté. Que faire ?", [
    { id: "DOC_ADD_MORE", title: "➕ Nouveau produit" },
    { id: "DOC_FINISH", title: "✅ Terminer" },
    { id: "DOC_CANCEL", title: "❌ Annuler" },
  ]);
}

async function sendPreviewMenu(to) {
  return sendButtons(to, "✅ Valider le document ?", [
    { id: "DOC_CONFIRM", title: "📄 Générer PDF" },
    { id: "DOC_ADD_MORE", title: "➕ Nouveau produit" },
    { id: "DOC_CANCEL", title: "❌ Annuler" },
  ]);
}

// ===============================
// Tampon menus
// ===============================
function stampPosLabel(pos) {
  if (pos === "bottom-left") return "Bas gauche";
  if (pos === "top-right") return "Haut droite";
  if (pos === "top-left") return "Haut gauche";
  return "Bas droite";
}
function stampSizeLabel(size) {
  const n = Number(size || 170);
  if (n <= 150) return "Petit";
  if (n >= 200) return "Grand";
  return "Normal";
}

async function sendStampMenu(to) {
  const p = await getOrCreateProfile(to);

  const enabled = p?.stamp_enabled === true;
  const paid = p?.stamp_paid === true;

  const pos = p?.stamp_position || "bottom-right";
  const size = p?.stamp_size || 170;
  const title = p?.stamp_title || "—";

  const pricingLine = paid
    ? `💳 Prix: *Payé ✅* (tampon gratuit sur tous vos PDF)`
    : `💳 Prix: *${STAMP_ONE_TIME_COST} crédits (paiement unique)*`;

  const header =
    `🟦 *Tampon (PDF)*\n\n` +
    `• Statut : *${enabled ? "ON ✅" : "OFF ❌"}*\n` +
    `• Paiement : *${paid ? "OK ✅" : "Non ❌"}*\n` +
    `• Fonction : *${title}*\n` +
    `• Position : *${stampPosLabel(pos)}*\n` +
    `• Taille : *${stampSizeLabel(size)}*\n\n` +
    `${pricingLine}`;

  return sendButtons(to, header + "\n\n👇 Choisissez :", [
    { id: "STAMP_TOGGLE", title: enabled ? "Désactiver" : "Activer" },
    { id: "STAMP_EDIT_TITLE", title: "Fonction" },
    { id: "STAMP_MORE", title: "Position/Taille" },
  ]);
}

async function sendStampMoreMenu(to) {
  const p = await getOrCreateProfile(to);
  const pos = p?.stamp_position || "bottom-right";
  const size = p?.stamp_size || 170;

  const txt = `🟦 *Réglages tampon*\n\n• Position : *${stampPosLabel(pos)}*\n• Taille : *${stampSizeLabel(size)}*`;

  return sendButtons(to, txt + "\n\n👇 Choisissez :", [
    { id: "STAMP_POS", title: "Position" },
    { id: "STAMP_SIZE", title: "Taille" },
    { id: "PROFILE_STAMP", title: "Retour" },
  ]);
}

async function sendStampPositionMenu(to) {
  return sendButtons(to, "📍 *Position du tampon* :", [
    { id: "STAMP_POS_BR", title: "Bas droite" },
    { id: "STAMP_POS_TR", title: "Haut droite" },
    { id: "STAMP_MORE", title: "Retour" },
  ]);
}
async function sendStampPositionMenu2(to) {
  return sendButtons(to, "📍 *Position du tampon* (suite) :", [
    { id: "STAMP_POS_BL", title: "Bas gauche" },
    { id: "STAMP_POS_TL", title: "Haut gauche" },
    { id: "STAMP_MORE", title: "Retour" },
  ]);
}
async function sendStampSizeMenu(to) {
  return sendButtons(to, "📏 *Taille du tampon* :", [
    { id: "STAMP_SIZE_S", title: "Petit" },
    { id: "STAMP_SIZE_M", title: "Normal" },
    { id: "STAMP_SIZE_L", title: "Grand" },
  ]);
}

// ===============================
// Profil flow (7 étapes)
// ===============================
async function startProfileFlow(from) {
  const s = getSession(from);
  s.step = "profile";
  s.profileStep = "business_name";
  await getOrCreateProfile(from);

  await sendText(
    from,
    "🏢 *Profil entreprise*\n\n1/7 — Nom de l'entreprise ?\nEx: GUESWENDE Technologies\n\n📌 Tapez 0 pour ignorer."
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
    const email = skip ? null : t;
    if (email && !isValidEmail(email)) {
      await sendText(from, "❌ Format email invalide. Réessayez ou tapez 0.");
      return true;
    }
    await updateProfile(from, { email });
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
    await sendText(from, "7/7 — Envoyez votre logo en *image* (ou tapez 0)");
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
    await sendText(from, "⚠️ Pour le logo, envoyez une *image*. Ou tapez 0.");
    return true;
  }

  return false;
}

// ===============================
// Logo upload (image)
// ===============================
async function handleLogoImage(from, msg) {
  const mediaId = msg?.image?.id;
  if (!mediaId) {
    await sendText(from, "❌ Image reçue mais sans media_id. Réessayez.");
    return;
  }

  const info = await getMediaInfo(mediaId);
  if (info?.file_size && info.file_size > LIMITS.maxImageSize) {
    await sendText(from, "❌ Image trop grande. Envoyez une image plus légère.");
    return;
  }

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

// ===============================
// Credits
// ===============================
async function replyBalance(from) {
  const bal = await getBalance(from);
  await sendText(
    from,
    `💳 *Votre solde KADI* : ${bal} crédit(s)\n\n` +
      `📄 PDF simple (devis/facture/reçu) = ${PDF_SIMPLE_CREDITS} crédit\n` +
      `📷 OCR (photo -> PDF) = ${OCR_PDF_CREDITS} crédits\n` +
      `📄 Décharge = ${DECHARGE_CREDITS} crédits\n` +
      `🟦 Tampon officiel = ${STAMP_ONE_TIME_COST} crédits (paiement unique)`
  );
}

async function replyRechargeInfo(from) {
  const s = getSession(from);
  s.step = "recharge_proof";
  await sendText(
    from,
    `💰 *Recharger vos crédits KADI*\n\n✅ Orange Money\n📌 Numéro : *${OM_NUMBER}*\n👤 Nom : *${OM_NAME}*\n💳 Offre : *${PRICE_LABEL}*\n\n📎 Après paiement, envoyez ici une *preuve* (capture d'écran).\n\n🔑 Si vous avez un code: *CODE KDI-XXXX-XXXX*`
  );
}

// ===============================
// Product-by-product flow
// ===============================
function resetDraftSession(s) {
  s.step = "idle";
  s.mode = null;
  s.factureKind = null;
  s.lastDocDraft = null;
  s.itemDraft = null;
  s.pendingOcrMediaId = null;
}

async function startDocFlow(from, mode, factureKind = null) {
  const s = getSession(from);

  s.step = "doc_client";
  s.mode = mode;
  s.factureKind = factureKind;

  s.lastDocDraft = {
    type: mode,
    factureKind,
    docNumber: null,
    date: formatDateISO(),
    client: null,
    items: [],
    finance: null,
    source: "product",
  };

  const title =
    mode === "facture"
      ? factureKind === "proforma"
        ? "🧾 Facture Pro forma"
        : "🧾 Facture Définitive"
      : mode === "devis"
      ? "📝 Devis"
      : mode === "recu"
      ? "🧾 Reçu"
      : "📄 Décharge";

  await sendText(from, `${title}\n\n👤 *Nom du client ?*\n(Ex: Awa / Ben / Société X)`);
}

async function askItemLabel(from) {
  const s = getSession(from);
  if (!s.lastDocDraft) return;

  s.step = "item_label";
  s.itemDraft = { label: null, qty: null, unitPrice: null };

  await sendText(from, `🧾 *Produit ${(s.lastDocDraft.items.length || 0) + 1}*\nNom / Désignation ?`);
}

async function askItemQty(from) {
  const s = getSession(from);
  s.step = "item_qty";
  await sendText(from, "🔢 Quantité ? (ex: 1, 2, 5)");
}

async function askItemPu(from) {
  const s = getSession(from);
  s.step = "item_pu";
  await sendText(from, "💰 Prix unitaire (FCFA) ? (ex: 5000)");
}

async function sendItemConfirmMenu(from) {
  const s = getSession(from);
  const it = s.itemDraft || {};
  const q = Number(it.qty || 0) || 0;
  const pu = Number(it.unitPrice || 0) || 0;
  const amt = q * pu;

  s.step = "item_confirm";

  return sendButtons(
    from,
    `✅ Produit prêt :\n${safe(it.label || "—")} | Qté:${money(q)} | PU:${money(pu)} | Mt:${money(amt)}\n\nQue faire ?`,
    [
      { id: "ITEM_SAVE", title: "✅ Confirmer" },
      { id: "ITEM_EDIT", title: "✏️ Modifier" },
      { id: "DOC_CANCEL", title: "❌ Annuler" },
    ]
  );
}

async function handleProductFlowText(from, text) {
  const s = getSession(from);
  if (!s.lastDocDraft) return false;

  const t = norm(text);
  if (!t) return false;

  if (s.step === "missing_client_pdf") {
    s.lastDocDraft.client = t.slice(0, LIMITS.maxClientNameLength);
    s.step = "doc_review";
    const preview = buildPreviewMessage({ doc: s.lastDocDraft });
    await sendText(from, preview);

    const cost = computeBasePdfCost(s.lastDocDraft);
    await sendText(from, formatBaseCostLine(cost));

    await sendPreviewMenu(from);
    return true;
  }

  if (s.step === "doc_client") {
    s.lastDocDraft.client = t.slice(0, LIMITS.maxClientNameLength);
    await askItemLabel(from);
    return true;
  }

  if (s.step === "item_label") {
    s.itemDraft = s.itemDraft || {};
    s.itemDraft.label = t.slice(0, LIMITS.maxItemLabelLength);
    await askItemQty(from);
    return true;
  }

  if (s.step === "item_qty") {
    const n = parseNumberSmart(t);
    if (!n || n <= 0) {
      await sendText(from, "❌ Quantité invalide. Réessayez (ex: 2).");
      return true;
    }
    s.itemDraft = s.itemDraft || {};
    s.itemDraft.qty = n;
    await askItemPu(from);
    return true;
  }

  if (s.step === "item_pu") {
    const n = parseNumberSmart(t);
    if (n == null || n < 0) {
      await sendText(from, "❌ Prix invalide. Réessayez (ex: 5000).");
      return true;
    }
    s.itemDraft = s.itemDraft || {};
    s.itemDraft.unitPrice = n;
    await sendItemConfirmMenu(from);
    return true;
  }

  if (s.step === "stamp_title") {
    const val = t === "0" ? null : t;
    await updateProfile(from, { stamp_title: val });
    s.step = "idle";
    await sendText(from, "✅ Fonction tampon mise à jour.");
    await sendStampMenu(from);
    return true;
  }

  return false;
}

// ===============================
// OCR helpers
// ===============================
function guessDocTypeFromOcr(text) {
  const t = String(text || "").toLowerCase();
  if (t.includes("facture")) return "facture";
  if (t.includes("reçu") || t.includes("recu")) return "recu";
  if (t.includes("devis") || t.includes("proforma") || t.includes("pro forma")) return "devis";
  if (t.includes("décharge") || t.includes("decharge")) return "decharge";
  return null;
}

function extractTotalFromOcr(text) {
  const m =
    String(text || "").match(/total\s*[:\-]?\s*([0-9][0-9\s.,]+)/i) ||
    String(text || "").match(/montant\s+total\s*[:\-]?\s*([0-9][0-9\s.,]+)/i);
  if (!m) return null;
  const n = parseNumberSmart(m[1]);
  return n == null ? null : n;
}

function parseOcrToDraft(ocrText) {
  const lines = String(ocrText || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let client = null;
  for (const line of lines) {
    const m = line.match(/^client\s*[:\-]\s*(.+)$/i) || line.match(/^nom\s*[:\-]\s*(.+)$/i);
    if (m) {
      client = (m[1] || "").trim().slice(0, LIMITS.maxClientNameLength);
      break;
    }
  }

  const items = [];
  for (const line of lines) {
    if (!/\d/.test(line)) continue;
    const nums = line.match(/\d+(?:[.,]\d+)?/g) || [];
    const pu = nums.length ? parseNumberSmart(nums[nums.length - 1]) : 0;
    const label = line.replace(/\d+(?:[.,]\d+)?/g, "").trim() || line.trim();
    items.push(makeItem(label, 1, pu || 0));
    if (items.length >= LIMITS.maxItems) break;
  }

  const detected = extractTotalFromOcr(ocrText);
  const calc = computeFinance({ items }).gross;
  return { client, items, finance: { subtotal: calc, gross: detected ?? calc } };
}

async function robustOcr(buffer, mimeType = "image/jpeg", maxRetries = LIMITS.maxOcrRetries) {
  let lastErr = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      let tText = "";
      try {
        tText = await ocrImageToText(buffer);
      } catch (e) {
        lastErr = e;
        tText = "";
      }

      if (tText && (!OCR_HYBRID || ocrLooksGood(tText))) return tText;

      if (_geminiClient) {
        try {
          const gText = await geminiOcrImageBuffer(buffer, mimeType);
          if (gText && gText.trim().length) return gText;
        } catch (ge) {
          logger.warn("OCR", "Gemini fallback failed (ignored)", { message: ge?.message, model: GEMINI_MODEL });
        }
      }

      if (tText && tText.trim().length) return tText;

      throw lastErr || new Error("OCR_EMPTY");
    } catch (e) {
      lastErr = e;
      if (attempt === maxRetries) break;
      await sleep(Math.pow(2, attempt) * 800);
    }
  }

  throw lastErr || new Error("OCR_FAILED");
}

async function processOcrImageToDraft(from, mediaId) {
  const s = getSession(from);

  const info = await getMediaInfo(mediaId);
  if (info?.file_size && info.file_size > LIMITS.maxImageSize) {
    await sendText(from, "❌ Image trop grande. Envoyez une photo plus légère.");
    return;
  }

  const mime = info?.mime_type || "image/jpeg";
  const buf = await downloadMediaToBuffer(info.url);
  await sendText(from, "🔎 Lecture de la photo…");

  let ocrText = "";
  try {
    ocrText = await robustOcr(buf, mime);
  } catch (e) {
    await sendText(from, "❌ Impossible de lire la photo. Essayez une photo plus nette (bonne lumière, sans flou).");
    return;
  }

  if (!ocrText || ocrText.trim().length < 8) {
    await sendText(from, "❌ Lecture trop faible. Essayez une photo plus nette (bonne lumière, sans flou).");
    return;
  }

  if (!s.lastDocDraft) {
    const guessed = guessDocTypeFromOcr(ocrText) || "devis";
    s.lastDocDraft = {
      type: guessed,
      factureKind: null,
      docNumber: null,
      date: formatDateISO(),
      client: null,
      items: [],
      finance: null,
      source: "ocr",
    };
  }

  s.step = "ocr_review";

  const parsed = parseOcrToDraft(ocrText);
  if (parsed.client) s.lastDocDraft.client = parsed.client;
  if (parsed.items?.length) s.lastDocDraft.items = parsed.items.slice(0, LIMITS.maxItems);

  s.lastDocDraft.finance = parsed.finance || computeFinance(s.lastDocDraft);

  const preview = buildPreviewMessage({ doc: s.lastDocDraft });
  await sendText(from, preview);

  const cost = computeBasePdfCost(s.lastDocDraft);
  await sendText(from, formatBaseCostLine(cost));

  return sendButtons(from, "✅ Valider ?", [
    { id: "DOC_CONFIRM", title: "📄 Générer PDF" },
    { id: "DOC_RESTART", title: "🔁 Recommencer" },
    { id: "BACK_HOME", title: "Menu" },
  ]);
}

async function handleAdminBroadcastImage(from, msg) {
  const s = getSession(from);

  if (!ensureAdmin(from)) return false;
  if (s.adminPendingAction !== "broadcast_image") return false;

  const mediaId = msg?.image?.id;
  if (!mediaId) {
    await sendText(from, "❌ Image reçue mais sans media_id. Réessayez.");
    return true;
  }

  try {
    const info = await getMediaInfo(mediaId);
    if (info?.file_size && info.file_size > LIMITS.maxImageSize) {
      await sendText(from, "❌ Image trop grande. Envoyez une image plus légère.");
      return true;
    }

    const mime = info?.mime_type || "image/jpeg";
    const ext = guessExtFromMime(mime);
    const buf = await downloadMediaToBuffer(info.url);

    await sendText(from, "📢 Image reçue. Broadcast en cours...");

    if (!kadiBroadcast?.broadcastImageToAll) {
      resetAdminBroadcastState(s);
      await sendText(from, "⚠️ Module broadcast image absent.");
      return true;
    }

    const caption = s.broadcastCaption || "";
    resetAdminBroadcastState(s);

    await kadiBroadcast.broadcastImageToAll({
      adminWaId: from,
      imageBuffer: buf,
      mimeType: mime,
      filename: `broadcast-${Date.now()}.${ext}`,
      caption,
    });

    return true;
  } catch (e) {
    logger.error("admin_broadcast_image", e, { from });
    resetAdminBroadcastState(s);
    await sendText(from, "❌ Erreur lors du broadcast image.");
    return true;
  }
}

async function handleIncomingImage(from, msg) {
  const s = getSession(from);

  if (await handleAdminBroadcastImage(from, msg)) return;

  if (s.step === "profile" && s.profileStep === "logo") return handleLogoImage(from, msg);

  const mediaId = msg?.image?.id;
  if (!mediaId) return sendText(from, "❌ Image reçue mais sans media_id. Réessayez.");

  s.pendingOcrMediaId = mediaId;
  return sendButtons(from, "📷 Photo reçue. Générer quel document ?", [
    { id: "OCR_DEVIS", title: "Devis" },
    { id: "OCR_FACTURE", title: "Facture" },
    { id: "OCR_RECU", title: "Reçu" },
  ]);
}

// ===============================
// PDF creation
// ===============================
async function createAndSendPdf(from) {
  const s = getSession(from);
  const draft = s.lastDocDraft;

  if (!draft) {
    await sendText(from, "❌ Aucun document en cours. Tapez MENU.");
    return;
  }

  if (!safe(draft.client)) {
    s.step = "missing_client_pdf";
    await sendText(from, "⚠️ Client manquant.\nTapez le nom du client :");
    return;
  }

  try {
    validateDraft(draft);
  } catch (err) {
    await sendText(from, `❌ Erreur dans le document: ${err.message}`);
    return;
  }

  const cost = computeBasePdfCost(draft);
  const reason = draft.source === "ocr" ? "ocr_pdf" : draft.type === "decharge" ? "decharge_pdf" : "pdf";

  const cons = await consumeCredit(from, cost, reason);
  if (!cons.ok) {
    await sendText(
      from,
      `❌ Solde insuffisant.\nVous avez ${cons.balance} crédit(s).\nCe document coûte ${cost} crédit(s).\n👉 Tapez RECHARGE.`
    );
    return;
  }

  let successAfterDebit = false;

  try {
    draft.finance = computeFinance(draft);

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
        console.warn("logo download error:", e?.message);
      }
    }

    const title = getDocTitle(draft);
    const total = draft.finance?.gross ?? computeFinance(draft).gross;

    let pdfBuf = await buildPdfBuffer({
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

    pdfBuf = await applyStampAndSignatureIfAny(pdfBuf, profile, logoBuf);

    try {
      await saveDocument({ waId: from, doc: draft });
    } catch (e) {
      console.warn("saveDocument error:", e?.message);
    }

    const fileName = `${draft.docNumber}-${formatDateISO()}.pdf`;
    const up = await uploadMediaBuffer({ buffer: pdfBuf, filename: fileName, mimeType: "application/pdf" });
    if (!up?.id) throw new Error("Upload PDF échoué");

    successAfterDebit = true;

    await sendDocument({
      to: from,
      mediaId: up.id,
      filename: fileName,
      caption: `✅ ${title} ${draft.docNumber}\nTotal: ${money(total)} FCFA\nCoût: ${cost} crédit(s)\nSolde: ${cons.balance} crédit(s)`,
    });

    resetDraftSession(s);
    await sendHomeMenu(from);
  } catch (e) {
    console.error("createAndSendPdf error:", e?.message);

    if (!successAfterDebit) {
      try {
        await addCredits(from, cost, "rollback_pdf_failed");
      } catch (rb) {
        console.error("rollback credits failed:", rb?.message);
      }
    }

    await sendText(from, "❌ Erreur lors de la création du PDF. Réessayez.");
  }
}

// ===============================
// Welcome credits + Onboarding
// ===============================
async function ensureWelcomeCredits(waId) {
  try {
    if (!isValidWhatsAppId(waId)) return;

    const cached = _WELCOME_CACHE.get(waId);
    if (cached && Date.now() - cached < 24 * 60 * 60 * 1000) return;

    const p = await getOrCreateProfile(waId);
    if (p && p.welcome_credits_granted === true) {
      _WELCOME_CACHE.set(waId, Date.now());
      return;
    }

    const bal = await getBalance(waId);
    if (bal > 0) {
      _WELCOME_CACHE.set(waId, Date.now());
      try {
        await updateProfile(waId, { welcome_credits_granted: true });
      } catch (_) {}
      return;
    }

    await addCredits(waId, WELCOME_CREDITS, "welcome");
    _WELCOME_CACHE.set(waId, Date.now());

    try {
      await updateProfile(waId, { welcome_credits_granted: true });
    } catch (_) {}

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
      `👋 Bienvenue sur *KADI*.\n\n` +
      `✅ *Devis / Facture / Reçu* en 30 secondes.\n` +
      `📷 Envoyez une *photo* → KADI extrait et refait un PDF propre.\n` +
      `🟦 Tampon officiel: *${STAMP_ONE_TIME_COST} crédits (paiement unique)*.\n\n` +
      `👇 Choisissez :`;

    await sendButtons(from, msg, [
      { id: "HOME_DOCS", title: "Créer" },
      { id: "HOME_PROFILE", title: "Profil" },
      { id: "HOME_CREDITS", title: "Crédits" },
    ]);

    await markOnboardingDone(from, 1);
  } catch (e) {
    console.warn("⚠️ onboarding:", e?.message);
  }
}

// ===============================
// ADMIN handler + Commands
// ===============================
function ensureAdmin(waId) {
  return ADMIN_WA_ID && waId === ADMIN_WA_ID;
}

async function broadcastToAllKnownUsers(from, text) {
  if (!ensureAdmin(from)) {
    await sendText(from, "❌ Admin seulement.");
    return true;
  }

  const msg = String(text || "").replace(/^\/?broadcast\s*/i, "").trim();
  if (!msg) {
    await sendText(from, "❌ Format: /broadcast <message>");
    return true;
  }

  if (kadiBroadcast?.broadcastToAll) {
    await sendText(from, "📢 Broadcast texte lancé...");
    await kadiBroadcast.broadcastToAll({ adminWaId: from, message: msg });
    return true;
  }

  await sendText(from, "⚠️ Module broadcast absent. Ajoute ./kadiBroadcast.js");
  return true;
}

async function prepareBroadcastImage(from, text) {
  if (!ensureAdmin(from)) {
    await sendText(from, "❌ Admin seulement.");
    return true;
  }

  const s = getSession(from);
  const caption = String(text || "").replace(/^\/?broadcastimage\s*/i, "").trim();

  s.adminPendingAction = "broadcast_image";
  s.broadcastCaption = caption || "";

  await sendText(
    from,
    caption
      ? "🖼️ OK. Envoie maintenant l'image à diffuser.\nLa légende a bien été enregistrée."
      : "🖼️ OK. Envoie maintenant l'image à diffuser.\nAucune légende définie."
  );
  return true;
}

async function cancelBroadcastImage(from) {
  if (!ensureAdmin(from)) {
    await sendText(from, "❌ Admin seulement.");
    return true;
  }

  const s = getSession(from);
  resetAdminBroadcastState(s);
  await sendText(from, "✅ Broadcast image annulé.");
  return true;
}

async function handleAdmin(from, text) {
  if (!ensureAdmin(from)) return false;

  const lower = String(text || "").toLowerCase().trim();

  if (lower.startsWith("admin create")) {
    const match = text.match(/^admin create\s+(\d+)\s+(\d+)$/i);
    if (!match) {
      await sendText(from, "❌ Format: ADMIN CREATE <nb_codes> <credits_par_code>");
      return true;
    }
    const nb = parseInt(match[1], 10);
    const credits = parseInt(match[2], 10);

    try {
      const codes = await createRechargeCodes({ count: nb, creditsEach: credits, createdBy: from });
      let response = `✅ ${nb} codes créés (${credits} crédits chacun):\n`;
      codes.forEach((code, i) => (response += `${i + 1}. ${code}\n`));
      await sendText(from, response);
    } catch (e) {
      logger.error("admin_create_codes", e, { from, nb, credits });
      await sendText(from, "❌ Erreur création codes.");
    }
    return true;
  }

  if (lower.startsWith("admin add")) {
    const match = text.match(/^admin add\s+(\d+)\s+(\d+)$/i);
    if (!match) {
      await sendText(from, "❌ Format: ADMIN ADD <wa_id> <credits>");
      return true;
    }
    const targetWaId = match[1];
    const credits = parseInt(match[2], 10);

    if (!isValidWhatsAppId(targetWaId)) {
      await sendText(from, "❌ WhatsApp ID invalide.");
      return true;
    }

    try {
      await addCredits(targetWaId, credits, "admin_add");
      const newBalance = await getBalance(targetWaId);
      await sendText(from, `✅ ${credits} crédits ajoutés à ${targetWaId}\nNouveau solde: ${newBalance}`);
    } catch (e) {
      logger.error("admin_add_credits", e, { from, targetWaId, credits });
      await sendText(from, "❌ Erreur lors de l'ajout de crédits.");
    }
    return true;
  }

  if (lower === "admin" || lower === "admin help") {
    await sendText(
      from,
      "👨‍💼 *Commandes Admin*\n\n" +
        "📊 Stats:\n• /stats\n• /top 30\n• /export 30\n\n" +
        "📢 Broadcast:\n• /broadcast Votre message...\n• /broadcastimage [légende]\n• /broadcastcancel\n\n" +
        "💰 Crédits:\n• ADMIN ADD <wa_id> <credits>\n\n" +
        "🎫 Codes:\n• ADMIN CREATE <nb_codes> <credits_par_code>"
    );
    return true;
  }

  if (lower.startsWith("/broadcastimage") || lower.startsWith("broadcastimage")) {
    return prepareBroadcastImage(from, text);
  }

  if (lower === "/broadcastcancel" || lower === "broadcastcancel") {
    return cancelBroadcastImage(from);
  }

  if (lower.startsWith("/broadcast") || lower.startsWith("broadcast")) {
    return broadcastToAllKnownUsers(from, text);
  }

  return false;
}

async function handleStatsCommand(from, text) {
  if (!ensureAdmin(from)) return sendText(from, "❌ Commande réservée à l'administrateur.");

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
    logger.error("stats_command", e, { from });
    return sendText(from, "❌ Erreur: impossible de calculer les stats pour le moment.");
  }
}

async function handleTopCommand(from, text) {
  if (!ensureAdmin(from)) return sendText(from, "❌ Commande réservée à l'administrateur.");

  const days = parseDaysArg(text, 30);
  const top = await getTopClients({ days, limit: 5 });

  if (!top.length) return sendText(from, `🏆 TOP CLIENTS — ${days}j\nAucune donnée.`);

  const lines = top.map((r, i) => `${i + 1}) ${r.client} — ${r.doc_count} doc • ${money(r.total_sum)} FCFA`).join("\n");
  return sendText(from, `🏆 *TOP 5 CLIENTS* — ${days} jours\n\n${lines}`);
}

async function handleExportCommand(from, text) {
  if (!ensureAdmin(from)) return sendText(from, "❌ Commande réservée à l'administrateur.");

  const days = parseDaysArg(text, 30);
  const rows = await getDocsForExport({ days });

  const header = ["created_at", "wa_id", "doc_number", "doc_type", "facture_kind", "client", "date", "total", "items_count"];

  const csvLines = [header.join(",")].concat(
    rows.map((r) =>
      [
        r.created_at || "",
        r.wa_id || "",
        r.doc_number || "",
        r.doc_type || "",
        r.facture_kind || "",
        `"${String(r.client || "").replace(/"/g, '""')}"`,
        r.date || "",
        String(r.total ?? ""),
        String(Array.isArray(r.items) ? r.items.length : 0),
      ].join(",")
    )
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

async function handleCommand(from, text) {
  const lower = String(text || "").toLowerCase().trim();

  if (lower === "/stats" || lower === "stats") return handleStatsCommand(from, text);
  if (lower.startsWith("/top") || lower.startsWith("top")) return handleTopCommand(from, text);
  if (lower.startsWith("/export") || lower.startsWith("export")) return handleExportCommand(from, text);

  if (lower === "solde" || lower === "credits" || lower === "crédits" || lower === "balance") {
    await replyBalance(from);
    return true;
  }
  if (lower === "recharge") {
    await replyRechargeInfo(from);
    return true;
  }
  if (lower === "menu" || lower === "m") {
    await sendHomeMenu(from);
    return true;
  }
  if (lower === "profil" || lower === "profile") {
    await sendProfileMenu(from);
    return true;
  }

  return false;
}

// ===============================
// INTERACTIVE HANDLER
// ===============================
async function handleInteractiveReply(from, replyId) {
  const s = getSession(from);

  if (replyId === "BACK_HOME") return sendHomeMenu(from);
  if (replyId === "BACK_DOCS") return sendDocsMenu(from);

  if (replyId === "HOME_DOCS") return sendDocsMenu(from);
  if (replyId === "HOME_CREDITS") return sendCreditsMenu(from);
  if (replyId === "HOME_PROFILE") return sendProfileMenu(from);

  if (replyId === "DOC_DEVIS") return startDocFlow(from, "devis");
  if (replyId === "DOC_RECU") return startDocFlow(from, "recu");
  if (replyId === "DOC_DECHARGE") return startDocFlow(from, "decharge");

  if (replyId === "DOC_FACTURE") {
    s.step = "facture_kind";
    return sendFactureKindMenu(from);
  }

  if (replyId === "FAC_PROFORMA" || replyId === "FAC_DEFINITIVE") {
    const kind = replyId === "FAC_PROFORMA" ? "proforma" : "definitive";
    return startDocFlow(from, "facture", kind);
  }

  if (replyId === "OCR_DEVIS" || replyId === "OCR_RECU") {
    const mediaId = s.pendingOcrMediaId;
    s.pendingOcrMediaId = null;
    if (!mediaId) return sendText(from, "❌ Photo introuvable. Renvoyez-la.");
    s.lastDocDraft = null;
    const mode = replyId === "OCR_RECU" ? "recu" : "devis";
    s.lastDocDraft = {
      type: mode,
      factureKind: null,
      docNumber: null,
      date: formatDateISO(),
      client: null,
      items: [],
      finance: null,
      source: "ocr",
    };
    return processOcrImageToDraft(from, mediaId);
  }

  if (replyId === "OCR_FACTURE") {
    const mediaId = s.pendingOcrMediaId;
    s.pendingOcrMediaId = null;
    if (!mediaId) return sendText(from, "❌ Photo introuvable. Renvoyez-la.");
    s.lastDocDraft = {
      type: "facture",
      factureKind: "definitive",
      docNumber: null,
      date: formatDateISO(),
      client: null,
      items: [],
      finance: null,
      source: "ocr",
    };
    return processOcrImageToDraft(from, mediaId);
  }

  if (replyId === "PROFILE_EDIT") return startProfileFlow(from);
  if (replyId === "PROFILE_STAMP") return sendStampMenu(from);

  if (replyId === "STAMP_TOGGLE") {
    const p = await getOrCreateProfile(from);

    if (p?.stamp_enabled === true) {
      await updateProfile(from, { stamp_enabled: false });
      await sendText(from, "🟦 Tampon désactivé.");
      return sendStampMenu(from);
    }

    if (p?.stamp_paid !== true) {
      const res = await consumeFeature(from, "stamp_addon");

      if (!res?.ok) {
        await sendText(
          from,
          `❌ Solde insuffisant.\nLe tampon coûte *${STAMP_ONE_TIME_COST} crédits* (paiement unique).\n👉 Tapez RECHARGE.`
        );
        return sendStampMenu(from);
      }

      await updateProfile(from, {
        stamp_paid: true,
        stamp_paid_at: new Date().toISOString(),
        stamp_enabled: true,
      });

      await sendText(
        from,
        `🟦 *Tampon activé !*\n✅ Paiement unique effectué: *${STAMP_ONE_TIME_COST} crédits*\n📄 Le tampon sera ajouté gratuitement à vos PDF.`
      );

      return sendStampMenu(from);
    }

    await updateProfile(from, { stamp_enabled: true });
    await sendText(from, "🟦 Tampon activé.");
    return sendStampMenu(from);
  }

  if (replyId === "STAMP_EDIT_TITLE") {
    s.step = "stamp_title";
    await sendText(from, "✍️ Fonction (tampon) ?\nEx: GERANT / DIRECTEUR / COMMERCIAL\n\nTapez 0 pour effacer.");
    return;
  }
  if (replyId === "STAMP_MORE") return sendStampMoreMenu(from);
  if (replyId === "STAMP_POS") {
    await sendStampPositionMenu(from);
    return sendStampPositionMenu2(from);
  }
  if (replyId === "STAMP_SIZE") return sendStampSizeMenu(from);

  if (replyId === "STAMP_POS_BR") {
    await updateProfile(from, { stamp_position: "bottom-right" });
    return sendStampMenu(from);
  }
  if (replyId === "STAMP_POS_BL") {
    await updateProfile(from, { stamp_position: "bottom-left" });
    return sendStampMenu(from);
  }
  if (replyId === "STAMP_POS_TR") {
    await updateProfile(from, { stamp_position: "top-right" });
    return sendStampMenu(from);
  }
  if (replyId === "STAMP_POS_TL") {
    await updateProfile(from, { stamp_position: "top-left" });
    return sendStampMenu(from);
  }

  if (replyId === "STAMP_SIZE_S") {
    await updateProfile(from, { stamp_size: 150 });
    return sendStampMenu(from);
  }
  if (replyId === "STAMP_SIZE_M") {
    await updateProfile(from, { stamp_size: 170 });
    return sendStampMenu(from);
  }
  if (replyId === "STAMP_SIZE_L") {
    await updateProfile(from, { stamp_size: 200 });
    return sendStampMenu(from);
  }

  if (replyId === "CREDITS_SOLDE") return replyBalance(from);
  if (replyId === "CREDITS_RECHARGE") return replyRechargeInfo(from);

  if (replyId === "ITEM_SAVE") {
    const it = s.itemDraft || {};
    const item = makeItem(it.label, it.qty, it.unitPrice);
    if (s.lastDocDraft.items.length < LIMITS.maxItems) s.lastDocDraft.items.push(item);
    s.lastDocDraft.finance = computeFinance(s.lastDocDraft);
    s.itemDraft = null;
    return sendAfterProductMenu(from);
  }

  if (replyId === "ITEM_EDIT") return askItemLabel(from);
  if (replyId === "DOC_ADD_MORE") return askItemLabel(from);

  if (replyId === "DOC_FINISH") {
    s.step = "doc_review";
    const preview = buildPreviewMessage({ doc: s.lastDocDraft });
    await sendText(from, preview);

    const cost = computeBasePdfCost(s.lastDocDraft);
    await sendText(from, formatBaseCostLine(cost));

    return sendPreviewMenu(from);
  }

  if (replyId === "DOC_CONFIRM") return createAndSendPdf(from);

  if (replyId === "DOC_RESTART") {
    resetDraftSession(s);
    await sendText(from, "🔁 Recommençons.");
    return sendDocsMenu(from);
  }

  if (replyId === "DOC_CANCEL") {
    resetDraftSession(s);
    await sendText(from, "❌ Annulé.");
    return sendHomeMenu(from);
  }

  await sendText(from, "⚠️ Action non reconnue. Tapez MENU.");
}

// ===============================
// MAIN ENTRY — handleIncomingMessage
// ===============================
async function handleIncomingMessage(value) {
  const start = Date.now();

  try {
    if (!value) return;
    if (value.statuses?.length) return;
    if (!value.messages?.length) return;

    const msg = value.messages[0];
    const from = msg.from;

    if (!isValidWhatsAppId(from)) {
      logger.warn("invalid_wa_id", "Invalid WhatsApp ID received", { from });
      return;
    }

    try {
      await recordActivity(from);
    } catch (e) {
      logger.warn("activity_recording", e.message, { from });
    }

    await ensureWelcomeCredits(from);
    await maybeSendOnboarding(from);

    const replyIdInteractive =
      msg.interactive?.button_reply?.id ||
      msg.interactive?.list_reply?.id ||
      null;

    const replyIdButton =
      msg.button?.payload ||
      msg.button?.text ||
      null;

    if (replyIdInteractive || replyIdButton) {
      console.log("[KADI] BUTTON CLICK", {
        from,
        msgType: msg.type,
        replyIdInteractive,
        replyIdButton,
      });
    }

    if (msg.type === "interactive" && replyIdInteractive) {
      return handleInteractiveReply(from, replyIdInteractive);
    }

    if (msg.type === "button" && replyIdButton) {
      const mapped =
        replyIdButton === "Activer" || replyIdButton === "Désactiver"
          ? "STAMP_TOGGLE"
          : replyIdButton;

      return handleInteractiveReply(from, mapped);
    }

    if (msg.type === "image") {
      const s = getSession(from);

      // priorité au broadcast image admin
      if (ensureAdmin(from) && s.adminPendingAction === "broadcast_image") {
        return handleAdminBroadcastImage(from, msg);
      }

      if (s.step === "profile" && s.profileStep === "logo") return handleLogoImage(from, msg);
      return handleIncomingImage(from, msg);
    }

    const text = norm(msg.text?.body);
    if (!text) return;

    if (await handleAdmin(from, text)) return;

    const mCode = text.match(REGEX.code);
    if (mCode) {
      const result = await redeemCode({ waId: from, code: mCode[1] });
      if (!result.ok) {
        if (result.error === "CODE_DEJA_UTILISE") return sendText(from, "❌ Code déjà utilisé.");
        return sendText(from, "❌ Code invalide.");
      }
      return sendText(from, `✅ Recharge OK : +${result.added} crédits\n💳 Nouveau solde : ${result.balance}`);
    }

    if (await handleProfileAnswer(from, text)) return;

    if (await handleProductFlowText(from, text)) return;

    if (await handleCommand(from, text)) return;

    await sendText(from, "Tapez *MENU* pour commencer.");
  } catch (e) {
    logger.error("incoming_message", e, { messageType: value?.messages?.[0]?.type });
  } finally {
    const duration = Date.now() - start;
    logger.metric("message_processing", duration, true, { messageType: value?.messages?.[0]?.type });
  }
}

// ===============================
// EXPORTS
// ===============================
module.exports = {
  handleIncomingMessage,
  isValidWhatsAppId,
  isValidEmail,
};