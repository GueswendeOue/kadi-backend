"use strict";

const QRCode = require("qrcode");

function safe(v) {
  return String(v || "").trim();
}

function fmtNumber(n) {
  const x = Math.round(Number(n || 0));
  if (!Number.isFinite(x)) return "0";
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function numberToFrench(n) {
  n = Math.floor(Number(n) || 0);
  if (n === 0) return "zéro";

  const units = [
    "",
    "un",
    "deux",
    "trois",
    "quatre",
    "cinq",
    "six",
    "sept",
    "huit",
    "neuf",
  ];

  function under100(x) {
    if (x < 10) return units[x];

    if (x < 17) {
      return [
        "dix",
        "onze",
        "douze",
        "treize",
        "quatorze",
        "quinze",
        "seize",
      ][x - 10];
    }

    if (x < 20) return `dix-${units[x - 10]}`;

    if (x < 70) {
      const tensMap = {
        20: "vingt",
        30: "trente",
        40: "quarante",
        50: "cinquante",
        60: "soixante",
      };

      const ten = Math.floor(x / 10) * 10;
      const unit = x % 10;

      if (unit === 0) return tensMap[ten];
      if (unit === 1) return `${tensMap[ten]} et un`;
      return `${tensMap[ten]}-${units[unit]}`;
    }

    if (x < 80) {
      if (x === 71) return "soixante et onze";
      return `soixante-${under100(x - 60)}`;
    }

    if (x === 80) return "quatre-vingts";
    if (x < 100) return `quatre-vingt-${under100(x - 80)}`;

    return "";
  }

  function under1000(x) {
    const h = Math.floor(x / 100);
    const r = x % 100;

    let s = "";

    if (h > 0) {
      s = h === 1 ? "cent" : `${units[h]} cent`;
      if (r === 0 && h > 1) s += "s";
    }

    if (r > 0) s = s ? `${s} ${under100(r)}` : under100(r);
    return s;
  }

  const parts = [];
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1_000);
  const rest = n % 1_000;

  if (millions > 0) {
    parts.push(
      millions === 1 ? "un million" : `${under1000(millions)} millions`
    );
  }

  if (thousands > 0) {
    parts.push(thousands === 1 ? "mille" : `${under1000(thousands)} mille`);
  }

  if (rest > 0) {
    parts.push(under1000(rest));
  }

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function normalizeDocType(typeUpper) {
  const t = String(typeUpper || "").toUpperCase().trim();
  if (!t) return "DOCUMENT";
  if (t.includes("PRO FORMA")) return "FACTURE_PROFORMA";
  if (t.includes("FACTURE")) return "FACTURE";
  if (t.includes("DEVIS")) return "DEVIS";
  if (t.includes("REÇU") || t.includes("RECU")) return "RECU";
  if (t.includes("DÉCHARGE") || t.includes("DECHARGE")) return "DECHARGE";
  return "DOCUMENT";
}

function resolveRendererKey(docData = {}) {
  const typeKey = normalizeDocType(docData.type || "");
  const receiptFormat = String(docData.receiptFormat || "").toLowerCase();

  if (typeKey === "FACTURE_PROFORMA") return "facture_proforma";
  if (typeKey === "FACTURE") return "facture";
  if (typeKey === "DEVIS") return "devis";
  if (typeKey === "DECHARGE") return "decharge";
  if (typeKey === "RECU") {
    if (receiptFormat === "compact" || receiptFormat === "ticket") {
      return "recu_compact";
    }
    return "recu_a4";
  }

  throw new Error("PDF_RENDERER_UNSUPPORTED_TYPE");
}

function closingPhrase(rendererKey) {
  if (rendererKey === "facture") return "Arrêtée la présente facture";
  if (rendererKey === "facture_proforma") {
    return "Arrêtée la présente facture pro forma";
  }
  if (rendererKey === "devis") return "Arrêté le présent devis";
  if (rendererKey === "recu_a4" || rendererKey === "recu_compact") {
    return "Arrêté le présent reçu";
  }
  if (rendererKey === "decharge") return "Arrêtée la présente décharge";
  return "Arrêté le présent document";
}

async function makeKadiQrBuffer({ fullNumberE164, prefillText }) {
  const encoded = encodeURIComponent(prefillText || "Bonjour KADI");
  const url = `https://wa.me/${fullNumberE164}?text=${encoded}`;
  const png = await QRCode.toBuffer(url, {
    type: "png",
    width: 140,
    margin: 1,
    errorCorrectionLevel: "M",
  });

  return { png, url };
}

module.exports = {
  safe,
  fmtNumber,
  numberToFrench,
  normalizeDocType,
  resolveRendererKey,
  closingPhrase,
  makeKadiQrBuffer,
};