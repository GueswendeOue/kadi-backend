// kadiEngine.js — UPDATED (Google Vision/Tesseract + Gemini parsing + Admin broadcast)
// ✅ Tampon = 15 crédits (paiement UNIQUE), puis GRATUIT sur tous les PDF suivants
// ✅ OCR hybride: Google Vision/Tesseract + Gemini fallback + parsing intelligent
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

const { supabase } = require("./supabaseClient");

// ================= Optional modules (Tampon/Signature/Broadcast) =================
let kadiStamp = null;
let kadiSignature = null;

try {
  kadiStamp = require("./kadiStamp");
  console.log("✅ kadiStamp module loaded");
} catch (e) {
  console.warn("⚠️ kadiStamp load failed:", e?.message);
  console.warn(e?.stack);
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

// ================= Imports core =================

// Session / State
const { getSession } = require("./kadiState");

// Counters
const { nextDocNumber } = require("./kadiCounter");

// ================= PDF =================
const pdfMod = require("./kadiPdf");

if (process.env.KADI_DEBUG_PDF_MODULE === "1") {
  console.log("[KADI] PDF MODULE RESOLVED ✅", require.resolve("./kadiPdf"));
  console.log("[KADI] PDF MODULE KEYS ✅", Object.keys(pdfMod || {}));
}

const { analyzeSmartBlock } = require("./kadiSmartAnalyzer");
const { parseNaturalWhatsAppMessage } = require("./kadiNaturalParser");
const { logLearningEvent } = require("./kadiLearningLogger");
const crypto = require("crypto");

const {
  detectDechargeType,
  buildDechargeText,
  buildDechargePreviewMessage,
  initDechargeDraft,
  buildDechargeConfirmationMessage,
  buildPostConfirmationMessage,
} = require("./kadiDecharge");


const { buildPdfBuffer } = pdfMod;


// ================= Storage / Database =================
const { saveDocument } = require("./kadiRepo");

const {
  getOrCreateProfile,
  updateProfile,
  updateProfileByIdentity,
  markOnboardingDone,
} = require("./store");

function makeDraftMeta(overrides = {}) {
  return {
    usedGeminiParse: false,
    businessSector: null,
    usedStamp: false,
    creditsConsumed: null,
    ...overrides,
  };
}

function cloneDraftToNewDocType(draft, targetType) {
  if (!draft) return null;

  const clonedItems = Array.isArray(draft.items)
    ? draft.items.map((it) => ({ ...it }))
    : [];

  const next = {
    ...draft,
    type: targetType,
    factureKind: targetType === "facture" ? "definitive" : null,
    docNumber: null,
    savedDocumentId: null,
    savedPdfMediaId: null,
    savedPdfFilename: null,
    savedPdfCaption: null,
    requestId: null,
    status: "draft",
    source: draft.source || "product",
    items: clonedItems,
    finance: clonedItems.length
      ? computeFinance({ items: clonedItems })
      : draft.finance || null,
    meta: makeDraftMeta({
      ...(draft.meta || {}),
      convertedFromType: draft.type || null,
      convertedAt: new Date().toISOString(),
    }),
  };

  if (targetType === "recu") {
    next.receiptFormat = draft.receiptFormat || "a4";
  } else {
    delete next.receiptFormat;
  }

  return next;
}

async function createDevisFollowup({ waId, documentId, docNumber, sourceDoc, dueAt }) {
  const { error } = await supabase.from("kadi_devis_followups").insert({
    wa_id: waId,
    document_id: documentId || null,
    doc_number: docNumber,
    source_doc: sourceDoc || null,
    due_at: new Date(dueAt).toISOString(),
    status: "pending",
    attempts: 0,
    postponed_count: 0,
  });

  if (error) throw error;
}

async function markDevisFollowupSent(id) {
  const { error } = await supabase
    .from("kadi_devis_followups")
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) throw error;
}

