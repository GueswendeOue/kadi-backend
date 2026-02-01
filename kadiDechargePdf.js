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

function normalizeDocTypeForFooter(typeUpper) {
  const t = String(typeUpper || "").toUpperCase();
  if (t.includes("DÉCHARGE") || t.includes("DECHARGE")) return { docWord: "décharge", title: "DÉCHARGE" };
  return { docWord: "document", title: "DOCUMENT" };
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

function drawStampBox(pdf, { x, y, w, h, lines = [] }) {
  pdf.save();
  pdf.rect(x, y, w, h).dash(3, { space: 3 }).stroke();
  pdf.undash();

  pdf.font("Helvetica-Bold").fontSize(9).fillColor("#000");
  pdf.text("TAMPON", x + 10, y + 8);

  pdf.font("Helvetica").fontSize(8).fillColor("#111");
  const txt = (lines || []).filter(Boolean).join("\n");
  pdf.text(txt, x + 10, y + 22, { width: w - 20, height: h - 32 });

  pdf.restore();
}

function drawSignatureBox(pdf, { x, y, w, h, label = "Signature" }) {
  pdf.save();
  pdf.rect(x, y, w, h).stroke();
  pdf.font("Helvetica").fontSize(9).fillColor("#000");
  pdf.text(label, x + 10, y + 8);
  pdf.restore();
}

/**
 * buildDechargePdfBuffer
 * docData = {
 *   type: "DECHARGE",
 *   docNumber, date,
 *   party1: { name, cin, phone, address },
 *   party2: { name, cin, phone, address },
 *   object, amount, amountWords,
 *   place
 * }
 */
async function buildDechargePdfBuffer({ docData = {}, businessProfile = null }) {
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

      const pageLeft = 50;
      const pageRight = 545;

      const typeUpper = String(docData.type || "DECHARGE").toUpperCase();
      const typ = normalizeDocTypeForFooter(typeUpper);

      const docNumber = docData.docNumber || "—";
      const date = docData.date || "—";
      const place = docData.place || "";

      const p1 = docData.party1 || {};
      const p2 = docData.party2 || {};

      const amount = Number(docData.amount || 0);
      const amountWords = safe(docData.amountWords);

      const object = safe(docData.object || "—");

      // -------- Header --------
      const topY = 45;

      pdf.fillColor("#000");
      pdf.font("Helvetica-Bold").fontSize(16).text(typ.title, pageLeft, topY, { width: pageRight - pageLeft, align: "center" });

      pdf.moveDown(0.2);

      pdf.font("Helvetica").fontSize(10).text(`N° : ${docNumber}`, pageLeft, topY + 28, { width: pageRight - pageLeft, align: "left" });
      pdf.font("Helvetica").fontSize(10).text(`Date : ${date}`, pageLeft, topY + 28, { width: pageRight - pageLeft, align: "right" });

      pdf.moveTo(pageLeft, topY + 52).lineTo(pageRight, topY + 52).stroke();

      let y = topY + 70;

      // -------- Parties --------
      const boxW = (pageRight - pageLeft - 15) / 2;
      const boxH = 115;

      pdf.rect(pageLeft, y, boxW, boxH).stroke();
      pdf.rect(pageLeft + boxW + 15, y, boxW, boxH).stroke();

      pdf.font("Helvetica-Bold").fontSize(10).text("PARTIE 1 (Bénéficiaire)", pageLeft + 10, y + 8);
      pdf.font("Helvetica").fontSize(10).text(
        [
          safe(p1.name) ? `Nom : ${safe(p1.name)}` : null,
          safe(p1.cin) ? `N° pièce : ${safe(p1.cin)}` : null,
          safe(p1.phone) ? `Téléphone : ${safe(p1.phone)}` : null,
          safe(p1.address) ? `Adresse : ${safe(p1.address)}` : null,
        ].filter(Boolean).join("\n") || "—",
        pageLeft + 10,
        y + 28,
        { width: boxW - 20, lineGap: 2 }
      );

      pdf.font("Helvetica-Bold").fontSize(10).text("PARTIE 2 (Remettant)", pageLeft + boxW + 25, y + 8);
      pdf.font("Helvetica").fontSize(10).text(
        [
          safe(p2.name) ? `Nom : ${safe(p2.name)}` : null,
          safe(p2.cin) ? `N° pièce : ${safe(p2.cin)}` : null,
          safe(p2.phone) ? `Téléphone : ${safe(p2.phone)}` : null,
          safe(p2.address) ? `Adresse : ${safe(p2.address)}` : null,
        ].filter(Boolean).join("\n") || "—",
        pageLeft + boxW + 25,
        y + 28,
        { width: boxW - 20, lineGap: 2 }
      );

      y += boxH + 18;

      // -------- Corps --------
      pdf.font("Helvetica").fontSize(11).fillColor("#000");

      const body1 =
        `Je soussigné(e) ${safe(p1.name) || "________________"} (Partie 1), reconnais avoir reçu de ${safe(p2.name) || "________________"} (Partie 2), ` +
        `la somme de ${fmtNumber(amount)} FCFA (${amountWords || "________________"}) ` +
        `au titre de : ${object}.`;

      const body2 =
        `Je soussigné(e) ${safe(p2.name) || "________________"} (Partie 2), déclare avoir remis à ${safe(p1.name) || "________________"} (Partie 1), ` +
        `la somme de ${fmtNumber(amount)} FCFA (${amountWords || "________________"}) ` +
        `au titre de : ${object}.`;

      pdf.text(body1, pageLeft, y, { width: pageRight - pageLeft, lineGap: 3 });
      y += 62;
      pdf.text(body2, pageLeft, y, { width: pageRight - pageLeft, lineGap: 3 });

      y += 70;

      if (place) {
        pdf.font("Helvetica").fontSize(11).text(`Fait à : ${place}`, pageLeft, y, { width: pageRight - pageLeft });
        y += 18;
      }

      // -------- Signatures + Tampon --------
      const sigW = (pageRight - pageLeft - 15) / 2;
      const sigH = 85;

      drawSignatureBox(pdf, { x: pageLeft, y, w: sigW, h: sigH, label: "Signature Partie 1" });
      drawSignatureBox(pdf, { x: pageLeft + sigW + 15, y, w: sigW, h: sigH, label: "Signature Partie 2" });

      y += sigH + 18;

      // Tampon généré depuis profil (si dispo)
      const bp = businessProfile || {};
      const stampLines = [
        safe(bp.business_name) || null,
        safe(bp.address) || null,
        safe(bp.phone) ? `Tel: ${safe(bp.phone)}` : null,
        safe(bp.ifu) ? `IFU: ${safe(bp.ifu)}` : null,
        safe(bp.rccm) ? `RCCM: ${safe(bp.rccm)}` : null,
      ];

      drawStampBox(pdf, {
        x: pageLeft,
        y,
        w: 260,
        h: 85,
        lines: stampLines,
      });

      // -------- Footer KADI + QR --------
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
