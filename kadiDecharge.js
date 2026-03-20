"use strict";

function normalizeText(input = "") {
  return String(input)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function detectDechargeType(text = "") {
  const t = normalizeText(text);

  if (/\b(fcfa|franc|montant|avance|paiement|payer|versement|acompte)\b/.test(t)) {
    return "argent";
  }

  if (/\b(telephone|tel|iphone|samsung|appareil|ordinateur|pc|moto|velo|machine)\b/.test(t)) {
    return "objet";
  }

  if (/\b(ciment|fer|sable|gravier|chantier|travaux|materiaux|materiel)\b/.test(t)) {
    return "travaux";
  }

  return "autre";
}

function buildDechargeText({ client, businessName, motif, total, dechargeType }) {
  const name = client || "—";
  const biz = businessName || "—";
  const reason = motif || "objet non précisé";
  const amount = Number(total || 0);

  if (dechargeType === "argent") {
    return `Je soussigné(e), ${name}, reconnais avoir reçu de la part de ${biz} la somme de ${amount} FCFA au titre de : ${reason}. La présente décharge est établie pour servir et valoir ce que de droit.`;
  }

  if (dechargeType === "objet") {
    return `Je soussigné(e), ${name}, reconnais avoir reçu de la part de ${biz} le bien suivant : ${reason}. La présente décharge est établie pour servir et valoir ce que de droit.`;
  }

  if (dechargeType === "travaux") {
    return `Je soussigné(e), ${name}, reconnais avoir reçu de la part de ${biz} les éléments suivants : ${reason}. Cette décharge confirme la réception dans le cadre des travaux.`;
  }

  return `Je soussigné(e), ${name}, reconnais avoir reçu de la part de ${biz} : ${reason}. La présente décharge est établie pour servir et valoir ce que de droit.`;
}

function buildDechargePreviewMessage({ doc, money }) {
  const total = Number(doc?.finance?.gross || 0);

  const lines = [
    `📄 *APERÇU*`,
    `Type: DÉCHARGE`,
    `Date: ${doc?.date || "-"}`,
    `Concerné: ${doc?.client || "—"}`,
    `Motif: ${doc?.motif || "—"}`,
  ];

  if (total > 0) {
    lines.push(`Montant: *${money(total)} FCFA*`);
  }

  if (doc?.confirmation?.requested && doc?.confirmation?.targetWaId) {
    lines.push(`Confirmation WhatsApp: ${doc.confirmation.targetWaId}`);
  }

  return lines.join("\n");
}

function initDechargeDraft({ dateISO, makeDraftMeta }) {
  return {
    type: "decharge",
    factureKind: null,
    docNumber: null,
    date: dateISO,
    client: null,
    motif: null,
    dechargeType: "autre",
    items: [],
    finance: null,
    source: "decharge_flow",
    meta: makeDraftMeta(),
    confirmation: {
      requested: false,
      targetWaId: null,
      confirmed: false,
      confirmedAt: null,
      confirmedBy: null,
    },
  };
}

function buildDechargeConfirmationMessage({ doc, money }) {
  const total = Number(doc?.finance?.gross || 0);

  const lines = [
    `📄 *Demande de confirmation - Décharge KADI*`,
    ``,
    `Une décharge a été préparée avec les informations suivantes :`,
    `• Concerné : ${doc?.client || "—"}`,
    `• Motif : ${doc?.motif || "—"}`,
  ];

  if (total > 0) {
    lines.push(`• Montant : ${money(total)} FCFA`);
  }

  lines.push("");
  lines.push(`Si vous confirmez ces informations, répondez simplement :`);
  lines.push(`*CONFIRMER*`);

  return lines.join("\n");
}

function buildPostConfirmationMessage({ isFirstTime = false, kadiWaLink = "" }) {
  if (isFirstTime) {
    return [
      `✅ Confirmation enregistrée.`,
      ``,
      `KADI peut aussi vous aider sur WhatsApp pour créer :`,
      `• devis`,
      `• factures`,
      `• reçus`,
      `• décharges`,
      ``,
      kadiWaLink ? `Essayez KADI ici : ${kadiWaLink}` : `Essayez simplement en envoyant votre demande 🙂`,
    ].join("\n");
  }

  return [
    `✅ Confirmation enregistrée.`,
    ``,
    `Besoin d’un autre document ? Écrivez simplement votre demande 👍`,
  ].join("\n");
}

module.exports = {
  detectDechargeType,
  buildDechargeText,
  buildDechargePreviewMessage,
  initDechargeDraft,
  buildDechargeConfirmationMessage,
  buildPostConfirmationMessage,
};