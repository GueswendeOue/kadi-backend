// kadiDechargePdf.js
"use strict";

const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

function safe(v) {
  return String(v || "").trim();
}

function fmtNumber(n) {
  const x = Math.round(Number(n || 0));
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// mini conversion nombre→texte (fr) simple
function numberToFrench(n) {
  n = Math.floor(Number(n) || 0);
  if (n === 0) return "zéro";

  const units = ["", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf"];
  const teens = ["dix", "onze", "douze", "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf"];
  const tens = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante", "soixante", "quatre-vingt", "quatre-vingt"];

  function under100(x) {
    if (x < 10) return units[x];
    if (x < 20) return teens[x - 10];

    const t = Math.floor(x / 10);
    const u = x % 10;

    if (t === 7 || t === 9) {
      const base = tens[t];
      const rest = x - t * 10;
      return `${base}-${teens[rest - 10]}`;
    }

    if (t === 8 && u === 0) return "quatre-vingts";
    if (u === 0) return tens[t];
    if (t === 8) return `quatre-vingt-${units[u]}`;
    if (u === 1 && (t === 2 || t === 3 || t === 4 || t === 5 || t === 6)) return `${tens[t]} et un`;
    return `${tens[t]}-${units[u]}`;
  }

  function under1000(x) {
    const h = Math.floor(x / 100);
    const r = x % 100;
    let s = "";

    if (h > 0) {
      if (h === 1) s = "cent";
      else s = `${units[h]} cent`;
      if (r === 0 && h > 1) s += "s";
    }

    if (r > 0) s = s ? `${s} ${under100(r)}` : under100(r);
    return s;
  }

  function chunk(x, value, name) {
    const q = Math.floor(x / value);
    const r = x % value;
    if (q === 0) return { text: "", rest: r };

    if (name === "mille") {
      if (q === 1) return { text: "mille", rest: r };
      return { text: `${under1000(q)} mille`, rest: r };
    }

    const t = q === 1 ? `${name}` : `${under1000(q)} ${name}s`;
    return { text: t, rest: r };
  }

  let x = n;
  const parts = [];

  const m = chunk(x, 1_000_000, "million");
  if (m.text) parts.push(m.text);
  x = m.rest;

  const k = chunk(x, 1_000, "mille");
  if (k.text) parts.push(k.text);
  x = k.rest;

  if (x > 0) parts.push(under1000(x));

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

async function makeKadiQrPngBuffer({ fullNumberE164, prefillText }) {
  const encoded = encodeURIComponent(prefillText || "Bonjour KADI");
  const url = `https://wa.me/${fullNumberE164}?text=${encoded}`;

  const png = await QRCode.toBuffer(url, {
    type: "png",
    width: 220,
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#000000", light: "#FFFFFF" },
  });

  return { url, png };
}

/**
 * Build Décharge PDF
 * docData = {
 *   title: "DÉCHARGE",
 *   docNumber: "KDI-DEC-0001",
 *   date: "2026-01-31",
 *   place: "Ouagadougou",
 *   amount: 6000000,
 *   currency: "FCFA",
 *   objet: "Règlement ... (optionnel)",
 *   partie1: { nom, phone, id_type, id_number },
 *   partie2: { nom, phone, id_type, id_number },
 *   confirmations: { p1: true/false, p2: true/false } (optionnel)
 * }
 */
async function buildDechargePdfBuffer({ docData = {}, businessProfile = null, logoBuffer = null }) {
  const KADI_NUMBER_LOCAL = process.env.KADI_NUMBER || "79239027";
  const KADI_COUNTRY = process.env.KADI_COUNTRY_CODE || "226";
  const KADI_E164 = process.env.KADI_E164 || `${KADI_COUNTRY}${KADI_NUMBER_LOCAL}`;
  const KADI_PREFILL = process.env.KADI_QR_PREFILL || "Bonjour KADI, je veux créer un document";

  let qr = null;
  try {
    qr = await makeKadiQrPngBuffer({ fullNumberE164: KADI_E164, prefillText: KADI_PREFILL });
  } catch (_) {
    qr = null;
  }

  return new Promise((resolve, reject) => {
    try {
      const pdf = new PDFDocument({ size: "A4", margin: 50 });
      const chunks = [];
      pdf.on("data", (c) => chunks.push(c));
      pdf.on("end", () => resolve(Buffer.concat(chunks)));

      const bp = businessProfile || {};
      const pageLeft = 50;
      const pageRight = 545;
      const topY = 45;

      const typeUpper = String(docData.title || "DÉCHARGE").toUpperCase();
      const docNumber = docData.docNumber || "—";
      const date = docData.date || "—";
      const place = docData.place || "—";
      const amount = Number(docData.amount || 0);
      const currency = docData.currency || "FCFA";
      const objet = safe(docData.objet || "");

      const p1 = docData.partie1 || {};
      const p2 = docData.partie2 || {};

      // ---- Header ----
      if (logoBuffer) {
        try {
          pdf.image(logoBuffer, pageLeft, topY, { fit: [70, 70] });
        } catch {}
      }

      const headerTextX = pageLeft + (logoBuffer ? 85 : 0);
      const headerTop = topY;

      pdf.fillColor("#000");
      pdf.font("Helvetica-Bold").fontSize(13).text(safe(bp.business_name) || "KADI", headerTextX, headerTop, {
        width: 280,
      });

      pdf.font("Helvetica").fontSize(9);
      const bizLines = [
        safe(bp.address) ? `Adresse : ${safe(bp.address)}` : null,
        safe(bp.phone) ? `Tél : ${safe(bp.phone)}` : null,
        safe(bp.email) ? `Email : ${safe(bp.email)}` : null,
        safe(bp.ifu) ? `IFU : ${safe(bp.ifu)}` : null,
        safe(bp.rccm) ? `RCCM : ${safe(bp.rccm)}` : null,
      ].filter(Boolean);

      pdf.text(bizLines.join("\n"), headerTextX, headerTop + 18, { width: 280, lineGap: 2 });

      // Title right
      pdf.font("Helvetica-Bold").fontSize(16).text(typeUpper, pageLeft, headerTop, {
        width: pageRight - pageLeft,
        align: "right",
      });

      pdf.font("Helvetica").fontSize(10);
      pdf.text(`N° : ${docNumber}`, pageLeft, headerTop + 20, { width: pageRight - pageLeft, align: "right" });
      pdf.text(`Date : ${date}`, pageLeft, headerTop + 35, { width: pageRight - pageLeft, align: "right" });

      pdf.moveTo(pageLeft, headerTop + 80).lineTo(pageRight, headerTop + 80).stroke();

      // ---- Body ----
      let y = headerTop + 95;

      // Place line
      pdf.font("Helvetica").fontSize(11).fillColor("#000");
      pdf.text(`${place}, le ${date}`, pageLeft, y);
      y += 22;

      // Title centered
      pdf.font("Helvetica-Bold").fontSize(15).text("DÉCHARGE", pageLeft, y, {
        width: pageRight - pageLeft,
        align: "center",
      });
      y += 25;

      // Main paragraph
      const words = numberToFrench(amount);
      const montantStr = `${fmtNumber(amount)} ${currency} (${words} francs CFA)`;

      pdf.font("Helvetica").fontSize(11);

      const parag =
        `Je soussigné(e) ${safe(p1.nom) || "—"}, ` +
        `${safe(p1.id_type) ? `titulaire de ${safe(p1.id_type)} ` : ""}` +
        `${safe(p1.id_number) ? `N° ${safe(p1.id_number)}, ` : ""}` +
        `${safe(p1.phone) ? `tél: ${safe(p1.phone)}, ` : ""}` +
        `déclare avoir reçu de ${safe(p2.nom) || "—"} ` +
        `${safe(p2.id_type) ? `(${safe(p2.id_type)} ` : ""}` +
        `${safe(p2.id_type) && safe(p2.id_number) ? `N° ${safe(p2.id_number)}` : safe(p2.id_type) ? "" : ""}` +
        `${safe(p2.id_type) ? `) ` : ""}` +
        `${safe(p2.phone) ? `tél: ${safe(p2.phone)} ` : ""}` +
        `la somme de : ${montantStr}.`;

      pdf.text(parag, pageLeft, y, { width: pageRight - pageLeft, lineGap: 3 });
      y += 70;

      if (objet) {
        pdf.font("Helvetica-Bold").text("Objet :", pageLeft, y);
        pdf.font("Helvetica").text(objet, pageLeft + 50, y, { width: pageRight - pageLeft - 50 });
        y += 35;
      }

      pdf.font("Helvetica").text(
        "La présente décharge est établie pour servir et valoir ce que de droit.",
        pageLeft,
        y,
        { width: pageRight - pageLeft }
      );
      y += 40;

      // ---- Signatures area ----
      const boxW = (pageRight - pageLeft - 20) / 2;
      const boxH = 110;

      // left box = Partie 1 (reçoit)
      pdf.rect(pageLeft, y, boxW, boxH).stroke();
      pdf.font("Helvetica-Bold").fontSize(10).text("Partie 1 (Reçoit)", pageLeft + 10, y + 10);
      pdf.font("Helvetica").fontSize(10).text(safe(p1.nom) || "—", pageLeft + 10, y + 28, { width: boxW - 20 });
      pdf.font("Helvetica").fontSize(9).fillColor("#333").text("Signature", pageLeft + 10, y + 90);

      // right box = Partie 2 (remet)
      pdf.fillColor("#000");
      pdf.rect(pageLeft + boxW + 20, y, boxW, boxH).stroke();
      pdf.font("Helvetica-Bold").fontSize(10).text("Partie 2 (Remet)", pageLeft + boxW + 30, y + 10);
      pdf.font("Helvetica").fontSize(10).text(safe(p2.nom) || "—", pageLeft + boxW + 30, y + 28, { width: boxW - 20 });
      pdf.font("Helvetica").fontSize(9).fillColor("#333").text("Signature", pageLeft + boxW + 30, y + 90);

      pdf.fillColor("#000");
      y += boxH + 20;

      // ---- Confirmations (optionnel, B4 activera) ----
      const conf = docData.confirmations || null;
      if (conf) {
        pdf.font("Helvetica-Bold").fontSize(10).text("Confirmations WhatsApp :", pageLeft, y);
        y += 14;
        pdf.font("Helvetica").fontSize(10).text(
          `• Partie 1 a confirmé avoir reçu : ${conf.p1 ? "OUI ✅" : "NON"}`,
          pageLeft,
          y
        );
        y += 14;
        pdf.text(`• Partie 2 a confirmé avoir remis : ${conf.p2 ? "OUI ✅" : "NON"}`, pageLeft, y);
        y += 18;
      }

      // ---- Footer (bas de page) + QR ----
      const footerY = pdf.page.height - 70;
      const qrSize = 55;

      pdf.moveTo(pageLeft, footerY - 6).lineTo(pageRight, footerY - 6).stroke();

      pdf.font("Helvetica").fontSize(8).fillColor("#444");

      const footerText = `Généré par KADI • WhatsApp +${KADI_COUNTRY} ${KADI_NUMBER_LOCAL.replace(
        /(\d{2})(\d{2})(\d{2})(\d{2})/,
        "$1 $2 $3 $4"
      )} • Scannez pour essayer`;

      pdf.text(footerText, pageLeft, footerY + 18, {
        width: (pageRight - pageLeft) - (qr ? (qrSize + 10) : 0),
        align: "left",
        lineBreak: false,
        ellipsis: true,
      });

      if (qr?.png) {
        try {
          pdf.image(qr.png, pageRight - qrSize, footerY, { fit: [qrSize, qrSize] });
        } catch {}
      }

      pdf.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildDechargePdfBuffer };