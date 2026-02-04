// kadiEngine.js
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

// Broadcast module optionnel (si tu l’as créé)
let kadiBroadcast = null;
try {
  kadiBroadcast = require("./kadiBroadcast");
} catch (e) {
  // ok
}

// ================= Imports core =================
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
  sendList, // (optionnel)
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

// ================= Config =================
const ADMIN_WA_ID = process.env.ADMIN_WA_ID || "";
const OM_NUMBER = process.env.OM_NUMBER || "76894642";
const OM_NAME = process.env.OM_NAME || "GUESWENDE Ouedraogo";
const PRICE_LABEL = process.env.CREDITS_PRICE_LABEL || "2000F = 25 crédits";

const WELCOME_CREDITS = Number(process.env.WELCOME_CREDITS || 50);
const OCR_PDF_CREDITS = Number(process.env.OCR_PDF_CREDITS || 2);

const PACK_CREDITS = Number(process.env.PACK_CREDITS || 25);
const PACK_PRICE_FCFA = Number(process.env.PACK_PRICE_FCFA || 2000);

// Anti-spam broadcast
const BROADCAST_BATCH = Number(process.env.BROADCAST_BATCH || 25);
const BROADCAST_DELAY_MS = Number(process.env.BROADCAST_DELAY_MS || 450);

// ================= Regex / Limits =================
const REGEX = {
  code: /^code\s+(kdi-[\w-]+)/i,
};

