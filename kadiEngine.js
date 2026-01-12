// kadiEngine.js
"use strict";

const { getSession } = require("./kadiState");
const { nextDocNumber } = require("./kadiCounter");
const { buildPdfBuffer } = require("./kadiPdf");
const { saveDocument } = require("./kadiRepo");
const { getOrCreateProfile, updateProfile } = require("./store");

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
  verifyRequestSignature,
} = require("./whatsappApi");

const {
  getBalance,
  consumeCredit,
  createRechargeCodes,
  redeemCode,
  addCredits,
} = require("./kadiCreditsRepo");

const { supabase } = require("./supabaseClient");

// ✅ NOUVEAU: activité + stats repos
const { recordActivity } = require("./kadiActivityRepo");
const { getKadiStats } = require("./kadiStatsRepo");

// ---------------- Config ----------------
const ADMIN_WA_ID = process.env.ADMIN_WA_ID || ""; // ex: "226XXXXXXXX"
const OM_NUMBER = process.env.OM_NUMBER || "76894642";
const OM_NAME = process.env.OM_NAME || "GUESWENDE Ouedraogo";
const PRICE_LABEL = process.env.CREDITS_PRICE_LABEL || "2000F = 25 crédits";
const WELCOME_CREDITS = Number(process.env.WELCOME_CREDITS || 50);

// Anti-double welcome in memory (bonus si pas de colonne DB)
const _WELCOME_CACHE = new Set();

// ---------------- Utils ----------------
function norm(s) {
  return String(s || "").trim();
}

function formatDateISO(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n));
}

function asInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : def;
}

function parseDaysArg(text, defDays) {
  const m = String(text || "").trim().match(/(?:\s+)(\d{1,3})\b/);
  if (!m) return defDays;
  const d = Number(m[1]);
  if (!Number.isFinite(d) || d <= 0) return defDays;
  return Math.min(d, 365);
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows) {
  return rows.map((r) => r.map(csvEscape).join(",")).join("\n");
}

/**
 * cleanNumber: tolère
 * - "1 000 000" / "1,000,000" / "1000000"
 * - "12,5" (décimal)
 */
