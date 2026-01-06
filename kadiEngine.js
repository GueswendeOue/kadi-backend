"use strict";

const { getSession } = require("./kadiState");
const { getOrCreateProfile, updateProfile } = require("./store");
const { uploadLogoBuffer } = require("./supabaseStorage");
const { sendText, sendButtons, getMediaInfo, downloadMediaToBuffer } = require("./whatsappApi");

// ============================
// Utils
// ============================
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

function clampPercent(p) {
  if (p == null) return null;
  const v = Number(p);
  if (!Number.isFinite(v)) return null;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

function money(v) {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return String(Math.round(n));
}

// Parse ligne: "Impression x2 5000" / "2 Impression 5000" / "Impression 5000"
function parseItemLine(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;

  const nums = raw.match(/(\d[\d\s.,]*)/g) || [];
  const numbers = nums.map(cleanNumber).filter((v) => typeof v === "number");

  let qty = null;
  const xMatch = raw.match(/x\s*(\d+)/i);
  if (xMatch) qty = Number(xMatch[1]);

  let unitPrice = null;

  if (numbers.length === 1) {
    qty = qty || 1;
    unitPrice = numbers[0];
  } else if (numbers.length >= 2) {
    const first = numbers[0];
    const last = numbers[numbers.length - 1];

    if (!qty) {
      if (Number.isInteger(first) && first > 0 && first <= 100) {
        qty = first;
        unitPrice = last;
      } else {
        qty = 1;
        unitPrice = last;
      }
    } else {
      unitPrice = last;
    }
  }

  qty = qty || 1;
  unitPrice = unitPrice ?? null;

  const label =
    raw
      .replace(/x\s*\d+/gi, "")
      .replace(/(\d[\d\s.,]*)/g, "")
      .replace(/[-:]+/g, " ")
      .trim() || raw;

  const amount = unitPrice != null ? Number(qty) * Number(unitPrice) : null;
  return { label, qty: Number(qty), unitPrice, amount, raw };
}

function sumItems(items) {
  let sum = 0;
  let hasAny = false;
  for (const it of items || []) {
    if (typeof it?.amount === "number" && Number.isFinite(it.amount)) {
      sum += it.amount;
      hasAny = true;
    }
  }
  return hasAny ? sum : 0;
}

function computeFinance(doc) {
  const items = Array.isArray(doc.items) ? doc.items : [];
  const subtotal = sumItems(items);

  let discount = 0;
  const discountType = doc.discountType;
  const discountValue = doc.discountValue;

  if (discountType === "percent") {
    const p = clampPercent(discountValue);
    if (p != null) discount = subtotal * (p / 100);
  } else if (discountType === "amount") {
    const a = Number(discountValue);
    if (Number.isFinite(a) && a > 0) discount = a;
  }

  if (discount > subtotal) discount = subtotal;

  const net = subtotal - discount;

  let vat = 0;
  const vatRate = clampPercent(doc.vatRate);
  if (vatRate != null && vatRate > 0) vat = net * (vatRate / 100);

  const gross = net + vat;

  let deposit = 0;
  if (typeof doc.deposit === "number" && Number.isFinite(doc.deposit) && doc.deposit > 0) {
    deposit = doc.deposit;
  }
  if (deposit > gross) deposit = gross;

  const due = gross - deposit;

  return { subtotal, discount, net, vat, gross, deposit, due };
}

function normalizeDoc(doc) {
  doc.items = Array.isArray(doc.items) ? doc.items : [];
  doc.date = doc.date || formatDateISO();

  doc.vatRate = doc.vatRate ?? null;
  doc.discountType = doc.discountType ?? null;
  doc.discountValue = doc.discountValue ?? null;
  doc.deposit = typeof doc.deposit === "number" ? doc.deposit : null;

  doc.paid = typeof doc.paid === "boolean" ? doc.paid : null;
  doc.paymentMethod = doc.paymentMethod || null;
  doc.motif = doc.motif || null;

  doc.finance = computeFinance(doc);
  return doc;
}

// Preview WhatsApp
function buildPreview(doc, businessProfile = null) {
  const type = String(doc.type || "document").toUpperCase();
  const items = Array.isArray(doc.items) ? doc.items : [];
  const f = doc.finance || computeFinance(doc);

  const header = [];
  if (businessProfile) {
    if (businessProfile.business_name) header.push(`🏢 ${businessProfile.business_name}`);
    if (businessProfile.address) header.push(`📍 ${businessProfile.address}`);
    if (businessProfile.phone) header.push(`📞 ${businessProfile.phone}`);
    if (businessProfile.email) header.push(`✉️ ${businessProfile.email}`);
    if (businessProfile.ifu) header.push(`IFU: ${businessProfile.ifu}`);
    if (businessProfile.rccm) header.push(`RCCM: ${businessProfile.rccm}`);
    if (businessProfile.logo_path) header.push(`🖼️ Logo: OK ✅`);
  }

  const lines = items.length
    ? items
        .map((it, idx) => {
          const pu = it.unitPrice != null ? it.unitPrice : "—";
          const amt = it.amount != null ? it.amount : "—";
          return `${idx + 1}) ${it.label} | Qté:${it.qty} | PU:${pu} | Montant:${amt}`;
        })
        .join("\n")
    : "—";

  return `
${header.length ? header.join("\n") + "\n\n" : ""}📄 *${type}*
Date : ${doc.date || "—"}
Client : ${doc.client || "—"}

Lignes :
${lines}

Sous-total : ${money(f.subtotal)}
Remise : ${money(f.discount)}
Net : ${money(f.net)}
TVA : ${money(f.vat)}
Total : ${money(f.gross)}
Acompte : ${money(f.deposit)}
Reste : ${money(f.due)}
`.trim();
}

// ============================
// Doc generation
// ============================
async function generateDocumentFromText({ userId, mode, text }) {
  if (!mode) return { ok: false, error: "MODE_MISSING" };

  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const doc = normalizeDoc({
    type: mode,
    docNumber: null,
    date: formatDateISO(),
    client: null,
    items: [],
    raw_text: text,
    questions: [],
    vatRate: null,
    discountType: null,
    discountValue: null,
    deposit: null,
    paid: null,
    paymentMethod: null,
    motif: null,
  });

  for (const line of lines) {
    if (!doc.client && /^(client|nom)\s*[:\-]/i.test(line)) {
      doc.client = line.replace(/^(client|nom)\s*[:\-]\s*/i, "").trim() || null;
      continue;
    }
    if (/\d/.test(line)) {
      const it = parseItemLine(line);
      if (it) doc.items.push(it);
    }
  }

  doc.questions = [];
  if (!doc.client) doc.questions.push("Le nom du client ?");
  if (!doc.items.length) doc.questions.push("Les prestations ou produits ? (ex: Design logo x1 30000)");

  normalizeDoc(doc);
  return { ok: true, doc, questions: doc.questions };
}

function applyAnswerToDraft({ draft, question, answer }) {
  if (!draft) return { ok: false, error: "DRAFT_MISSING" };
  const a = String(answer || "").trim();
  if (!a) return { ok: false, error: "ANSWER_EMPTY" };

  draft.items = Array.isArray(draft.items) ? draft.items : [];

  if (/nom du client/i.test(question)) {
    draft.client = a;
  } else if (/prestations|produits|éléments/i.test(question)) {
    const parts = a.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
      const it = parseItemLine(p);
      if (it) draft.items.push(it);
    }
  } else {
    draft.raw_text = (draft.raw_text || "") + "\n" + a;
  }

  draft.questions = [];
  if (!draft.client) draft.questions.push("Le nom du client ?");
  if (!draft.items.length) draft.questions.push("Les prestations ou produits ? (ex: Design logo x1 30000)");

  normalizeDoc(draft);
  return { ok: true, draft, questions: draft.questions };
}