async function postponeDevisFollowup(id, hours = 24) {
  const { data, error: readError } = await supabase
    .from("kadi_devis_followups")
    .select("postponed_count")
    .eq("id", id)
    .maybeSingle();

  if (readError) throw readError;

  const { error } = await supabase
    .from("kadi_devis_followups")
    .update({
      status: "pending",
      due_at: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(),
      postponed_count: Number(data?.postponed_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) throw error;
}

async function markDevisFollowupConverted(id, convertedTo) {
  const { error } = await supabase
    .from("kadi_devis_followups")
    .update({
      status: "converted",
      converted_to: convertedTo,
      converted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) throw error;
}

async function markDevisFollowupDismissed(id) {
  const { error } = await supabase
    .from("kadi_devis_followups")
    .update({
      status: "dismissed",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) throw error;
}

async function getDueDevisFollowups(limit = 20) {
  const { data, error } = await supabase
    .from("kadi_devis_followups")
    .select("*")
    .eq("status", "pending")
    .lte("due_at", new Date().toISOString())
    .order("due_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

async function sendDevisFollowupMessage(row) {
  const text =
    `📄 Votre devis ${row.doc_number} est prêt depuis 24h.\n\n` +
    `Avez-vous conclu avec le client ?\n\n` +
    `Vous pouvez maintenant le transformer rapidement en :\n` +
    `• Facture\n• Reçu`;

  await sendButtons(row.wa_id, text, [
    { id: `FOLLOWUP_FACTURE_${row.id}`, title: "📄 Faire facture" },
    { id: `FOLLOWUP_RECU_${row.id}`, title: "🧾 Faire reçu" },
    { id: `FOLLOWUP_LATER_${row.id}`, title: "⏳ Plus tard" },
  ]);
}

async function processDevisFollowups(limit = 20) {
  const rows = await getDueDevisFollowups(limit);
  if (!rows.length) return 0;

  let sent = 0;

  for (const row of rows) {
    try {
      await sendDevisFollowupMessage(row);

      const { error } = await supabase
        .from("kadi_devis_followups")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          attempts: Number(row.attempts || 0) + 1,
          updated_at: new Date().toISOString(),
          last_error: null,
        })
        .eq("id", row.id);

      if (error) throw error;
      sent += 1;
    } catch (e) {
      await supabase
        .from("kadi_devis_followups")
        .update({
          last_error: String(e?.message || e || "unknown_error"),
          attempts: Number(row.attempts || 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
    }
  }

  return sent;
}

async function getDevisFollowupById(id) {
  const { data, error } = await supabase
    .from("kadi_devis_followups")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

// ================= Supabase Storage =================
const {
  uploadLogoBuffer,
  getSignedLogoUrl,
  downloadSignedUrlToBuffer,
  uploadCampaignImageBuffer,
  getSignedCampaignUrl,
} = require("./supabaseStorage");


// ================= OCR =================
const { ocrImageToText } = require("./kadiOcr");

const {
  geminiIsEnabled,
  ocrLooksGood,
  geminiOcrImageBuffer,
  parseInvoiceTextWithGemini,
} = require("./kadiGemini");


// ================= WhatsApp API =================
const {
  sendText,
  sendButtons,
  sendList,
  getMediaInfo,
  downloadMediaToBuffer,
  uploadMediaBuffer,
  sendDocument,
} = require("./whatsappApi");


// ================= Credits =================
const {
  getBalance,
  consumeCredit,
  consumeFeature,
  createRechargeCodes,
  redeemCode,
  addCredits,
} = require("./kadiCreditsRepo");


// ================= Activity =================
const { recordActivity } = require("./kadiActivityRepo");


// ================= Stats =================
const {
  getStats,
  getTopClients,
  getDocsForExport,
  money,
} = require("./kadiStatsRepo");

// ================= Config =================
const ADMIN_WA_ID = process.env.ADMIN_WA_ID || "";
const OM_NUMBER = process.env.OM_NUMBER || "76894642";
const OM_NAME = process.env.OM_NAME || "GUESWENDE Ouedraogo";
const PRICE_LABEL = process.env.CREDITS_PRICE_LABEL || "2000F = 25 crédits";

const WELCOME_CREDITS = Number(process.env.WELCOME_CREDITS || 10);
const PACK_CREDITS = Number(process.env.PACK_CREDITS || 25);
const PACK_PRICE_FCFA = Number(process.env.PACK_PRICE_FCFA || 2000);

const BROADCAST_BATCH = Number(process.env.BROADCAST_BATCH || 25);
const BROADCAST_DELAY_MS = Number(process.env.BROADCAST_DELAY_MS || 450);

// ================= Pricing / Credits =================
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

const _WELCOME_CACHE = new Map();

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

function extractMetaIdentity(value = {}) {
  const contact = value?.contacts?.[0] || {};
  const msg = value?.messages?.[0] || {};
  const status = value?.statuses?.[0] || {};

  const waId =
    contact?.wa_id ||
    msg?.from ||
    status?.recipient_id ||
    null;

  const bsuid =
    contact?.user_id ||
    msg?.from_user_id ||
    status?.recipient_user_id ||
    null;

  const parentBsuid =
    contact?.parent_user_id ||
    msg?.from_parent_user_id ||
    status?.parent_recipient_user_id ||
    null;

  const username = contact?.profile?.username || null;
  const profileName = contact?.profile?.name || null;

  return {
    waId: waId ? String(waId).trim() : null,
    bsuid: bsuid ? String(bsuid).trim() : null,
    parentBsuid: parentBsuid ? String(parentBsuid).trim() : null,
    username: username ? String(username).trim() : null,
    profileName: profileName ? String(profileName).trim() : null,
  };
}

function resolveOwnerKey(identity = {}) {
  // version sans casse pour l’instant
  return identity?.waId || identity?.bsuid || null;
}

async function syncMetaIdentity(identity = {}) {
  const waId = identity?.waId || null;
  const bsuid = identity?.bsuid || null;
  const parentBsuid = identity?.parentBsuid || null;
  const username = identity?.username || null;
  const profileName = identity?.profileName || null;

  if (!waId && !bsuid) return null;

  const profile = await getOrCreateProfile(waId, {
    bsuid,
    parentBsuid,
    username,
    profileName,
  });

  const patch = {};

  if (bsuid && profile?.bsuid !== bsuid) patch.bsuid = bsuid;
  if (parentBsuid && profile?.parent_bsuid !== parentBsuid) {
    patch.parent_bsuid = parentBsuid;
  }
  if (username && profile?.whatsapp_username !== username) {
    patch.whatsapp_username = username;
  }
  if (profileName && !profile?.owner_name) {
    patch.owner_name = profileName;
  }

  if (Object.keys(patch).length) {
    await updateProfileByIdentity({ waId, bsuid }, patch);
  }

  return profile;
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
function hasStampProfileReady(profile) {
  return !!(
    safe(profile?.business_name) &&
    safe(profile?.phone) &&
    safe(profile?.stamp_title)
  );
}

function resetStampChoice(session) {
  session.addStampForNextDoc = false;
  session.stampMode = null;
}

function buildPreGenerateStampMessage() {
  return (
    "📄 Votre document est prêt à être généré.\n\n" +
    "✨ Ajouter un tampon professionnel ?\n" +
    "✔️ Rend votre document plus crédible\n" +
    "✔️ Donne une image professionnelle\n" +
    "💳 Coût du tampon sur ce document : *1 crédit*"
  );
}

async function sendPreGenerateStampMenu(to) {
  const text = buildPreGenerateStampMessage();

  return sendButtons(to, text, [
    { id: "PRESTAMP_ADD_ONCE", title: "🟦 Ajouter tampon" },
    { id: "PRESTAMP_SKIP", title: "⚪ Sans tampon" },
    { id: "PROFILE_STAMP", title: "💎 Tampon illimité" },
  ]);
}


// ===============================
// User locks (anti-concurrence)
// ===============================
const _userLocks = new Map();

async function withUserLock(waId, fn) {
  const previous = _userLocks.get(waId) || Promise.resolve();

  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });

  _userLocks.set(waId, previous.then(() => current));

  try {
    await previous;
    return await fn();
  } finally {
    release();
    if (_userLocks.get(waId) === current) {
      _userLocks.delete(waId);
    }
  }
}

// ===============================
// Tampon & Signature (wrapper)
// ===============================
async function applyStampAndSignatureIfAny(pdfBuffer, profile, logoBuffer = null) {
  let buf = pdfBuffer;

  const canStamp = profile?.stamp_enabled === true && profile?.stamp_paid === true;

  console.log("[STAMP CHECK]", {
    stamp_enabled: profile?.stamp_enabled,
    stamp_paid: profile?.stamp_paid,
    stamp_path: profile?.stamp_path || null,
    stamp_position: profile?.stamp_position || null,
    stamp_size: profile?.stamp_size || null,
    canStamp,
  });

  if (canStamp && kadiStamp?.applyStampToPdfBuffer) {
    try {
      console.log("[STAMP] applying...");
      buf = await kadiStamp.applyStampToPdfBuffer(buf, profile, {
        pages: "last",
        logoBuffer: Buffer.isBuffer(logoBuffer) ? logoBuffer : null,
      });
      console.log("[STAMP] applied successfully");
    } catch (e) {
      console.warn("[STAMP ERROR]", e?.message);
      logger.warn("stamp", e.message);
    }
  } else {
    console.log("[STAMP] skipped");
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

function parseNumberSmart(input) {
  let t = String(input || "").toLowerCase().trim();
  if (!t) return null;

  // normalisation légère
  t = t.replace(/\s+/g, " ");

  // 1) formats type 25mil / 25 mille / 25k
  if (
    /\b(k|mil|mille)\b/.test(t) ||
    /(\d)(k|mil|mille)\b/.test(t)
  ) {
    const raw = t.replace(/\s+/g, "").replace(/mille/g, "k").replace(/mil/g, "k");
    const numPart = raw.replace(/k/g, "").replace(/,/g, "."); // 25,5k => 25.5
    const n = Number(numPart);
    return Number.isFinite(n) ? Math.round(n * 1000) : null;
  }

  // 2) formats type 1 million / 1.5 million / 2millions
  if (
    /\bmillion(s)?\b/.test(t) ||
    /(\d)million(s)?\b/.test(t)
  ) {
    const raw = t.replace(/\s+/g, "").replace(/millions/g, "million");
    const numPart = raw.replace(/million/g, "").replace(/,/g, ".");
    const n = Number(numPart);
    return Number.isFinite(n) ? Math.round(n * 1000000) : null;
  }

  // 3) si espace + point + virgule ensemble, on suppose séparateurs de milliers
  // ex: 25 000 / 25.000 / 25,000 => 25000
  if (/^\d{1,3}([ .,]\d{3})+$/.test(t)) {
    const normalized = t.replace(/[ .,]/g, "");
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
  }

  // 4) nombre "standard"
  // - virgule seule => décimale (25,5)
  // - point seul => décimale (25.5)
  const compact = t.replace(/\s/g, "");
  const cleaned = compact.replace(/,/g, ".");
  const n = Number(cleaned);

  return Number.isFinite(n) ? n : null;
}

function sanitizeOcrLabel(line) {
  return String(line || "")
    .replace(/\d+(?:[.,]\d+)?/g, " ")
    .replace(/[|=;:_'"`’“”«»#*.,()[\]{}<>/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeItemLineText(input) {
  let t = String(input || "").trim();
  if (!t) return "";

  t = t
    .replace(/[–—]/g, "-")
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  return t;
}

function isProbablyTotalLine(input) {
  const t = String(input || "").toLowerCase().trim();
  if (!t) return true;

  return [
    "total",
    "total general",
    "total général",
    "total materiel",
    "total matériel",
    "prix total",
    "sous total",
    "montant total",
    "reste",
  ].some((x) => t.includes(x));
}

function cleanupItemLabel(label) {
  let t = String(label || "").trim();
  if (!t) return "";

  // enlever séparateurs isolés
  t = t
    .replace(/[:=]\s*$/g, "")
    .replace(/^\s*[-•*]+\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // ne pas casser les dimensions/type 40x40, 2x4, 1.5, 32A, 5mm...
  return t;
}

function computeAmountSafe(qty, unitPrice, amount) {
  const q = Number(qty);
  const pu = Number(unitPrice);
  const mt = Number(amount);

  if (Number.isFinite(mt) && mt > 0) return mt;
  if (Number.isFinite(q) && q > 0 && Number.isFinite(pu) && pu >= 0) return q * pu;
  if (Number.isFinite(pu) && pu >= 0) return pu;

  return 0;
}

function parseQtyToken(token) {
  const t = String(token || "").trim().toLowerCase();
  if (!t) return null;

  // x5 / 5x / x 5 / 5
  let m =
    t.match(/^x\s*(\d+(?:[.,]\d+)?)$/i) ||
    t.match(/^(\d+(?:[.,]\d+)?)\s*x$/i) ||
    t.match(/^(\d+(?:[.,]\d+)?)$/i);

  if (!m) return null;

  const n = Number(String(m[1]).replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseLineNumbersOrdered(input) {
  const t = String(input || "");
  const matches = t.match(/\d+(?:[.,]\d+)?(?:\s*(?:k|mil|mille|million|millions))?/gi) || [];

  return matches
    .map((raw) => ({
      raw,
      value: parseNumberSmart(raw),
    }))
    .filter((x) => Number.isFinite(x.value));
}

function makeParsedItem({
  raw,
  label,
  qty = 1,
  unitPrice = 0,
  amount = null,
  confidence = 0.5,
}) {
  const cleanLabel = cleanupItemLabel(label || "");
  const q = Number.isFinite(Number(qty)) && Number(qty) > 0 ? Number(qty) : 1;
  const pu = Number.isFinite(Number(unitPrice)) && Number(unitPrice) >= 0 ? Number(unitPrice) : 0;
  const amt = computeAmountSafe(q, pu, amount);

  return {
    raw: String(raw || "").trim(),
    label: cleanLabel || "Produit",
    qty: q,
    unitPrice: pu,
    amount: amt,
    confidence,
  };
}

function parseItemLineSmart(input) {
  const raw = normalizeItemLineText(input);
  if (!raw) return null;
  if (isProbablyTotalLine(raw)) return null;

  const lower = raw.toLowerCase();

  // ===============================
  // CAS 1 : label:prixxqty=total
  // Ex: Fil1.5:9000x5=45000
  // ===============================
  let m = raw.match(/^(.+?)\s*[:]\s*([0-9][0-9\s.,kKmMiIlL]*)\s*x\s*([0-9]+(?:[.,]\d+)?)\s*=\s*([0-9][0-9\s.,kKmMiIlL]*)$/i);
  if (m) {
    const label = cleanupItemLabel(m[1]);
    const unitPrice = parseNumberSmart(m[2]);
    const qty = parseQtyToken(m[3]);
    const amount = parseNumberSmart(m[4]);

    if (label && unitPrice != null && qty != null) {
      return makeParsedItem({
        raw,
        label,
        qty,
        unitPrice,
        amount,
        confidence: 0.97,
      });
    }
  }

  // ===============================
  // CAS 2 : label:prixxqty
  // Ex: Fil1.5:9000x5
  // ===============================
  m = raw.match(/^(.+?)\s*[:]\s*([0-9][0-9\s.,kKmMiIlL]*)\s*x\s*([0-9]+(?:[.,]\d+)?)$/i);
  if (m) {
    const label = cleanupItemLabel(m[1]);
    const unitPrice = parseNumberSmart(m[2]);
    const qty = parseQtyToken(m[3]);

    if (label && unitPrice != null && qty != null) {
      return makeParsedItem({
        raw,
        label,
        qty,
        unitPrice,
        confidence: 0.94,
      });
    }
  }

  // ===============================
  // CAS 3 : label qty x prix = total
  // Ex: Câble 2x4 25x1000=25000
  // ===============================
  m = raw.match(/^(.+?)\s+([0-9]+(?:[.,]\d+)?)\s*x\s*([0-9][0-9\s.,kKmMiIlL]*)\s*=\s*([0-9][0-9\s.,kKmMiIlL]*)$/i);
  if (m) {
    const label = cleanupItemLabel(m[1]);
    const qty = parseQtyToken(m[2]);
    const unitPrice = parseNumberSmart(m[3]);
    const amount = parseNumberSmart(m[4]);

    if (label && qty != null && unitPrice != null) {
      return makeParsedItem({
        raw,
        label,
        qty,
        unitPrice,
        amount,
        confidence: 0.9,
      });
    }
  }

  // ===============================
  // CAS 4 : "label ... qty unité ... prix"
  // Ex: Ciment 2 tonnes 115000
  // Ex: barres de fer 12 3500
  // ===============================
  const unitsPattern =
    "(sac|sacs|barre|barres|tonne|tonnes|voyage|voyages|bidon|bidons|carton|cartons|kg|kilo|kilos|litre|litres|planche|planches|tôle|tôles|tube|tubes|rouleau|rouleaux|paquet|paquets|porte|portes|fenêtre|fenêtres)";
  m = raw.match(
    new RegExp(`^(.+?)\\s+(\\d+(?:[.,]\\d+)?)\\s+${unitsPattern}\\s+([0-9][0-9\\s.,kKmMiIlL]*)$`, "i")
  );
  if (m) {
    const labelLeft = cleanupItemLabel(m[1]);
    const qty = parseQtyToken(m[2]);
    const unitWord = cleanupItemLabel(m[3]);
    const unitPrice = parseNumberSmart(m[4]);

    if (qty != null && unitPrice != null) {
      const label = cleanupItemLabel(`${labelLeft} ${unitWord}`);
      return makeParsedItem({
        raw,
        label,
        qty,
        unitPrice,
        confidence: 0.86,
      });
    }
  }

  // ===============================
  // CAS 5 : "label qty prix"
  // Ex: planches 5 8500
  // Ex: tôles 10 3500
  // ===============================
  m = raw.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)\s+([0-9][0-9\s.,kKmMiIlL]*)$/i);
  if (m) {
    const label = cleanupItemLabel(m[1]);
    const qty = parseQtyToken(m[2]);
    const unitPrice = parseNumberSmart(m[3]);

    if (label && qty != null && unitPrice != null) {
      return makeParsedItem({
        raw,
        label,
        qty,
        unitPrice,
        confidence: 0.82,
      });
    }
  }

  // ===============================
  // CAS 6 : "label : prix"
  // Ex: Coffre 08module:3500
  // Ex: Contact étanche :1500
  // ===============================
  m = raw.match(/^(.+?)\s*[:]\s*([0-9][0-9\s.,kKmMiIlL]*)$/i);
  if (m) {
    const label = cleanupItemLabel(m[1]);
    const unitPrice = parseNumberSmart(m[2]);

    if (label && unitPrice != null) {
      return makeParsedItem({
        raw,
        label,
        qty: 1,
        unitPrice,
        confidence: 0.8,
      });
    }
  }

  // ===============================
  // CAS 7 : label avec 2 nombres ou plus
  // Ex: Tube rectangulaire 40/8 4 barres 1 barre: 8000
  // On garde tout avant le dernier nombre comme label
  // ===============================
  const nums = parseLineNumbersOrdered(raw);
  if (nums.length >= 1) {
    const lastRaw = nums[nums.length - 1].raw;
    const lastValue = nums[nums.length - 1].value;

    const idx = lower.lastIndexOf(String(lastRaw).toLowerCase());
    if (idx > 0 && lastValue != null) {
      const before = cleanupItemLabel(raw.slice(0, idx));
      if (before && before.length >= 3) {
        // essayer de récupérer une quantité avant le dernier prix
        const qtyMatch =
          before.match(/\b(\d+(?:[.,]\d+)?)\s*(?:barre|barres|sac|sacs|bidon|bidons|tonne|tonnes|voyage|voyages)\b/i) ||
          before.match(/\b(\d+(?:[.,]\d+)?)\b(?!.*\b\d+(?:[.,]\d+)?\b)/i);

        let qty = 1;
        if (qtyMatch) {
          const maybeQty = parseQtyToken(qtyMatch[1]);
          if (maybeQty != null && maybeQty <= 1000) qty = maybeQty;
        }

        return makeParsedItem({
          raw,
          label: before,
          qty,
          unitPrice: lastValue,
          confidence: 0.68,
        });
      }
    }
  }

  // ===============================
  // CAS 8 : fallback texte brut + un prix
  // Ex: Ajout de tôle 6000
  // ===============================
  m = raw.match(/^(.+?)\s+([0-9][0-9\s.,kKmMiIlL]*)$/i);
  if (m) {
    const label = cleanupItemLabel(m[1]);
    const unitPrice = parseNumberSmart(m[2]);

    if (label && unitPrice != null) {
      return makeParsedItem({
        raw,
        label,
        qty: 1,
        unitPrice,
        confidence: 0.62,
      });
    }
  }

  return null;
}

function splitCandidateItemLines(input) {
  const text = String(input || "").trim();
  if (!text) return [];

  return text
    .split(/\r?\n+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((line) => line.length >= 2);
}

function parseItemsBlockSmart(input) {
  const lines = splitCandidateItemLines(input);
  const items = [];
  const ignored = [];

  for (const line of lines) {
    const parsed = parseItemLineSmart(line);
    if (parsed) {
      items.push(parsed);
    } else {
      ignored.push(line);
    }
  }

  return { items, ignored };
}

function extractBlockTotals(input) {
  const lines = splitCandidateItemLines(input);

  let materialTotal = null;
  let grandTotal = null;

  for (const line of lines) {
    const t = String(line || "").toLowerCase().trim();

    if (t.includes("total matériel") || t.includes("total materiel")) {
      const nums = parseLineNumbersOrdered(line);
      if (nums.length) materialTotal = nums[nums.length - 1].value;
    }

    if (t.includes("total général") || t.includes("total general")) {
      const nums = parseLineNumbersOrdered(line);
      if (nums.length) grandTotal = nums[nums.length - 1].value;
    }
  }

  return {
    materialTotal,
    grandTotal,
  };
}

function buildTotalsCheckMessage({ computedTotal, materialTotal, grandTotal }) {
  const computed = Number(computedTotal || 0);
  const material = Number(materialTotal || 0);
  const grand = Number(grandTotal || 0);

  const lines = [];

  lines.push("📊 Vérification des totaux :");
  lines.push(`• Total calculé : ${money(computed)} FCFA`);

  if (material > 0) {
    lines.push(`• Total matériel détecté : ${money(material)} FCFA`);
  }

  if (grand > 0) {
    lines.push(`• Total général détecté : ${money(grand)} FCFA`);
  }

  let warning = false;

  if (grand > 0 && grand !== computed) {
    warning = true;
  } else if (grand <= 0 && material > 0 && material !== computed) {
    warning = true;
  }

  if (warning) {
    lines.push("");
    lines.push("⚠️ Les totaux ne correspondent pas.");
    lines.push("👉 Certaines lignes n’ont peut-être pas été prises en compte.");
    lines.push("✔️ Vérifiez avant de générer le PDF.");
  } else {
    lines.push("");
    lines.push("✅ Les totaux semblent cohérents.");
  }

  return {
    text: lines.join("\n"),
    warning,
  };
}

function buildSmartMismatchMessage({ gapInfo, hint }) {
  const { computed, material, grand, gap, severity, hasMismatch } = gapInfo;

  if (!hasMismatch) {
    return {
      text:
        `✅ Vérification terminée.\n\n` +
        `Le total semble cohérent avec les lignes reconnues.`,
      warning: false,
    };
  }

  const lines = [
    "📊 Petite vérification :",
    `• Total reconnu par KADI : ${money(computed)} FCFA`,
  ];

  if (material > 0) {
    lines.push(`• Total matériel indiqué : ${money(material)} FCFA`);
  }

  if (grand > 0) {
    lines.push(`• Total général indiqué : ${money(grand)} FCFA`);
  }

  lines.push("");

  const hintMessages = {
    missing_labor: "👉 Il semble manquer la main d’œuvre ou la pose.",
    missing_material: "👉 Il semble manquer du matériel ou certains produits.",
    missing_transport: "👉 Il semble manquer le transport ou certains frais.",
    check_quantity: "👉 Vérifiez les quantités ou les prix des articles.",
    missing_fee: "👉 Vérifiez si des frais ou une prestation ont été oubliés.",
    unknown: "👉 Il manque peut-être une ligne ou un montant.",
  };

  const hintText = hintMessages[hint] || hintMessages.unknown;

  if (severity === "high") {
    lines.push("⚠️ Écart important détecté.");
    lines.push(`👉 Différence estimée : ${money(gap)} FCFA.`);
  } else {
    lines.push("⚠️ Petite différence détectée.");
  }

  lines.push(hintText);
  lines.push("");
  lines.push("💡 Vous pouvez compléter ou corriger les éléments pour ajuster le total.");

  return {
    text: lines.join("\n"),
    warning: true,
  };
}

async function tryHandleNaturalMessage(from, text) {
  const s = getSession(from);
  const parsed = parseNaturalWhatsAppMessage(text);

  if (!parsed) {
    await logLearningEvent({
      waId: from,
      rawText: text,
      parseSuccess: false,
      failureReason: "natural_not_understood",
      itemsCount: 0,
    });
    return false;
  }

  // Si aucun draft actif, il faut soit créer un draft,
  // soit demander le type si non détecté.
  if (!s.lastDocDraft) {
    const detectedType = parsed.docType;

    if (!detectedType) {
      s.pendingSmartBlockText = String(text || "").trim();

      await sendButtons(
        from,
        "🧠 J’ai reconnu un message naturel.\n\nQuel document voulez-vous créer ?",
        [
          { id: "SMARTBLOCK_DEVIS", title: "Devis" },
          { id: "SMARTBLOCK_FACTURE", title: "Facture" },
          { id: "SMARTBLOCK_RECU", title: "Reçu" },
        ]
      );

      return true;
    }

    if (detectedType === "decharge") {
      s.lastDocDraft = initDechargeDraft({
        dateISO: formatDateISO(),
        makeDraftMeta,
      });
      s.lastDocDraft.type = "decharge";
      s.lastDocDraft.source = "natural_text";
    } else {
      s.lastDocDraft = {
        type: detectedType,
        factureKind: detectedType === "facture" ? "definitive" : null,
        docNumber: null,
        date: formatDateISO(),
        client: null,
        motif: null,
        items: [],
        finance: null,
        source: "natural_text",
        meta: makeDraftMeta(),
      };
    }
  }

  const draft = s.lastDocDraft;

  if (parsed.kind === "simple_payment") {
    draft.type = parsed.docType || draft.type || "recu";

    if (parsed.client && !draft.client) {
      draft.client = parsed.client.slice(0, LIMITS.maxClientNameLength);
    }

    if (parsed.motif && !draft.motif) {
      draft.motif = parsed.motif.slice(0, LIMITS.maxItemLabelLength);
    }

    if (draft.type === "decharge") {
      draft.dechargeType = detectDechargeType(draft.motif || parsed.motif || "");
    }

    draft.items = [
      makeItem(parsed.motif || "Paiement", 1, parsed.total || 0),
    ];
    draft.finance = computeFinance(draft);

    if (!safe(draft.client)) {
      await logLearningEvent({
        waId: from,
        rawText: text,
        parseSuccess: true,
        failureReason: "client_missing",
        itemsCount: 1,
      });

      s.step = "missing_client_pdf";
      await sendText(from, "👤 Quel est le nom du client ?");
      return true;
    }

    s.step = "doc_review";

    const preview =
      draft.type === "decharge"
        ? buildDechargePreviewMessage({ doc: draft, money })
        : buildPreviewMessage({ doc: draft });

    await sendText(from, preview);

    const cost = computeBasePdfCost(draft);
    await sendText(from, formatBaseCostLine(cost));

    await sendPreviewMenu(from);
    return true;
  }

  // 🔥 NOUVEAU : INTENT ONLY
  if (parsed.kind === "intent_only") {
    if (draft.type === "decharge") {
      if (parsed.client && !draft.client) {
        draft.client = parsed.client.slice(0, LIMITS.maxClientNameLength);
      }

      if (parsed.motif && !draft.motif) {
        draft.motif = parsed.motif.slice(0, LIMITS.maxItemLabelLength);
        draft.dechargeType = detectDechargeType(draft.motif);
      }

      if (!safe(draft.client)) {
        s.step = "decharge_client";
        await sendText(from, "👤 Quel est le nom de la personne concernée ?");
        return true;
      }

      if (!safe(draft.motif)) {
        s.step = "decharge_motif";
        await sendText(from, "📝 Quel est le motif de la décharge ?");
        return true;
      }

      s.step = "decharge_amount";
      await sendText(from, "💰 Quel est le montant ?\nSi pas de montant, tapez *0*.");
      return true;
    }

    if (parsed.client && !draft.client) {
      draft.client = parsed.client.slice(0, LIMITS.maxClientNameLength);
    }

    if (parsed.motif && !draft.motif) {
      draft.motif = parsed.motif.slice(0, LIMITS.maxItemLabelLength);
    }

    if (!safe(draft.client)) {
      s.step = "doc_client";
      await sendText(from, "👤 Quel est le nom du client ?");
      return true;
    }

    await sendText(
      from,
      `✅ ${String(draft.type || "").toUpperCase()} en cours\n` +
        `👤 Client : ${draft.client}\n` +
        (draft.motif ? `📝 Motif : ${draft.motif}\n` : "") +
        `\nAjoutez les éléments ou les prix 👇`
    );

    await askItemLabel(from);
    return true;
  }

  if (parsed.kind === "items") {
    if (parsed.client && !draft.client) {
      draft.client = parsed.client.slice(0, LIMITS.maxClientNameLength);
    }

    draft.items = parsed.items.map((it) =>
      makeItem(it.label, it.qty, it.unitPrice)
    );
    draft.finance = computeFinance(draft);

    const analysis = analyzeSmartBlock({
      items: draft.items,
      computedTotal: draft.finance?.gross || 0,
    });

    draft.meta = makeDraftMeta({
      ...(draft.meta || {}),
      businessType: analysis.businessType,
      totalsGap: analysis.gapInfo.gap,
      totalsGapSeverity: analysis.gapInfo.severity,
      missingHint: analysis.hint,
    });

    if (!safe(draft.client)) {
      await logLearningEvent({
        waId: from,
        rawText: text,
        parseSuccess: true,
        failureReason: "client_missing",
        itemsCount: draft.items.length || 0,
      });

      s.step = "missing_client_pdf";
      await sendText(from, "👤 Quel est le nom du client ?");
      return true;
    }

    const smartMessage = buildSmartMismatchMessage({
      gapInfo: analysis.gapInfo,
      hint: analysis.hint,
    });

    if (smartMessage.warning) {
      await sendText(from, smartMessage.text);

      await sendButtons(from, "Choisissez une action :", [
        { id: "SMARTBLOCK_FIX", title: "Corriger" },
        { id: "SMARTBLOCK_CONTINUE", title: "Continuer" },
      ]);

      s.step = "smartblock_warning";
      return true;
    }

    s.step = "doc_review";

    const preview = buildPreviewMessage({ doc: draft });
    await sendText(from, preview);

    const cost = computeBasePdfCost(draft);
    await sendText(from, formatBaseCostLine(cost));

    await sendPreviewMenu(from);
    return true;
  }

  await logLearningEvent({
    waId: from,
    rawText: text,
    parseSuccess: false,
    failureReason: "natural_not_understood",
    itemsCount: 0,
  });

  return false;
}

async function tryHandleDechargeConfirmation(from, text) {
  if (String(text || "").trim().toLowerCase() !== "confirmer") return false;

  await sendText(
    from,
    "✅ Votre confirmation a été reçue.\nSi une décharge KADI vous a été envoyée, elle peut maintenant être finalisée."
  );

  const p = await getOrCreateProfile(from);
  const isFirstTime = !p?.onboarding_done;
  const kadiWaLink = `https://wa.me/${process.env.KADI_E164 || "22679239027"}`;

  const followup = buildPostConfirmationMessage({
    isFirstTime,
    kadiWaLink,
  });

  await sendText(from, followup);
  return true;
}

async function handleSmartItemsBlockText(from, text) {
  const s = getSession(from);
  const draft = s.lastDocDraft;

  const raw = String(text || "").trim();

  // 1) Garde-fous
  if (!raw || !/\r?\n/.test(raw)) return false;
  if (s.step === "profile" || s.step === "stamp_title") return false;

  // 2) Parsing du bloc
const { items, ignored } = parseItemsBlockSmart(raw);
if (!Array.isArray(items) || items.length < 2) {
  await logLearningEvent({
    waId: from,
    rawText: raw,
    parseSuccess: false,
    failureReason: "no_items_detected",
    itemsCount: items?.length || 0,
  });
  return false;
}

  // 3) Aucun draft actif → demander le type de document
  if (!draft) {
    return askDocTypeForSmartBlock(from, raw);
  }

  // 4) Construire les lignes du draft
  const parsedItems = items.map((it) => makeItem(it.label, it.qty, it.unitPrice));
  draft.items = parsedItems;
  draft.finance = computeFinance(draft);

  // 5) Totaux détectés dans le texte
  const totalsDetected = extractBlockTotals(raw);
  const computedTotal = Number(draft.finance?.gross || 0);

  // 6) Analyse smart centralisée
  const analysis = analyzeSmartBlock({
    items: draft.items,
    computedTotal,
    materialTotal: totalsDetected.materialTotal,
    grandTotal: totalsDetected.grandTotal,
  });

  // 7) Sauvegarde des métadonnées utiles
  draft.meta = makeDraftMeta({
    ...(draft.meta || {}),
    businessType: analysis.businessType,
    detectedMaterialTotal: totalsDetected.materialTotal,
    detectedGrandTotal: totalsDetected.grandTotal,
    computedTotalFromParsedItems: computedTotal,
    totalsGap: analysis.gapInfo.gap,
    totalsGapSeverity: analysis.gapInfo.severity,
    missingHint: analysis.hint,
  });

  // 8) Si client manquant, le demander avant d’aller plus loin
  if (!safe(draft.client)) {
    s.step = "missing_client_pdf";
    await sendText(
      from,
      `✅ ${items.length} ligne(s) détectée(s).\n👤 Maintenant, tapez le nom du client :`
    );
    return true;
  }

  // 9) Construire le message intelligent
  const smartMessage = buildSmartMismatchMessage({
    businessType: analysis.businessType,
    gapInfo: analysis.gapInfo,
    hint: analysis.hint,
  });

  // 10) Si incohérence détectée → proposer correction ou continuation
  if (smartMessage.warning) {
    await sendText(from, smartMessage.text);

    await sendButtons(from, "Choisissez une action :", [
      { id: "SMARTBLOCK_FIX", title: "Corriger" },
      { id: "SMARTBLOCK_CONTINUE", title: "Continuer" },
    ]);

    s.step = "smartblock_warning";
    return true;
  }

  // 11) Sinon → aperçu normal
  s.step = "doc_review";

  const preview = buildPreviewMessage({ doc: draft });
  await sendText(from, preview);

  const cost = computeBasePdfCost(draft);
  await sendText(from, formatBaseCostLine(cost));

  if (ignored.length > 0) {
    await sendText(
      from,
      `ℹ️ ${ignored.length} ligne(s) non reconnue(s) ont été ignorée(s).`
    );
  }

  await sendPreviewMenu(from);
  return true;
}

async function askDocTypeForSmartBlock(from, text) {
  const s = getSession(from);
  const { items } = parseItemsBlockSmart(text);

  if (!items || items.length < 2) return false;

  s.pendingSmartBlockText = String(text || "").trim();

  await sendButtons(
    from,
    `🧠 J’ai détecté ${items.length} ligne(s) de produits.\n\nQuel document voulez-vous créer ?`,
    [
      { id: "SMARTBLOCK_DEVIS", title: "Devis" },
      { id: "SMARTBLOCK_FACTURE", title: "Facture" },
      { id: "SMARTBLOCK_RECU", title: "Reçu" },
    ]
  );

  return true;
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

function getRechargeOffers() {
  return {
    PACK_1000: {
      id: "PACK_1000",
      amountFcfa: 1000,
      credits: 10,
      label: "Pack 1000F",
      bonusText: null,
      includesStamp: false,
    },
    PACK_2000: {
      id: "PACK_2000",
      amountFcfa: 2000,
      credits: 25,
      label: "Pack 2000F",
      bonusText: "⭐ Recommandé",
      includesStamp: false,
    },
    PACK_5000: {
      id: "PACK_5000",
      amountFcfa: 5000,
      credits: 50,
      label: "Pack 5000F",
      bonusText: "🎁 Tampon PRO offert",
      includesStamp: true,
    },
  };
}

function getRechargeOfferById(replyId) {
  return getRechargeOffers()[replyId] || null;
}

async function sendRechargePacksMenu(to) {
  return sendButtons(to, "💰 Choisissez un pack KADI :", [
    { id: "PACK_1000", title: "Pack 1000F" },
    { id: "PACK_2000", title: "Pack 2000F" },
    { id: "PACK_5000", title: "Pack 5000F" },
  ]);
}

async function sendRechargePaymentMenu(to, offer) {
  if (!offer) {
    await sendText(to, "❌ Offre introuvable.");
    return sendRechargePacksMenu(to);
  }

  const lines = [
    `💳 *${offer.label}*`,
    ``,
    `• ${offer.credits} crédits`,
  ];

  if (offer.includesStamp) {
    lines.push(`• Tampon professionnel OFFERT 🎁`);
  }

  if (offer.bonusText) {
    lines.push(`• ${offer.bonusText}`);
  }

  lines.push("", "Choisissez un mode :", "");

  await sendButtons(to, lines.join("\n"), [
    { id: `PAY_MM_${offer.amountFcfa}`, title: "Mobile Money" },
    { id: `PAY_CODE_${offer.amountFcfa}`, title: "Code recharge" },
    { id: "CREDITS_RECHARGE", title: "Retour" },
  ]);
}

async function sendCreditsMenu(to) {
  return sendButtons(to, "💳 Crédits KADI", [
    { id: "CREDITS_SOLDE", title: "Voir solde" },
    { id: "CREDITS_RECHARGE", title: "Acheter pack" },
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
    { id: "DOC_CONFIRM", title: "✅ Continuer" },
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
    { id: "BACK_HOME", title: "Menu" },
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
  const balRes = await getBalance(from);
  const bal = balRes?.balance || 0;

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
  s.step = "recharge_pack_menu";
  s.pendingRechargePack = null;
  s.pendingRechargeAmount = null;

  await sendText(
    from,
    "💰 *Packs disponibles*\n\n" +
      "🟢 1000F → 10 crédits\n" +
      "🟡 2000F → 25 crédits ⭐ recommandé\n" +
      "💎 5000F → 50 crédits + tampon PRO OFFERT 🎁"
  );

  return sendRechargePacksMenu(from);
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
  s.adminPendingAction = null;
  s.broadcastCaption = null;
}

async function sendReceiptFormatMenu(to) {
  const text =
    "🧾 *Reçu*\n\n" +
    "Quel format voulez-vous ?\n\n" +
    "• 🧾 Ticket → petit format, facile à envoyer\n" +
    "• 📄 A4 → format professionnel complet";

  await sendButtons(to, text, [
    { id: "RECEIPT_FORMAT_COMPACT", title: "🧾 Ticket" },
    { id: "RECEIPT_FORMAT_A4", title: "📄 A4" },
    { id: "BACK_DOCS", title: "🔙 Retour" },
  ]);
}

async function startDocFlow(from, mode, factureKind = null) {
  const s = getSession(from);

  s.mode = mode;
  s.factureKind = factureKind;

  const modeNorm = String(mode || "").toLowerCase();

  if (modeNorm === "decharge") {
    s.lastDocDraft = initDechargeDraft({
      dateISO: formatDateISO(),
      makeDraftMeta,
    });

    s.step = "decharge_client";

    await sendText(
      from,
      `📄 Décharge\n\n👤 *Nom de la personne concernée ?*\n(Ex: Mr Ouedraogo / Awa / Société X)`
    );
    return;
  }

  s.lastDocDraft = {
    type: mode,
    factureKind,
    docNumber: null,
    date: formatDateISO(),
    client: null,
    items: [],
    finance: null,
    source: "product",
    meta: makeDraftMeta(),
  };

  const title =
    modeNorm === "facture"
      ? factureKind === "proforma"
        ? "🧾 Facture Pro forma"
        : "🧾 Facture Définitive"
      : modeNorm === "devis"
      ? "📝 Devis"
      : "🧾 Reçu";

  // Cas spécial : reçu → demander le format avec boutons
  if (modeNorm === "reçu" || modeNorm === "recu") {
    s.step = "receipt_format";
    return sendReceiptFormatMenu(from);
  }

  s.step = "doc_client";

  await sendText(
    from,
    `${title}\n\n👤 *Nom du client ?*\n(Ex: Awa / Ben / Société X)`
  );
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

function normalizeReceiptFormat(text) {
  const t = String(text || "").trim().toLowerCase();

  if (["1", "rapide", "compact", "whatsapp", "wa"].includes(t)) return "compact";
  if (["2", "pro", "a4", "professionnel", "professionnelle"].includes(t)) return "a4";

  return null;
}
async function handleStampFlow(from, text) {
  const s = getSession(from);
  if (!s) return false;

  const t = String(text || "").trim();
  if (!t) return false;

  // 🔥 accepte plusieurs noms de step (safe)
  if (
    s.step === "stamp_title" ||
    s.step === "stamp_function" ||
    s.step === "stamp_role"
  ) {
    const value = t === "0" ? "" : t.slice(0, 40);

    await updateProfile(from, {
      stamp_title: value || null,
    });

    s.step = null;

    await sendText(
      from,
      value
        ? `✅ Fonction enregistrée : *${value}*`
        : "✅ Fonction du tampon effacée."
    );

    await sendStampMenu(from);
    return true;
  }

  return false;
}

async function handleProductFlowText(from, text) {
  const s = getSession(from);
  if (!s.lastDocDraft) return false;

  const t = norm(text);
  if (!t) return false;

  // ===============================
  // Client manquant avant aperçu PDF
  // ===============================
  if (s.step === "missing_client_pdf") {
    s.lastDocDraft.client = t.slice(0, LIMITS.maxClientNameLength);

    const draft = s.lastDocDraft;

    // Cas spécial : document issu d’un bloc intelligent
    if (draft?.source === "smart_block") {
      const analysis = analyzeSmartBlock({
        items: draft.items || [],
        computedTotal: draft?.finance?.gross || 0,
        materialTotal: draft?.meta?.detectedMaterialTotal,
        grandTotal: draft?.meta?.detectedGrandTotal,
      });

      draft.meta = makeDraftMeta({
        ...(draft.meta || {}),
        businessType: analysis.businessType,
        totalsGap: analysis.gapInfo.gap,
        totalsGapSeverity: analysis.gapInfo.severity,
        missingHint: analysis.hint,
      });

      const smartMessage = buildSmartMismatchMessage({
        businessType: analysis.businessType,
        gapInfo: analysis.gapInfo,
        hint: analysis.hint,
      });

      if (smartMessage.warning) {
        await sendText(from, smartMessage.text);

        await sendButtons(from, "Que voulez-vous faire ?", [
          { id: "SMARTBLOCK_FIX", title: "Corriger" },
          { id: "SMARTBLOCK_CONTINUE", title: "Continuer" },
        ]);

        s.step = "smartblock_warning";
        return true;
      }
    }

    // Flow normal vers aperçu
    s.step = "doc_review";

    const preview = buildPreviewMessage({ doc: s.lastDocDraft });
    await sendText(from, preview);

    const cost = computeBasePdfCost(s.lastDocDraft);
    await sendText(from, formatBaseCostLine(cost));

    await sendPreviewMenu(from);
    return true;
  }

  // ===============================
  // Choix du format de reçu
  // ===============================
  if (s.step === "receipt_format") {
    const format = normalizeReceiptFormat(t);

    if (!format) {
      await sendText(
        from,
        "Répondez simplement :\n• RAPIDE → version WhatsApp\n• PRO → version A4"
      );
      return true;
    }

    s.lastDocDraft = s.lastDocDraft || {};
    s.lastDocDraft.receiptFormat = format;

    s.step = "doc_client";

    await sendText(
      from,
      format === "compact"
        ? "✅ Reçu rapide sélectionné.\n\n👤 Quel est le nom du client ?"
        : "✅ Reçu professionnel A4 sélectionné.\n\n👤 Quel est le nom du client ?"
    );
    return true;
  }

  // ===============================
  // Flow décharge séparé
  // ===============================
  if (s.step === "decharge_client") {
    s.lastDocDraft.client = t.slice(0, LIMITS.maxClientNameLength);
    s.step = "decharge_motif";
    await sendText(from, "📝 Quel est le motif de la décharge ?");
    return true;
  }

  if (s.step === "decharge_motif") {
    s.lastDocDraft.motif = t.slice(0, LIMITS.maxItemLabelLength);
    s.lastDocDraft.dechargeType = detectDechargeType(t);
    s.step = "decharge_amount";
    await sendText(
      from,
      "💰 Quel est le montant ?\nSi pas de montant, tapez *0*."
    );
    return true;
  }

  if (s.step === "decharge_amount") {
    const isZero = t === "0";
    const n = isZero ? 0 : parseNumberSmart(t);

    if (!isZero && (n == null || n < 0)) {
      await sendText(from, "❌ Montant invalide. Réessayez (ex: 100000) ou tapez 0.");
      return true;
    }

    const amount = isZero ? 0 : n;

    s.lastDocDraft.items = [
      makeItem(s.lastDocDraft.motif || "Décharge", 1, amount),
    ];
    s.lastDocDraft.finance = computeFinance(s.lastDocDraft);

    s.step = "decharge_confirm_target";
    await sendText(
      from,
      "📲 Voulez-vous envoyer cette décharge à l’autre partie pour confirmation WhatsApp ?\n\nRépondez par :\n• OUI\n• NON"
    );
    return true;
  }

  if (s.step === "decharge_confirm_target") {
    const answer = t.toLowerCase();

    if (answer === "oui") {
      s.step = "decharge_target_wa";
      await sendText(
        from,
        "📱 Entrez le numéro WhatsApp de l’autre partie au format simple.\nEx: 70112233 ou 22670112233"
      );
      return true;
    }

    if (answer === "non") {
      s.lastDocDraft.confirmation = {
        requested: false,
        targetWaId: null,
        confirmed: false,
        confirmedAt: null,
        confirmedBy: null,
      };

      s.step = "doc_review";

      const preview = buildDechargePreviewMessage({
        doc: s.lastDocDraft,
        money,
      });
      await sendText(from, preview);

      const cost = computeBasePdfCost(s.lastDocDraft);
      await sendText(from, formatBaseCostLine(cost));

      await sendPreviewMenu(from);
      return true;
    }

    await sendText(from, "Répondez seulement par *OUI* ou *NON*.");
    return true;
  }

  if (s.step === "decharge_target_wa") {
    let target = t.replace(/\D/g, "");

    if (target.length === 8) {
      target = `226${target}`;
    }

    if (!isValidWhatsAppId(target)) {
      await sendText(from, "❌ Numéro invalide. Réessayez.");
      return true;
    }

    s.lastDocDraft.confirmation = {
      requested: true,
      targetWaId: target,
      confirmed: false,
      confirmedAt: null,
      confirmedBy: null,
    };

    const preview = buildDechargePreviewMessage({
      doc: s.lastDocDraft,
      money,
    });

    await sendText(from, preview);

    await sendButtons(from, "Valider l’envoi de la demande de confirmation ?", [
      { id: "DECHARGE_SEND_CONFIRMATION", title: "Envoyer" },
      { id: "DOC_CANCEL", title: "Annuler" },
    ]);

    s.step = "decharge_send_confirmation";
    return true;
  }

  // ===============================
  // Flow manuel produit par produit
  // ===============================
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

  // ===============================
  // Tampon
  // ===============================
if (s.step === "stamp_title") {
  const raw = String(text || "").trim();
  const cleaned = raw.replace(/\s+/g, " ");
  const val = cleaned === "0" || !cleaned ? null : cleaned.slice(0, 30);

  await updateProfile(from, { stamp_title: val });

  s.step = null;

  await sendText(
    from,
    val
      ? `✅ Fonction tampon mise à jour : ${val}`
      : "✅ Fonction tampon effacée."
  );

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
  const patterns = [
    /total\s*[:\-]?\s*([0-9\s.,]+)/i,
    /total\s*ttc\s*[:\-]?\s*([0-9\s.,]+)/i,
    /net\s*a\s*payer\s*[:\-]?\s*([0-9\s.,]+)/i,
    /montant\s+total\s*[:\-]?\s*([0-9\s.,]+)/i,
    /a\s+payer\s*[:\-]?\s*([0-9\s.,]+)/i,
  ];

  for (const p of patterns) {
    const m = String(text || "").match(p);
    if (m) {
      const n = parseNumberSmart(m[1]);
      if (n != null) return n;
    }
  }

  return null;
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
      line.match(/^nom\s*[:\-]\s*(.+)$/i);
    if (m) {
      client = (m[1] || "").trim().slice(0, LIMITS.maxClientNameLength);
      break;
    }
  }

  const items = [];

  for (const line of lines) {
    if (!/\d/.test(line)) continue;
    if (/date/i.test(line)) continue;
    if (/total/i.test(line)) continue;
    if (/montant/i.test(line)) continue;
    if (/client/i.test(line)) continue;
    if (/nom/i.test(line)) continue;

    const label = sanitizeOcrLabel(line);
    if (!looksLikeRealItemLabel(label)) continue;

    const nums = line.match(/\d+(?:[.,]\d+)?/g) || [];
    if (!nums.length) continue;

    const candidates = nums
      .map((x) => parseNumberSmart(x))
      .filter((n) => Number.isFinite(n) && n > 0);

    if (!candidates.length) continue;

    const pu = candidates[candidates.length - 1] || 0;
    if (!Number.isFinite(pu) || pu <= 0) continue;

    items.push(makeItem(label, 1, pu));
    if (items.length >= LIMITS.maxItems) break;
  }

  const detected = extractTotalFromOcr(ocrText);
  const calc = computeFinance({ items }).gross;

  return {
    client,
    items,
    finance: {
      subtotal: calc,
      gross: detected ?? calc,
    },
  };
}

async function robustOcr(buffer, mimeType = "image/jpeg", maxRetries = LIMITS.maxOcrRetries) {
  let lastErr = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      let baseText = "";

      try {
        baseText = await ocrImageToText(buffer);
        logger.info("ocr", "Base OCR result", {
          attempt,
          length: String(baseText || "").trim().length,
          preview: String(baseText || "").slice(0, 200),
        });
      } catch (e) {
        lastErr = e;
        baseText = "";
        logger.warn("ocr", "Base OCR failed", {
          attempt,
          message: e?.message,
        });
      }

      if (baseText && String(baseText).trim().length >= 3) {
        if (geminiIsEnabled() && !ocrLooksGood(baseText)) {
          try {
            const gText = await geminiOcrImageBuffer(buffer, mimeType);
            if (gText && String(gText).trim().length >= 3) {
              logger.info("ocr", "Gemini OCR improved result", {
                attempt,
                length: String(gText || "").trim().length,
                preview: String(gText || "").slice(0, 200),
              });
              return gText;
            }
          } catch (ge) {
            logger.warn("ocr", "Gemini OCR fallback failed", {
              attempt,
              message: ge?.message,
            });
          }
        }

        return baseText;
      }

      if (geminiIsEnabled()) {
        try {
          const gText = await geminiOcrImageBuffer(buffer, mimeType);
          if (gText && String(gText).trim().length >= 3) {
            logger.info("ocr", "Gemini OCR accepted", {
              attempt,
              length: String(gText || "").trim().length,
              preview: String(gText || "").slice(0, 200),
            });
            return gText;
          }
        } catch (ge) {
          logger.warn("ocr", "Gemini OCR direct failed", {
            attempt,
            message: ge?.message,
          });
        }
      }

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
  await sendText(from, "🔎 Lecture intelligente de la photo…");

  let ocrText = "";
  try {
    ocrText = await robustOcr(buf, mime);
    logger.info("ocr", "OCR text extracted", {
      from,
      length: String(ocrText || "").trim().length,
      preview: String(ocrText || "").slice(0, 300),
    });
  } catch (e) {
    logger.error("ocr", e, { from, step: "robustOcr" });
    await sendText(from, "❌ Impossible de lire la photo. Essayez une photo plus nette (bonne lumière, sans flou).");
    return;
  }

  if (!ocrText || ocrText.trim().length < 3) {
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
if (!s.lastDocDraft.meta) {
  s.lastDocDraft.meta = makeDraftMeta();
}

  s.step = "ocr_review";

  let parsed = null;

  try {
    const gemParsed = await parseInvoiceTextWithGemini(ocrText);

    parsed = {
      client: gemParsed?.client || null,
      items: Array.isArray(gemParsed?.items)
        ? gemParsed.items.map((it) =>
            makeItem(
              it?.label || "Produit",
              Number(it?.qty || 1),
              Number(it?.unitPrice ?? it?.amount ?? 0)
            )
          )
        : [],
      finance: {
        subtotal: Number(gemParsed?.total || 0),
        gross: Number(gemParsed?.total || 0),
      },
    };

    if (!parsed.items.length) {
      throw new Error("Gemini returned no items");
    }

    const noisyItems = parsed.items.filter(
  (it) => !looksLikeRealItemLabel(it?.label || "")
);

if (noisyItems.length > 0) {
  throw new Error("Gemini returned noisy items");
}

if (parsed.items.length > 10) {
  throw new Error("Gemini returned too many items");
}

    s.lastDocDraft.meta = makeDraftMeta({
  ...(s.lastDocDraft.meta || {}),
  usedGeminiParse: true,
});

logger.info("ocr", "Gemini parsing ok", {
  from,
  client: parsed.client,
  itemsCount: parsed.items.length,
  total: parsed.finance?.gross || 0,
});
  } catch (e) {
    logger.warn("ocr", "Gemini parsing failed, fallback local parser", {
      from,
      message: e?.message,
    });

   s.lastDocDraft.meta = makeDraftMeta({
  ...(s.lastDocDraft.meta || {}),
  usedGeminiParse: false,
});

parsed = parseOcrToDraft(ocrText);
  }

  if (parsed.client) s.lastDocDraft.client = parsed.client;
  if (parsed.items?.length) {
    s.lastDocDraft.items = parsed.items.slice(0, LIMITS.maxItems);
  }

  s.lastDocDraft.finance = parsed.finance || computeFinance(s.lastDocDraft);

  logger.info("ocr", "Draft ready for preview", {
    from,
    client: s.lastDocDraft.client,
    itemsCount: s.lastDocDraft.items.length,
    total: s.lastDocDraft.finance?.gross || 0,
  });

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

    // ===============================
    // 1) Broadcast image classique
    // ===============================
    if (s.adminPendingAction === "broadcast_image") {
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
        audience: "all_known",
      });

      return true;
    }

    // ===============================
    // 2) Broadcast template avec image header
    // ===============================
    if (s.adminPendingAction === "broadcast_template_image") {
      await sendText(from, "🧩 Image reçue. Préparation du template en cours...");

      if (!kadiBroadcast?.broadcastTemplateToAll) {
        resetAdminBroadcastState(s);
        await sendText(from, "⚠️ Module broadcast template absent.");
        return true;
      }

      const { filePath } = await uploadCampaignImageBuffer({
        userId: "admin",
        buffer: buf,
        mimeType: mime,
        filename: `template-${Date.now()}`,
      });

      const headerImageLink = await getSignedCampaignUrl(filePath);

      resetAdminBroadcastState(s);

      await kadiBroadcast.broadcastTemplateToAll({
        adminWaId: from,
        templateName: "kadi_monday_boost",
        language: "fr",
        audience: "all_known",
        headerImageLink,
      });

      return true;
    }

    return false;
  } catch (e) {
    logger.error("admin_broadcast_image", e, { from, action: s.adminPendingAction });
    resetAdminBroadcastState(s);
    await sendText(from, "❌ Erreur lors du traitement de l'image.");
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
async function saveDocumentWithRetry({ waId, draft, maxAttempts = 3 }) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const saved = await saveDocument({ waId, doc: draft });
      return saved;
    } catch (e) {
      const msg = String(e?.message || e || "");
      lastError = e;

      if (!msg.startsWith("DOC_NUMBER_ALREADY_EXISTS")) {
        throw e;
      }

      console.warn(
        `[KADI] doc number collision detected (attempt ${attempt}/${maxAttempts}) for ${draft.docNumber}`
      );

      draft.docNumber = await nextDocNumber({
        waId,
        mode: draft.type,
        factureKind: draft.factureKind,
        dateISO: draft.date,
      });
    }
  }

  throw lastError || new Error("SAVE_DOCUMENT_FAILED_AFTER_RETRY");
}

async function createAndSendPdf(from) {
  const s = getSession(from);
  const draft = s.lastDocDraft;

  console.log("[KADI] createAndSendPdf", {
    type: draft?.type,
    receiptFormat: draft?.receiptFormat,
    docNumber: draft?.docNumber,
    savedDocumentId: draft?.savedDocumentId || null,
    savedPdfMediaId: draft?.savedPdfMediaId || null,
    isGeneratingPdf: !!s.isGeneratingPdf,
    addStampForNextDoc: !!s.addStampForNextDoc,
    stampMode: s.stampMode || null,
  });

  if (!draft) {
    await sendText(from, "❌ Aucun document en cours. Tapez MENU.");
    return;
  }

  if (s.isGeneratingPdf) {
    await sendText(from, "⏳ Génération déjà en cours... veuillez patienter.");
    return;
  }

  if (draft.savedDocumentId || draft.savedPdfMediaId) {
    s.step = "doc_already_generated";
    await sendAlreadyGeneratedMenu(from);
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

  const baseCost = computeBasePdfCost(draft);
  const baseReason =
    draft.source === "ocr"
      ? "ocr_pdf"
      : draft.type === "decharge"
      ? "decharge_pdf"
      : "pdf";

  draft.requestId = draft.requestId || crypto.randomUUID();

  const consumeOperationKey = `pdf:consume:${draft.requestId}`;
  const failedRollbackOperationKey = `pdf:rollback:${draft.requestId}`;

  s.isGeneratingPdf = true;

  let debited = false;
  let successAfterDebit = false;
  let finalBalance = 0;

  try {
    const profile = await getOrCreateProfile(from);

    const usePaidStamp =
      profile?.stamp_enabled === true && profile?.stamp_paid === true;

    const useOneTimeStamp =
      s.addStampForNextDoc === true &&
      s.stampMode === "one_time" &&
      profile?.stamp_paid !== true;

    const stampExtraCost = useOneTimeStamp ? 1 : 0;
    const totalCost = baseCost + stampExtraCost;
    const finalReason = useOneTimeStamp ? `${baseReason}_stamp_once` : baseReason;

    const cons = await consumeCredit(
      { waId: from },
      totalCost,
      finalReason,
      consumeOperationKey,
      {
        requestId: draft.requestId,
        docType: draft.type || null,
        docNumber: draft.docNumber || null,
        factureKind: draft.factureKind || null,
        source: draft.source || null,
        baseCost,
        stampExtraCost,
        usePaidStamp,
        useOneTimeStamp,
      }
    );

    if (!cons.ok) {
      await sendText(
        from,
        `❌ Solde insuffisant.\nVous avez ${cons.balance} crédit(s).\nCe document coûte ${totalCost} crédit(s).\n👉 Tapez RECHARGE.`
      );
      return;
    }

    debited = true;
    finalBalance = cons.balance;

    const computedFinance = computeFinance(draft);
    draft.finance = {
      subtotal: computedFinance.subtotal,
      gross: draft.finance?.gross ?? computedFinance.gross,
    };

    if (!draft.docNumber) {
      draft.docNumber = await nextDocNumber({
        waId: from,
        mode: draft.type,
        factureKind: draft.factureKind,
        dateISO: draft.date,
      });
    }

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
        motif: draft.motif || null,
        dechargeType: draft.dechargeType || null,
        dechargeText:
          draft.type === "decharge"
            ? buildDechargeText({
                client: draft.client,
                businessName: safe(profile?.business_name),
                motif: draft.motif,
                total,
                dechargeType: draft.dechargeType,
              })
            : null,
        items: draft.items || [],
        total,
        receiptFormat: draft.receiptFormat || "a4",
      },
      businessProfile: profile,
      logoBuffer: logoBuf,
    });

    const stampProfile =
      usePaidStamp || useOneTimeStamp
        ? {
            ...profile,
            stamp_enabled: true,
            stamp_paid: true,
          }
        : profile;

    pdfBuf = await applyStampAndSignatureIfAny(pdfBuf, stampProfile, logoBuf);

    draft.meta = makeDraftMeta({
      ...(draft.meta || {}),
      creditsConsumed: totalCost,
      usedStamp: !!(usePaidStamp || useOneTimeStamp),
      usedGeminiParse: !!draft?.meta?.usedGeminiParse,
      businessSector: draft?.meta?.businessSector || null,
      requestId: draft.requestId,
      stampMode: usePaidStamp ? "unlimited" : useOneTimeStamp ? "one_time" : "none",
    });

    draft.status = "generated";

    const fileName = `${draft.docNumber}-${formatDateISO()}.pdf`;
    const up = await uploadMediaBuffer({
      buffer: pdfBuf,
      filename: fileName,
      mimeType: "application/pdf",
    });

    if (!up?.id) {
      throw new Error("Upload PDF échoué");
    }

    const saved = await saveDocumentWithRetry({
      waId: from,
      draft,
      maxAttempts: 3,
    });

    draft.savedDocumentId = saved?.id || "generated";
    successAfterDebit = true;

    draft.savedPdfMediaId = up.id;
    draft.savedPdfFilename = fileName;
    draft.savedPdfCaption =
      `✅ ${title} ${draft.docNumber}\n` +
      `Total: ${money(total)} FCFA\n` +
      `Coût: ${totalCost} crédit(s)\n` +
      `Solde: ${finalBalance} crédit(s)`;

    await sendDocument({
      to: from,
      mediaId: draft.savedPdfMediaId,
      filename: draft.savedPdfFilename,
      caption: draft.savedPdfCaption,
    });

    if (draft.type === "devis") {
      try {
        await createDevisFollowup({
          waId: from,
          documentId: draft.savedDocumentId,
          docNumber: draft.docNumber,
          sourceDoc: {
            client: draft.client || null,
            items: draft.items || [],
            finance: draft.finance || null,
            date: draft.date || null,
            source: draft.source || null,
          },
          dueAt: Date.now() + 24 * 60 * 60 * 1000,
        });
      } catch (e) {
        console.warn("followup create error:", e?.message);
      }
    }

    resetStampChoice(s);

    s.step = "doc_generated";
    await sendGeneratedSuccessMenu(from);
  } catch (e) {
    console.error("createAndSendPdf error:", e?.message);

    if (debited && !successAfterDebit) {
      try {
        const stampExtraCost =
          s.addStampForNextDoc === true && s.stampMode === "one_time" ? 1 : 0;
        const totalCost = baseCost + stampExtraCost;

        await addCredits(
          { waId: from },
          totalCost,
          "rollback_pdf_failed",
          failedRollbackOperationKey,
          {
            requestId: draft.requestId,
            docType: draft.type || null,
            docNumber: draft.docNumber || null,
            factureKind: draft.factureKind || null,
          }
        );
      } catch (rb) {
        console.error("rollback credits failed:", rb?.message);
      }
    }

    await sendText(from, "❌ Erreur lors de la création du PDF. Réessayez.");
  } finally {
    s.isGeneratingPdf = false;
    if (draft) draft._saving = false;
  }
}

// --- UI / Messages ---

function buildGeneratedSuccessMessage(draft = null) {
  return (
    `✅ ${draft?.type === "devis" ? "Devis" : "Document"} généré avec succès.\n\n` +
    "Que voulez-vous faire maintenant ?"
  );
}

function buildAlreadyGeneratedMessage(draft = null) {
  return (
    `📄 ${draft?.type === "devis" ? "Ce devis" : "Ce document"} a déjà été généré.\n\n` +
    "Que voulez-vous faire ?"
  );
}


// --- Menus ---

async function sendGeneratedSuccessMenu(to) {
  const s = getSession(to);
  const draft = s?.lastDocDraft || null;
  const text = buildGeneratedSuccessMessage(draft);

  await sendButtons(to, text, [
    { id: "DOC_RESTART", title: "📤 Nouveau doc" },
    { id: "DOC_EDIT_AFTER_GENERATED", title: "✏️ Modifier" },
    { id: "DOC_CANCEL", title: "🏠 Menu" },
  ]);
}

async function sendAlreadyGeneratedMenu(to) {
  const s = getSession(to);
  const draft = s?.lastDocDraft || null;
  const text = buildAlreadyGeneratedMessage(draft);

  await sendButtons(to, text, [
    { id: "DOC_RESTART", title: "📤 Nouveau doc" },
    { id: "DOC_EDIT_AFTER_GENERATED", title: "✏️ Modifier" },
    { id: "DOC_CANCEL", title: "🏠 Menu" },
  ]);
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

    // Déjà marqué comme donné
    if (p?.welcome_credits_granted === true) {
      _WELCOME_CACHE.set(waId, Date.now());
      return;
    }

    // Si l'utilisateur a déjà un solde positif, on ne redonne pas
  const balRes = await getBalance(waId);
const bal = balRes?.balance || 0;

if (bal > 0) {
  _WELCOME_CACHE.set(waId, Date.now());

  try {
    await updateProfile(waId, { welcome_credits_granted: true });
  } catch (_) {}

  return;
}

    // Donne les crédits UNE seule fois
    await addCredits(waId, WELCOME_CREDITS, "welcome");

    try {
      await updateProfile(waId, { welcome_credits_granted: true });
    } catch (_) {}

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

// ===============================
// ADMIN handler + Commands
// ===============================
function ensureAdmin(identityInput) {
  const adminWaIds = ["22670626055"];
  const adminBsuids = [
    // ajoute ici tes BSUID admin si Meta commence à les envoyer
    // ex: "4:123456789012345"
  ];
  const adminUsernames = [
    // optionnel plus tard
    // ex: "kadi"
  ];

  const identity =
    typeof identityInput === "string"
      ? {
          waId: String(identityInput).trim() || null,
          bsuid: null,
          username: null,
        }
      : {
          waId: String(identityInput?.waId || identityInput?.wa_id || "").trim() || null,
          bsuid: String(identityInput?.bsuid || "").trim() || null,
          username: String(identityInput?.username || "").trim() || null,
        };

  if (identity.waId && adminWaIds.includes(identity.waId)) return true;
  if (identity.bsuid && adminBsuids.includes(identity.bsuid)) return true;
  if (identity.username && adminUsernames.includes(identity.username)) return true;

  return false;
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
  const raw = String(text || "").trim();

  // /broadcastimage [légende]
  if (/^\/?broadcastimage\b/i.test(raw)) {
    const caption = raw.replace(/^\/?broadcastimage\s*/i, "").trim();

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

  // /broadcasttemplateimage
  if (/^\/?broadcasttemplateimage\b/i.test(raw)) {
    s.adminPendingAction = "broadcast_template_image";
    await sendText(
      from,
      "🧩 OK. Envoie maintenant l'image du template à diffuser à tous les utilisateurs."
    );
    return true;
  }

  return false;
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

async function handleAdmin(identity, text) {
  if (!ensureAdmin(identity)) return false;

  const from = resolveOwnerKey(identity);
  if (!from) return false;

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
      const codes = await createRechargeCodes({
        count: nb,
        creditsEach: credits,
        createdBy: identity?.waId || identity?.bsuid || from,
      });

      let response = `✅ ${nb} codes créés (${credits} crédits chacun):\n`;
      codes.forEach((c, i) => {
        response += `${i + 1}. ${c.code} (${c.credits} crédits)\n`;
      });

      await sendText(from, response);
    } catch (e) {
      logger.error("admin_create_codes", e, {
        from,
        waId: identity?.waId || null,
        bsuid: identity?.bsuid || null,
        nb,
        credits,
      });
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
      await addCredits(
        { waId: targetWaId },
        credits,
        "admin_add",
        null,
        {
          source: "admin_add",
          adminWaId: identity?.waId || null,
          adminBsuid: identity?.bsuid || null,
        }
      );

      const balRes = await getBalance({ waId: targetWaId });
      const newBalance = balRes?.balance || 0;

      await sendText(
        from,
        `✅ ${credits} crédits ajoutés à ${targetWaId}\nNouveau solde: ${newBalance}`
      );
    } catch (e) {
      logger.error("admin_add_credits", e, {
        from,
        adminWaId: identity?.waId || null,
        adminBsuid: identity?.bsuid || null,
        targetWaId,
        credits,
      });
      await sendText(from, "❌ Erreur lors de l'ajout de crédits.");
    }

    return true;
  }

  if (lower.startsWith("/credit")) {
    const parts = text.trim().split(/\s+/);
    const amount = Number(parts[1]);

    if (!amount || amount <= 0) {
      await sendText(from, "❌ Format: /credit <montant>");
      return true;
    }

    try {
      const result = await addCredits(
        {
          waId: identity?.waId || null,
          bsuid: identity?.bsuid || null,
          username: identity?.username || null,
        },
        amount,
        "admin_self_credit",
        null,
        {
          source: "admin_self_credit",
        }
      );

      await sendText(
        from,
        `✅ Crédit ajouté : +${amount}\n💳 Nouveau solde : ${result?.balance || 0}`
      );
    } catch (e) {
      logger.error("admin_self_credit", e, {
        from,
        adminWaId: identity?.waId || null,
        adminBsuid: identity?.bsuid || null,
        amount,
      });
      await sendText(from, "❌ Erreur lors du rechargement admin.");
    }

    return true;
  }

  if (lower === "/balance" || lower === "admin balance") {
    try {
      const balRes = await getBalance({
        waId: identity?.waId || null,
        bsuid: identity?.bsuid || null,
        username: identity?.username || null,
      });

      await sendText(from, `💳 Solde admin : ${balRes?.balance || 0} crédit(s)`);
    } catch (e) {
      logger.error("admin_balance", e, {
        from,
        adminWaId: identity?.waId || null,
        adminBsuid: identity?.bsuid || null,
      });
      await sendText(from, "❌ Impossible de lire le solde.");
    }

    return true;
  }

  if (lower === "admin" || lower === "admin help") {
    await sendText(
      from,
      "👨‍💼 *KADI ADMIN PANEL*\n\n" +
        "📊 Stats:\n" +
        "• /stats\n" +
        "• /statsmini\n" +
        "• /statsdocs\n" +
        "• /statscredits\n" +
        "• /statsusers\n" +
        "• /alert\n" +
        "• /top 30\n" +
        "• /export 30\n\n" +
        "📢 Broadcast:\n" +
        "• /broadcast Votre message...\n" +
        "• /broadcastimage [légende]\n" +
        "• /broadcasttemplate\n" +
        "• /broadcasttemplateimage\n" +
        "• /broadcastcancel\n\n" +
        "💰 Crédits:\n" +
        "• /credit <montant>\n" +
        "• /balance\n" +
        "• ADMIN ADD <wa_id> <credits>\n\n" +
        "🎫 Codes:\n" +
        "• ADMIN CREATE <nb_codes> <credits_par_code>"
    );
    return true;
  }

  if (lower === "/broadcasttemplate" || lower === "broadcasttemplate") {
    if (!kadiBroadcast?.broadcastTemplateToAll) {
      await sendText(from, "❌ Module broadcast template absent.");
      return true;
    }

    await sendText(from, "📢 Broadcast template lancé vers tous les utilisateurs...");

    try {
      await kadiBroadcast.broadcastTemplateToAll({
        adminWaId: identity?.waId || from,
        templateName: "relance_utilisateur_kadi",
        language: "fr",
        audience: "all_known",
      });
    } catch (e) {
      logger.error("admin_broadcast_template", e, {
        from,
        adminWaId: identity?.waId || null,
        adminBsuid: identity?.bsuid || null,
      });
      await sendText(from, "❌ Erreur lors du broadcast template.");
    }

    return true;
  }

  if (lower === "/broadcasttemplateimage" || lower === "broadcasttemplateimage") {
    return prepareBroadcastImage(from, text);
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
  if (!ensureAdmin(from)) {
    return sendText(from, "❌ Commande réservée à l'administrateur.");
  }

  try {
    const stats = await getStats({
      packCredits: PACK_CREDITS,
      packPriceFcfa: PACK_PRICE_FCFA,
    });

    // ── Helpers locaux ──────────────────────────────
    const pct = (n, total) =>
      total > 0 ? ` (${Math.round((n / total) * 100)}%)` : "";

    const trend = (n, label) =>
      n === 0 ? `• ${label}: —` : `• ${label}: ${n}`;

    // ── Blocs ───────────────────────────────────────
    const u = stats.users;
    const d = stats.docs;
    const c = stats.credits;
    const r = stats.revenue;
    const k = stats.kpis || {};

    // Utilisateurs payants réels
    const payingUsers = u.usersRecharged || 0;

    // Documents par type
    const topDocTypes =
      (d.byType || [])
        .slice(0, 4)
        .map((r) => `  • ${r.doc_type}: ${r.docs} — ${money(r.total_fcfa)} FCFA`)
        .join("\n") || "  • Aucune donnée";

    // Pays
    const topCountries =
      (d.byCountry || [])
        .filter((r) => r.country !== "unknown")
        .slice(0, 3)
        .map((r) => `  • ${r.country}: ${r.docs} docs — ${money(r.total_fcfa)} FCFA`)
        .join("\n") || "  • Aucune donnée";

    // Raisons crédits 30j
    const topReasons =
      (c.byReason30 || [])
        .slice(0, 5)
        .map((r) => `  • ${r.reason}: +${r.added} / -${r.consumed} (${r.tx_count} tx)`)
        .join("\n") || "  • Aucune donnée";

    // Rétention
    const ret = (stats.retention || [])[0];
    const retentionBlock = ret
      ? `  • Cohorte: ${String(ret.first_week || "").slice(0, 10)}\n` +
        `  • Nouveaux: ${ret.new_users}\n` +
        `  • W1: ${ret.retained_w1}/${ret.new_users}${pct(ret.retained_w1, ret.new_users)}\n` +
        `  • W2: ${ret.retained_w2}/${ret.new_users}${pct(ret.retained_w2, ret.new_users)}`
      : "  • Aucune donnée";

    // Features utilisées
    const featuresBlock = [
      d.stampedDocs > 0 ? `  ✅ Tampon: ${d.stampedDocs}` : `  ⬜ Tampon: 0`,
      d.ocrDocs > 0 ? `  ✅ OCR: ${d.ocrDocs}` : `  ⬜ OCR: 0`,
      d.geminiParsedDocs > 0 ? `  ✅ Gemini: ${d.geminiParsedDocs}` : `  ⬜ Gemini: 0`,
    ].join("\n");

    // Alerte revenus
    const revenueAlert =
      payingUsers === 0
        ? `⚠️ *0 utilisateur payant — action requise*\n\n`
        : ``;

    // ── Message final ───────────────────────────────
    const msg =
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 *KADI — DASHBOARD*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +

      revenueAlert +

      `👥 *UTILISATEURS*\n` +
      `  • Total: ${u.totalUsers}\n` +
      `  • Onboardés: ${u.onboardedUsers}${pct(u.onboardedUsers, u.totalUsers)}\n` +
      `  • Actifs 1j / 7j / 30j: ${u.active1d} / ${u.active7} / ${u.active30}\n` +
      `  • Ont créé un doc: ${u.usersWithDocs}${pct(u.usersWithDocs, u.totalUsers)}\n` +
      `  • Payants: ${payingUsers}${pct(payingUsers, u.active30)}\n\n` +

      `📄 *DOCUMENTS*\n` +
      `  • Total: ${d.total} | 7j: ${d.last7} | 30j: ${d.last30}\n` +
      `  • Volume total: ${money(d.sumAll)} FCFA\n` +
      `  • Volume 30j: ${money(d.sum30)} FCFA\n` +
      `  • Panier moyen: ${money(d.avgAll)} FCFA\n\n` +

      `📂 *PAR TYPE*\n${topDocTypes}\n\n` +

      `🌍 *PAR PAYS*\n${topCountries}\n\n` +

      `🤖 *FEATURES*\n${featuresBlock}\n\n` +

      `💳 *CRÉDITS*\n` +
      `  • Solde wallets: ${money(c.totalBalance)}\n` +
      `  • Ajoutés / Consommés (total): ${c.creditsAdded} / ${c.creditsConsumed}\n` +
      `  • Ajoutés / Consommés (7j): ${c.added7} / ${c.consumed7}\n` +
      `  • Transactions: ${c.totalTx}\n\n` +

      `🧾 *CRÉDITS PAR RAISON (30j)*\n${topReasons}\n\n` +

      `💰 *BUSINESS*\n` +
      `  • Payants: ${payingUsers} utilisateurs\n` +
      `  • Crédits payés 30j: ${c.addedPaid30}\n` +
      `  • Revenu estimé 30j: ${money(r.est30)} FCFA\n` +
      `  • Conversion: ${k.paymentConversion || 0}%\n\n` +

      `🎫 *CODES PROMO*\n` +
      `  • Créés: ${stats.codes.codesCreated} | Utilisés: ${stats.codes.codesRedeemed} (${stats.codes.redeemRatePct}%)\n\n` +

      `📈 *RÉTENTION*\n${retentionBlock}\n\n` +

      `━━━━━━━━━━━━━━━━━━━━`;

    return sendText(from, msg);
  } catch (e) {
    logger.error("stats_command", e, { from });
    return sendText(from, "❌ Erreur stats. Réessaie dans quelques secondes.");
  }
}

async function handleStatsMiniCommand(from) {
  if (!ensureAdmin(from)) {
    return sendText(from, "❌ Commande réservée à l'administrateur.");
  }

  try {
    const stats = await getStats({
      packCredits: PACK_CREDITS,
      packPriceFcfa: PACK_PRICE_FCFA,
    });

    const msg =
      `📊 *KADI MINI STATS*\n\n` +
      `👥 Users: ${stats.users.totalUsers}\n` +
      `🔥 Actifs 7j: ${stats.users.active7}\n` +
      `📄 Docs total: ${stats.docs.total}\n` +
      `📅 Docs 30j: ${stats.docs.last30}\n` +
      `💰 Volume total: ${money(stats.docs.sumAll)} FCFA\n` +
      `💳 Crédits consommés: ${stats.credits.creditsConsumed}\n` +
      `💵 Revenu estimé 30j: ${money(stats.revenue.est30)} FCFA`;

    return sendText(from, msg);
  } catch (e) {
    logger.error("stats_mini_command", e, { from });
    return sendText(from, "❌ Impossible de charger les mini stats.");
  }
}

async function handleStatsDocsCommand(from) {
  if (!ensureAdmin(from)) {
    return sendText(from, "❌ Commande réservée à l'administrateur.");
  }

  try {
    const stats = await getStats({
      packCredits: PACK_CREDITS,
      packPriceFcfa: PACK_PRICE_FCFA,
    });

    const byType = (stats.docs.byType || [])
      .slice(0, 5)
      .map((r) => `• ${r.doc_type}: ${r.docs}`)
      .join("\n") || "• Aucune donnée";

    const bySource = (stats.docs.bySource || [])
      .slice(0, 5)
      .map((r) => `• ${r.source}: ${r.docs}`)
      .join("\n") || "• Aucune donnée";

    const msg =
      `📄 *KADI — DOCS & PRODUIT*\n\n` +
      `📊 Volume\n` +
      `• Total: ${stats.docs.total}\n` +
      `• 7j: ${stats.docs.last7}\n` +
      `• 30j: ${stats.docs.last30}\n\n` +
      `💰 Business\n` +
      `• Total FCFA: ${money(stats.docs.sumAll)}\n` +
      `• 30j: ${money(stats.docs.sum30)}\n` +
      `• Panier moyen: ${money(stats.docs.avgAll)}\n\n` +
      `🤖 Usage\n` +
      `• OCR: ${stats.docs.ocrDocs}\n` +
      `• Manuel: ${stats.docs.manualDocs}\n` +
      `• Gemini: ${stats.docs.geminiParsedDocs}\n` +
      `• Tampon: ${stats.docs.stampedDocs}\n\n` +
      `📂 Types\n${byType}\n\n` +
      `🧭 Sources\n${bySource}`;

    return sendText(from, msg);
  } catch (e) {
    logger.error("stats_docs", e, { from });
    return sendText(from, "❌ Erreur stats docs.");
  }
}

async function handleStatsCreditsCommand(from) {
  if (!ensureAdmin(from)) {
    return sendText(from, "❌ Commande réservée à l'administrateur.");
  }

  try {
    const stats = await getStats({
      packCredits: PACK_CREDITS,
      packPriceFcfa: PACK_PRICE_FCFA,
    });

    const topReasons = (stats.credits.byReason30 || [])
      .slice(0, 5)
      .map((r) => `• ${r.reason}: +${r.added} / -${r.consumed}`)
      .join("\n") || "• Aucune donnée";

    const msg =
      `💳 *KADI — CRÉDITS & REVENUS*\n\n` +
      `📊 Global\n` +
      `• Solde total: ${stats.credits.totalBalance}\n` +
      `• Transactions: ${stats.credits.totalTx}\n\n` +
      `📥 Ajouts\n` +
      `• Total: ${stats.credits.creditsAdded}\n` +
      `• 7j: ${stats.credits.added7}\n` +
      `• Payés 30j: ${stats.credits.addedPaid30}\n\n` +
      `📤 Consommation\n` +
      `• Total: ${stats.credits.creditsConsumed}\n` +
      `• 7j: ${stats.credits.consumed7}\n\n` +
      `💰 Revenus\n` +
      `• Crédits payés: ${stats.revenue.creditsPaid}\n` +
      `• Estimé 30j: ${money(stats.revenue.est30)} FCFA\n\n` +
      `🧾 Raisons (30j)\n${topReasons}`;

    return sendText(from, msg);
  } catch (e) {
    logger.error("stats_credits", e, { from });
    return sendText(from, "❌ Erreur stats crédits.");
  }
}

async function handleStatsUsersCommand(from) {
  if (!ensureAdmin(from)) {
    return sendText(from, "❌ Commande réservée à l'administrateur.");
  }

  try {
    const stats = await getStats({
      packCredits: PACK_CREDITS,
      packPriceFcfa: PACK_PRICE_FCFA,
    });

    const topCountries = (stats.docs.byCountry || [])
      .slice(0, 5)
      .map((r) => `• ${r.country}: ${r.docs} docs`)
      .join("\n") || "• Aucune donnée";

    const retention = (stats.retention || [])[0]
      ? `• Cohorte: ${String(stats.retention[0].first_week || "").slice(0, 10)}\n` +
        `• Nouveaux: ${stats.retention[0].new_users}\n` +
        `• W1: ${stats.retention[0].retained_w1}\n` +
        `• W2: ${stats.retention[0].retained_w2}`
      : "• Aucune donnée";

    const msg =
      `👥 *KADI — USERS & GROWTH*\n\n` +
      `📊 Utilisateurs\n` +
      `• Total: ${stats.users.totalUsers}\n` +
      `• Actifs 1j: ${stats.users.active1d}\n` +
      `• Actifs 7j: ${stats.users.active7}\n` +
      `• Actifs 30j: ${stats.users.active30}\n\n` +
      `🚀 Adoption\n` +
      `• Avec docs: ${stats.users.usersWithDocs}\n` +
      `• Onboardés: ${stats.users.onboardedUsers}\n\n` +
      `💳 Monétisation\n` +
      `• Wallets: ${stats.users.usersWithWallet}\n` +
      `• Ont payé: ${stats.users.usersRecharged}\n\n` +
      `🌍 Top pays\n${topCountries}\n\n` +
      `📈 Rétention\n${retention}`;

    return sendText(from, msg);
  } catch (e) {
    logger.error("stats_users", e, { from });
    return sendText(from, "❌ Erreur stats users.");
  }
}

async function handleAlertsCommand(from) {
  if (!ensureAdmin(from)) {
    return sendText(from, "❌ Commande réservée à l'administrateur.");
  }

  try {
    const stats = await getStats({
      packCredits: PACK_CREDITS,
      packPriceFcfa: PACK_PRICE_FCFA,
    });

    const today = formatDateISO();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const todayDocs = Array.isArray(stats.docs?.daily30d)
      ? (stats.docs.daily30d.find((r) => String(r.day || "").slice(0, 10) === today)?.docs || 0)
      : 0;

    const yesterdayDocs = Array.isArray(stats.docs?.daily30d)
      ? (stats.docs.daily30d.find((r) => String(r.day || "").slice(0, 10) === yesterday)?.docs || 0)
      : 0;

    const todayCreditsConsumed = Array.isArray(stats.credits?.daily30d)
      ? (stats.credits.daily30d.find((r) => String(r.day || "").slice(0, 10) === today)?.consumed || 0)
      : 0;

    const alerts = [];

    if (todayDocs === 0) {
      alerts.push("⚠️ Aucun document généré aujourd’hui.");
    }

    if (yesterdayDocs >= 5 && todayDocs < yesterdayDocs * 0.5) {
      alerts.push(`📉 Forte baisse activité docs : ${todayDocs} aujourd’hui vs ${yesterdayDocs} hier.`);
    }

    if (yesterdayDocs >= 1 && todayDocs >= yesterdayDocs * 2) {
      alerts.push(`🚀 Pic d’activité docs : ${todayDocs} aujourd’hui vs ${yesterdayDocs} hier.`);
    }

    if ((stats.users?.active7 || 0) < 5) {
      alerts.push(`👥 Activité faible : seulement ${stats.users?.active7 || 0} utilisateur(s) actifs sur 7 jours.`);
    }

    if ((stats.revenue?.est30 || 0) <= 0) {
      alerts.push("💸 Aucun revenu estimé détecté sur les 30 derniers jours.");
    }

    if ((stats.credits?.creditsConsumed || 0) > 0 && (stats.revenue?.est30 || 0) <= 0) {
      alerts.push("⚠️ Les crédits sont consommés mais aucun revenu payant n’est encore détecté.");
    }

    if ((stats.docs?.ocrDocs || 0) > 0 && (stats.docs?.total || 0) > 0) {
      const ocrShare = (stats.docs.ocrDocs / Math.max(1, stats.docs.total)) * 100;
      if (ocrShare >= 60) {
        alerts.push(`📷 Forte part OCR : ${Math.round(ocrShare)}% des documents viennent de l’OCR.`);
      }
    }

    if ((stats.docs?.stampedDocs || 0) >= 10) {
      alerts.push(`🟦 Bon usage du tampon : ${stats.docs.stampedDocs} document(s) avec tampon.`);
    }

    if (todayCreditsConsumed >= 20) {
      alerts.push(`🔥 Forte consommation aujourd’hui : ${todayCreditsConsumed} crédits consommés.`);
    }

    if ((stats.users?.totalUsers || 0) > 0) {
      const onboardRate = ((stats.users?.onboardedUsers || 0) / Math.max(1, stats.users.totalUsers)) * 100;
      if (onboardRate < 40) {
        alerts.push(`🧭 Onboarding faible : seulement ${Math.round(onboardRate)}% des utilisateurs ont terminé le profil.`);
      }
    }

    if (!alerts.length) {
      return sendText(
        from,
        "✅ *KADI ALERTS*\n\nAucune alerte critique pour le moment.\nLe système semble stable."
      );
    }

    const msg =
      `🚨 *KADI ALERTS*\n\n` +
      alerts.map((a, i) => `${i + 1}. ${a}`).join("\n");

    return sendText(from, msg);
  } catch (e) {
    logger.error("alerts_command", e, { from });
    return sendText(from, "❌ Impossible de calculer les alertes pour le moment.");
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
  if (!ensureAdmin(from)) {
    return sendText(from, "❌ Commande réservée à l'administrateur.");
  }

  const days = parseDaysArg(text, 30);
  const rows = await getDocsForExport({ days });

  const header = [
    "created_at",
    "wa_id",
    "wa_country_code",
    "wa_country_guess",
    "doc_number",
    "doc_type",
    "facture_kind",
    "client",
    "date",
    "subtotal",
    "discount",
    "net",
    "vat",
    "total",
    "deposit",
    "due",
    "paid",
    "payment_method",
    "motif",
    "source",
    "items_count",
    "used_ocr",
    "used_gemini_parse",
    "used_stamp",
    "credits_consumed",
    "business_sector",
    "status",
  ];

  const csvEscape = (value) => {
    if (value === null || value === undefined) return "";
    const s = String(value);
    return `"${s.replace(/"/g, '""')}"`;
  };

  const csvLines = [header.join(",")].concat(
    rows.map((r) =>
      [
        csvEscape(r.created_at),
        csvEscape(r.wa_id),
        csvEscape(r.wa_country_code),
        csvEscape(r.wa_country_guess),
        csvEscape(r.doc_number),
        csvEscape(r.doc_type),
        csvEscape(r.facture_kind),
        csvEscape(r.client),
        csvEscape(r.date),
        csvEscape(r.subtotal),
        csvEscape(r.discount),
        csvEscape(r.net),
        csvEscape(r.vat),
        csvEscape(r.total),
        csvEscape(r.deposit),
        csvEscape(r.due),
        csvEscape(r.paid),
        csvEscape(r.payment_method),
        csvEscape(r.motif),
        csvEscape(r.source),
        csvEscape(r.items_count),
        csvEscape(r.used_ocr),
        csvEscape(r.used_gemini_parse),
        csvEscape(r.used_stamp),
        csvEscape(r.credits_consumed),
        csvEscape(r.business_sector),
        csvEscape(r.status),
      ].join(",")
    )
  );

  const buf = Buffer.from(csvLines.join("\n"), "utf8");
  const fileName = `kadi-export-${days}j-${formatDateISO()}.csv`;

  const up = await uploadMediaBuffer({
    buffer: buf,
    filename: fileName,
    mimeType: "text/csv",
  });

  if (!up?.id) {
    return sendText(from, "❌ Export: upload échoué.");
  }

  return sendDocument({
    to: from,
    mediaId: up.id,
    filename: fileName,
    caption:
      `📤 Export CSV (${days} jours)\n` +
      `Lignes: ${rows.length}\n` +
      `Colonnes: ${header.length}`,
  });
}

async function handleCommand(from, text) {
  const lower = String(text || "").toLowerCase().trim();
  const s = getSession(from);

  // ===============================
  // Commandes globales utilisateur
  // ===============================
  if (lower === "menu" || lower === "m" || lower === "/menu") {
    s.step = "idle";
    s.mode = null;
    s.factureKind = null;
    s.lastDocDraft = null;
    s.itemDraft = null;
    s.pendingOcrMediaId = null;
    s.adminPendingAction = null;
    s.broadcastCaption = null;
    s.pendingRechargePack = null;
    s.pendingRechargeAmount = null;

    await sendHomeMenu(from);
    return true;
  }

  if (
    lower === "annuler" ||
    lower === "annule" ||
    lower === "stop" ||
    lower === "retour" ||
    lower === "/cancel"
  ) {
    s.step = "idle";
    s.mode = null;
    s.factureKind = null;
    s.lastDocDraft = null;
    s.itemDraft = null;
    s.pendingOcrMediaId = null;
    s.adminPendingAction = null;
    s.broadcastCaption = null;
    s.pendingRechargePack = null;
    s.pendingRechargeAmount = null;

    await sendText(from, "❌ Action annulée.");
    await sendHomeMenu(from);
    return true;
  }

  // ===============================
  // Commandes générales
  // ===============================
  if (lower === "/stats" || lower === "stats") return handleStatsCommand(from, text);
  if (lower === "/statsmini" || lower === "statsmini") return handleStatsMiniCommand(from);
  if (lower === "/statsdocs" || lower === "statsdocs") return handleStatsDocsCommand(from);
  if (lower === "/statscredits" || lower === "statscredits") return handleStatsCreditsCommand(from);
  if (lower === "/statsusers" || lower === "statsusers") return handleStatsUsersCommand(from);
  if (lower === "/alert" || lower === "/alerts" || lower === "alert" || lower === "alerts") {
    return handleAlertsCommand(from);
  }
  if (lower.startsWith("/top") || lower.startsWith("top")) return handleTopCommand(from, text);
  if (lower.startsWith("/export") || lower.startsWith("export")) return handleExportCommand(from, text);

  if (lower === "solde" || lower === "credits" || lower === "crédits" || lower === "balance") {
    await replyBalance(from);
    return true;
  }

  if (lower === "recharge" || lower === "acheter pack" || lower === "pack") {
    await replyRechargeInfo(from);
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

  if (replyId === "SMARTBLOCK_FIX") {
    return sendText(
      from,
      "✍️ D’accord. Ajoutez ou corrigez les lignes, puis renvoyez le texte."
    );
  }

  if (replyId === "SMARTBLOCK_CONTINUE") {
    const draft = s.lastDocDraft;

    if (!draft) {
      return sendText(from, "❌ Aucun document en cours.");
    }

    s.step = "doc_review";

    const preview = buildPreviewMessage({ doc: draft });
    await sendText(from, preview);

    const cost = computeBasePdfCost(draft);
    await sendText(from, formatBaseCostLine(cost));

    await sendPreviewMenu(from);
    return;
  }

  if (replyId === "BACK_HOME") return sendHomeMenu(from);
  if (replyId === "BACK_DOCS") return sendDocsMenu(from);

  if (replyId === "HOME_DOCS") return sendDocsMenu(from);
  if (replyId === "HOME_CREDITS") return sendCreditsMenu(from);
  if (replyId === "HOME_PROFILE") return sendProfileMenu(from);
  if (replyId === "RECEIPT_FORMAT_COMPACT") {
  if (!s.lastDocDraft) {
    await sendText(from, "❌ Aucun document en cours.");
    return;
  }

  s.lastDocDraft.receiptFormat = "compact";
  s.step = "doc_client";

  await sendText(from, "🧾 Format ticket sélectionné.");
  await sendText(
    from,
    `👤 *Nom du client ?*\n(Ex: Awa / Ben / Société X)`
  );
  return;
}

if (replyId === "RECEIPT_FORMAT_A4") {
  if (!s.lastDocDraft) {
    await sendText(from, "❌ Aucun document en cours.");
    return;
  }

  s.lastDocDraft.receiptFormat = "a4";
  s.step = "doc_client";

  await sendText(from, "📄 Format A4 sélectionné.");
  await sendText(
    from,
    `👤 *Nom du client ?*\n(Ex: Awa / Ben / Société X)`
  );
  return;
}

  const followupFacture = replyId.match(/^FOLLOWUP_FACTURE_(.+)$/);
  if (followupFacture) {
    const followupId = followupFacture[1];
    const row = await getDevisFollowupById(followupId);

    if (!row || !row.source_doc) {
      await sendText(from, "❌ Devis introuvable.");
      return;
    }

    s.lastDocDraft = cloneDraftToNewDocType(
      {
        type: "devis",
        factureKind: null,
        docNumber: row.doc_number,
        date: row.source_doc?.date || formatDateISO(),
        client: row.source_doc?.client || null,
        items: row.source_doc?.items || [],
        finance: row.source_doc?.finance || null,
        source: row.source_doc?.source || "product",
        meta: makeDraftMeta(),
      },
      "facture"
    );

    s.step = "doc_review";

    await markDevisFollowupConverted(followupId, "facture");

    await sendText(from, "✅ J’ai repris votre devis pour créer une facture.");

    const preview = buildPreviewMessage({ doc: s.lastDocDraft });
    await sendText(from, preview);

    const cost = computeBasePdfCost(s.lastDocDraft);
    await sendText(from, formatBaseCostLine(cost));

    return sendPreviewMenu(from);
  }

  const followupRecu = replyId.match(/^FOLLOWUP_RECU_(.+)$/);
  if (followupRecu) {
    const followupId = followupRecu[1];
    const row = await getDevisFollowupById(followupId);

    if (!row || !row.source_doc) {
      await sendText(from, "❌ Devis introuvable.");
      return;
    }

    s.lastDocDraft = cloneDraftToNewDocType(
      {
        type: "devis",
        factureKind: null,
        docNumber: row.doc_number,
        date: row.source_doc?.date || formatDateISO(),
        client: row.source_doc?.client || null,
        items: row.source_doc?.items || [],
        finance: row.source_doc?.finance || null,
        source: row.source_doc?.source || "product",
        meta: makeDraftMeta(),
      },
      "recu"
    );

    s.step = "doc_review";

    await markDevisFollowupConverted(followupId, "recu");

    await sendText(from, "✅ J’ai repris votre devis pour créer un reçu.");

    const preview = buildPreviewMessage({ doc: s.lastDocDraft });
    await sendText(from, preview);

    const cost = computeBasePdfCost(s.lastDocDraft);
    await sendText(from, formatBaseCostLine(cost));

    return sendPreviewMenu(from);
  }

  const followupLater = replyId.match(/^FOLLOWUP_LATER_(.+)$/);
  if (followupLater) {
    const followupId = followupLater[1];
    await postponeDevisFollowup(followupId, 24);
    await sendText(from, "⏳ D’accord, je vous le rappellerai dans 24h.");
    return;
  }

  if (
    replyId === "SMARTBLOCK_DEVIS" ||
    replyId === "SMARTBLOCK_FACTURE" ||
    replyId === "SMARTBLOCK_RECU"
  ) {
    const raw = s.pendingSmartBlockText;
    if (!raw) {
      return sendText(from, "❌ Bloc introuvable. Renvoyez votre texte.");
    }

    const mode =
      replyId === "SMARTBLOCK_FACTURE"
        ? "facture"
        : replyId === "SMARTBLOCK_RECU"
        ? "recu"
        : "devis";

    s.lastDocDraft = {
      type: mode,
      factureKind: mode === "facture" ? "definitive" : null,
      docNumber: null,
      date: formatDateISO(),
      client: null,
      items: [],
      finance: null,
      source: "smart_block",
      meta: makeDraftMeta(),
    };

    s.pendingSmartBlockText = null;

    return handleSmartItemsBlockText(from, raw);
  }

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
      meta: makeDraftMeta(),
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
      meta: makeDraftMeta(),
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
      const res = await consumeFeature(
        { waId: from },
        "stamp_addon",
        `stamp:addon:${from}`,
        { feature: "stamp_addon" }
      );

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
    await sendText(
      from,
      "✍️ Fonction (tampon) ?\nEx: GERANT / DIRECTEUR / COMMERCIAL\n\nTapez 0 pour effacer."
    );
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

    if (s.lastDocDraft.items.length < LIMITS.maxItems) {
      s.lastDocDraft.items.push(item);
    }

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

  if (replyId === "DECHARGE_SEND_CONFIRMATION") {
    const draft = s.lastDocDraft;

    if (!draft || draft.type !== "decharge") {
      await sendText(from, "❌ Aucune décharge en cours.");
      return;
    }

    const targetWaId = draft?.confirmation?.targetWaId;
    if (!targetWaId) {
      await sendText(from, "❌ Numéro de confirmation manquant.");
      return;
    }

    const confirmationMessage = buildDechargeConfirmationMessage({
      doc: draft,
      money,
    });

    await sendText(targetWaId, confirmationMessage);

    s.step = "doc_review";

    const preview = buildDechargePreviewMessage({
      doc: draft,
      money,
    });
    await sendText(from, preview);

    const cost = computeBasePdfCost(draft);
    await sendText(from, formatBaseCostLine(cost));

    await sendPreviewMenu(from);
    return;
  }

  if (replyId === "DOC_CONFIRM") {
    const draft = s.lastDocDraft;

    if (!draft) {
      await sendText(from, "❌ Aucun document en cours.");
      return;
    }

    if (draft._saving === true || s.isGeneratingPdf === true) {
      await sendText(from, "⏳ Génération en cours...");
      return;
    }

    if (draft.savedDocumentId || draft.savedPdfMediaId) {
      s.step = "doc_already_generated";
      await sendAlreadyGeneratedMenu(from);
      return;
    }

    const p = await getOrCreateProfile(from);

    if (p?.stamp_paid === true && p?.stamp_enabled === true) {
      resetStampChoice(s);

      draft._saving = true;
      try {
        await createAndSendPdf(from);
        return;
      } finally {
        draft._saving = false;
      }
    }

    await sendPreGenerateStampMenu(from);
    return;
  }

  if (replyId === "PRESTAMP_SKIP") {
    resetStampChoice(s);

    const draft = s.lastDocDraft;
    if (!draft) {
      await sendText(from, "❌ Aucun document en cours.");
      return;
    }

    draft._saving = true;
    try {
      await createAndSendPdf(from);
      return;
    } finally {
      draft._saving = false;
    }
  }

  if (replyId === "PRESTAMP_ADD_ONCE") {
    const p = await getOrCreateProfile(from);

    if (!hasStampProfileReady(p)) {
      await sendText(
        from,
        "⚠️ Pour un tampon propre, complétez d’abord votre profil entreprise.\n\nAllez dans Profil > Configurer, puis revenez générer votre document."
      );
      return sendProfileMenu(from);
    }

    s.addStampForNextDoc = true;
    s.stampMode = "one_time";

    const draft = s.lastDocDraft;
    if (!draft) {
      await sendText(from, "❌ Aucun document en cours.");
      return;
    }

    draft._saving = true;
    try {
      await createAndSendPdf(from);
      return;
    } finally {
      draft._saving = false;
    }
  }

  if (replyId === "DOC_RESTART") {
    resetDraftSession(s);
    await sendText(from, "🔁 Recommençons.");
    return sendDocsMenu(from);
  }

  if (replyId === "DOC_CANCEL") {
    resetDraftSession(s);
    await sendText(from, "✅ Retour au menu.");
    return sendHomeMenu(from);
  }

  if (replyId === "DOC_RESEND_LAST_PDF") {
    const draft = s.lastDocDraft;

    if (!draft?.savedPdfMediaId) {
      await sendText(from, "❌ Aucun PDF déjà généré à renvoyer.");
      return;
    }

    await sendDocument({
      to: from,
      mediaId: draft.savedPdfMediaId,
      filename: draft.savedPdfFilename || `${draft.docNumber || "document"}.pdf`,
      caption:
        draft.savedPdfCaption ||
        "📄 Voici à nouveau votre document.\nAucun crédit supplémentaire n’a été consommé.",
    });

    s.step = "doc_already_generated";
    await sendAlreadyGeneratedMenu(from);
    return;
  }

  if (replyId === "DOC_EDIT_AFTER_GENERATED") {
    const draft = s.lastDocDraft;

    if (!draft) {
      await sendText(from, "❌ Aucun document à modifier.");
      return;
    }

    draft.savedDocumentId = null;
    draft.savedPdfMediaId = null;
    draft.savedPdfFilename = null;
    draft.savedPdfCaption = null;
    draft.status = "draft";
    draft.requestId = null;

    s.step = "doc_review";

    await sendText(
      from,
      "✏️ *Mode modification activé.*\n\n" +
        "Vous pouvez corriger puis régénérer le document.\n" +
        "Chaque nouvelle génération consommera le coût normal du document."
    );

    await sendButtons(from, "Que voulez-vous faire ?", [
      { id: "DOC_ADD_MORE", title: "➕ Modifier" },
      { id: "DOC_CONFIRM", title: "📄 Régénérer" },
      { id: "DOC_CANCEL", title: "🏠 Menu" },
    ]);
    return;
  }

  await sendText(from, "⚠️ Action non reconnue. Tapez MENU.");
}

async function handleIncomingMessage(value) {
  const start = Date.now();

  try {
    if (!value) return;
    if (value.statuses?.length) return;
    if (!value.messages?.length) return;

    const msg = value.messages[0];
    const identity = extractMetaIdentity(value);

    const from = resolveOwnerKey(identity);
    const waId = identity.waId;
    const bsuid = identity.bsuid;

    console.log("[KADI] META IDENTITY", {
      waId,
      bsuid,
      parentBsuid: identity.parentBsuid,
      username: identity.username,
      msgType: msg?.type,
    });

    if (!from) {
      logger.warn("missing_identity", "No wa_id or bsuid found in incoming webhook", {
        messageType: msg?.type,
      });
      return;
    }

    if (waId && !isValidWhatsAppId(waId)) {
      logger.warn("invalid_wa_id", "Invalid WhatsApp ID received", { waId, bsuid });
      return;
    }

    return await withUserLock(from, async () => {
      try {
        await syncMetaIdentity(identity);
      } catch (e) {
        logger.warn("meta_identity_sync", e.message, {
          waId,
          bsuid,
        });
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
          waId,
          bsuid,
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
        const caption = norm(msg.image?.caption || "");

        if (
          waId &&
          ensureAdmin(identity) &&
          caption.toLowerCase().startsWith("/broadcastimage")
        ) {
          const commandCaption = caption.replace(/^\/broadcastimage\s*/i, "").trim();
          s.adminPendingAction = "broadcast_image";
          s.broadcastCaption = commandCaption || "";
          return handleAdminBroadcastImage(from, msg);
        }

        if (s.adminPendingAction === "broadcast_image") {
          return handleAdminBroadcastImage(from, msg);
        }

        if (s.step === "profile" && s.profileStep === "logo") {
          return handleLogoImage(from, msg);
        }

        return handleIncomingImage(from, msg);
      }

      const text = norm(msg.text?.body);
      if (!text) return;

      // 1) ADMIN d'abord
      if (await handleAdmin(identity, text)) return;

      // 2) Recharge code avant les flows
      const mCode = text.match(REGEX.code);
      if (mCode) {
        const result = await redeemCode({ waId: from }, mCode[1]);

        if (!result.ok) {
          if (result.error === "CODE_DEJA_UTILISE") {
            return sendText(from, "❌ Code déjà utilisé.");
          }
          return sendText(from, "❌ Code invalide.");
        }

        return sendText(
          from,
          `✅ Recharge OK : +${result.added} crédits\n💳 Nouveau solde : ${result.balance}`
        );
      }

      // 3) Confirmation décharge
      if (await tryHandleDechargeConfirmation(from, text)) return;

      // 4) Commandes globales avant les flows
      if (await handleCommand(from, text)) return;

      // 5) Messages naturels WhatsApp
      if (await tryHandleNaturalMessage(from, text)) return;

      // 6) Collage intelligent de plusieurs lignes produits
      if (await handleSmartItemsBlockText(from, text)) return;

      // 7) Flows texte
      if (await handleProfileAnswer(from, text)) return;
      if (await handleStampFlow(from, text)) return;
      if (await handleProductFlowText(from, text)) return;

      await sendText(from, "Tapez *MENU* pour commencer.");
    });
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

async function handleIncomingStatuses(statuses = []) {
  try {
    for (const st of statuses) {
      console.log("[KADI/STATUS]", {
        messageId: st.messageId,
        recipientId: st.recipientId,
        status: st.status,
        timestamp: st.timestamp,
        errorCode: st.errorCode,
        errorTitle: st.errorTitle,
      });
    }
  } catch (e) {
    logger.error("incoming_statuses", e);
  }
}

// ===============================
// EXPORTS
// ===============================
module.exports = {
  handleIncomingMessage,
  handleIncomingStatuses,
  isValidWhatsAppId,
  isValidEmail,
  processDevisFollowups,
};