function cleanNumber(str) {
  if (str == null) return null;
  let s = String(str).trim();
  if (!s) return null;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if (hasComma && !hasDot) {
    const parts = s.split(",");
    if (parts.length === 2 && parts[1].length !== 3) {
      s = `${parts[0]}.${parts[1]}`;
    } else {
      s = s.replace(/,/g, "");
    }
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

function parseItemLine(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;

  let qty = null;
  const xAfter = raw.match(/\bx\s*(\d+)\b/i);
  const xBefore = raw.match(/\b(\d+)\s*x\b/i);
  if (xAfter) qty = Number(xAfter[1]);
  else if (xBefore) qty = Number(xBefore[1]);

  const numbers = extractNumbersSmart(raw).filter((n) => Number.isFinite(n));

  let unitPrice = 0;
  if (numbers.length === 1) {
    unitPrice = numbers[0];
  } else if (numbers.length >= 2) {
    const nonYear = numbers.filter((n) => !(n >= 1900 && n <= 2100));
    const pool = nonYear.length ? nonYear : numbers;
    unitPrice = Math.max(...pool);
  }

  if (!qty) {
    const smalls = numbers.filter((n) => Number.isInteger(n) && n > 0 && n <= 100);
    qty = smalls.length ? smalls[0] : 1;
  }

  const label =
    raw
      .replace(/\b(\d+)\s*x\b/gi, " ")
      .replace(/\bx\s*(\d+)\b/gi, " ")
      .replace(/\d+/g, " ")
      .replace(/[-:]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || raw;

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

// ---------------- Welcome credits (50 gratuits) ----------------
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
      `🎁 Bienvenue sur KADI !\nVous recevez *${WELCOME_CREDITS} crédits gratuits*.\n📄 1 crédit = 1 PDF`
    );
  } catch (e) {
    console.warn("⚠️ ensureWelcomeCredits error:", e?.message);
  }
}

// ---------------- Menus ----------------
async function sendHomeMenu(to) {
  return sendButtons(to, "👋 Bonjour. Que souhaitez-vous faire ?", [
    { id: "HOME_DOCS", title: "Documents" },
    { id: "HOME_CREDITS", title: "Crédits" },
    { id: "HOME_PROFILE", title: "Profil" },
  ]);
}

async function sendDocsMenu(to) {
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

// ---------------- Profil entreprise ----------------
async function startProfileFlow(from) {
  const s = getSession(from);
  s.step = "profile";
  s.profileStep = "business_name";
  await getOrCreateProfile(from);

  await sendText(
    from,
    "🏢 *Profil entreprise*\n\n1/7 — Nom de l’entreprise ?\nEx: GUESWENDE Technologies\n\n📌 Tapez 0 pour ignorer un champ."
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

// ---------------- Recharge preuve -> admin ----------------
async function replyRechargeInfo(from) {
  const s = getSession(from);
  s.step = "recharge_proof";

  await sendText(
    from,
    `💰 *Recharger vos crédits KADI*\n\n✅ Orange Money\n📌 Numéro : *${OM_NUMBER}*\n👤 Nom : *${OM_NAME}*\n💳 Offre : *${PRICE_LABEL}*\n\n📎 Après paiement, envoyez ici une *preuve* (capture d’écran).\nLe support vérifiera et activera vos crédits.\n\n🔑 Si vous avez un code: *CODE KDI-XXXX-XXXX*`
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
          `🧾 *Preuve de paiement reçue*\nClient WA: ${from}\nOffre: ${PRICE_LABEL}\n\n✅ Action admin:\nADMIN ADD ${from} 25`,
      });
    } else {
      await sendText(ADMIN_WA_ID, `🧾 Preuve paiement reçue (upload fail). Client: ${from}`);
    }

    await sendText(
      from,
      "✅ Merci. Votre preuve a été transmise au support.\n⏳ Après vérification, vos crédits seront activés."
    );

    const s = getSession(from);
    s.step = "idle";
    await sendHomeMenu(from);
  } catch (e) {
    console.error("handleRechargeProofImage error:", e?.message);
    await sendText(from, "❌ Désolé, la preuve n’a pas pu être traitée. Réessayez.");
  }
}

// ---------------- Logo upload ----------------
async function handleLogoImage(from, msg) {
  const s = getSession(from);

  if (s.step === "recharge_proof") {
    return handleRechargeProofImage(from, msg);
  }

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

  if (s.step === "profile" && s.profileStep === "logo") {
    s.step = "idle";
    s.profileStep = null;
    await sendText(from, "✅ Logo enregistré. Profil terminé.");
    await sendHomeMenu(from);
    return;
  }

  await sendText(from, "✅ Logo enregistré.");
}

// ---------------- Crédits ----------------
async function replyBalance(from) {
  const bal = await getBalance(from);
  await sendText(from, `💳 *Votre solde KADI* : ${bal} crédit(s)\n📄 1 crédit = 1 PDF`);
}

// ---------------- Admin security ----------------
function ensureAdmin(from) {
  return Boolean(ADMIN_WA_ID && from === ADMIN_WA_ID);
}

// ---------------- /STATS (admin) ----------------
async function replyStats(from) {
  if (!ensureAdmin(from)) {
    return sendText(from, "❌ Commande réservée à l’administrateur.");
  }

  try {
    const s = await getKadiStats();

    const msg =
      `📊 *KADI — STATISTIQUES*\n\n` +
      `👥 *Utilisateurs*\n` +
      `• Total : ${s.users.total}\n` +
      `• Actifs 7j : ${s.users.active_7d}\n` +
      `• Actifs 30j : ${s.users.active_30d}\n\n` +
      `📄 *Documents*\n` +
      `• Total : ${s.documents.total}\n` +
      `• 7 derniers jours : ${s.documents.d7}\n` +
      `• 30 derniers jours : ${s.documents.d30}\n` +
      `• Aujourd’hui : ${s.documents.today}\n\n` +
      `💳 *Crédits (7j)*\n` +
      `• Consommés : ${asInt(s.credits.d7.consumed)}\n` +
      `• Ajoutés : ${asInt(s.credits.d7.added)}\n` +
      `• Bonus welcome (incl.) : ${asInt(s.credits.d7.welcomeAdded)}\n\n` +
      `💰 *Revenu estimé (30j)*\n` +
      `• ≈ ${asInt(s.revenue.estimate_30d_fcfa)} FCFA\n\n` +
      `🕒 ${new Date().toLocaleString("fr-FR")}`;

    await sendText(from, msg);
  } catch (e) {
    console.error("replyStats error:", e?.message);
    await sendText(from, "❌ Erreur stats. Vérifie business_profiles / kadi_activity / kadi_documents / kadi_credit_tx.");
  }
}

// ---------------- TOP / EXPORT (Admin) ----------------
async function replyTopClients(from, days = 30) {
  if (!ensureAdmin(from)) return sendText(from, "❌ Commande réservée à l’administrateur.");

  try {
    const sinceIso = new Date(Date.now() - days * 86400000).toISOString();

    const { data, error } = await supabase
      .from("kadi_documents")
      .select("client,total,created_at")
      .gte("created_at", sinceIso)
      .limit(10000);

    if (error) throw error;

    const map = new Map();
    for (const r of data || []) {
      const key = (r.client || "—").trim() || "—";
      const prev = map.get(key) || { count: 0, sum: 0 };
      prev.count += 1;
      prev.sum += Number(r.total) || 0;
      map.set(key, prev);
    }

    const top = [...map.entries()]
      .sort((a, b) => (b[1].count - a[1].count) || (b[1].sum - a[1].sum))
      .slice(0, 5);

    if (!top.length) return sendText(from, `🏆 TOP CLIENTS — ${days}j\nAucune donnée.`);

    const lines = top
      .map(([name, v], i) => `${i + 1}) ${name} — ${v.count} doc • ${money(v.sum)} FCFA`)
      .join("\n");

    await sendText(from, `🏆 *TOP 5 CLIENTS* — ${days} jours\n\n${lines}`);
  } catch (e) {
    console.error("replyTopClients error:", e?.message);
    await sendText(from, "❌ Erreur top clients.");
  }
}

async function exportDocsCsv(from, days = 30) {
  if (!ensureAdmin(from)) return sendText(from, "❌ Commande réservée à l’administrateur.");

  try {
    const sinceIso = new Date(Date.now() - days * 86400000).toISOString();

    const { data, error } = await supabase
      .from("kadi_documents")
      .select("created_at,wa_id,doc_number,doc_type,facture_kind,client,date,total,items")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(10000);

    if (error) throw error;

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

    const rows = (data || []).map((r) => [
      r.created_at || "",
      r.wa_id || "",
      r.doc_number || "",
      r.doc_type || "",
      r.facture_kind || "",
      r.client || "",
      r.date || "",
      String(r.total ?? ""),
      String(Array.isArray(r.items) ? r.items.length : 0),
    ]);

    const csv = toCsv([header, ...rows]);
    const buf = Buffer.from(csv, "utf8");
    const fileName = `kadi-export-${days}j-${formatDateISO()}.csv`;

    const up = await uploadMediaBuffer({
      buffer: buf,
      filename: fileName,
      mimeType: "text/csv",
    });

    if (!up?.id) return sendText(from, "❌ Export: upload échoué.");

    await sendDocument({
      to: from,
      mediaId: up.id,
      filename: fileName,
      caption: `📤 Export CSV (${days} jours)\nLignes: ${rows.length}`,
    });
  } catch (e) {
    console.error("exportDocsCsv error:", e?.message);
    await sendText(from, "❌ Erreur export CSV.");
  }
}

// ---------------- Documents flow ----------------
async function startDocFlow(from, mode, factureKind = null) {
  const s = getSession(from);
  s.step = "collecting_doc";
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
    `${prefix}\n\nEnvoyez les lignes comme ceci :\nClient: Awa\nDesign logo x1 30000\nImpression x2 5000\n\n📌 Exemple aussi: Impression 2x 5000`
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
    "",
    `Arrêtée la présente ${title.toLowerCase()} à la somme de : ${money(f.gross)} FCFA.`,
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
      const it = parseItemLine(line);
      if (it) draft.items.push(it);
    }
  }

  draft.finance = computeFinance(draft);

  const profile = await getOrCreateProfile(from);
  const preview = await buildPreviewMessage({ profile, doc: draft });

  await sendText(from, preview);
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

  const cons = await consumeCredit(from, 1, "pdf");
  if (!cons.ok) {
    await sendText(from, `❌ Solde insuffisant.\nVous avez ${cons.balance} crédit(s).\n👉 Tapez RECHARGE.`);
    return;
  }

  draft.docNumber = nextDocNumber(draft.type, draft.factureKind);
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
    caption: `✅ ${title} ${draft.docNumber}\nTotal: ${money(total)} FCFA\nSolde: ${cons.balance} crédit(s)`,
  });

  s.step = "idle";
  s.mode = null;
  s.factureKind = null;
  s.lastDocDraft = null;

  await sendHomeMenu(from);
}

