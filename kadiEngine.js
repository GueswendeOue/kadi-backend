// kadiEngine.js
"use strict";

// ================= Logger =================
const logger = {
  info: (context, message, meta = {}) => {
    console.log(`[KADI/INFO/${context}]`, message, meta);
  },
  warn: (context, message, meta = {}) => {
    console.warn(`[KADI/WARN/${context}]`, message, meta);
  },
  error: (context, error, meta = {}) => {
    console.error(
      `[KADI/ERROR/${context}]`,
      error?.message || error,
      { ...meta, stack: error?.stack }
    );
  },
  metric: (name, duration, success = true, meta = {}) => {
    console.log(
      `[KADI/METRIC/${name}] ${duration}ms`,
      { success, ...meta }
    );
  },
};

const { getSession } = require("./kadiState");
const { nextDocNumber } = require("./kadiCounter");
const { buildPdfBuffer } = require("./kadiPdf");
const { saveDocument } = require("./kadiRepo");
const { getOrCreateProfile, updateProfile, markOnboardingDone } = require("./store");
const { uploadLogoBuffer, getSignedLogoUrl, downloadSignedUrlToBuffer } = require("./supabaseStorage");
const { ocrImageBuffer } = require("./kadiOcr");

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

// ---------------- Config ----------------
const ADMIN_WA_ID = process.env.ADMIN_WA_ID || "";
const OM_NUMBER = process.env.OM_NUMBER || "76894642";
const OM_NAME = process.env.OM_NAME || "GUESWENDE Ouedraogo";
const PRICE_LABEL = process.env.CREDITS_PRICE_LABEL || "2000F = 25 crédits";

const WELCOME_CREDITS = Number(process.env.WELCOME_CREDITS || 50);
const OCR_PDF_CREDITS = Number(process.env.OCR_PDF_CREDITS || 2);

const PACK_CREDITS = Number(process.env.PACK_CREDITS || 25);
const PACK_PRICE_FCFA = Number(process.env.PACK_PRICE_FCFA || 2000);

// ---------------- Limits ----------------
const LIMITS = {
  maxItems: 50,
  maxImageSize: 5 * 1024 * 1024, // 5MB
  maxOcrRetries: 3,
  maxClientNameLength: 100,
  maxItemLabelLength: 200,
};

const _WELCOME_CACHE = new Map(); // waId -> timestamp(ms)

// ---------------- Utils ----------------
function safe(v) {
  return String(v || "").trim();
}

function norm(s) {
  return String(s || "").trim();
}

