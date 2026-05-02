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

  if (/\b(fcfa|franc|montant|avance|paiement|payer|versement|acompte)\b/.test(t) && /\b(objet|bien|materiel|materiau|machine|telephone|perceuse)\b/.test(t)) {
    return "mixte";
  }

  if (/\b(fcfa|franc|montant|avance|paiement|payer|versement|acompte)\b/.test(t)) {
    return "argent";
  }

  if (/\b(telephone|tel|iphone|samsung|appareil|ordinateur|pc|moto|velo|machine|perceuse)\b/.test(t)) {
    return "objet";
  }

  if (/\b(ciment|fer|sable|gravier|chantier|travaux|materiaux|materiel)\b/.test(t)) {
    return "travaux";
  }

  return "autre";
}

function formatAmount(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Intl.NumberFormat("fr-FR").format(Math.round(n));
}

function cleanValue(value = "") {
  const s = String(value || "").trim();
  return s || null;
}

function normalizeDechargeFields(doc = {}) {
  const amountReceived = Number(
    doc.amount_received ??
      doc.amountReceived ??
      doc.receivedAmount ??
      (doc.dechargeType === "argent" || doc.dechargeType === "mixte"
        ? doc.total ?? doc.finance?.gross
        : 0) ??
      0
  );

  const explicitObjectLabel =
    cleanValue(doc.object_label) ||
    cleanValue(doc.objectLabel) ||
    cleanValue(doc.receivedObject) ||
    null;

  const subjectObjectLabel =
    amountReceived > 0 && doc.dechargeType === "argent"
      ? null
      : cleanValue(doc.subject);

  const objectLabel = explicitObjectLabel || subjectObjectLabel || null;

  const objectValue = Number(
    doc.object_value ?? doc.objectValue ?? doc.value ?? 0
  );

  const purpose =
    cleanValue(doc.discharge_purpose) ||
    cleanValue(doc.dischargePurpose) ||
    cleanValue(doc.purpose) ||
    cleanValue(doc.motif) ||
    null;

  const cniNumber =
    cleanValue(doc.cni_number) ||
    cleanValue(doc.cniNumber) ||
    cleanValue(doc.identity_number) ||
    cleanValue(doc.identityNumber) ||
    null;

  const receiverPhone =
    cleanValue(doc.receiver_phone) ||
    cleanValue(doc.receiverPhone) ||
    cleanValue(doc.clientPhone) ||
    null;

  let dechargeType = cleanValue(doc.dechargeType) || "autre";
  if (objectLabel && amountReceived > 0) dechargeType = "mixte";
  else if (amountReceived > 0) dechargeType = "argent";
  else if (objectLabel) dechargeType = "objet";

  return {
    client: cleanValue(doc.client),
    cni_number: cniNumber,
    receiver_phone: receiverPhone,
    object_label: objectLabel,
    amount_received: Number.isFinite(amountReceived) ? amountReceived : 0,
    object_value: Number.isFinite(objectValue) ? objectValue : 0,
    discharge_purpose: purpose,
    dechargeType,
  };
}

function buildIdentityClause(fields) {
  const parts = [];
  if (fields.cni_number) {
    parts.push(`titulaire de la pièce d’identité N° ${fields.cni_number}`);
  }
  if (fields.receiver_phone) {
    parts.push(`joignable au ${fields.receiver_phone}`);
  }
  return parts.length ? `, ${parts.join(", ")}` : "";
}

function buildDechargeText(input = {}) {
  const fields = normalizeDechargeFields(input);
  const name = fields.client || "—";
  const biz = input.businessName || "—";
  const identity = buildIdentityClause(fields);
  const amount = formatAmount(fields.amount_received);
  const objectLabel = fields.object_label;
  const purpose = fields.discharge_purpose;
  const finalSentence =
    "La présente décharge est établie pour servir et valoir ce que de droit.";

  let body;

  if (objectLabel && amount) {
    body =
      `Je soussigné(e), ${name}${identity}, reconnais avoir reçu de la part de ${biz} :\n` +
      `- Objet : ${objectLabel}\n` +
      `- Somme : ${amount} FCFA`;
  } else if (amount) {
    body = `Je soussigné(e), ${name}${identity}, reconnais avoir reçu de la part de ${biz} la somme de ${amount} FCFA.`;
  } else if (objectLabel) {
    body = `Je soussigné(e), ${name}${identity}, reconnais avoir reçu de la part de ${biz} l’objet suivant : ${objectLabel}.`;
  } else {
    const fallback = purpose || "les éléments indiqués";
    body = `Je soussigné(e), ${name}${identity}, reconnais avoir reçu de la part de ${biz} : ${fallback}.`;
  }

  if (purpose && purpose !== objectLabel) {
    body += `\n\nCette remise est faite pour : ${purpose}.`;
  }

  return `${body}\n\n${finalSentence}`;
}

function buildDechargePreviewMessage({ doc, money }) {
  const fields = normalizeDechargeFields(doc);
  const amountReceived = Number(fields.amount_received || 0);
  const objectValue = Number(fields.object_value || 0);

  const lines = [
    `📄 *APERÇU*`,
    `Type: DÉCHARGE`,
    `Date: ${doc?.date || "-"}`,
    `Concerné: ${fields.client || "—"}`,
  ];

  if (fields.cni_number) lines.push(`CNI / Pièce: ${fields.cni_number}`);
  if (fields.receiver_phone) {
    lines.push(`Téléphone / WhatsApp: ${fields.receiver_phone}`);
  }
  if (fields.object_label) lines.push(`Objet reçu: ${fields.object_label}`);
  if (amountReceived > 0) {
    lines.push(`Somme reçue: *${money(amountReceived)} FCFA*`);
  }
  if (objectValue > 0) {
    lines.push(`Valeur estimée: *${money(objectValue)} FCFA*`);
  }
  if (fields.discharge_purpose) lines.push(`Motif: ${fields.discharge_purpose}`);

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
    cni_number: null,
    receiver_phone: null,
    object_label: null,
    amount_received: null,
    object_value: null,
    discharge_purpose: null,
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
  const fields = normalizeDechargeFields(doc);
  const amountReceived = Number(fields.amount_received || 0);

  const lines = [
    `📄 *Demande de confirmation - Décharge KADI*`,
    ``,
    `Une décharge a été préparée avec les informations suivantes :`,
    `• Concerné : ${fields.client || "—"}`,
  ];

  if (fields.object_label) lines.push(`• Objet : ${fields.object_label}`);
  if (amountReceived > 0) {
    lines.push(`• Somme : ${money(amountReceived)} FCFA`);
  }
  if (fields.discharge_purpose) lines.push(`• Motif : ${fields.discharge_purpose}`);

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
  normalizeDechargeFields,
  buildDechargeText,
  buildDechargePreviewMessage,
  initDechargeDraft,
  buildDechargeConfirmationMessage,
  buildPostConfirmationMessage,
};
