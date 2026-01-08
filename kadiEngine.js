"use strict";

const { getSession } = require("./kadiState");
const { parseCommand } = require("./kadiCommands");
const { nextDocNumber } = require("./kadiCounter");
const { buildPdfBuffer } = require("./kadiPdf");
const { saveDocument } = require("./kadiRepo");

const { getOrCreateProfile, updateProfile } = require("./store");
const { uploadLogoBuffer, getSignedLogoUrl } = require("./supabaseStorage");
const { getWallet, decrementOneCredit, applyVoucher } = require("./billingRepo");

const {
  sendText,
  sendButtons,
  getMediaInfo,
  downloadMediaToBuffer,
  uploadMediaBuffer,
  sendDocument,
} = require("./whatsappApi");

// -------------------- Utils --------------------
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
  return Number.isFinite(n) ? n : null;
}
function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n));
}

// Parsing robuste item
function parseItemLine(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;

  const nums = raw.match(/(\d[\d\s.,]*)/g) || [];
  const numbers = nums.map(cleanNumber).filter((v) => typeof v === "number");

  let qty = null;
  const xAfter = raw.match(/x\s*(\d+)/i);
  const xBefore = raw.match(/(\d+)\s*x/i);
  if (xAfter) qty = Number(xAfter[1]);
  else if (xBefore) qty = Number(xBefore[1]);

  let unitPrice = null;
  if (numbers.length >= 1) unitPrice = numbers[numbers.length - 1];

  if (!qty && numbers.length >= 2) {
    const first = numbers[0];
    qty = Number.isInteger(first) && first > 0 && first <= 100 ? first : 1;
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

  const amount = unitPrice != null ? Number(qty) * Number(unitPrice) : 0;
  return { label, qty: Number(qty), unitPrice: unitPrice ?? 0, amount, raw };
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
  return {
    subtotal,
    discount: 0,
    net: gross,
    vat: 0,
    gross,
    deposit: 0,
    due: gross,
  };
}

// -------------------- Menus --------------------
async function sendMainMenu(to) {
  const wallet = await getWallet(to);
  return sendButtons(
    to,
    `📋 *Menu KADI*\nCrédits: *${wallet.credits}*\nChoisis une action :`,
    [
      { id: "MENU_FACTURE", title: "Créer facture" },
      { id: "MENU_PROFIL", title: "Profil entreprise" },
      { id: "MENU_TOPUP", title: "Acheter crédits" },
    ]
  );
}

async function sendAfterPreviewMenu(to) {
  return sendButtons(to, "✅ Que veux-tu faire ?", [
    { id: "DOC_CONFIRM", title: "Confirmer PDF" },
    { id: "DOC_RESTART", title: "Recommencer" },
    { id: "MENU_HOME", title: "Menu" },
  ]);
}

async function sendTopupInstructions(to) {
  return sendText(
    to,
    [
      "💳 *Acheter des crédits KADI*",
      "",
      "✅ Pack recommandé : *2000 FCFA = 25 crédits* (1 crédit = 1 PDF)",
      "",
      "🟧 *Orange Money (manuel pour l’instant)*",
      "1) Fais un dépôt OM vers notre numéro (bientôt automatisé)",
      "2) Après paiement, tu recevras un *code* (voucher)",
      "3) Active-le ici en envoyant :",
      "",
      "*code:XXXX-XXXX*",
      "",
      "📌 Tu peux aussi taper *menu* pour revenir.",
    ].join("\n")
  );
}

// -------------------- Profile Flow (0 = ignorer) --------------------
async function startProfileFlow(from) {
  const s = getSession(from);
  s.step = "profile";
  s.profileStep = "business_name";
  await getOrCreateProfile(from);

  await sendText(
    from,
    "🏢 *Profil entreprise*\n\n1/7 — Quel est le *nom* de ton entreprise ?\nEx: GUESWENDE Technologies"
  );
}

async function handleProfileAnswer(from, text) {
  const s = getSession(from);
  const t = norm(text);
  if (s.step !== "profile" || !s.profileStep) return false;

  const isSkip = t === "0";
  const step = s.profileStep;

  if (step === "business_name") {
    await updateProfile(from, { business_name: isSkip ? null : t });
    s.profileStep = "address";
    await sendText(from, "2/7 — Adresse ? (ou tape 0)");
    return true;
  }
  if (step === "address") {
    await updateProfile(from, { address: isSkip ? null : t });
    s.profileStep = "phone";
    await sendText(from, "3/7 — Téléphone pro ? (ou tape 0)");
    return true;
  }
  if (step === "phone") {
    await updateProfile(from, { phone: isSkip ? null : t });
    s.profileStep = "email";
    await sendText(from, "4/7 — Email ? (ou tape 0)");
    return true;
  }
  if (step === "email") {
    await updateProfile(from, { email: isSkip ? null : t });
    s.profileStep = "ifu";
    await sendText(from, "5/7 — IFU ? (ou tape 0)");
    return true;
  }
  if (step === "ifu") {
    await updateProfile(from, { ifu: isSkip ? null : t });
    s.profileStep = "rccm";
    await sendText(from, "6/7 — RCCM ? (ou tape 0)");
    return true;
  }
  if (step === "rccm") {
    await updateProfile(from, { rccm: isSkip ? null : t });
    s.profileStep = "logo";
    await sendText(from, "7/7 — Envoie ton *logo* en image 📷 (ou tape 0)");
    return true;
  }
  if (step === "logo") {
    if (isSkip) {
      s.step = "idle";
      s.profileStep = null;
      await sendText(from, "✅ Profil enregistré (sans logo).");
      await sendMainMenu(from);
      return true;
    }
    await sendText(from, "⚠️ Pour le logo, envoie une *image* (pas du texte). Ou tape 0");
    return true;
  }

  return false;
}

async function handleLogoImage(from, msg) {
  const s = getSession(from);
  const mediaId = msg?.image?.id;

  if (!mediaId) {
    await sendText(from, "❌ Image reçue mais sans media_id. Réessaie.");
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
    await sendText(from, "✅ Logo enregistré ! Profil terminé.");
    await sendMainMenu(from);
    return;
  }

  await sendText(from, "✅ Logo enregistré !");
}

// -------------------- Document Flow --------------------
async function startDocFlow(from, mode) {
  const s = getSession(from);
  s.step = "collecting_doc";
  s.mode = mode;

  s.lastDocDraft = {
    type: mode,
    docNumber: null,
    date: formatDateISO(),
    client: null,
    items: [],
    finance: null,
  };

  await sendText(
    from,
    [
      `🧾 OK. Mode: *${mode.toUpperCase()}*`,
      "Envoie les lignes comme ça :",
      "Client: Awa",
      "Design logo x1 30000",
      "Impression x2 5000",
    ].join("\n")
  );
}

async function buildPreviewMessage({ profile, doc }) {
  const bp = profile || {};
  const finance = computeFinance(doc);

  const header = [
    bp.business_name ? `🏢 ${bp.business_name}` : "🏢 (Entreprise non définie)",
    bp.address ? `📍 ${bp.address}` : null,
    bp.phone ? `📞 ${bp.phone}` : null,
    bp.email ? `✉️ ${bp.email}` : null,
    bp.ifu ? `IFU: ${bp.ifu}` : null,
    bp.rccm ? `RCCM: ${bp.rccm}` : null,
    bp.logo_path ? `🖼️ Logo: OK ✅` : `🖼️ Logo: (aucun)`,
  ]
    .filter(Boolean)
    .join("\n");

  const lines = (doc.items || [])
    .map((it, idx) => `${idx + 1}) ${it.label} | Qté:${it.qty} | PU:${money(it.unitPrice)} | Montant:${money(it.amount)}`)
    .join("\n");

  return [
    header,
    "",
    `📄 *${String(doc.type || "").toUpperCase()}*`,
    `Date : ${doc.date || "—"}`,
    `Client : ${doc.client || "—"}`,
    "",
    "*Lignes :*",
    lines || "—",
    "",
    `Total : ${money(finance.gross)}`,
    "",
    "🧾 *Arrêter la présente facture à la somme de* :",
    `*${money(finance.gross)} FCFA*`,
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
    await sendText(from, "❌ Aucun document en cours. Tape *menu*.");
    return;
  }

  // 1) décrément crédit (atomique)
  const dec = await decrementOneCredit(from);
  if (!dec.ok) {
    await sendText(
      from,
      `⛔ *Crédits insuffisants.*\nCrédits: *${dec.credits_left || 0}*\n\n👉 Clique *Acheter crédits* ou envoie un code: *code:XXXX-XXXX*`
    );
    await sendMainMenu(from);
    return;
  }

  // 2) doc number
  draft.docNumber = nextDocNumber(draft.type);
  draft.finance = draft.finance || computeFinance(draft);

  // 3) récupérer profil + logo buffer (signed url)
  const profile = await getOrCreateProfile(from);

  let logoBuffer = null;
  if (profile?.logo_path) {
    try {
      const signedUrl = await getSignedLogoUrl(profile.logo_path);
      if (signedUrl) {
        // signedUrl est public temporaire -> download direct via axios sans token whatsapp
        const axios = require("axios");
        const resp = await axios.get(signedUrl, { responseType: "arraybuffer", timeout: 30000 });
        logoBuffer = Buffer.from(resp.data);
      }
    } catch (e) {
      console.error("logo download error:", e?.message);
    }
  }

  // 4) build pdf
  const pdfBuf = await buildPdfBuffer({
    docData: {
      type: String(draft.type || "").toUpperCase(),
      docNumber: draft.docNumber,
      date: draft.date,
      client: draft.client,
      items: draft.items || [],
      total: draft.finance?.gross ?? computeFinance(draft).gross,
    },
    businessProfile: profile,
    logoBuffer,
  });

  // 5) upload + send doc
  const fileName = `${draft.docNumber}-${formatDateISO()}.pdf`;

  const up = await uploadMediaBuffer({
    buffer: pdfBuf,
    filename: fileName,
    mimeType: "application/pdf",
  });

  const mediaId = up?.id;
  if (!mediaId) {
    await sendText(from, "❌ Upload PDF échoué. Regarde les logs Render.");
    return;
  }

  await sendDocument({
    to: from,
    mediaId,
    filename: fileName,
    caption: `✅ ${String(draft.type || "").toUpperCase()} ${draft.docNumber} — Total: ${money(draft.finance.gross)} FCFA\nCrédits restants: ${dec.credits_left}`,
  });

  // 6) save history (best effort)
  try {
    await saveDocument({ waId: from, doc: draft });
  } catch (e) {
    console.error("saveDocument error:", e?.message);
  }

  // reset
  s.step = "idle";
  s.mode = null;
  s.lastDocDraft = null;

  await sendMainMenu(from);
}

// -------------------- Voucher parsing --------------------
function parseVoucherText(text) {
  const t = norm(text);
  const m = t.match(/^code\s*:\s*(.+)$/i);
  if (!m) return null;
  return m[1].trim();
}

// -------------------- Interactive Replies --------------------
async function handleInteractiveReply(from, replyId) {
  const s = getSession(from);

  if (replyId === "MENU_FACTURE") return startDocFlow(from, "facture");
  if (replyId === "MENU_PROFIL") return startProfileFlow(from);
  if (replyId === "MENU_TOPUP") return sendTopupInstructions(from);

  if (replyId === "DOC_CONFIRM") return confirmAndSendPdf(from);

  if (replyId === "DOC_RESTART") {
    s.step = "idle";
    s.mode = null;
    s.lastDocDraft = null;
    await sendText(from, "🔁 OK, on recommence.");
    return sendMainMenu(from);
  }

  if (replyId === "MENU_HOME") return sendMainMenu(from);

  await sendText(from, "⚠️ Action non reconnue. Tape *menu*.");
}

// -------------------- Main Handler --------------------
async function handleIncomingMessage(value) {
  if (!value) return;

  if (value.statuses?.length) {
    const st = value.statuses[0];
    console.log("📊 Status:", st.status, "id:", st.id);
    return;
  }

  if (!value.messages?.length) return;

  const msg = value.messages[0];
  const from = msg.from;

  // interactive
  if (msg.type === "interactive") {
    const replyId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
    if (replyId) return handleInteractiveReply(from, replyId);
  }

  // image (logo)
  if (msg.type === "image") return handleLogoImage(from, msg);

  // text
  const text = norm(msg.text?.body);
  if (!text) return;

  const lower = text.toLowerCase();

  // profile flow first
  if (await handleProfileAnswer(from, text)) return;

  // voucher
  const voucher = parseVoucherText(text);
  if (voucher) {
    try {
      const r = await applyVoucher(from, voucher);
      if (r.ok) {
        await sendText(from, `✅ Recharge OK ! Crédits: *${r.credits_new}*`);
      } else {
        await sendText(from, `❌ Code invalide ou déjà utilisé. Crédits: *${r.credits_new || 0}*`);
      }
    } catch (e) {
      await sendText(from, "⚠️ Erreur lors de l’activation du code. Réessaie.");
    }
    await sendMainMenu(from);
    return;
  }

  // menu
  if (lower === "menu" || lower === "m") return sendMainMenu(from);

  // start shortcuts
  if (lower === "facture") return startDocFlow(from, "facture");
  if (lower === "profil" || lower === "profile") return startProfileFlow(from);
  if (lower === "credits" || lower === "crédits") return sendTopupInstructions(from);

  // collecting doc
  if (await handleDocText(from, text)) return;

  await sendText(from, `🤖 J’ai reçu: "${text}"\n\nTape *menu* pour voir les options.`);
}

module.exports = { handleIncomingMessage, sendMainMenu, cleanNumber };