// ---------------- Admin commands (legacy) ----------------
async function handleAdmin(from, text) {
  if (!ADMIN_WA_ID || from !== ADMIN_WA_ID) return false;

  const t = norm(text);

  {
    const m = t.match(/^ADMIN\s+CODES\s+(\d+)\s+(\d+)$/i);
    if (m) {
      const count = Number(m[1]);
      const creditsEach = Number(m[2]);

      const codes = await createRechargeCodes({ count, creditsEach, createdBy: from });
      const preview = codes
        .slice(0, 20)
        .map((c) => `${c.code} (${c.credits})`)
        .join("\n");

      await sendText(from, `✅ ${codes.length} codes générés.\n\nAperçu (20):\n${preview}`);
      return true;
    }
  }

  {
    const m = t.match(/^ADMIN\s+ADD\s+(\d+)\s+(\d+)$/i);
    if (m) {
      const wa = m[1];
      const amt = Number(m[2]);
      const bal = await addCredits(wa, amt, `admin:${from}`);
      await sendText(from, `✅ Crédité ${amt} sur ${wa}. Nouveau solde: ${bal}`);
      return true;
    }
  }

  {
    const m = t.match(/^ADMIN\s+SOLDE\s+(\d+)$/i);
    if (m) {
      const wa = m[1];
      const bal = await getBalance(wa);
      await sendText(from, `💳 Solde de ${wa}: ${bal} crédit(s)`);
      return true;
    }
  }

  return false;
}

