"use strict";

/**
 * kadiEngine.js — VERSION À JOUR (Année + Compteur Supabase + Skip = "0")
 *
 * ✅ Numérotation propre: DEV-2026-0001 / FAC-2026-0001 / RCU-2026-0001
 * ✅ Profil entreprise Supabase (business_profiles)
 * ✅ Logo bucket PRIVÉ (storage) + signed URL (optionnel pour PDF)
 * ✅ Boutons interactifs
 * ✅ Génération PDF + upload WhatsApp + envoi document
 * ✅ "0" pour ignorer (au lieu de "-") — accepte aussi "-" par compat
 */

const axios = require("axios");

const { getSession } = require("./kadiState");
const { parseCommand } = require("./kadiCommands");

// ✅ IMPORTANT: on utilise le compteur Supabase "par année"
const { nextDocNumber } = require("./kadiCounterRepo");

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

// -------------------- Utils --------------------
function norm(s) {
  return String(s || "").trim();
}

function isSkip(v) {
  const t = norm(v);
  return t === "0" || t === "-" || /^skip$/i.test(t);
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

// Parsing robuste: "x2", "2x", "qty 2", "2 * 5000" etc.
function parseItemLine(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;

  const nums = raw.match(/(\d[\d\s.,]*)/g) || [];
  const numbers = nums.map(cleanNumber).filter((v) => typeof v === "number");

  // qty via "x2" ou "2x"
  let qty = null;
  const xAfter = raw.match(/x\s*(\d+)/i);
  const xBefore = raw.match(/(\d+)\s*x/i);
  if (xAfter) qty = Number(xAfter[1]);
  else if (xBefore) qty = Number(xBefore[1]);

  // prix unitaire = dernier nombre
  let unitPrice = null;
  if (numbers.length >= 1) unitPrice = numbers[numbers.length - 1];

  // si qty pas donné et on a au moins 2 nombres, le premier est qty si petit
  if (!qty && numbers.length >= 2) {
    const first = numbers[0];
    if (Number.isInteger(first) && first > 0 && first <= 100) qty = first;
    else qty = 1;
  }

  qty = qty || 1;

  // label = texte sans nombres / sans x2
  const label =
    raw
      .replace(/(\d[\d\s.,]*)/g, " ")
      .replace(/\bx\s*\d+\b/gi, " ")
      .replace(/\b\d+\s*x\b/gi, " ")
      .replace(/[-:]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || raw;

  // si pas de prix -> on ignore la ligne (évite montants bizarres)
  if (unitPrice == null) return null;

  const amount = Number(qty) * Number(unitPrice);

  return { label, qty: Number(qty), unitPrice, amount, raw };
}

function sumItems(items) {
  let sum = 0;
  for (const it of items || []) {
    if (typeof it?.amount === "number" && Number.isFinite(it.amount)) sum += it.amount;
  }
  return sum;
}

// MVP: pas encore TVA/remise/acompte (on pourra réactiver + tard)
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

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n));
}

