// kadiEngine.js
"use strict";

const axios = require("axios");

const { getSession } = require("./kadiState");
const { parseCommand } = require("./kadiCommands");
const { nextDocNumber } = require("./kadiCounter");
const { buildPdfBuffer } = require("./kadiPdf");
const { saveDocument } = require("./kadiRepo");

const { getOrCreateProfile, updateProfile } = require("./store");
const { uploadLogoBuffer, getSignedLogoUrl } = require("./supabaseStorage");

const {
  sendText,
  sendButtons,
  getMediaInfo,
  downloadMediaToBuffer,
  uploadMediaBuffer,
  sendDocument,
} = require("./whatsappApi");

// =====================
// Utils
// =====================
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

// qty + PU parsing (robuste)
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

  const amount = unitPrice != null ? Number(qty) * Number(unitPrice) : null;

  return { label, qty: Number(qty), unitPrice, amount, raw };
}

function sumItems(items) {
  let sum = 0;
  for (const it of items || []) {
    if (typeof it?.amount === "number" && Number.isFinite(it.amount)) sum += it.amount;
  }
  return sum;
}

function computeFinance(doc) {
  const subtotal = sumItems(doc.items || []);
  const gross = subtotal; // (TVA/remise plus tard)
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

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n));
}

// Année propre: 2026-FAC-0001
function withYear(docNumber, dateISO) {
  const y = String(dateISO || formatDateISO()).slice(0, 4);
  if (!docNumber) return `${y}-DOC-0000`;
  if (docNumber.startsWith(`${y}-`)) return docNumber;
  return `${y}-${docNumber}`;
}

// download logo via signed url (bucket privé)
async function downloadSignedLogoToBuffer(signedUrl) {
  if (!signedUrl) return null;
  const resp = await axios.get(signedUrl, { responseType: "arraybuffer", timeout: 30000 });
  return Buffer.from(resp.data);
}

// =====================
// MENUS
// =====================
async function sendMainMenu(to) {
  // WhatsApp buttons max = 3
  return sendButtons(to, "📋 *Menu KADI*\nChoisis une action :", [
    { id: "MENU_DEVIS", title: "Créer un devis" },
    { id: "MENU_FACTURE", title: "Créer une facture" },
    { id: "MENU_PROFIL", title: "Profil entreprise" },
  ]);
}

async function sendAfterPreviewMenu(to) {
  return sendButtons(to, "✅ Que veux-tu faire ?", [
    { id: "DOC_CONFIRM", title: "Confirmer" },
    { id: "DOC_RESTART", title: "Recommencer" },
    { id: "MENU_HOME", title: "Menu" },
  ]);
}

// =====================
// PROFILE FLOW (0 au lieu de -)
// =====================
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

  const step = s.profileStep;

  if (step === "business_name") {
    await updateProfile(from, { business_name: t });
    s.profileStep = "address";
    await sendText(from, "2/7 — Adresse ?\nEx: Ouaga, Karpala, Secteur 05");
    return true;
  }

  if (step === "address") {
    await updateProfile(from, { address: t });
    s.profileStep = "phone";
    await sendText(from, "3/7 — Téléphone pro ?\nEx: +226 70 62 60 55");
    return true;
  }

  if (step === "phone") {
    await updateProfile(from, { phone: t });
    s.profileStep = "email";
    await sendText(from, "4/7 — Email ? (ou tape 0)");
    return true;
  }

  if (step === "email") {
    await updateProfile(from, { email: t === "0" ? null : t });
    s.profileStep = "ifu";
    await sendText(from, "5/7 — IFU ? (ou tape 0)");
    return true;
  }

  if (step === "ifu") {
    await updateProfile(from, { ifu: t === "0" ? null : t });
    s.profileStep = "rccm";
    await sendText(from, "6/7 — RCCM ? (ou tape 0)");
    return true;
  }

  if (step === "rccm") {
    await updateProfile(from, { rccm: t === "0" ? null : t });
    s.profileStep = "logo";
    await sendText(from, "7/7 — Envoie ton *logo* en image 📷 (ou tape 0)");
    return true;
  }

  if (step === "logo") {
    if (t === "0") {
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

// =====================
// DOC FLOW
// =====================
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
    `🧾 OK. Mode: *${String(mode).toUpperCase()}*\nEnvoie les lignes comme ça :\nClient: Awa\nDesign logo x1 30000\nImpression x2 5000\n\n(Ensuite tu confirmes pour recevoir le PDF.)`
  );
}

