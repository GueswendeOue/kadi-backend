"use strict";

// ================= Logger =================
const logger = {
  info: (c, m, meta = {}) => console.log(`[KADI/INFO/${c}]`, m, meta),
  warn: (c, m, meta = {}) => console.warn(`[KADI/WARN/${c}]`, m, meta),
  error: (c, e, meta = {}) =>
    console.error(`[KADI/ERROR/${c}]`, e?.message || e, { ...meta, stack: e?.stack }),
};

// ================= Imports =================
const { getSession } = require("./kadiState");
const { nextDocNumber } = require("./kadiCounter");
const { buildPdfBuffer } = require("./kadiPdf");
const { saveDocument } = require("./kadiRepo");
const { getOrCreateProfile, updateProfile } = require("./store");
const { uploadMediaBuffer, getSignedLogoUrl, downloadSignedUrlToBuffer } = require("./supabaseStorage");
const { sendText, sendButtons, sendList, getMediaInfo, downloadMediaToBuffer, sendDocument } = require("./whatsappApi");
const { getBalance, consumeCredit, addCredits } = require("./kadiCreditsRepo");
const { recordActivity } = require("./kadiActivityRepo");

let kadiStamp = null;
try { kadiStamp = require("./kadiStamp"); } catch (_) {}

const LIMITS = {
  maxItems: 100,
  maxItemLabelLength: 200,
  maxClientNameLength: 100,
};