// -------------------- Menus --------------------
async function sendMainMenu(to) {
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

// -------------------- Profile Flow --------------------
async function startProfileFlow(from) {
  const s = getSession(from);
  s.step = "profile";
  s.profileStep = "business_name";
  await getOrCreateProfile(from);

  await sendText(
    from,
    "🏢 *Profil entreprise*\n\n1/7 — Quel est le *nom* de ton entreprise ?\nEx: Gueswende Technologies SARL"
  );
}

async function handleProfileAnswer(from, text) {
  const s = getSession(from);
  const t = norm(text);
  if (s.step !== "profile" || !s.profileStep) return false;

  const step = s.profileStep;

  if (step === "business_name") {
    if (isSkip(t)) {
      await sendText(from, "⚠️ Le nom ne peut pas être ignoré. Donne le nom de ton entreprise.");
      return true;
    }
    await updateProfile(from, { business_name: t });
    s.profileStep = "address";
    await sendText(from, "2/7 — Adresse ?\nEx: Ouaga, Karpala, Secteur 05\n(ou tape 0)");
    return true;
  }

  if (step === "address") {
    await updateProfile(from, { address: isSkip(t) ? null : t });
    s.profileStep = "phone";
    await sendText(from, "3/7 — Téléphone pro ?\nEx: +226 70 62 60 55\n(ou tape 0)");
    return true;
  }

  if (step === "phone") {
    await updateProfile(from, { phone: isSkip(t) ? null : t });
    s.profileStep = "email";
    await sendText(from, "4/7 — Email ? (ou tape 0)");
    return true;
  }

  if (step === "email") {
    await updateProfile(from, { email: isSkip(t) ? null : t });
    s.profileStep = "ifu";
    await sendText(from, "5/7 — IFU ? (ou tape 0)");
    return true;
  }

  if (step === "ifu") {
    await updateProfile(from, { ifu: isSkip(t) ? null : t });
    s.profileStep = "rccm";
    await sendText(from, "6/7 — RCCM ? (ou tape 0)");
    return true;
  }

  if (step === "rccm") {
    await updateProfile(from, { rccm: isSkip(t) ? null : t });
    s.profileStep = "logo";
    await sendText(from, "7/7 — Envoie ton *logo* en image 📷 (ou tape 0)");
    return true;
  }

  if (step === "logo") {
    if (isSkip(t)) {
      s.step = "idle";
      s.profileStep = null;
      await sendText(from, "✅ Profil enregistré (sans logo).");
      await sendMainMenu(from);
      return true;
    }
    await sendText(from, "⚠️ Pour le logo, envoie une *image* (pas du texte). Ou tape 0.");
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
    `🧾 OK. Mode: *${mode.toUpperCase()}*\nEnvoie les lignes comme ça :\nClient: Awa\nDesign logo x1 30000\nImpression x2 5000`
  );
}

async function buildPreviewMessage({ profile, doc }) {
  const bp = profile || {};
  const finance = computeFinance(doc);

  const logoOk = bp.logo_path ? "OK ✅" : "NON";
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
    `Sous-total : ${money(finance.subtotal)}`,
    `TVA : ${money(finance.vat)}`,
    `Total : ${money(finance.gross)}`,
    `Reste : ${money(finance.due)}`,
  ].join("\n");
}

async function handleDocText(from, text) {
  const s = getSession(from);
  if (s.step !== "collecting_doc" || !s.lastDocDraft) return false;

  const draft = s.lastDocDraft;

  // ✅ Commandes (supprime/corrige/ajoute...) si l’utilisateur les tape
  const cmd = parseCommand(text);
  if (cmd) {
    // MVP: on implémente juste cancel / show_list
    if (cmd.type === "cancel") {
      s.step = "idle";
      s.mode = null;
      s.lastDocDraft = null;
      await sendText(from, "✅ OK, annulé.");
      await sendMainMenu(from);
      return true;
    }
    if (cmd.type === "show_list") {
      const preview = await buildPreviewMessage({
        profile: await getOrCreateProfile(from),
        doc: draft,
      });
      await sendText(from, preview);
      await sendAfterPreviewMenu(from);
      return true;
    }
    // Les autres commandes seront ajoutées plus tard (delete/replace/add)
    await sendText(from, "⚠️ Commande reconnue, mais pas encore activée dans cette version.");
    return true;
  }

  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // client + items
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

  // si pas de client -> demande
  if (!draft.client) {
    await sendText(from, "👤 Donne le nom du client avec :\nClient: Nom");
    return true;
  }
  // si pas d'items -> demande
  if (!draft.items.length) {
    await sendText(from, "🧾 Ajoute au moins une ligne.\nEx: Impression x2 5000");
    return true;
  }

  const profile = await getOrCreateProfile(from);
  const preview = await buildPreviewMessage({ profile, doc: draft });

  await sendText(from, preview);
  await sendAfterPreviewMenu(from);
  return true;
}

