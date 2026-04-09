"use strict";

// ===============================
// HELPERS
// ===============================
function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatMoney(n) {
  const value = toNumber(n);
  if (value == null) return null;

  return (
    value.toLocaleString("fr-FR", {
      maximumFractionDigits: 0,
    }) + " FCFA"
  );
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value = "") {
  return String(value || "").trim();
}

// ===============================
// DOC LABEL
// ===============================
function getDocLabel(intent = {}) {
  switch (intent?.docType) {
    case "facture":
      return intent?.factureKind === "proforma"
        ? "📄 Facture proforma"
        : "📄 Facture";
    case "recu":
      return "🧾 Reçu";
    case "decharge":
      return "📝 Décharge";
    default:
      return "📋 Devis";
  }
}

// ===============================
// COMPUTE TOTAL
// ===============================
function computeIntentTotal(intent = {}) {
  const explicitTotal = toNumber(intent?.total);
  if (explicitTotal != null && explicitTotal >= 0) {
    return explicitTotal;
  }

  const items = safeArray(intent?.items);
  if (!items.length) return null;

  let sum = 0;
  let hasAtLeastOneLine = false;

  for (const item of items) {
    const qty = toNumber(item?.qty) ?? 1;
    const unitPrice = toNumber(item?.unitPrice);
    const lineTotal = toNumber(item?.lineTotal);

    if (lineTotal != null && lineTotal >= 0) {
      sum += lineTotal;
      hasAtLeastOneLine = true;
      continue;
    }

    if (unitPrice != null && unitPrice >= 0 && qty > 0) {
      sum += Math.round(qty * unitPrice);
      hasAtLeastOneLine = true;
    }
  }

  return hasAtLeastOneLine ? sum : null;
}

// ===============================
// NORMALIZE DISPLAY DATA
// ===============================
function normalizeIntentForUx(intent = {}) {
  return {
    docType: intent?.docType || "devis",
    factureKind: intent?.factureKind || null,
    client: safeString(intent?.client),
    motif: safeString(intent?.motif),
    items: safeArray(intent?.items),
    missing: safeArray(intent?.missing),
    total: computeIntentTotal(intent),
    confidence: toNumber(intent?.confidence),
  };
}

// ===============================
// MESSAGE PRINCIPAL
// ===============================
function buildIntentMessage(intent = {}) {
  const data = normalizeIntentForUx(intent);
  const parts = [];

  parts.push(`🎤 *${getDocLabel(data)}*`);
  parts.push("");
  parts.push("Voici ce que j’ai compris 👇");
  parts.push("");

  if (data.client) {
    parts.push(`👤 *Client* : ${data.client}`);
    parts.push("");
  }

  if (data.motif && data.items.length === 0) {
    parts.push(`📝 *Motif* : ${data.motif}`);
    parts.push("");
  }

  if (data.items.length > 0) {
    parts.push("📦 *Détails* :");

    for (const item of data.items) {
      const label = safeString(item?.label) || "Produit";
      const qty = toNumber(item?.qty) ?? 1;
      const unitPrice = toNumber(item?.unitPrice);
      const lineTotal =
        toNumber(item?.lineTotal) ??
        (unitPrice != null ? Math.round(qty * unitPrice) : null);

      let line = `• ${label} × ${qty}`;

      if (unitPrice != null) {
        line += ` — ${formatMoney(unitPrice)}`;
      }

      if (lineTotal != null && qty > 1) {
        line += ` (Mt: ${formatMoney(lineTotal)})`;
      }

      parts.push(line);
    }

    parts.push("");
  }

  if (data.total != null && data.total >= 0) {
    parts.push(`💰 *Total estimé* : ${formatMoney(data.total)}`);
    parts.push("");
  }

  if (data.missing.length === 0) {
    parts.push("✅ Tout est prêt.");
  } else {
    parts.push("⚠️ Quelques infos manquent :");

    if (data.missing.includes("client")) {
      parts.push("• Nom du client");
    }

    if (data.missing.includes("items")) {
      parts.push("• Éléments / prestations");
    }

    if (data.missing.includes("price")) {
      parts.push("• Prix de certains éléments");
    }

    parts.push("");
  }

  if (data.confidence != null) {
    if (data.confidence >= 0.85) {
      parts.push("🟢 Compréhension très bonne");
    } else if (data.confidence >= 0.6) {
      parts.push("🟡 Vérification conseillée");
    } else {
      parts.push("🔶 Vérifiez avant validation");
    }
  }

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ===============================
// QUESTION GUIDÉE
// ===============================
function getNextQuestion(intent = {}) {
  const data = normalizeIntentForUx(intent);

  if (data.missing.includes("client")) {
    if (data.docType === "decharge") {
      return "👤 Quel est le nom de la personne concernée ?";
    }

    return "👤 Quel est le nom du client ?";
  }

  if (data.missing.includes("items")) {
    if (data.docType === "decharge" || data.docType === "recu") {
      return "📝 Quel est le motif ?\n\nEx: Loyer avril ou avance chantier";
    }

    return "📦 Quels sont les éléments ?\n\nEx: 2 portes à 25000 et 2 fenêtres à 5000";
  }

  if (data.missing.includes("price")) {
    const item = data.items.find((i) => toNumber(i?.unitPrice) == null);

    if (item) {
      const label = safeString(item?.label) || "cet article";
      return `💰 Quel est le prix pour *${label}* ?\n\nEx: 5000`;
    }

    return "💰 Quel est le prix ?";
  }

  return null;
}

module.exports = {
  formatMoney,
  getDocLabel,
  computeIntentTotal,
  buildIntentMessage,
  getNextQuestion,
};