// ============================
// Menus + Buttons
// ============================
async function sendMainMenu(to) {
  return sendButtons(to, "📋 *Menu KADI*\nChoisis une action :", [
    { id: "MENU_DEVIS", title: "Créer un devis" },
    { id: "MENU_FACTURE", title: "Créer une facture" },
    { id: "MENU_PROFIL", title: "Profil entreprise" },
  ]);
}

async function sendConfirmButtons(to) {
  return sendButtons(to, "✅ Que veux-tu faire ?", [
    { id: "DOC_CONFIRM", title: "Confirmer" },
    { id: "DOC_RESET", title: "Recommencer" },
    { id: "DOC_MENU", title: "Menu" },
  ]);
}

// ============================
// Profile Flow
// ============================
async function startProfileFlow(from) {
  const s = getSession(from);
  s.step = "profile";
  s.profileStep = "business_name";

  await getOrCreateProfile(from);

  await sendText(from, "🏢 *Profil entreprise*\n\n1/7 — Quel est le *nom* de ton entreprise ?\nEx: Kadi SARL");
}

async function handleProfileAnswer(from, text) {
  const s = getSession(from);
  const t = norm(text);

  if (s.step !== "profile" || !s.profileStep) return false;

  const step = s.profileStep;

  if (step === "business_name") {
    await updateProfile(from, { business_name: t });
    s.profileStep = "address";
    await sendText(from, "2/7 — Quelle est ton *adresse* ?\nEx: Ouaga, Karpala, Secteur 05");
    return true;
  }

  if (step === "address") {
    await updateProfile(from, { address: t });
    s.profileStep = "phone";
    await sendText(from, "3/7 — Ton *téléphone* pro ?\nEx: +226 70 62 60 55");
    return true;
  }

  if (step === "phone") {
    await updateProfile(from, { phone: t });
    s.profileStep = "email";
    await sendText(from, "4/7 — Ton *email* ? (ou tape - pour ignorer)");
    return true;
  }

  if (step === "email") {
    await updateProfile(from, { email: t === "-" ? null : t });
    s.profileStep = "ifu";
    await sendText(from, "5/7 — Ton *IFU* ? (ou tape - pour ignorer)");
    return true;
  }

  if (step === "ifu") {
    await updateProfile(from, { ifu: t === "-" ? null : t });
    s.profileStep = "rccm";
    await sendText(from, "6/7 — Ton *RCCM* ? (ou tape - pour ignorer)");
    return true;
  }

  if (step === "rccm") {
    await updateProfile(from, { rccm: t === "-" ? null : t });
    s.profileStep = "logo";
    await sendText(from, "7/7 — Envoie maintenant ton *logo* en image 📷 (png/jpg).\n\n📌 Si tu n’as pas de logo, tape -");
    return true;
  }

  if (step === "logo") {
    if (t === "-") {
      s.step = "idle";
      s.profileStep = null;
      await sendText(from, "✅ Profil enregistré (sans logo).");
      await sendMainMenu(from);
      return true;
    }
    await sendText(from, "⚠️ Pour le logo, envoie une *image* (pas du texte). Ou tape - pour ignorer.");
    return true;
  }

  return false;
}

