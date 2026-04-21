"use strict";

const { sendText, sendButtons } = require("./kadiMessaging");

function safeText(value, fallback = "") {
  const s = String(value ?? "").trim();
  return s || fallback;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getAdminWaId() {
  return (
    safeText(process.env.KADI_ADMIN_WA, "") ||
    safeText(process.env.ADMIN_WA_ID, "") ||
    ""
  );
}

function buildMethodLabel(method = "") {
  const m = safeText(method).toLowerCase();

  if (m === "orange_money") return "Orange Money";
  if (m === "pispi") return "PI-SPI";

  return safeText(method, "Inconnu");
}

function buildProofSummary(topup, proofKind = "text") {
  if (proofKind === "image") {
    return "📎 Preuve image reçue";
  }

  const proofText = safeText(topup?.proof_text, "");
  if (!proofText) {
    return "📝 Preuve texte non disponible";
  }

  return `📝 Preuve texte :\n${proofText.slice(0, 700)}`;
}

async function notifyAdminTopupReview(from, topup, proofKind = "text") {
  const adminWaId = getAdminWaId();

  if (!adminWaId) {
    console.warn(
      "[TOPUP] KADI_ADMIN_WA / ADMIN_WA_ID manquant, notification admin ignorée"
    );
    return false;
  }

  if (!topup?.id) {
    console.warn("[TOPUP] topup invalide pour notification admin");
    return false;
  }

  const amount = toNum(topup.amount_fcfa, 0);
  const credits = toNum(topup.credits, 0);
  const methodLabel = buildMethodLabel(topup.payment_method);
  const proofSummary = buildProofSummary(topup, proofKind);

  const text =
    "🔔 *Nouvelle recharge à valider*\n\n" +
    `👤 Utilisateur : ${safeText(from, "-")}\n` +
    `💰 Montant : ${amount} FCFA\n` +
    `🎁 Crédits : ${credits}\n` +
    `💳 Mode : ${methodLabel}\n` +
    `🧾 Référence : ${safeText(topup.reference, "-")}\n` +
    `${topup.includes_stamp ? "🟦 Inclut : Tampon offert\n" : ""}` +
    `📌 Statut : ${safeText(topup.status, "pending_review")}\n\n` +
    proofSummary;

  await sendText(adminWaId, text);

  if (proofKind === "image" && safeText(topup.proof_image_url, "")) {
    await sendText(
      adminWaId,
      `🖼️ Preuve image enregistrée : ${safeText(topup.proof_image_url)}`
    );
  }

  await sendButtons(adminWaId, "Action admin :", [
    { id: `TOPUP_APPROVE_${topup.id}`, title: "Valider" },
    { id: `TOPUP_REJECT_${topup.id}`, title: "Refuser" },
  ]);

  return true;
}

module.exports = {
  notifyAdminTopupReview,
};