// ---------------- Interactive replies ----------------
async function handleInteractiveReply(from, replyId) {
  if (replyId === "BACK_HOME") return sendHomeMenu(from);
  if (replyId === "HOME_DOCS") return sendDocsMenu(from);
  if (replyId === "HOME_CREDITS") return sendCreditsMenu(from);
  if (replyId === "HOME_PROFILE") return sendProfileMenu(from);

  if (replyId === "DOC_DEVIS") return startDocFlow(from, "devis");
  if (replyId === "DOC_RECU") return startDocFlow(from, "recu");

  if (replyId === "DOC_FACTURE") return sendFactureKindMenu(from);
  if (replyId === "FAC_PROFORMA") return startDocFlow(from, "facture", "proforma");
  if (replyId === "FAC_DEFINITIVE") return startDocFlow(from, "facture", "definitive");
  if (replyId === "BACK_DOCS") return sendDocsMenu(from);

  if (replyId === "PROFILE_EDIT") return startProfileFlow(from);
  if (replyId === "PROFILE_VIEW") {
    const p = await getOrCreateProfile(from);
    await sendText(
      from,
      `🏢 Profil\nNom: ${p.business_name || "0"}\nAdresse: ${p.address || "0"}\nTel: ${p.phone || "0"}\nEmail: ${p.email || "0"}\nIFU: ${p.ifu || "0"}\nRCCM: ${p.rccm || "0"}\nLogo: ${p.logo_path ? "OK ✅" : "0"}`
    );
    return;
  }

  if (replyId === "CREDITS_SOLDE") return replyBalance(from);
  if (replyId === "CREDITS_RECHARGE") return replyRechargeInfo(from);

  if (replyId === "DOC_CONFIRM") return confirmAndSendPdf(from);
  if (replyId === "DOC_RESTART") {
    const s = getSession(from);
    s.step = "idle";
    s.mode = null;
    s.factureKind = null;
    s.lastDocDraft = null;
    await sendText(from, "🔁 Très bien. Recommençons.");
    return sendDocsMenu(from);
  }

  await sendText(from, "⚠️ Action non reconnue. Tapez MENU.");
}