async function handleLogoImage(from, imageMessage) {
  const s = getSession(from);
  const mediaId = imageMessage?.image?.id;

  if (!mediaId) {
    await sendText(from, "❌ Image reçue mais sans media_id. Réessaie d’envoyer l’image.");
    return;
  }

  const info = await getMediaInfo(mediaId);
  const mime = info.mime_type || "image/jpeg";

  const buf = await downloadMediaToBuffer(info.url);

  const { filePath } = await uploadLogoBuffer({
    userId: from,
    buffer: buf,
    mimeType: mime,
  });

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

// ============================
// Interactive Replies
// ============================
async function handleInteractiveReply(from, replyId) {
  const s = getSession(from);

  if (replyId === "MENU_DEVIS") {
    s.step = "collecting_doc";
    s.mode = "devis";
    s.lastDocDraft = null;
    s.pendingQuestion = null;

    await sendText(from, "📝 OK. Envoie les lignes.\nEx:\nClient: Karim\nChaise x2 5000\nTable x1 20000");
    return;
  }

  if (replyId === "MENU_FACTURE") {
    s.step = "collecting_doc";
    s.mode = "facture";
    s.lastDocDraft = null;
    s.pendingQuestion = null;

    await sendText(from, "🧾 OK. Envoie les lignes.\nEx:\nClient: Awa\nDesign logo x1 30000\nImpression x2 5000");
    return;
  }

  if (replyId === "MENU_PROFIL") {
    await startProfileFlow(from);
    return;
  }

  if (replyId === "DOC_MENU") {
    s.step = "idle";
    s.mode = null;
    s.lastDocDraft = null;
    s.pendingQuestion = null;
    await sendMainMenu(from);
    return;
  }

  if (replyId === "DOC_RESET") {
    s.step = "collecting_doc";
    s.lastDocDraft = null;
    s.pendingQuestion = null;

    await sendText(from, "🔄 OK. Renvoie les détails du document.\nEx:\nClient: Awa\nDesign logo x1 30000\nImpression x2 5000");
    return;
  }

  if (replyId === "DOC_CONFIRM") {
    if (!s.lastDocDraft) {
      await sendText(from, "⚠️ Aucun document à confirmer. Tape *menu*.");
      return;
    }
    // Plus tard: génération PDF + stockage Supabase + historique
    s.step = "idle";
    await sendText(from, "✅ Document confirmé ! (PDF + historique arrive ensuite)");
    await sendMainMenu(from);
    return;
  }

  await sendText(from, "⚠️ Action non reconnue. Tape *menu*.");
}

// ============================
// MAIN webhook handler
// ============================
async function handleIncomingMessage(value) {
  if (!value) return;

  // Status updates
  if (value.statuses?.length) {
    const st = value.statuses[0];
    console.log("📊 Status:", st.status, "id:", st.id);
    return;
  }

  // No messages
  if (!value.messages?.length) {
    console.log("ℹ️ Webhook reçu sans messages (probablement status/update).");
    return;
  }

  const msg = value.messages[0];
  const from = msg.from;
  const s = getSession(from);

  // Interactive
  if (msg.type === "interactive") {
    const replyId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
    if (replyId) {
      await handleInteractiveReply(from, replyId);
      return;
    }
  }

  // Image (logo)
  if (msg.type === "image") {
    await handleLogoImage(from, msg);
    return;
  }

  // Text
  const text = norm(msg.text?.body);
  if (!text) return;

  const lower = text.toLowerCase();

  // Profile flow priority
  const consumed = await handleProfileAnswer(from, text);
  if (consumed) return;

  // Menu command
  if (lower === "menu" || lower === "m") {
    await sendMainMenu(from);
    return;
  }

  // Start profile
  if (lower === "profil" || lower === "profile") {
    await startProfileFlow(from);
    return;
  }

  // ✅ DOC FLOW: if collecting_doc => generate / ask questions / preview
  if (s.step === "collecting_doc" && s.pendingQuestion && s.lastDocDraft) {
    const out = applyAnswerToDraft({
      draft: s.lastDocDraft,
      question: s.pendingQuestion,
      answer: text,
    });

    if (!out.ok) {
      await sendText(from, "❌ Je n’ai pas compris. Réessaie.");
      return;
    }

    s.lastDocDraft = out.draft;

    if (out.questions?.length) {
      s.pendingQuestion = out.questions[0];

      const bp = await getOrCreateProfile(from);
      await sendText(from, buildPreview(out.draft, bp) + "\n\n❓ " + s.pendingQuestion);
      return;
    }

    s.pendingQuestion = null;
    s.step = "confirming_doc";

    const bp = await getOrCreateProfile(from);
    await sendText(from, buildPreview(out.draft, bp));
    await sendConfirmButtons(from);
    return;
  }

  if (s.step === "collecting_doc" && s.mode) {
    const result = await generateDocumentFromText({
      userId: from,
      mode: s.mode,
      text,
    });

    if (!result.ok) {
      await sendText(from, "❌ Erreur génération.\nEx:\nClient: Awa\nDesign logo x1 30000\nImpression x2 5000");
      return;
    }

    s.lastDocDraft = result.doc;

    const bp = await getOrCreateProfile(from);

    if (result.questions?.length) {
      s.pendingQuestion = result.questions[0];
      await sendText(from, buildPreview(result.doc, bp) + "\n\n❓ " + s.pendingQuestion);
      return;
    }

    s.step = "confirming_doc";
    await sendText(from, buildPreview(result.doc, bp));
    await sendConfirmButtons(from);
    return;
  }

  // Fallback
  await sendText(from, `🤖 J’ai reçu: "${text}"\n\nTape *menu* pour voir les options.`);
}

module.exports = { handleIncomingMessage, sendMainMenu };