// ================= Utils =================
const safe = (v) => String(v || "").trim();
const norm = (v) => String(v || "").trim();
const cleanNumber = (s) => {
  if (!s) return null;
  const n = Number(String(s).replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const REGEX = {
  client: /^client\s*[:\-]\s*(.+)$/i,
};

// ================= Stamp wrapper =================
async function applyStampIfAny(pdfBuffer, profile) {
  if (kadiStamp?.applyStampToPdfBuffer) {
    try {
      return await kadiStamp.applyStampToPdfBuffer(pdfBuffer, profile);
    } catch (e) {
      logger.warn("stamp", e.message);
    }
  }
  return pdfBuffer;
}

// ================= Finance =================
function computeFinance(doc) {
  let sum = 0;
  for (const it of doc.items || []) sum += Number(it.amount || 0);
  return { gross: sum };
}

// ================= Menus =================
async function sendHomeMenu(to) {
  return sendButtons(to, "🏠 *Menu KADI*", [
    { id: "HOME_DOCS", title: "Documents" },
    { id: "HOME_PROFILE", title: "Profil" },
    { id: "HOME_CREDITS", title: "Crédits" },
  ]);
}

async function sendDocsMenu(to) {
  return sendButtons(to, "📄 Quel document ?", [
    { id: "DOC_DEVIS", title: "Devis" },
    { id: "DOC_FACTURE", title: "Facture" },
    { id: "DOC_RECU", title: "Reçu" },
    { id: "DOC_DECHARGE", title: "Décharge" },
  ]);
}

async function sendAddMoreMenu(to) {
  return sendButtons(to, "✅ Produit ajouté. Que faire ?", [
    { id: "ITEM_ADD_MORE", title: "Ajouter" },
    { id: "ITEM_FINISH", title: "Terminer" },
    { id: "BACK_DOCS", title: "Annuler" },
  ]);
}

// ================= DOC FLOW =================
async function startDocFlow(from, mode) {
  const s = getSession(from);

  s.step = "item_label";
  s.mode = mode;
  s.itemDraft = { label: null, qty: null, unitPrice: null };
  s.lastDocDraft = {
    type: mode,
    date: new Date().toISOString().slice(0, 10),
    client: null,
    items: [],
    source: "wizard",
  };

  await sendText(
    from,
    `🧾 *${mode.toUpperCase()}*\n\n` +
    `👤 Vous pouvez taper *Client: Nom* à tout moment.\n\n` +
    `➡️ *Nom du produit 1 ?*`
  );
}
// ================= ITEM WIZARD =================
async function askQty(from) {
  const s = getSession(from);
  const label = s.itemDraft?.label || "—";
  await sendText(from, `📦 Produit : *${label}*\n\n➡️ Quantité ? (ex: 2)`);
}

async function askUnitPrice(from) {
  const s = getSession(from);
  const label = s.itemDraft?.label || "—";
  const qty = s.itemDraft?.qty || 1;
  await sendText(from, `📦 Produit : *${label}*\nQté : *${qty}*\n\n➡️ Prix unitaire ? (ex: 5000)`);
}

function pushItem(session) {
  const d = session.itemDraft || {};
  const label = safe(d.label).slice(0, LIMITS.maxItemLabelLength) || "—";
  const qty = Number(d.qty || 1);
  const unitPrice = Number(d.unitPrice || 0);
  const amount = qty * unitPrice;

  session.lastDocDraft.items.push({
    label,
    qty,
    unitPrice,
    amount,
    raw: `${label} x${qty} ${unitPrice}`,
  });

  session.itemDraft = { label: null, qty: null, unitPrice: null };
}

// ================= Preview =================
async function sendPreview(from) {
  const s = getSession(from);
  const doc = s.lastDocDraft;
  if (!doc) return;

  const f = computeFinance(doc);

  const lines = (doc.items || [])
    .slice(0, 20)
    .map((it, i) => `${i + 1}) ${it.label} | Qté:${it.qty} | PU:${it.unitPrice} | Mt:${it.amount}`)
    .join("\n");

  await sendText(
    from,
    `📄 *APERÇU*\n` +
      `Type: *${String(doc.type || "").toUpperCase()}*\n` +
      `Date: ${doc.date}\n` +
      `Client: ${doc.client || "—"}\n\n` +
      `*Lignes (${doc.items.length})*\n${lines || "—"}\n\n` +
      `TOTAL: *${f.gross} FCFA*`
  );

  return sendButtons(from, "✅ Valider ?", [
    { id: "DOC_CONFIRM", title: "Générer PDF" },
    { id: "ITEM_ADD_MORE", title: "Ajouter" },
    { id: "BACK_DOCS", title: "Annuler" },
  ]);
}

// ================= PDF =================
async function createAndSendPdf(from) {
  const s = getSession(from);
  const draft = s.lastDocDraft;

  if (!draft) {
    await sendText(from, "❌ Aucun document en cours.");
    return sendHomeMenu(from);
  }

  if (!draft.client) {
    await sendText(from, "⚠️ Client manquant. Tapez: *Client: Nom*");
    return;
  }

  if (!draft.items?.length) {
    await sendText(from, "⚠️ Ajoutez au moins 1 produit.");
    return;
  }

  // 1 crédit par PDF
  const cons = await consumeCredit(from, 1, "pdf");
  if (!cons.ok) {
    await sendText(from, `❌ Solde insuffisant (${cons.balance}). Tapez *RECHARGE*`);
    return;
  }

  try {
    // doc number
    const docNumber = await nextDocNumber({
      waId: from,
      mode: draft.type,
      factureKind: null,
      dateISO: draft.date,
    });

    const profile = await getOrCreateProfile(from);

    let logoBuf = null;
    if (profile?.logo_path) {
      try {
        const signed = await getSignedLogoUrl(profile.logo_path);
        logoBuf = await downloadSignedUrlToBuffer(signed);
      } catch (_) {}
    }

    const total = computeFinance(draft).gross;

    let pdfBuf = await buildPdfBuffer({
      docData: {
        type: String(draft.type || "").toUpperCase(),
        docNumber,
        date: draft.date,
        client: draft.client,
        items: draft.items,
        total,
      },
      businessProfile: profile,
      logoBuffer: logoBuf,
    });

    // ✅ tampon (si activé)
    pdfBuf = await applyStampIfAny(pdfBuf, profile);

    try {
      await saveDocument({ waId: from, doc: { ...draft, docNumber, total } });
    } catch (_) {}

    const fileName = `${docNumber}-${draft.date}.pdf`;
    const up = await uploadMediaBuffer({
      buffer: pdfBuf,
      filename: fileName,
      mimeType: "application/pdf",
    });

    if (!up?.id) throw new Error("Upload PDF échoué");

    await sendDocument({
      to: from,
      mediaId: up.id,
      filename: fileName,
      caption: `✅ ${String(draft.type).toUpperCase()} ${docNumber}\nTotal: ${total} FCFA\nSolde: ${cons.balance}`,
    });

    // reset
    s.step = "idle";
    s.mode = null;
    s.itemDraft = null;
    s.lastDocDraft = null;

    return sendHomeMenu(from);
  } catch (e) {
    // rollback credit if fail early? (optionnel)
    try { await addCredits(from, 1, "rollback_pdf_fail"); } catch (_) {}
    await sendText(from, "❌ Erreur PDF. Réessayez.");
  }
}

// ================= Interactive handler =================
async function handleInteractiveReply(from, replyId) {
  const s = getSession(from);

  if (replyId === "BACK_HOME") return sendHomeMenu(from);
  if (replyId === "BACK_DOCS") {
    s.step = "idle";
    s.mode = null;
    s.itemDraft = null;
    s.lastDocDraft = null;
    return sendDocsMenu(from);
  }

  if (replyId === "HOME_DOCS") return sendDocsMenu(from);
  if (replyId === "HOME_PROFILE") return sendText(from, "🏢 Profil: (à garder ton flow existant)");
  if (replyId === "HOME_CREDITS") {
    const bal = await getBalance(from);
    return sendText(from, `💳 Solde: ${bal} crédit(s)`);
  }

  if (replyId === "DOC_DEVIS") return startDocFlow(from, "devis");
  if (replyId === "DOC_FACTURE") return startDocFlow(from, "facture");
  if (replyId === "DOC_RECU") return startDocFlow(from, "recu");
  if (replyId === "DOC_DECHARGE") return startDocFlow(from, "decharge");

  if (replyId === "ITEM_ADD_MORE") {
    s.step = "item_label";
    s.itemDraft = { label: null, qty: null, unitPrice: null };
    return sendText(from, "➡️ Nom du prochain produit ?");
  }

  if (replyId === "ITEM_FINISH") {
    return sendPreview(from);
  }

  if (replyId === "DOC_CONFIRM") {
    return createAndSendPdf(from);
  }

  return sendText(from, "⚠️ Action inconnue. Tapez MENU.");
}

// ================= Text router (wizard) =================
async function handleWizardText(from, text) {
  const s = getSession(from);
  const t = norm(text);

  // client à tout moment
  const mClient = REGEX.client.exec(t);
  if (mClient && s.lastDocDraft) {
    s.lastDocDraft.client = safe(mClient[1]).slice(0, LIMITS.maxClientNameLength);
    await sendText(from, `✅ Client défini: *${s.lastDocDraft.client}*`);
    // on continue le step en cours sans casser
    if (s.step === "item_label") return sendText(from, "➡️ Nom du produit ?");
    if (s.step === "item_qty") return askQty(from);
    if (s.step === "item_pu") return askUnitPrice(from);
    return true;
  }

  if (s.step === "item_label") {
    if (!s.lastDocDraft) return false;
    s.itemDraft.label = safe(t);
    s.step = "item_qty";
    await askQty(from);
    return true;
  }

  if (s.step === "item_qty") {
    const q = cleanNumber(t);
    if (!q || q <= 0) {
      await sendText(from, "❌ Quantité invalide. Ex: 2");
      return true;
    }
    s.itemDraft.qty = q;
    s.step = "item_pu";
    await askUnitPrice(from);
    return true;
  }

  if (s.step === "item_pu") {
    const pu = cleanNumber(t);
    if (pu == null || pu < 0) {
      await sendText(from, "❌ Prix invalide. Ex: 5000");
      return true;
    }
    s.itemDraft.unitPrice = pu;
    pushItem(s);

    // proposition UX: afficher aperçu mini puis menu ajouter/terminer
    const last = s.lastDocDraft.items[s.lastDocDraft.items.length - 1];
    await sendText(from, `✅ Ajouté: ${last.label} | Qté:${last.qty} | PU:${last.unitPrice} | Mt:${last.amount}`);
    await sendAddMoreMenu(from);
    return true;
  }

  return false;
}

// ================= MAIN ENTRY =================
async function handleIncomingMessage(value) {
  try {
    if (!value) return;
    if (value.statuses?.length) return;
    if (!value.messages?.length) return;

    const msg = value.messages[0];
    const from = msg.from;

    // activity
    try { await recordActivity(from); } catch (_) {}

    // interactive
    if (msg.type === "interactive") {
      const replyId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
      if (replyId) return handleInteractiveReply(from, replyId);
      return;
    }

    // image (pour l’instant on ne touche pas OCR ici)
    if (msg.type === "image") {
      await sendText(from, "📷 OCR: garde ton module OCR existant (on le recolle ensuite proprement).");
      return;
    }

    // text
    const text = norm(msg.text?.body);
    if (!text) return;

    const lower = text.toLowerCase().trim();
    if (lower === "menu" || lower === "m") return sendHomeMenu(from);
    if (lower === "docs" || lower === "documents") return sendDocsMenu(from);

    // wizard
    if (await handleWizardText(from, text)) return;

    // fallback
    await sendText(from, "Tapez *MENU* pour commencer.");
  } catch (e) {
    logger.error("incoming_message", e);
  }
}

// ================= EXPORTS =================
module.exports = {
  handleIncomingMessage,
  cleanNumber,
};