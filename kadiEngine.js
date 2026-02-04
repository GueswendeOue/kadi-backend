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

// ================= Tampon & Signature (optionnels) =================
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
  sendList,
  getMediaInfo,
  downloadMediaToBuffer,
  uploadMediaBuffer,
  sendDocument,
} = require("./whatsappApi");

const { getBalance, consumeCredit, createRechargeCodes, redeemCode, addCredits } = require("./kadiCreditsRepo");
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

// ---------------- Regex ----------------
const REGEX = {
  client: /^client\s*[:\-]\s*(.+)$/i,
  code: /^code\s+(kdi-[\w-]+)/i,
};

// ---------------- Limits ----------------
const LIMITS = {
  maxItems: 200,
  maxImageSize: 5 * 1024 * 1024,
  maxOcrRetries: 3,
  maxClientNameLength: 100,
  maxItemLabelLength: 200,
};

// welcome cache
const _WELCOME_CACHE = new Map();

// ================= Utils =================
function safe(v) {
  return String(v || "").trim();
}
function norm(s) {
  return String(s || "").trim();
}
function formatDateISO() {
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

// ===============================
// TAMPON & SIGNATURE (wrapper)
// ===============================
async function applyStampAndSignatureIfAny(pdfBuffer, profile) {
  let buf = pdfBuffer;

  // ✅ SAFE: pages last + prendre position/size du profil
  if (kadiStamp?.applyStampToPdfBuffer) {
    try {
      buf = await kadiStamp.applyStampToPdfBuffer(buf, profile, {
        pages: "last",
        position: profile?.stamp_position || "bottom-right",
        size: Number(profile?.stamp_size || 170),
        opacity: 0.9,
        margin: 18,
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
// DOC CATALOG
// ===============================
const DOC_CATALOG = [
  { id: "DOC_DEVIS", title: "Devis", desc: "Proposition de prix", kind: "devis" },
  { id: "DOC_FACTURE", title: "Facture", desc: "Facture client", kind: "facture" },
  { id: "DOC_RECU", title: "Reçu", desc: "Reçu de paiement", kind: "recu" },
  { id: "DOC_DECHARGE", title: "Décharge", desc: "Décharge simple", kind: "decharge" },
];

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
  return { subtotal, gross: subtotal };
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
    { id: "PROFILE_VIEW", title: "Voir" },
    { id: "BACK_HOME", title: "Menu" },
  ]);
}

// ✅ Menu produit (après ajout)
async function sendAfterProductMenu(to) {
  return sendButtons(to, "✅ Produit ajouté. Que faire ?", [
    { id: "P_ADD", title: "Ajouter" },
    { id: "P_DONE", title: "Terminer" },
    { id: "P_CANCEL", title: "Annuler" },
  ]);
}

// ✅ Preview / validation
async function sendAfterPreviewMenu(to) {
  return sendButtons(to, "✅ Valider ?", [
    { id: "DOC_CONFIRM", title: "Générer PDF" },
    { id: "DOC_RESTART", title: "Annuler" },
    { id: "BACK_HOME", title: "Menu" },
  ]);
}

// ===============================
// Profil flow (7 étapes) — identique
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
// Recharge proof + logo image — identique à toi
// ===============================
async function replyRechargeInfo(from) {
  const s = getSession(from);
  s.step = "recharge_proof";

  await sendText(
    from,
    `💰 *Recharger vos crédits KADI*\n\n✅ Orange Money\n📌 Numéro : *${OM_NUMBER}*\n👤 Nom : *${OM_NAME}*\n💳 Offre : *${PRICE_LABEL}*\n\n📎 Après paiement, envoyez ici une *preuve* (capture d'écran).\n\n🔑 Si vous avez un code: *CODE KDI-XXXX-XXXX*`
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
    await sendText(from, "❌ Désolé, la preuve n'a pas pu être traitée. Réessayez.");
  }
}

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

// ===============================
// DOC FLOW (produits)
// ===============================
async function startDocFlow(from, mode, factureKind = null) {
  const s = getSession(from);

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
    source: "text",
  };

  // ✅ lancer par produit 1
  s.step = "p_name";
  s.pendingProduct = { label: null, qty: null, unitPrice: null };

  const title =
    mode === "facture"
      ? factureKind === "proforma"
        ? "🧾 Facture Pro forma"
        : "🧾 Facture Définitive"
      : mode === "devis"
      ? "📝 Devis"
      : mode === "decharge"
      ? "📄 Décharge"
      : "🧾 Reçu";

  await sendText(
    from,
    `${title}\n\n🛒 *Produit 1* — Nom / Désignation ?\nEx: Logo, Impression A4, Verre clair 44x34 cm\n\n(À tout moment: *Annuler*)`
  );
}

function addItemToDraft(draft, item) {
  if (!draft.items) draft.items = [];
  if (draft.items.length >= LIMITS.maxItems) return false;

  const label = safe(item.label).slice(0, LIMITS.maxItemLabelLength) || "—";
  const qty = Number(item.qty || 0);
  const unitPrice = Number(item.unitPrice || 0);
  const amount = Number(qty) * Number(unitPrice);

  draft.items.push({
    label,
    qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
    unitPrice: Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0,
    amount: Number.isFinite(amount) ? amount : 0,
    raw: label,
  });

  draft.finance = computeFinance(draft);
  return true;
}

function buildPreview(draft) {
  const type =
    draft.type === "facture"
      ? draft.factureKind === "proforma"
        ? "FACTURE PRO FORMA"
        : "FACTURE DÉFINITIVE"
      : String(draft.type || "").toUpperCase();

  const lines = (draft.items || []).map((it, i) => {
    const mt = Number(it.amount || 0);
    return `${i + 1}) ${it.label} | Qté:${money(it.qty)} | PU:${money(it.unitPrice)} | Mt:${money(mt)}`;
  });

  const total = draft.finance?.gross ?? computeFinance(draft).gross;

  return (
    `📄 *APERCU*\n` +
    `Type: ${type}\n` +
    `Date: ${draft.date || "-"}\n` +
    `Client: ${draft.client || "—"}\n\n` +
    `Lignes (${lines.length})\n` +
    (lines.length ? lines.join("\n") : "—") +
    `\n\nTOTAL: *${money(total)} FCFA*`
  );
}

async function askNextProductName(from) {
  const s = getSession(from);
  const n = (s.lastDocDraft?.items?.length || 0) + 1;
  s.step = "p_name";
  s.pendingProduct = { label: null, qty: null, unitPrice: null };
  await sendText(from, `🛒 *Produit ${n}* — Nom / Désignation ?`);
}

async function finishDraftAndAskValidate(from) {
  const s = getSession(from);
  const d = s.lastDocDraft;
  if (!d) return sendText(from, "❌ Aucun document en cours.");

  if (!d.items || !d.items.length) {
    await sendText(from, "⚠️ Ajoutez au moins 1 produit.");
    return askNextProductName(from);
  }

  await sendText(from, buildPreview(d));
  await sendAfterPreviewMenu(from);
}

// ===============================
// CREATE PDF
// ===============================
async function createAndSendPdf(from) {
  const s = getSession(from);
  const draft = s.lastDocDraft;

  if (!draft) {
    await sendText(from, "❌ Aucun document en cours. Tapez MENU.");
    return;
  }

  // ✅ client obligatoire
  if (!draft.client) {
    s.step = "await_client_name_for_pdf";
    await sendText(from, "⚠️ Client manquant. Tapez le *nom du client* :");
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

    // ✅ safe stamp
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

    s.step = "idle";
    s.mode = null;
    s.factureKind = null;
    s.lastDocDraft = null;

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

  if (replyId === "DOC_DECHARGE") {
    // tu peux remettre ton flow décharge complet ici si tu veux
    return sendText(from, "📄 Décharge: flow à remettre si besoin.");
  }

  if (replyId === "DOC_FACTURE") {
    s.step = "facture_kind";
    return sendFactureKindMenu(from);
  }

  if (replyId === "FAC_PROFORMA" || replyId === "FAC_DEFINITIVE") {
    const kind = replyId === "FAC_PROFORMA" ? "proforma" : "definitive";
    return startDocFlow(from, "facture", kind);
  }

  // profil
  if (replyId === "PROFILE_EDIT") return startProfileFlow(from);

  if (replyId === "PROFILE_VIEW") {
    const p = await getOrCreateProfile(from);
    await sendText(
      from,
      `🏢 *Profil*\nNom: ${p.business_name || "—"}\nAdresse: ${p.address || "—"}\nTel: ${p.phone || "—"}\nEmail: ${
        p.email || "—"
      }\nIFU: ${p.ifu || "—"}\nRCCM: ${p.rccm || "—"}\nLogo: ${p.logo_path ? "OK ✅" : "—"}`
    );
    return;
  }

  // crédits
  if (replyId === "CREDITS_SOLDE") return replyBalance(from);
  if (replyId === "CREDITS_RECHARGE") return replyRechargeInfo(from);

  // ✅ produits
  if (replyId === "P_ADD") return askNextProductName(from);
  if (replyId === "P_DONE") return finishDraftAndAskValidate(from);
  if (replyId === "P_CANCEL" || replyId === "DOC_RESTART") {
    s.step = "idle";
    s.mode = null;
    s.factureKind = null;
    s.lastDocDraft = null;
    s.pendingProduct = null;
    await sendText(from, "❌ Annulé.");
    return sendHomeMenu(from);
  }

  // pdf
  if (replyId === "DOC_CONFIRM") return createAndSendPdf(from);

  await sendText(from, "⚠️ Action non reconnue. Tapez MENU.");
}

// ===============================
// COMMANDS (admin/stats/export) — tu peux recoller ton bloc si tu veux
// ===============================
function ensureAdmin(waId) {
  return ADMIN_WA_ID && waId === ADMIN_WA_ID;
}

async function handleStatsCommand(from, text) {
  if (!ensureAdmin(from)) return sendText(from, "❌ Commande réservée à l'administrateur.");

  try {
    const stats = await getStats({ packCredits: PACK_CREDITS, packPriceFcfa: PACK_PRICE_FCFA });
    const msgTxt =
      `📊 *KADI — STATISTIQUES*\n\n` +
      `👥 Utilisateurs: ${stats.users.totalUsers}\n` +
      `• Actifs 7j: ${stats.users.active7}\n` +
      `• Actifs 30j: ${stats.users.active30}\n\n` +
      `📄 Docs total: ${stats.docs.total}\n` +
      `• 7j: ${stats.docs.last7}\n` +
      `• 30j: ${stats.docs.last30}\n\n` +
      `💰 Revenu estimé (30j): ≈ ${stats.revenue.est30} FCFA`;
    return sendText(from, msgTxt);
  } catch (e) {
    logger.error("stats_command", e, { from });
    return sendText(from, "❌ Erreur stats.");
  }
}

async function handleTopCommand(from, text) {
  if (!ensureAdmin(from)) return sendText(from, "❌ Admin seulement.");
  const days = parseDaysArg(text, 30);
  const top = await getTopClients({ days, limit: 5 });
  if (!top.length) return sendText(from, `🏆 TOP — ${days}j\nAucune donnée.`);
  const lines = top.map((r, i) => `${i + 1}) ${r.client} — ${r.doc_count} doc • ${money(r.total_sum)} FCFA`).join("\n");
  return sendText(from, `🏆 *TOP 5* — ${days} jours\n\n${lines}`);
}

async function handleExportCommand(from, text) {
  if (!ensureAdmin(from)) return sendText(from, "❌ Admin seulement.");
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
        String(r.client || "").replace(/"/g, '""'),
        r.date || "",
        String(r.total ?? ""),
        String(Array.isArray(r.items) ? r.items.length : 0),
      ].join(",")
    )
  );

  const buf = Buffer.from(csvLines.join("\n"), "utf8");
  const fileName = `kadi-export-${days}j-${formatDateISO()}.csv`;
  const up = await uploadMediaBuffer({ buffer: buf, filename: fileName, mimeType: "text/csv" });
  if (!up?.id) return sendText(from, "❌ Export upload échoué.");

  return sendDocument({ to: from, mediaId: up.id, filename: fileName, caption: `📤 Export CSV (${days} jours)\nLignes: ${rows.length}` });
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
  if (lower === "devis") {
    await startDocFlow(from, "devis");
    return true;
  }
  if (lower === "recu" || lower === "reçu") {
    await startDocFlow(from, "recu");
    return true;
  }
  if (lower === "facture") {
    const s = getSession(from);
    s.step = "facture_kind";
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

    try {
      await recordActivity(from);
    } catch (e) {
      logger.warn("activity_recording", e.message, { from });
    }

    // onboarding + welcome credits (optionnel si tu veux recoller ton bloc)
    // (je ne le retire pas si tu l'utilises déjà ailleurs)

    if (msg.type === "interactive") {
      const replyId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
      if (replyId) return handleInteractiveReply(from, replyId);
      return;
    }

    if (msg.type === "image") {
      const s = getSession(from);
      if (s.step === "profile" && s.profileStep === "logo") return handleLogoImage(from, msg);
      if (s.step === "recharge_proof") return handleRechargeProofImage(from, msg);
      return sendText(from, "📷 Photo reçue (OCR à recoller si besoin).");
    }

    const text = norm(msg.text?.body);
    if (!text) return;

    const s = getSession(from);

    // ✅ 1) si on attend un CLIENT (pour PDF)
    if (s.step === "await_client_name_for_pdf") {
      const name = safe(text).slice(0, LIMITS.maxClientNameLength);
      if (!s.lastDocDraft) {
        s.step = "idle";
        return sendText(from, "❌ Aucun document en cours.");
      }
      s.lastDocDraft.client = name || null;
      s.step = "idle"; // on sort du mode client
      await sendText(from, `✅ Client enregistré: ${s.lastDocDraft.client}`);
      // on relance directement la génération
      return createAndSendPdf(from);
    }

    // ✅ 2) flow produits: p_name -> p_qty -> p_pu
    if (s.lastDocDraft && (s.step === "p_name" || s.step === "p_qty" || s.step === "p_pu")) {
      const t = safe(text);

      if (t.toLowerCase() === "annuler") {
        s.step = "idle";
        s.mode = null;
        s.factureKind = null;
        s.lastDocDraft = null;
        s.pendingProduct = null;
        await sendText(from, "❌ Annulé.");
        await sendHomeMenu(from);
        return;
      }

      if (s.step === "p_name") {
        s.pendingProduct = s.pendingProduct || { label: null, qty: null, unitPrice: null };
        s.pendingProduct.label = t;
        s.step = "p_qty";
        await sendText(from, "🔢 Quantité ?");
        return;
      }

      if (s.step === "p_qty") {
        const q = Number(String(t).replace(",", "."));
        if (!Number.isFinite(q) || q <= 0) {
          await sendText(from, "❌ Quantité invalide. Exemple: 2");
          return;
        }
        s.pendingProduct.qty = q;
        s.step = "p_pu";
        await sendText(from, "💰 Prix unitaire ?");
        return;
      }

      if (s.step === "p_pu") {
        const pu = Number(String(t).replace(/\s/g, "").replace(",", "."));
        if (!Number.isFinite(pu) || pu < 0) {
          await sendText(from, "❌ Prix unitaire invalide. Exemple: 5000");
          return;
        }
        s.pendingProduct.unitPrice = pu;

        // ajout
        const ok = addItemToDraft(s.lastDocDraft, s.pendingProduct);
        if (!ok) {
          await sendText(from, `⚠️ Limite ${LIMITS.maxItems} lignes atteinte.`);
          return finishDraftAndAskValidate(from);
        }

        // reset pending
        s.pendingProduct = null;
        s.step = "idle";

        // feedback + menu
        const last = s.lastDocDraft.items[s.lastDocDraft.items.length - 1];
        await sendText(from, `✅ Ajouté: ${last.label} | Qté:${money(last.qty)} | PU:${money(last.unitPrice)} | Mt:${money(last.amount)}`);
        await sendAfterProductMenu(from);
        return;
      }
    }

    // profil texte
    if (await handleProfileAnswer(from, text)) return;

    // commandes
    if (await handleCommand(from, text)) return;

    // défaut
    await sendText(from, "Tapez *MENU* pour commencer.");
  } catch (e) {
    logger.error("incoming_message", e, { messageType: value?.messages?.[0]?.type });
  } finally {
    const duration = Date.now() - start;
    logger.metric("message_processing", duration, true, { messageType: value?.messages?.[0]?.type });
  }
}

module.exports = { handleIncomingMessage, isValidWhatsAppId, isValidEmail };