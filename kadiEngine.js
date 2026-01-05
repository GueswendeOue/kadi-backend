"use strict";

const { getSession } = require("./kadiState");
const { getOrCreateProfile, updateProfile } = require("./store");
const { uploadLogoBuffer } = require("./supabaseStorage");
const { sendText, sendButtons, getMediaInfo, downloadMediaToBuffer } = require("./whatsappApi");

function norm(s) {
  return String(s || "").trim();
}

async function sendMainMenu(to) {
  // WhatsApp buttons max = 3
  return sendButtons(
    to,
    "📋 *Menu KADI*\nChoisis une action :",
    [
      { id: "MENU_DEVIS", title: "Créer un devis" },
      { id: "MENU_FACTURE", title: "Créer une facture" },
      { id: "MENU_PROFIL", title: "Profil entreprise" }
    ]
  );
}

async function sendDocMenu(to) {
  return sendButtons(
    to,
    "📄 *Type de document*\nChoisis :",
    [
      { id: "DOC_DEVIS", title: "Devis" },
      { id: "DOC_FACTURE", title: "Facture" },
      { id: "DOC_RECU", title: "Reçu" }
    ]
  );
}

async function startProfileFlow(from) {
  const s = getSession(from);
  s.step = "profile";
  s.profileStep = "business_name";

  await getOrCreateProfile(from);

  await sendText(
    from,
    "🏢 *Profil entreprise*\n\n1/7 — Quel est le *nom* de ton entreprise ?\nEx: Kadi SARL"
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
    await sendText(
      from,
      "7/7 — Envoie maintenant ton *logo* en image 📷 (png/jpg).\n\n📌 Si tu n’as pas de logo, tape -"
    );
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
    // S'il tape un texte au lieu d'image
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
    mimeType: mime
  });

  await updateProfile(from, { logo_path: filePath });

  // si on est dans le flow profil
  if (s.step === "profile" && s.profileStep === "logo") {
    s.step = "idle";
    s.profileStep = null;
    await sendText(from, "✅ Logo enregistré ! Profil terminé.");
    await sendMainMenu(from);
    return;
  }

  await sendText(from, "✅ Logo enregistré !");
}

async function handleInteractiveReply(from, replyId) {
  const s = getSession(from);

  if (replyId === "MENU_DEVIS") {
    s.step = "collecting_doc";
    s.mode = "devis";
    await sendText(from, "📝 OK. Envoie les lignes.\nEx:\nClient: Karim\nChaise x2 5000\nTable x1 20000");
    return;
  }

  if (replyId === "MENU_FACTURE") {
    s.step = "collecting_doc";
    s.mode = "facture";
    await sendText(from, "🧾 OK. Envoie les lignes.\nEx:\nClient: Awa\nDesign logo x1 30000\nImpression x2 5000");
    return;
  }

  if (replyId === "MENU_PROFIL") {
    await startProfileFlow(from);
    return;
  }

  if (replyId === "DOC_DEVIS" || replyId === "DOC_FACTURE" || replyId === "DOC_RECU") {
    const map = { DOC_DEVIS: "devis", DOC_FACTURE: "facture", DOC_RECU: "recu" };
    s.step = "collecting_doc";
    s.mode = map[replyId];
    await sendText(from, `📄 OK. Mode: *${s.mode}*\nEnvoie tes détails.`);
    return;
  }

  await sendText(from, "⚠️ Action non reconnue. Tape *menu*.");
}

async function handleIncomingMessage(value) {
  // value = change.value
  if (!value) return;

  // STATUSES
  if (value.statuses?.length) {
    const st = value.statuses[0];
    console.log("📊 Status:", st.status, "id:", st.id);
    return;
  }

  // MESSAGES
  if (!value.messages?.length) {
    console.log("ℹ️ Webhook reçu sans messages (probablement status/update).");
    return;
  }

  const msg = value.messages[0];
  const from = msg.from;

  // Interactive reply button
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

  // Priorité : si on est dans flow profil
  const consumed = await handleProfileAnswer(from, text);
  if (consumed) return;

  if (lower === "menu" || lower === "m") {
    await sendMainMenu(from);
    return;
  }

  // Option: "profil"
  if (lower === "profil" || lower === "profile") {
    await startProfileFlow(from);
    return;
  }

  // fallback
  await sendText(from, `🤖 J’ai reçu: "${text}"\n\nTape *menu* pour voir les options.`);
}

module.exports = { handleIncomingMessage, sendMainMenu };