async function buildPreviewMessage({ profile, doc }) {
  const bp = profile || {};
  const finance = computeFinance(doc);

  const logoOk = bp.logo_path ? "OK ✅" : "0";

  const header = [
    bp.business_name ? `🏢 ${bp.business_name}` : null,
    bp.address ? `📍 ${bp.address}` : null,
    bp.phone ? `📞 ${bp.phone}` : null,
    bp.email ? `✉️ ${bp.email}` : null,
    bp.ifu ? `IFU: ${bp.ifu}` : null,
    bp.rccm ? `RCCM: ${bp.rccm}` : null,
    `🖼️ Logo: ${logoOk}`,
  ]
    .filter(Boolean)
    .join("\n");

  const lines = (doc.items || [])
    .map((it, idx) => {
      return `${idx + 1}) ${it.label} | Qté:${money(it.qty)} | PU:${money(it.unitPrice)} | Montant:${money(it.amount)}`;
    })
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
    `Sous-total : ${money(finance.subtotal)}`,
    `Remise : ${money(finance.discount)}`,
    `Net : ${money(finance.net)}`,
    `TVA : ${money(finance.vat)}`,
    `Total : ${money(finance.gross)}`,
    `Acompte : ${money(finance.deposit)}`,
    `Reste : ${money(finance.due)}`,
    "",
    "✅ Si c’est bon, clique *Confirmer* pour recevoir le PDF.",
  ].join("\n");
}

function applyCommandToDraft(draft, cmd) {
  if (!draft) return false;

  switch (cmd.type) {
    case "cancel":
      return { action: "cancel" };

    case "set_client":
      draft.client = cmd.value || draft.client;
      return true;

    case "set_date":
      draft.date = cmd.value || draft.date;
      return true;

    case "add_lines":
      for (const l of cmd.lines || []) {
        const it = parseItemLine(l);
        if (it) draft.items.push(it);
      }
      return true;

    case "delete_item":
      if (cmd.index >= 1 && cmd.index <= draft.items.length) {
        draft.items.splice(cmd.index - 1, 1);
      }
      return true;

    case "replace_item":
      if (cmd.index >= 1 && cmd.index <= draft.items.length) {
        const it = parseItemLine(cmd.line);
        if (it) draft.items[cmd.index - 1] = it;
      }
      return true;

    default:
      return false;
  }
}