// (Optionnel) récupère le logo en buffer via signed URL (bucket privé)
async function tryGetLogoBuffer(from, profile) {
  try {
    if (!profile?.logo_path) return null;
    const signedUrl = await getSignedLogoUrl(profile.logo_path);
    if (!signedUrl) return null;

    const resp = await axios.get(signedUrl, { responseType: "arraybuffer", timeout: 20000 });
    return Buffer.from(resp.data);
  } catch (e) {
    console.error("⚠️ tryGetLogoBuffer failed:", e?.message);
    return null;
  }
}

async function confirmAndSendPdf(from) {
  const s = getSession(from);
  const draft = s.lastDocDraft;

  if (!draft) {
    await sendText(from, "❌ Aucun document en cours. Tape *menu*.");
    return;
  }

  if (!draft.client || !draft.items?.length) {
    await sendText(from, "⚠️ Il manque des infos (client ou lignes). Renvoie les détails puis confirme.");
    return;
  }

  // ✅ doc number "par année" via Supabase RPC
  draft.docNumber = await nextDocNumber({
    waId: from,
    mode: draft.type,     // "facture" | "devis" | "recu"
    dateISO: draft.date,  // "YYYY-MM-DD"
  });

  // Profil pour personnalisation
  const profile = await getOrCreateProfile(from);

  // Logo buffer (bucket privé) — sera utilisé seulement si kadiPdf gère logoBuffer
  const logoBuffer = await tryGetLogoBuffer(from, profile);

  // Sauve en DB
  try {
    await saveDocument({ waId: from, doc: draft });
  } catch (e) {
    console.error("saveDocument error:", e?.message);
    await sendText(from, "⚠️ Sauvegarde historique: erreur (on continue quand même).");
  }

  // Génère PDF (⚠️ si ton kadiPdf n’intègre pas encore logoBuffer/business, il l’ignorera)
  const pdfBuf = await buildPdfBuffer({
    type: String(draft.type || "").toUpperCase(),
    docNumber: draft.docNumber,
    date: draft.date,
    client: draft.client,
    items: draft.items || [],
    total: draft.finance?.gross ?? computeFinance(draft).gross,

    // ✅ Personnalisation (si kadiPdf supporte)
    business: {
      name: profile?.business_name || null,
      address: profile?.address || null,
      phone: profile?.phone || null,
      email: profile?.email || null,
      ifu: profile?.ifu || null,
      rccm: profile?.rccm || null,
    },
    logoBuffer, // Buffer|null
  });

  // Upload PDF to WhatsApp
  const fileName = `${draft.docNumber || "KADI"}-${formatDateISO()}.pdf`;

  const up = await uploadMediaBuffer({
    buffer: pdfBuf,
    filename: fileName,
    mimeType: "application/pdf",
  });

  const mediaId = up?.id;
  if (!mediaId) {
    await sendText(from, "❌ Upload PDF échoué (pas de media_id). Regarde les logs Render.");
    return;
  }

  await sendDocument({
    to: from,
    mediaId,
    filename: fileName,
    caption: `✅ ${String(draft.type || "").toUpperCase()} ${draft.docNumber}\nTotal: ${money(draft.finance?.gross)}`,
  });

  // reset doc flow
  s.step = "idle";
  s.mode = null;
  s.lastDocDraft = null;

  await sendMainMenu(from);
}

// -------------------- Interactive Replies --------------------
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

// -------------------- Main Webhook Handler --------------------
async function handleIncomingMessage(value) {
  if (!value) return;

  // Status updates
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

  // profile flow consumes
  if (await handleProfileAnswer(from, text)) return;

  // menu
  if (lower === "menu" || lower === "m") return sendMainMenu(from);

  // quick start
  if (lower === "facture") return startDocFlow(from, "facture");
  if (lower === "devis") return startDocFlow(from, "devis");
  if (lower === "profil" || lower === "profile") return startProfileFlow(from);

  // document collecting
  if (await handleDocText(from, text)) return;

  // fallback
  await sendText(from, `🤖 J’ai reçu: "${text}"\n\nTape *menu* pour voir les options.`);
}

module.exports = { handleIncomingMessage, sendMainMenu, cleanNumber };