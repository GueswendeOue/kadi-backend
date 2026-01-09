"use strict";

const { getSession, resetSession } = require("./kadiState");
const { nextDocNumber } = require("./kadiCounter");
const { buildPdfBuffer } = require("./kadiPdf");
const { saveDocument } = require("./kadiRepo");
const { getOrCreateProfile, updateProfile } = require("./store");
const { uploadLogoBuffer, getSignedLogoUrl, downloadSignedUrlToBuffer } = require("./supabaseStorage");

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

const ADMIN_WA_ID = process.env.ADMIN_WA_ID || "";

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

function cleanNumber(str) {
  const s = String(str).replace(/\s/g, "").replace(/,/g, ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseItemLine(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;

  const nums = raw.match(/(\d[\d\s.,]*)/g) || [];
  const numbers = nums.map(cleanNumber);

  let qty = null;
  const xAfter = raw.match(/x\s*(\d+)/i);
  const xBefore = raw.match(/(\d+)\s*x/i);
  if (xAfter) qty = Number(xAfter[1]);
  else if (xBefore) qty = Number(xBefore[1]);

  let unitPrice = 0;
  if (numbers.length >= 1) unitPrice = numbers[numbers.length - 1];

  if (!qty && numbers.length >= 2) {
    const first = numbers[0];
    if (Number.isInteger(first) && first > 0 && first <= 100) qty = first;
  }
  qty = qty || 1;

  const label =
    raw
      .replace(/(\d[\d\s.,]*)/g, " ")
      .replace(/\bx\s*\d+\b/gi, " ")
      .replace(/\b\d+\s*x\b/gi, " ")
      .replace(/[-:]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || raw;

  const amount = Number(qty) * Number(unitPrice || 0);

  return {
    label,
    qty: Number(qty) || 0,
    unitPrice: Number(unitPrice) || 0,
    amount: Number(amount) || 0,
    raw,
  };
}

function sumItems(items) {
  let sum = 0;
  for (const it of items || []) {
    const a = Number(it?.amount || 0);
    if (Number.isFinite(a)) sum += a;
  }
  return sum;
}

function computeFinance(doc) {
  const subtotal = sumItems(doc.items || []);
  const gross = subtotal;
  return { subtotal, gross };
}

function money(v) {
  const n = Number(v || 0);
  return String(Math.round(Number.isFinite(n) ? n : 0));
}

// --------------- Menus (Version B) ---------------
async function sendHomeMenu(to) {
  // 3 boutons max
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

// --------------- Profil entreprise ---------------
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

async function handleLogoImage(from, msg) {
  const s = getSession(from);

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

// --------------- Crédits ---------------
async function replyBalance(from) {
  const bal = await getBalance(from);
  await sendText(from, `💳 *Votre solde KADI* : ${bal} crédit(s)\n📄 1 crédit = 1 PDF`);
}

async function replyRechargeInfo(from) {
  const label = process.env.CREDITS_PRICE_LABEL || "2000F = 25 crédits";
  await sendText(
    from,
    `💰 *Recharger vos crédits KADI*\n\n✅ Actuellement: Orange Money\n📌 Offre: ${label}\n\n🔑 Après paiement, vous recevrez un *code*.\n👉 Envoyez ici: *CODE KDI-XXXX-XXXX*`
  );
}

// --------------- Documents ---------------
async function startDocFlow(from, mode, factureKind = null) {
  const s = getSession(from);
  s.step = "collecting_doc";
  s.mode = mode;
  s.factureKind = factureKind;

  s.lastDocDraft = {
    type: mode,
    factureKind: factureKind,
    docNumber: null,
    date: formatDateISO(),
    client: null,
    items: [],
    finance: null,
  };

  const prefix = mode === "facture"
    ? (factureKind === "proforma" ? "🧾 Facture Pro forma" : "🧾 Facture Définitive")
    : (mode === "devis" ? "📝 Devis" : "🧾 Reçu");

  await sendText(
    from,
    `${prefix}\n\nEnvoyez les lignes comme ceci :\nClient: Awa\nDesign logo x1 30000\nImpression x2 5000`
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
  ].filter(Boolean).join("\n");

  const title =
    doc.type === "facture"
      ? (doc.factureKind === "proforma" ? "FACTURE PRO FORMA" : "FACTURE DÉFINITIVE")
      : String(doc.type || "").toUpperCase();

  const lines = (doc.items || []).map((it, idx) => (
    `${idx + 1}) ${it.label} | Qté:${money(it.qty)} | PU:${money(it.unitPrice)} | Montant:${money(it.amount)}`
  )).join("\n");

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

  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);

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

  // ✅ check credits
  const cons = await consumeCredit(from, 1, "pdf");
  if (!cons.ok) {
    await sendText(from, `❌ Solde insuffisant.\nVous avez ${cons.balance} crédit(s).\n👉 Tapez RECHARGE.`);
    return;
  }

  // numéro
  draft.docNumber = nextDocNumber(draft.type, draft.factureKind);

  // profile + logo buffer
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

  // PDF buffer
  const title =
    draft.type === "facture"
      ? (draft.factureKind === "proforma" ? "FACTURE PRO FORMA" : "FACTURE DÉFINITIVE")
      : String(draft.type || "").toUpperCase();

  const total = draft.finance?.gross ?? computeFinance(draft).gross;

  const pdfBuf = await buildPdfBuffer({
    docData: {
      type: title,
      docNumber: draft.docNumber,
      date: draft.date,
      client: draft.client,
      items: draft.items || [],
      total: total,
    },
    businessProfile: profile,
    logoBuffer: logoBuf,
  });

  // save
  try {
    await saveDocument({ waId: from, doc: draft });
  } catch (e) {
    console.error("saveDocument error:", e?.message);
  }

  // upload to WhatsApp
  const fileName = `${draft.docNumber}-${formatDateISO()}.pdf`;
  const up = await uploadMediaBuffer({
    buffer: pdfBuf,
    filename: fileName,
    mimeType: "application/pdf",
  });

  const mediaId = up?.id;
  if (!mediaId) {
    await sendText(from, "❌ Envoi PDF impossible (upload échoué).");
    return;
  }

  await sendDocument({
    to: from,
    mediaId,
    filename: fileName,
    caption: `✅ ${title} ${draft.docNumber}\nTotal: ${money(total)} FCFA\nSolde: ${cons.balance} crédit(s)`,
  });

  // reset doc
  s.step = "idle";
  s.mode = null;
  s.factureKind = null;
  s.lastDocDraft = null;

  await sendHomeMenu(from);
}

// --------------- Admin (codes, topup) ---------------
async function handleAdmin(from, text) {
  if (!ADMIN_WA_ID || from !== ADMIN_WA_ID) return false;

  const t = norm(text);

  // ADMIN CODES 100 25
  // => génère 100 codes de 25 crédits
  {
    const m = t.match(/^ADMIN\s+CODES\s+(\d+)\s+(\d+)$/i);
    if (m) {
      const count = Number(m[1]);
      const creditsEach = Number(m[2]);

      const codes = await createRechargeCodes({ count, creditsEach, createdBy: from });
      const preview = codes.slice(0, 20).map(c => `${c.code} (${c.credits})`).join("\n");

      await sendText(
        from,
        `✅ ${codes.length} codes générés.\n\nAperçu (20):\n${preview}\n\n📌 Astuce: vous pouvez copier/coller ces codes.`
      );
      return true;
    }
  }

  // ADMIN ADD 22670626055 25
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

  // ADMIN SOLDE 22670626055
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

// --------------- Interactive replies ---------------
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

// --------------- Main entry ---------------
async function handleIncomingMessage(value) {
  if (!value) return;

  // statuses
  if (value.statuses?.length) return;

  if (!value.messages?.length) return;

  const msg = value.messages[0];
  const from = msg.from;

  // interactive
  if (msg.type === "interactive") {
    const replyId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
    if (replyId) return handleInteractiveReply(from, replyId);
  }

  // image
  if (msg.type === "image") {
    return handleLogoImage(from, msg);
  }

  // text
  const text = norm(msg.text?.body);
  if (!text) return;

  // admin commands
  if (await handleAdmin(from, text)) return;

  const lower = text.toLowerCase();

  // profile flow
  if (await handleProfileAnswer(from, text)) return;

  // credits shortcuts
  if (lower === "solde" || lower === "credits" || lower === "crédits" || lower === "balance") {
    return replyBalance(from);
  }
  if (lower === "recharge") {
    return replyRechargeInfo(from);
  }

  // redeem code: CODE KDI-XXXX-XXXX
  {
    const m = text.match(/^CODE\s+([A-Z0-9\-]+)$/i);
    if (m) {
      const result = await redeemCode({ waId: from, code: m[1] });
      if (!result.ok) {
        if (result.error === "CODE_DEJA_UTILISE") return sendText(from, "❌ Code déjà utilisé.");
        return sendText(from, "❌ Code invalide.");
      }
      return sendText(from, `✅ Recharge OK : +${result.added} crédits\n💳 Nouveau solde : ${result.balance}`);
    }
  }

  // menu
  if (lower === "menu" || lower === "m") return sendHomeMenu(from);

  // quick doc
  if (lower === "devis") return startDocFlow(from, "devis");
  if (lower === "recu" || lower === "reçu") return startDocFlow(from, "recu");
  if (lower === "facture") return sendFactureKindMenu(from);
  if (lower === "profil" || lower === "profile") return sendProfileMenu(from);

  // collecting doc?
  if (await handleDocText(from, text)) return;

  // fallback
  await sendText(from, `Je vous ai lu.\nTapez *MENU* pour commencer.`);
}

module.exports = { handleIncomingMessage, cleanNumber };