async function handleDocText(from, text) {
  const s = getSession(from);
  if (s.step !== "collecting_doc" || !s.lastDocDraft) return false;

  const draft = s.lastDocDraft;

  // 1) commandes (client:, ajoute:, supprime 2, corrige 3: ...)
  const cmd = parseCommand(text);
  if (cmd) {
    const result = applyCommandToDraft(draft, cmd);
    if (result && result.action === "cancel") {
      s.step = "idle";
      s.mode = null;
      s.lastDocDraft = null;
      await sendText(from, "❌ OK, document annulé.");
      await sendMainMenu(from);
      return true;
    }

    // après commande -> preview
    draft.finance = computeFinance(draft);
    const profile = await getOrCreateProfile(from);
    const preview = await buildPreviewMessage({ profile, doc: draft });
    await sendText(from, preview);
    await sendAfterPreviewMenu(from);
    return true;
  }

  // 2) parse brut lignes
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

  // doc number (avec année)
  const rawNum = nextDocNumber(draft.type);
  draft.docNumber = withYear(rawNum, draft.date);

  // profile + logo
  const profile = await getOrCreateProfile(from);

  let logoBuffer = null;
  if (profile?.logo_path) {
    try {
      const signedUrl = await getSignedLogoUrl(profile.logo_path);
      logoBuffer = await downloadSignedLogoToBuffer(signedUrl);
    } catch (e) {
      console.error("logo signed url / download error:", e?.message);
    }
  }

  // save doc in DB
  try {
    await saveDocument({ waId: from, doc: { ...draft, finance: computeFinance(draft) } });
  } catch (e) {
    console.error("saveDocument error:", e?.message);
    await sendText(from, "⚠️ Sauvegarde historique: erreur (on continue quand même).");
  }

  // build pdf with business profile + logo
  const finance = computeFinance(draft);

  const pdfBuf = await buildPdfBuffer({
    docData: {
      type: String(draft.type || "").toUpperCase(),
      docNumber: draft.docNumber,
      date: draft.date,
      client: draft.client,
      items: draft.items || [],
      total: finance.gross,
    },
    businessProfile: profile,
    logoBuffer,
    logoMime: null,
  });

  // upload pdf to WhatsApp
  const fileName = `${draft.docNumber || "KADI"}-${draft.date || formatDateISO()}.pdf`;
  let mediaId = null;

  try {
    const up = await uploadMediaBuffer({
      buffer: pdfBuf,
      filename: fileName,
      mimeType: "application/pdf",
    });
    mediaId = up?.id;
  } catch (e) {
    console.error("uploadMediaBuffer error:", e?.response?.data || e?.message);
  }

  if (!mediaId) {
    await sendText(
      from,
      "❌ Je n’ai pas pu envoyer le PDF (upload media échoué). Regarde les logs Render.\n\n✅ Le document est quand même prêt. On peut réessayer."
    );
    return;
  }

  await sendDocument({
    to: from,
    mediaId,
    filename: fileName,
    caption: `✅ ${String(draft.type || "").toUpperCase()} ${draft.docNumber}\nTotal: ${money(finance.gross)} FCFA`,
  });

  // reset doc flow
  s.step = "idle";
  s.mode = null;
  s.lastDocDraft = null;

  await sendMainMenu(from);
}

// =====================
// Interactive replies
// =====================
async function handleInteractiveReply(from, replyId) {
  const s = getSession(from);

  if (replyId === "MENU_DEVIS") return startDocFlow(from, "devis");
  if (replyId === "MENU_FACTURE") return startDocFlow(from, "facture");
  if (replyId === "MENU_PROFIL") return startProfileFlow(from);

  if (replyId === "DOC_CONFIRM") return confirmAndSendPdf(from);

  if (replyId === "DOC_RESTART") {
    s.step = "idle";
    s.mode = null;
    s.lastDocDraft = null;
    await sendText(from, "🔁 OK, on recommence. Choisis une action :");
    return sendMainMenu(from);
  }

  if (replyId === "MENU_HOME") return sendMainMenu(from);

  await sendText(from, "⚠️ Action non reconnue. Tape *menu*.");
}

// =====================
// Main handler
// =====================
async function handleIncomingMessage(value) {
  if (!value) return;

  // status updates
  if (value.statuses?.length) {
    const st = value.statuses[0];
    console.log("📊 Status:", st.status, "id:", st.id);
    return;
  }

  if (!value.messages?.length) {
    console.log("ℹ️ Webhook reçu sans messages (probablement status/update).");
    return;
  }

  const msg = value.messages[0];
  const from = msg.from;

  // interactive
  if (msg.type === "interactive") {
    const replyId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
    if (replyId) return handleInteractiveReply(from, replyId);
  }

  // image (logo)
  if (msg.type === "image") {
    return handleLogoImage(from, msg);
  }

  // text
  const text = norm(msg.text?.body);
  if (!text) return;

  const lower = text.toLowerCase();

  // profile flow consumes first
  if (await handleProfileAnswer(from, text)) return;

  // menu
  if (lower === "menu" || lower === "m") {
    return sendMainMenu(from);
  }

  // quick start
  if (lower === "facture") return startDocFlow(from, "facture");
  if (lower === "devis") return startDocFlow(from, "devis");
  if (lower === "profil" || lower === "profile") return startProfileFlow(from);

  // collecting doc
  if (await handleDocText(from, text)) return;

  // fallback
  await sendText(from, `🤖 J’ai reçu: "${text}"\n\nTape *menu* pour voir les options.`);
}

module.exports = {
  handleIncomingMessage,
  sendMainMenu,
  cleanNumber,
};