const LIMITS = {
  maxItems: 200,
  maxImageSize: 5 * 1024 * 1024,
  maxOcrRetries: 3,
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

// ===============================
// Tampon & Signature (wrapper)
// ===============================
async function applyStampAndSignatureIfAny(pdfBuffer, profile) {
  let buf = pdfBuffer;

  if (kadiStamp?.applyStampToPdfBuffer) {
    try {
      // Important: appliquer par défaut sur la DERNIÈRE page seulement
      buf = await kadiStamp.applyStampToPdfBuffer(buf, profile, {
        pages: "last",
        // position/size viennent du profil dans kadiStamp (si tu l’as modifié)
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
  const title =
    doc.type === "facture"
      ? doc.factureKind === "proforma"
        ? "FACTURE PRO FORMA"
        : "FACTURE DÉFINITIVE"
      : doc.type === "decharge"
      ? "DÉCHARGE"
      : String(doc.type || "").toUpperCase();

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

async function sendAfterPreviewMenu(to) {
  // 3 boutons max
  return sendButtons(to, "✅ Valider ?", [
    { id: "DOC_CONFIRM", title: "Générer PDF" },
    { id: "DOC_ADD_MORE", title: "Ajouter" },
    { id: "DOC_CANCEL", title: "Annuler" },
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
  const enabled = p?.stamp_enabled === true; // default OFF (important pour éviter PDF “pollué”)
  const pos = p?.stamp_position || "bottom-right";
  const size = p?.stamp_size || 170;
  const title = p?.stamp_title || "—";

  const header =
    `🟦 *Tampon (PDF)*\n\n` +
    `• Statut : *${enabled ? "ON ✅" : "OFF ❌"}*\n` +
    `• Fonction : *${title}*\n` +
    `• Position : *${stampPosLabel(pos)}*\n` +
    `• Taille : *${stampSizeLabel(size)}*`;

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

  const txt =
    `🟦 *Réglages tampon*\n\n` +
    `• Position : *${stampPosLabel(pos)}*\n` +
    `• Taille : *${stampSizeLabel(size)}*`;

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
/// ===============================
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
  await sendText(from, `💳 *Votre solde KADI* : ${bal} crédit(s)\n📄 1 crédit = 1 PDF`);
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
// Product-by-product flow (LE flow qu’on voulait)
// ===============================
function resetDraftSession(s) {
  s.step = "idle";
  s.mode = null;
  s.factureKind = null;
  s.lastDocDraft = null;
  s.itemDraft = null;
}

async function startDocFlow(from, mode, factureKind = null) {
  const s = getSession(from);

  s.step = "doc_client"; // 1) demander client d'abord
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
    source: "product", // product | ocr
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
    `✅ Produit prêt :\n${safe(it.label || "—")} | Qté:${money(q)} | PU:${money(pu)} | Mt:${money(amt)}\n\nAjouter ?`,
    [
      { id: "ITEM_SAVE", title: "Ajouter" },
      { id: "ITEM_EDIT", title: "Modifier" },
      { id: "DOC_CANCEL", title: "Annuler" },
    ]
  );
}

async function sendAfterAddMenu(from) {
  const s = getSession(from);
  s.step = "doc_review";

  const preview = buildPreviewMessage({ doc: s.lastDocDraft });
  await sendText(from, preview);

  // 3 boutons max
  return sendButtons(from, "✅ Produit ajouté. Que faire ?", [
    { id: "DOC_CONFIRM", title: "Générer PDF" },
    { id: "DOC_ADD_MORE", title: "Ajouter" },
    { id: "DOC_CANCEL", title: "Annuler" },
  ]);
}

// Texte entrant pendant flow produit
async function handleProductFlowText(from, text) {
  const s = getSession(from);
  if (!s.lastDocDraft) return false;

  const t = norm(text);
  if (!t) return false;

  // 1) client
  if (s.step === "doc_client") {
    s.lastDocDraft.client = t.slice(0, LIMITS.maxClientNameLength);
    await askItemLabel(from);
    return true;
  }

  // 2) label
  if (s.step === "item_label") {
    s.itemDraft = s.itemDraft || {};
    s.itemDraft.label = t.slice(0, LIMITS.maxItemLabelLength);
    await askItemQty(from);
    return true;
  }

  // 3) qty
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

  // 4) PU
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

  // Si on attend "fonction tampon"
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

  // client basique
  let client = null;
  for (const line of lines) {
    const m = line.match(/^client\s*[:\-]\s*(.+)$/i) || line.match(/^nom\s*[:\-]\s*(.+)$/i);
    if (m) {
      client = (m[1] || "").trim().slice(0, LIMITS.maxClientNameLength);
      break;
    }
  }

  // items OCR = best effort : on garde lignes contenant des chiffres
  const items = [];
  for (const line of lines) {
    if (!/\d/.test(line)) continue;
    // format simple : "Logo 5000" => label=line, qty=1, pu=5000
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

async function robustOcr(buffer, lang = "fra", maxRetries = LIMITS.maxOcrRetries) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await ocrImageBuffer(buffer, lang);
    } catch (e) {
      if (attempt === maxRetries) throw e;
      await sleep(Math.pow(2, attempt) * 1000);
    }
  }
}

// OCR -> Draft
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
    await sendText(from, "❌ Impossible de lire la photo. Essayez une photo plus nette (bonne lumière, sans flou).");
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

  // 3 boutons
  return sendButtons(from, "✅ Valider ?", [
    { id: "DOC_CONFIRM", title: "Générer PDF" },
    { id: "DOC_RESTART", title: "Recommencer" },
    { id: "BACK_HOME", title: "Menu" },
  ]);
}

async function handleIncomingImage(from, msg) {
  const s = getSession(from);

  if (s.step === "profile" && s.profileStep === "logo") return handleLogoImage(from, msg);

  const mediaId = msg?.image?.id;
  if (!mediaId) return sendText(from, "❌ Image reçue mais sans media_id. Réessayez.");

  // OCR direct
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

  // ✅ Fix bug: si client manquant, on le demande et on NE traite PAS sa réponse comme une ligne
  if (!safe(draft.client)) {
    s.step = "doc_client"; // on revient au step client
    await sendText(from, "⚠️ Client manquant. Tapez le nom du client :");
    return;
  }

  try {
    validateDraft(draft);
  } catch (err) {
    await sendText(from, `❌ Erreur dans le document: ${err.message}`);
    return;
  }

  const cost = draft.source === "ocr" ? OCR_PDF_CREDITS : 1;

  const cons = await consumeCredit(from, cost, draft.source === "ocr" ? "ocr_pdf" : "pdf");
  if (!cons.ok) {
    await sendText(
      from,
      `❌ Solde insuffisant.\nVous avez ${cons.balance} crédit(s).\nCe PDF coûte ${cost} crédit(s).\n👉 Tapez RECHARGE.`
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

    const title =
      draft.type === "facture"
        ? draft.factureKind === "proforma"
          ? "FACTURE PRO FORMA"
          : "FACTURE DÉFINITIVE"
        : draft.type === "decharge"
        ? "DÉCHARGE"
        : String(draft.type || "").toUpperCase();

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

    // ✅ Tampon/Signature
    pdfBuf = await applyStampAndSignatureIfAny(pdfBuf, profile);

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

    await sendText(waId, `🎁 Bienvenue sur KADI !\nVous recevez *${WELCOME_CREDITS} crédits gratuits*.\n📄 1 crédit = 1 PDF`);
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
      `📷 Envoyez une *photo* → KADI extrait et refait un PDF propre.\n\n` +
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

// Broadcast helper (admin only)
async function broadcastToAllKnownUsers(from, text) {
  if (!ensureAdmin(from)) {
    await sendText(from, "❌ Admin seulement.");
    return true;
  }

  // Format: /broadcast Votre message...
  const msg = String(text || "").replace(/^\/?broadcast\s*/i, "").trim();
  if (!msg) {
    await sendText(from, "❌ Format: /broadcast <message>");
    return true;
  }

  // Si tu as un module dédié
  if (kadiBroadcast?.broadcastToAll) {
    await kadiBroadcast.broadcastToAll({ adminWaId: from, message: msg });
    await sendText(from, "✅ Broadcast lancé (module).");
    return true;
  }

  // Sinon: fallback simple via store/repo (on va chercher via kadi_activity si ton repo l’expose)
  // Comme on n’a pas ici ton supabase client direct, on délègue au module si possible.
  await sendText(from, "⚠️ Module broadcast absent. Ajoute ./kadiBroadcast.js (ou branche Supabase ici).");
  return true;
}

async function handleAdmin(from, text) {
  if (!ensureAdmin(from)) return false;

  const lower = String(text || "").toLowerCase().trim();

  // codes recharge
  if (lower.startsWith("admin create")) {
    const match = text.match(/^admin create\s+(\d+)\s+(\d+)$/i);
    if (!match) {
      await sendText(from, "❌ Format: ADMIN CREATE <nb_codes> <credits_par_code>");
      return true;
    }
    const nb = parseInt(match[1], 10);
    const credits = parseInt(match[2], 10);

    try {
      const codes = await createRechargeCodes(nb, credits);
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
        "📢 Broadcast:\n• /broadcast Votre message...\n\n" +
        "💰 Crédits:\n• ADMIN ADD <wa_id> <credits>\n\n" +
        "🎫 Codes:\n• ADMIN CREATE <nb_codes> <credits_par_code>"
    );
    return true;
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

  // Nav
  if (replyId === "BACK_HOME") return sendHomeMenu(from);
  if (replyId === "BACK_DOCS") return sendDocsMenu(from);

  // Home
  if (replyId === "HOME_DOCS") return sendDocsMenu(from);
  if (replyId === "HOME_CREDITS") return sendCreditsMenu(from);
  if (replyId === "HOME_PROFILE") return sendProfileMenu(from);

  // Docs
  if (replyId === "DOC_DEVIS") return startDocFlow(from, "devis");
  if (replyId === "DOC_RECU") return startDocFlow(from, "recu");

  if (replyId === "DOC_FACTURE") {
    s.step = "facture_kind";
    return sendFactureKindMenu(from);
  }

  if (replyId === "FAC_PROFORMA" || replyId === "FAC_DEFINITIVE") {
    const kind = replyId === "FAC_PROFORMA" ? "proforma" : "definitive";
    return startDocFlow(from, "facture", kind);
  }

  // OCR choose doc
  if (replyId === "OCR_DEVIS" || replyId === "OCR_RECU") {
    const mediaId = s.pendingOcrMediaId;
    s.pendingOcrMediaId = null;
    if (!mediaId) return sendText(from, "❌ Photo introuvable. Renvoyez-la.");
    s.lastDocDraft = null;
    const mode = replyId === "OCR_RECU" ? "recu" : "devis";
    s.lastDocDraft = { type: mode, factureKind: null, docNumber: null, date: formatDateISO(), client: null, items: [], finance: null, source: "ocr" };
    return processOcrImageToDraft(from, mediaId);
  }

  if (replyId === "OCR_FACTURE") {
    const mediaId = s.pendingOcrMediaId;
    s.pendingOcrMediaId = null;
    if (!mediaId) return sendText(from, "❌ Photo introuvable. Renvoyez-la.");
    s.lastDocDraft = { type: "facture", factureKind: "definitive", docNumber: null, date: formatDateISO(), client: null, items: [], finance: null, source: "ocr" };
    return processOcrImageToDraft(from, mediaId);
  }

  // Profile
  if (replyId === "PROFILE_EDIT") return startProfileFlow(from);
  if (replyId === "PROFILE_STAMP") return sendStampMenu(from);

  // Tampon actions
  if (replyId === "STAMP_TOGGLE") {
    const p = await getOrCreateProfile(from);
    const enabled = p?.stamp_enabled === true;
    await updateProfile(from, { stamp_enabled: !enabled });
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

  if (replyId === "STAMP_POS_BR") { await updateProfile(from, { stamp_position: "bottom-right" }); return sendStampMenu(from); }
  if (replyId === "STAMP_POS_BL") { await updateProfile(from, { stamp_position: "bottom-left" }); return sendStampMenu(from); }
  if (replyId === "STAMP_POS_TR") { await updateProfile(from, { stamp_position: "top-right" }); return sendStampMenu(from); }
  if (replyId === "STAMP_POS_TL") { await updateProfile(from, { stamp_position: "top-left" }); return sendStampMenu(from); }

  if (replyId === "STAMP_SIZE_S") { await updateProfile(from, { stamp_size: 150 }); return sendStampMenu(from); }
  if (replyId === "STAMP_SIZE_M") { await updateProfile(from, { stamp_size: 170 }); return sendStampMenu(from); }
  if (replyId === "STAMP_SIZE_L") { await updateProfile(from, { stamp_size: 200 }); return sendStampMenu(from); }

  // Credits
  if (replyId === "CREDITS_SOLDE") return replyBalance(from);
  if (replyId === "CREDITS_RECHARGE") return replyRechargeInfo(from);

  // Item confirm
  if (replyId === "ITEM_SAVE") {
    const it = s.itemDraft || {};
    const item = makeItem(it.label, it.qty, it.unitPrice);
    if (s.lastDocDraft.items.length < LIMITS.maxItems) s.lastDocDraft.items.push(item);
    s.lastDocDraft.finance = computeFinance(s.lastDocDraft);
    s.itemDraft = null;
    return sendAfterAddMenu(from);
  }
  if (replyId === "ITEM_EDIT") {
    // on repart sur label
    return askItemLabel(from);
  }

  // After preview
  if (replyId === "DOC_ADD_MORE") return askItemLabel(from);
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

    // Interactive
    if (msg.type === "interactive") {
      const replyId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
      if (replyId) return handleInteractiveReply(from, replyId);
      return;
    }

    // Image
    if (msg.type === "image") {
      const s = getSession(from);
      if (s.step === "profile" && s.profileStep === "logo") return handleLogoImage(from, msg);
      return handleIncomingImage(from, msg);
    }

    // Text
    const text = norm(msg.text?.body);
    if (!text) return;

    // Admin
    if (await handleAdmin(from, text)) return;

    // Redeem code
    const mCode = text.match(REGEX.code);
    if (mCode) {
      const result = await redeemCode({ waId: from, code: mCode[1] });
      if (!result.ok) {
        if (result.error === "CODE_DEJA_UTILISE") return sendText(from, "❌ Code déjà utilisé.");
        return sendText(from, "❌ Code invalide.");
      }
      return sendText(from, `✅ Recharge OK : +${result.added} crédits\n💳 Nouveau solde : ${result.balance}`);
    }

    // Profile answers
    if (await handleProfileAnswer(from, text)) return;

    // Product flow answers (client/produit/qty/pu + stamp title)
    if (await handleProductFlowText(from, text)) return;

    // Commands
    if (await handleCommand(from, text)) return;

    // Fallback
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