// ---------------- Main entry ----------------
async function handleIncomingMessage(value) {
  if (!value) return;

  if (value.statuses?.length) return;
  if (!value.messages?.length) return;

  const msg = value.messages[0];
  const from = msg.from;

  // ✅ activity tracking (utilisateur vu)
  await recordActivity(from, "message", { type: msg.type });

  // 🎁 50 crédits gratuits au départ
  await ensureWelcomeCredits(from);

  if (msg.type === "interactive") {
    const replyId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
    if (replyId) {
      await recordActivity(from, "interactive", { replyId });
      return handleInteractiveReply(from, replyId);
    }
  }

  if (msg.type === "image") {
    await recordActivity(from, "image", {});
    return handleLogoImage(from, msg);
  }

  const text = norm(msg.text?.body);
  if (!text) return;

  // Commands ADMIN (stats/top/export)
  const lower = text.toLowerCase();

  if (lower === "/stats" || lower === "stats") {
    await recordActivity(from, "command", { cmd: "stats" });
    return replyStats(from);
  }

  if (lower.startsWith("/top") || lower.startsWith("top")) {
    const days = parseDaysArg(text, 30);
    await recordActivity(from, "command", { cmd: "top", days });
    return replyTopClients(from, days);
  }

  if (lower.startsWith("/export") || lower.startsWith("export")) {
    const days = parseDaysArg(text, 30);
    await recordActivity(from, "command", { cmd: "export", days });
    return exportDocsCsv(from, days);
  }

  if (await handleAdmin(from, text)) return;

  if (await handleProfileAnswer(from, text)) return;

  if (lower === "solde" || lower === "credits" || lower === "crédits" || lower === "balance") {
    return replyBalance(from);
  }

  if (lower === "recharge") {
    return replyRechargeInfo(from);
  }

  {
    const m = text.match(/^CODE\s+([A-Z0-9\-]+)$/i);
    if (m) {
      const result = await redeemCode({ waId: from, code: m[1] });
      if (!result.ok) {
        if (result.error === "CODE_DEJA_UTILISE") return sendText(from, "❌ Code déjà utilisé.");
        return sendText(from, "❌ Code invalide.");
      }
      await recordActivity(from, "redeem_code", { added: result.added });
      return sendText(from, `✅ Recharge OK : +${result.added} crédits\n💳 Nouveau solde : ${result.balance}`);
    }
  }

  if (lower === "menu" || lower === "m") return sendHomeMenu(from);

  if (lower === "devis") return startDocFlow(from, "devis");
  if (lower === "recu" || lower === "reçu") return startDocFlow(from, "recu");
  if (lower === "facture") return sendFactureKindMenu(from);
  if (lower === "profil" || lower === "profile") return sendProfileMenu(from);

  if (await handleDocText(from, text)) return;

  await sendText(from, `Je vous ai lu.\nTapez *MENU* pour commencer.`);
}

module.exports = { handleIncomingMessage, cleanNumber };