function nowISO() {
  const d = new Date();
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

function isValidWhatsAppId(id) {
  return /^\d+$/.test(id) && id.length >= 8 && id.length <= 15;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
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

// ---------------- Parsing lignes ----------------
function hasDimensionPattern(raw) {
  const s = String(raw || "").toLowerCase();

  // dimension avec unité (cm/mm/m)
  if (/\b\d+(?:[.,]\d+)?\s*(cm|mm|m)\s*[x×]\s*\d+(?:[.,]\d+)?\s*(cm|mm|m)?\b/.test(s)) return true;

  // dimension "nue" style 44x34
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
  const label = (d || raw).substring(0, LIMITS.maxItemLabelLength);

  const amount = Number(qty) * Number(unitPrice || 0);

  return {
    label,
    qty: Number(qty) || 1,
    unitPrice: Number(unitPrice) || 0,
    amount: Number.isFinite(amount) ? amount : 0,
    raw,
  };
}

function parseItemLine(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;

  const isDim = hasDimensionPattern(raw);
  let qty = null;

  // "2x" / "x2" seulement si ce n'est pas une dimension
  if (!isDim) {
    const xAfter = raw.match(/(?:^|\s)x\s*(\d{1,3})\b/i);
    const xBefore = raw.match(/(?:^|\s)(\d{1,3})\s*x\b/i);
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
  label = label.substring(0, LIMITS.maxItemLabelLength);

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

// ===============================
// OCR helpers (photo -> texte -> draft)
// ===============================
function guessDocTypeFromOcr(text) {
  const t = String(text || "").toLowerCase();
  if (t.includes("facture")) return "facture";
  if (t.includes("reçu") || t.includes("recu")) return "recu";
  if (t.includes("devis") || t.includes("proforma") || t.includes("pro forma")) return "devis";
  return null;
}

function extractTotalFromOcr(text) {
  const t = String(text || "");
  let m = t.match(/total\s*[:\-]?\s*([0-9][0-9\s.,]+)/i) || t.match(/montant\s+total\s*[:\-]?\s*([0-9][0-9\s.,]+)/i);
  if (!m) return null;
  return cleanNumber(m[1]);
}

function parseOcrToDraft(ocrText) {
  const lines = String(ocrText || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let client = null;
  for (const line of lines) {
    const m =
      line.match(/^client\s*[:\-]\s*(.+)$/i) ||
      line.match(/^nom\s*[:\-]\s*(.+)$/i) ||
      line.match(/^doit\s*[:\-]\s*(.+)$/i);
    if (m) {
      client = (m[1] || "").trim().substring(0, LIMITS.maxClientNameLength);
      break;
    }
  }

  const items = [];
  for (const line of lines) {
    const low = line.toLowerCase();
    if (
      low.startsWith("total") ||
      low.startsWith("date") ||
      low.startsWith("facture") ||
      low.startsWith("devis") ||
      low.startsWith("reçu") ||
      low.startsWith("recu") ||
      low.startsWith("ifu") ||
      low.startsWith("rccm") ||
      low.startsWith("adresse") ||
      low.startsWith("tél") ||
      low.startsWith("tel") ||
      low.startsWith("email")
    ) continue;

    if (/\d/.test(line)) {
      const itStructured = parseStructuredItemLine(line);
      const it = itStructured || parseItemLine(line);
      if (it && items.length < LIMITS.maxItems) items.push(it);
    }
  }

  const detected = extractTotalFromOcr(ocrText);
  const calc = sumItems(items);
  const finance = { subtotal: calc, gross: detected ?? calc };

  return { client, items, finance };
}

async function robustOcr(buffer, lang = "fra", maxRetries = LIMITS.maxOcrRetries) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await ocrImageBuffer(buffer, lang);
    } catch (e) {
      if (attempt === maxRetries) throw e;
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
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
      `🎁 Bienvenue sur KADI !\nVous recevez *${WELCOME_CREDITS} crédits gratuits*.\n📄 1 crédit = 1 PDF`
    );
  } catch (e) {
    console.warn("⚠️ ensureWelcomeCredits:", e?.message);
  }
}

async function maybeSendOnboarding(from) {
  try {
    const p = await getOrCreateProfile(from);
    if (p?.onboarding_done === true) return;

    // ✅ Message simple + captivant
    const msg =
      `👋 Bienvenue sur *KADI*.\n\n` +
      `✅ *Devis / Facture / Reçu* en 30 secondes.\n` +
      `📷 Envoyez aussi une *photo* d’un document → KADI extrait le texte et fait un PDF *propre*.\n\n` +
      `👇 Choisissez :`;

    // ✅ Un seul message (buttons) = plus propre
    await sendButtons(from, msg, [
      { id: "HOME_DOCS", title: "Créer document" },
      { id: "HOME_PROFILE", title: "Mon profil" },
      { id: "HOME_CREDITS", title: "Crédits" },
    ]);

    await markOnboardingDone(from, 1);
  } catch (e) {
    console.warn("⚠️ onboarding:", e?.message);
  }
}

// ===============================
// Menus (1 seul message)
// ===============================
async function sendHomeMenu(to) {
  return sendButtons(to, "🏠 *Menu KADI* — choisissez :", [
    { id: "HOME_DOCS", title: "Documents" },
    { id: "HOME_CREDITS", title: "Crédits" },
    { id: "HOME_PROFILE", title: "Profil" },
  ]);
}

async function sendDocsMenu(to) {
  // ✅ PAS en 2 messages
  return sendButtons(to, "📄 Quel document voulez-vous créer ?", [
    { id: "DOC_DEVIS", title: "Devis" },
    { id: "DOC_FACTURE", title: "Facture" },
    { id: "DOC_RECU", title: "Reçu" },
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
  return sendButtons(to, "✅ Vérifiez. Que souhaitez-vous faire ?", [
    { id: "DOC_CONFIRM", title: "Confirmer (PDF)" },
    { id: "DOC_RESTART", title: "Recommencer" },
    { id: "BACK_HOME", title: "Menu" },
  ]);
}

// ===============================
// Profil (7 étapes)
// ===============================
async function startProfileFlow(from) {
  const s = getSession(from);
  s.step = "profile";
  s.profileStep = "business_name";
  await getOrCreateProfile(from);

  await sendText(
    from,
    "🏢 *Profil entreprise*\n\n1/7 — Nom de l'entreprise ?\nEx: GUESWENDE Technologies\n\n📌 Tapez 0 pour ignorer un champ."
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
// Recharge + preuve (image)
// ===============================
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
    if (info?.file_size && info.file_size > LIMITS.maxImageSize) {
      await sendText(from, "❌ Image trop grande. Envoyez une capture plus légère.");
      return;
    }

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
    console.error("handleRechargeProofImage:", e?.message);
    await sendText(from, "❌ Désolé, la preuve n’a pas pu être traitée. Réessayez.");
  }
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
// Crédits
// ===============================
async function replyBalance(from) {
  const bal = await getBalance(from);
  await sendText(from, `💳 *Votre solde KADI* : ${bal} crédit(s)\n📄 1 crédit = 1 PDF`);
}
// ===============================
// Documents (texte)
// ===============================
async function startDocFlow(from, mode, factureKind = null) {
  const s = getSession(from);
  s.step = "collecting_doc";
  s.mode = mode;
  s.factureKind = factureKind;

  s.lastDocDraft = {
    type: mode, // devis | facture | recu
    factureKind,
    docNumber: null,
    date: formatDateISO(),
    client: null,
    items: [],
    finance: null,
    source: "text", // text | ocr
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
    `${prefix}\n\n` +
      `✅ Envoyez les lignes comme ceci :\n` +
      `Client: Awa\nDesign logo x1 30000\nImpression x2 5000\n\n` +
      `✅ Format conseillé (plus précis) :\n` +
      `D: Verre clair 44x34 cm | Q: 2 | PU: 7120\n` +
      `D: Silicone | Q: 1 | PU: 12000\n\n` +
      `📷 Vous pouvez aussi envoyer une *photo* d’un document (KADI extrait le texte et fait un PDF propre).`
  );
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

async function buildPreviewMessage({ profile, doc }) {
  try {
    validateDraft(doc);
  } catch (_) {}

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
    .slice(0, LIMITS.maxItems)
    .map(
      (it, idx) =>
        `${idx + 1}) ${it.label} | Qté:${money(it.qty)} | PU:${money(it.unitPrice)} | Montant:${money(it.amount)}`
    )
    .join("\n");

  const src = doc?.source === "ocr" ? "📷 Source: OCR (photo)" : "⌨️ Source: texte";

  return [
    header,
    "",
    `📄 *${title}*`,
    `Date : ${doc.date || "-"}`,
    `Client : ${doc.client || "-"}`,
    src,
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
    const m = REGEX.client.exec(line);
    if (m && !draft.client) {
      draft.client = (m[1] || "").trim().slice(0, LIMITS.maxClientNameLength) || null;
      continue;
    }

    if (/\d/.test(line) && !/^client\s*[:\-]/i.test(line)) {
      const itStructured = parseStructuredItemLine(line);
      const it = itStructured || parseItemLine(line);

      if (it) {
        if (draft.items.length < LIMITS.maxItems) {
          draft.items.push(it);
        } else {
          await sendText(from, `⚠️ Limite de ${LIMITS.maxItems} lignes atteinte. Les lignes suivantes sont ignorées.`);
          break;
        }
      }
    }
  }

  draft.finance = computeFinance(draft);

  const profile = await getOrCreateProfile(from);
  const preview = await buildPreviewMessage({ profile, doc: draft });

  await sendText(from, preview);
  await sendAfterPreviewMenu(from);
  return true;
}

// ===============================
// OCR (photo → texte → draft)
// ===============================
function guessDocTypeFromOcr(text) {
  const t = String(text || "").toLowerCase();
  if (t.includes("facture")) return "facture";
  if (t.includes("reçu") || t.includes("recu")) return "recu";
  if (t.includes("devis") || t.includes("proforma") || t.includes("pro forma")) return "devis";
  return null;
}

function extractTotalFromOcr(text) {
  const t = String(text || "");
  const m = t.match(REGEX.total) || t.match(REGEX.montantTotal);
  if (!m) return null;
  return cleanNumber(m[1]);
}

function parseOcrToDraft(ocrText) {
  const lines = String(ocrText || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let client = null;
  for (const line of lines) {
    const m =
      line.match(REGEX.client) ||
      line.match(/^nom\s*[:\-]\s*(.+)$/i) ||
      line.match(/^doit\s*[:\-]\s*(.+)$/i);
    if (m) {
      client = (m[1] || "").trim().slice(0, LIMITS.maxClientNameLength);
      break;
    }
  }

  const items = [];
  for (const line of lines) {
    const low = line.toLowerCase();
    // on skippe les lignes "meta"
    if (
      low.startsWith("total") ||
      low.startsWith("montant total") ||
      low.startsWith("date") ||
      low.startsWith("facture") ||
      low.startsWith("devis") ||
      low.startsWith("reçu") ||
      low.startsWith("recu") ||
      low.startsWith("ifu") ||
      low.startsWith("rccm") ||
      low.startsWith("adresse") ||
      low.startsWith("tél") ||
      low.startsWith("tel") ||
      low.startsWith("email")
    ) continue;

    if (/\d/.test(line)) {
      const itStructured = parseStructuredItemLine(line);
      const it = itStructured || parseItemLine(line);
      if (it && items.length < LIMITS.maxItems) items.push(it);
    }
  }

  const detected = extractTotalFromOcr(ocrText);
  const calc = sumItems(items);
  const finance = { subtotal: calc, gross: detected ?? calc };

  return { client, items, finance };
}

async function robustOcr(buffer, lang = "fra", maxRetries = LIMITS.maxOcrRetries) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await ocrImageBuffer(buffer, lang);
    } catch (e) {
      if (attempt === maxRetries) throw e;
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
}

async function processOcrImageToDraft(from, mediaId) {
  const s = getSession(from);

  const info = await getMediaInfo(mediaId);
  if (info?.file_size && info.file_size > LIMITS.maxImageSize) {
    await sendText(from, "❌ Image trop grande. Envoyez une photo plus légère.");
    return;
  }

  const buf = await downloadMediaToBuffer(info.url);

  await sendText(from, "🔎 Lecture de la photo…");

  let ocrText = "";
  try {
    ocrText = await robustOcr(buf, "fra");
  } catch (e) {
    console.warn("OCR failed:", e?.message);
    await sendText(from, "❌ Impossible de lire la photo. Essayez une photo plus nette (bonne lumière, sans flou).");
    return;
  }

  // si aucun doc en cours, on crée un draft
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
    s.step = "collecting_doc";
  } else {
    s.lastDocDraft.source = "ocr";
  }

  const parsed = parseOcrToDraft(ocrText);

  if (parsed.client && !s.lastDocDraft.client) s.lastDocDraft.client = parsed.client;

  if (parsed.items?.length) {
    const room = LIMITS.maxItems - s.lastDocDraft.items.length;
    const toAdd = parsed.items.slice(0, Math.max(0, room));
    s.lastDocDraft.items.push(...toAdd);

    if (parsed.items.length > toAdd.length) {
      await sendText(from, `⚠️ Limite ${LIMITS.maxItems} lignes. Certains items ont été ignorés.`);
    }
  }

  s.lastDocDraft.finance = parsed.finance || computeFinance(s.lastDocDraft);

  const profile = await getOrCreateProfile(from);
  const preview = await buildPreviewMessage({ profile, doc: s.lastDocDraft });

  await sendText(from, preview);
  await sendAfterPreviewMenu(from);
}

// ===============================
// Route image intelligente
// logo / preuve / OCR
// ===============================
async function handleIncomingImage(from, msg) {
  const s = getSession(from);

  // 1) logo
  if (s.step === "profile" && s.profileStep === "logo") return handleLogoImage(from, msg);

  // 2) preuve recharge
  if (s.step === "recharge_proof") return handleRechargeProofImage(from, msg);

  const mediaId = msg?.image?.id;
  if (!mediaId) return sendText(from, "❌ Image reçue mais sans media_id. Réessayez.");

  // 3) si pas de doc en cours -> on demande quel doc (évite confusion)
  if (s.step !== "collecting_doc" || !s.lastDocDraft) {
    s.step = "ocr_choose_doc";
    s.pendingOcrMediaId = mediaId;

    return sendButtons(from, "📷 J’ai reçu une photo. Quel document voulez-vous générer ?", [
      { id: "OCR_DEVIS", title: "Devis" },
      { id: "OCR_FACTURE", title: "Facture" },
      { id: "OCR_RECU", title: "Reçu" },
    ]);
  }

  // 4) sinon OCR direct
  return processOcrImageToDraft(from, mediaId);
}
// ===============================
// Création PDF finale (1 crédit ou OCR_PDF_CREDITS)
// ===============================
async function createAndSendPdf(from) {
  const s = getSession(from);
  const draft = s.lastDocDraft;

  if (!draft) {
    await sendText(from, "❌ Aucun document en cours. Tapez MENU.");
    return;
  }

  // Validation rapide
  try {
    validateDraft(draft);
  } catch (err) {
    await sendText(from, `❌ Erreur dans le document: ${err.message}`);
    return;
  }

  // Coût: OCR = plus cher au PDF final
  const cost = draft.source === "ocr" ? OCR_PDF_CREDITS : 1;

  const cons = await consumeCredit(from, cost, draft.source === "ocr" ? "ocr_pdf" : "pdf");
  if (!cons.ok) {
    await sendText(
      from,
      `❌ Solde insuffisant.\nVous avez ${cons.balance} crédit(s).\nCe PDF coûte ${cost} crédit(s).\n👉 Tapez RECHARGE.`
    );
    return;
  }

  // ⚠️ si bug après débit crédits, on essaie un rollback (addCredits)
  let successAfterDebit = false;

  try {
    // Numéro doc
    draft.docNumber = await nextDocNumber({
      waId: from,
      mode: draft.type,
      factureKind: draft.factureKind,
      dateISO: draft.date,
    });

    const profile = await getOrCreateProfile(from);

    // Logo buffer (optionnel)
    let logoBuf = null;
    if (profile?.logo_path) {
      try {
        const signed = await getSignedLogoUrl(profile.logo_path);
        logoBuf = await downloadSignedUrlToBuffer(signed);
      } catch (e) {
        console.warn("logo download error:", e?.message);
      }
    }

    const title =
      draft.type === "facture"
        ? draft.factureKind === "proforma"
          ? "FACTURE PRO FORMA"
          : "FACTURE DÉFINITIVE"
        : String(draft.type || "").toUpperCase();

    const total = draft.finance?.gross ?? computeFinance(draft).gross;

    // PDF buffer
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

    // Save document (best effort)
    try {
      await saveDocument({ waId: from, doc: draft });
    } catch (e) {
      console.warn("saveDocument error:", e?.message);
    }

    // Upload vers WhatsApp
    const fileName = `${draft.docNumber}-${formatDateISO()}.pdf`;
    const up = await uploadMediaBuffer({
      buffer: pdfBuf,
      filename: fileName,
      mimeType: "application/pdf",
    });

    if (!up?.id) throw new Error("Upload PDF échoué");

    successAfterDebit = true;

    await sendDocument({
      to: from,
      mediaId: up.id,
      filename: fileName,
      caption:
        `✅ ${title} ${draft.docNumber}\n` +
        `Total: ${money(total)} FCFA\n` +
        `Coût: ${cost} crédit(s)\n` +
        `Solde: ${cons.balance} crédit(s)`,
    });

    // Reset session
    s.step = "idle";
    s.mode = null;
    s.factureKind = null;
    s.lastDocDraft = null;

    await sendHomeMenu(from);
  } catch (e) {
    console.error("createAndSendPdf error:", e?.message);

    // rollback crédits si on a débité mais on n’a pas livré le PDF
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

async function confirmAndSendPdf(from) {
  return createAndSendPdf(from);
}
// ===============================
// INTERACTIVE HANDLER (boutons)
// ===============================
async function handleInteractiveReply(from, replyId) {
  const s = getSession(from);

  // ---------- Navigation ----------
  if (replyId === "BACK_HOME") return sendHomeMenu(from);
  if (replyId === "BACK_DOCS") return sendDocsMenu(from);

  // ---------- Home ----------
  if (replyId === "HOME_DOCS") return sendDocsMenu(from);
  if (replyId === "HOME_CREDITS") return sendCreditsMenu(from);
  if (replyId === "HOME_PROFILE") return sendProfileMenu(from);

  // ---------- Documents ----------
  if (replyId === "DOC_DEVIS") return startDocFlow(from, "devis");
  if (replyId === "DOC_RECU") return startDocFlow(from, "recu");

  if (replyId === "DOC_FACTURE") {
    return sendFactureKindMenu(from);
  }

  if (replyId === "FAC_PROFORMA") {
    return startDocFlow(from, "facture", "proforma");
  }

  if (replyId === "FAC_DEFINITIVE") {
    return startDocFlow(from, "facture", "definitive");
  }

  // ---------- OCR : choix type doc ----------
  if (replyId === "OCR_DEVIS" || replyId === "OCR_RECU") {
    const mediaId = s.pendingOcrMediaId;
    s.pendingOcrMediaId = null;

    if (!mediaId) {
      await sendText(from, "❌ Photo introuvable. Renvoyez-la.");
      return;
    }

    await startDocFlow(from, replyId === "OCR_DEVIS" ? "devis" : "recu");
    return processOcrImageToDraft(from, mediaId);
  }

  if (replyId === "OCR_FACTURE") {
    s.step = "ocr_wait_facture_kind";
    return sendFactureKindMenu(from);
  }

  // OCR + type facture
  if (
    (replyId === "FAC_PROFORMA" || replyId === "FAC_DEFINITIVE") &&
    s.step === "ocr_wait_facture_kind"
  ) {
    const mediaId = s.pendingOcrMediaId;
    s.pendingOcrMediaId = null;

    if (!mediaId) {
      await sendText(from, "❌ Photo introuvable. Renvoyez-la.");
      return;
    }

    await startDocFlow(
      from,
      "facture",
      replyId === "FAC_PROFORMA" ? "proforma" : "definitive"
    );

    return processOcrImageToDraft(from, mediaId);
  }

  // ---------- Profil ----------
  if (replyId === "PROFILE_EDIT") return startProfileFlow(from);

  if (replyId === "PROFILE_VIEW") {
    const p = await getOrCreateProfile(from);
    await sendText(
      from,
      `🏢 *Profil*\n` +
        `Nom: ${p.business_name || "—"}\n` +
        `Adresse: ${p.address || "—"}\n` +
        `Tel: ${p.phone || "—"}\n` +
        `Email: ${p.email || "—"}\n` +
        `IFU: ${p.ifu || "—"}\n` +
        `RCCM: ${p.rccm || "—"}\n` +
        `Logo: ${p.logo_path ? "OK ✅" : "—"}`
    );
    return;
  }

  // ---------- Crédits ----------
  if (replyId === "CREDITS_SOLDE") return replyBalance(from);
  if (replyId === "CREDITS_RECHARGE") return replyRechargeInfo(from);

  // ---------- PDF ----------
  if (replyId === "DOC_CONFIRM") return confirmAndSendPdf(from);

  if (replyId === "DOC_RESTART") {
    s.step = "idle";
    s.mode = null;
    s.factureKind = null;
    s.lastDocDraft = null;

    await sendText(from, "🔁 Recommençons.");
    return sendDocsMenu(from);
  }

  // Fallback
  await sendText(from, "⚠️ Action non reconnue. Tapez MENU.");
}
// ===============================
// COMMANDS (texte)
// ===============================
async function handleStatsCommand(from, text) {
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
    logger.error("stats_command", e, { from });
    return sendText(from, "❌ Erreur: impossible de calculer les stats pour le moment.");
  }
}

async function handleTopCommand(from, text) {
  if (!ensureAdmin(from)) return sendText(from, "❌ Commande réservée à l’administrateur.");

  const days = parseDaysArg(text, 30);
  const top = await getTopClients({ days, limit: 5 });

  if (!top.length) return sendText(from, `🏆 TOP CLIENTS — ${days}j\nAucune donnée.`);

  const lines = top
    .map((r, i) => `${i + 1}) ${r.client} — ${r.doc_count} doc • ${money(r.total_sum)} FCFA`)
    .join("\n");

  return sendText(from, `🏆 *TOP 5 CLIENTS* — ${days} jours\n\n${lines}`);
}

async function handleExportCommand(from, text) {
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
        escapeCsvValue(r.client || ""),
        r.date || "",
        String(r.total ?? ""),
        String(Array.isArray(r.items) ? r.items.length : 0),
      ];
      return vals.join(",");
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

async function handleCommand(from, text) {
  const lower = String(text || "").toLowerCase().trim();

  // stats/top/export (admin)
  if (lower === "/stats" || lower === "stats") return handleStatsCommand(from, text);
  if (lower.startsWith("/top") || lower.startsWith("top")) return handleTopCommand(from, text);
  if (lower.startsWith("/export") || lower.startsWith("export")) return handleExportCommand(from, text);

  // user quick commands
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
  if (lower === "devis") {
    await startDocFlow(from, "devis");
    return true;
  }
  if (lower === "recu" || lower === "reçu") {
    await startDocFlow(from, "recu");
    return true;
  }
  if (lower === "facture") {
    await sendFactureKindMenu(from);
    return true;
  }
  if (lower === "profil" || lower === "profile") {
    await sendProfileMenu(from);
    return true;
  }

  return false;
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

    // activity
    try {
      await recordActivity(from);
    } catch (e) {
      logger.warn("activity_recording", e.message, { from });
    }

    // welcome + onboarding (safe)
    await ensureWelcomeCredits(from);
    await maybeSendOnboarding(from);

    // ✅ INTERACTIVE -> return direct (évite double messages)
    if (msg.type === "interactive") {
      const replyId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
      if (replyId) return handleInteractiveReply(from, replyId);
      return;
    }

    // ✅ IMAGE -> route intelligent (logo / preuve / OCR)
    if (msg.type === "image") {
      return handleIncomingImage(from, msg);
    }

    // ✅ TEXT
    const text = norm(msg.text?.body);
    if (!text) return;

    // admin
    if (await handleAdmin(from, text)) return;

    // code recharge
    const mCode = text.match(CONFIG.regex.code);
    if (mCode) {
      const result = await redeemCode({ waId: from, code: mCode[1] });
      if (!result.ok) {
        if (result.error === "CODE_DEJA_UTILISE") return sendText(from, "❌ Code déjà utilisé.");
        return sendText(from, "❌ Code invalide.");
      }
      return sendText(from, `✅ Recharge OK : +${result.added} crédits\n💳 Nouveau solde : ${result.balance}`);
    }

    // profile flow
    if (await handleProfileAnswer(from, text)) return;

    // commands
    if (await handleCommand(from, text)) return;

    // doc text
    if (await handleDocText(from, text)) return;

    // fallback
    await sendText(from, "Tapez *MENU* pour commencer.");
  } catch (e) {
    logger.error("incoming_message", e, {
      messageType: value?.messages?.[0]?.type,
    });
  } finally {
    const duration = Date.now() - start;
    logger.metric("message_processing", duration, true, {
      messageType: value?.messages?.[0]?.type,
    });
  }
}

// ===============================
// EXPORTS
// ===============================
module.exports = {
  handleIncomingMessage,
  cleanNumber,
  isValidWhatsAppId,
  isValidEmail,
};