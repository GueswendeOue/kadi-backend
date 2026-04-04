"use strict";

const { sendText, sendButtons } = require("./whatsappApi");

async function notifyAdminTopupReview(from, topup, proofKind = "text") {
  const adminWaId = process.env.ADMIN_WA_ID;

  if (!adminWaId) {
    console.warn("[TOPUP] ADMIN_WA_ID manquant, notification admin ignorée");
    return;
  }

  if (!topup?.id) {
    console.warn("[TOPUP] topup invalide pour notification admin");
    return;
  }

  const amount = Number(topup.amount_fcfa || 0);
  const credits = Number(topup.credits || 0);
  const methodLabel =
    topup.payment_method === "orange_money"
      ? "Orange Money"
      : topup.payment_method === "pispi"
      ? "PI-SPI"
      : topup.payment_method || "Inconnu";

  const proofSummary =
    proofKind === "image"
      ? "📎 Preuve image reçue"
      : topup.proof_text
      ? `📝 Preuve texte :\n${String(topup.proof_text).slice(0, 500)}`
      : "📝 Preuve texte non disponible";

  const text =
    "🔔 *Nouvelle recharge à valider*\n\n" +
    `👤 Utilisateur : ${from}\n` +
    `💰 Montant : ${amount} FCFA\n` +
    `🎁 Crédits : ${credits}\n` +
    `💳 Mode : ${methodLabel}\n` +
    `🧾 Référence : ${topup.reference || "-"}\n` +
    (topup.includes_stamp ? "🟦 Inclut : Tampon offert\n" : "") +
    `📌 Statut : ${topup.status || "pending_review"}\n\n` +
    `${proofSummary}`;

  await sendText(adminWaId, text);

  if (proofKind === "image" && topup.proof_image_url) {
    await sendText(
      adminWaId,
      `🖼️ Preuve image enregistrée : ${topup.proof_image_url}`
    );
  }

  await sendButtons(adminWaId, "Action admin :", [
    { id: `TOPUP_APPROVE_${topup.id}`, title: "Valider" },
    { id: `TOPUP_REJECT_${topup.id}`, title: "Refuser" },
  ]);
}

module.exports = {
  notifyAdminTopupReview,
};