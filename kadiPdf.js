// kadiPdf.js
"use strict";

const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

// ================= Utils =================
function safe(v) {
  return String(v || "").trim();
}

function fmtNumber(n) {
  const x = Math.round(Number(n || 0));
  if (!Number.isFinite(x)) return "0";
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function closingPhrase(type) {
  const t = String(type || "").toUpperCase();
  if (t.includes("DEVIS")) return "Arrêté le présent devis";
  if (t.includes("FACTURE")) return "Arrêtée la présente facture";
  if (t.includes("REÇU") || t.includes("RECU")) return "Arrêté le présent reçu";
  return "Arrêté le présent document";
}

// ================= QR =================
async function makeQr({ e164 }) {
  const url = `https://wa.me/${e164}`;
  const png = await QRCode.toBuffer(url, { width: 120, margin: 1 });
  return png;
}

// ================= PDF =================
async function buildPdfBuffer({ docData, businessProfile, logoBuffer }) {
  const KADI_E164 = process.env.KADI_E164 || "22679239027";
  const qr = await makeQr({ e164: KADI_E164 });

  return new Promise((resolve) => {
    const pdf = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));

    const left = 50;
    const right = pdf.page.width - 50;

    // ===== HEADER =====
    if (logoBuffer) {
      pdf.image(logoBuffer, left, 45, { width: 55 });
    }

    pdf.font("Helvetica-Bold").fontSize(13)
      .text(businessProfile?.business_name || "—", left + 70, 45);

    pdf.font("Helvetica").fontSize(9)
      .text(`Adresse : ${businessProfile?.address || "—"}`, left + 70, 62)
      .text(`Tel : ${businessProfile?.phone || "—"}`, left + 70, 75);

    pdf.font("Helvetica-Bold").fontSize(16)
      .text(docData.type, left, 45, { width: right - left, align: "right" });

    pdf.font("Helvetica").fontSize(10)
      .text(`N° : ${docData.docNumber}`, left, 65, { width: right - left, align: "right" })
      .text(`Date : ${docData.date}`, left, 80, { width: right - left, align: "right" });

    pdf.moveTo(left, 120).lineTo(right, 120).stroke();

    // ===== CLIENT =====
    pdf.rect(left, 135, right - left, 45).stroke();
    pdf.font("Helvetica-Bold").text("Client", left + 10, 143);
    pdf.font("Helvetica").text(docData.client, left + 10, 160);

    // ===== TABLE =====
    const yStart = 210;
    const rowH = 26;

    const cols = {
      idx: { x: left, w: 30 },
      label: { x: left + 30, w: 260 },
      qty: { x: left + 290, w: 60 },
      pu: { x: left + 350, w: 80 },
      amt: { x: left + 430, w: 90 },
    };

    // Header row
    pdf.rect(left, yStart, right - left, rowH).fillAndStroke("#F2F2F2", "#000");
    pdf.font("Helvetica-Bold").fontSize(10);
    pdf.text("#", cols.idx.x, yStart + 8, { width: cols.idx.w, align: "center" });
    pdf.text("Désignation", cols.label.x + 5, yStart + 8);
    pdf.text("Qté", cols.qty.x, yStart + 8, { width: cols.qty.w, align: "right" });
    pdf.text("PU", cols.pu.x, yStart + 8, { width: cols.pu.w, align: "right" });
    pdf.text("Montant", cols.amt.x, yStart + 8, { width: cols.amt.w, align: "right" });

    // Rows
    let y = yStart + rowH;
    pdf.font("Helvetica").fontSize(10);

    docData.items.forEach((it, i) => {
      pdf.rect(left, y, right - left, rowH).stroke();

      pdf.text(String(i + 1), cols.idx.x, y + 8, { width: cols.idx.w, align: "center" });
      pdf.text(safe(it.label), cols.label.x + 5, y + 8, { width: cols.label.w - 10 });
      pdf.text(fmtNumber(it.qty), cols.qty.x, y + 8, { width: cols.qty.w, align: "right" });
      pdf.text(fmtNumber(it.unitPrice), cols.pu.x, y + 8, { width: cols.pu.w, align: "right" });
      pdf.text(fmtNumber(it.amount), cols.amt.x, y + 8, { width: cols.amt.w, align: "right" });

      y += rowH;
    });

    // ===== TOTAL =====
    pdf.rect(right - 260, y + 20, 260, 40).stroke();
    pdf.font("Helvetica-Bold").fontSize(12)
      .text("TOTAL", right - 250, y + 32)
      .text(`${fmtNumber(docData.total)} FCFA`, right - 10, y + 32, { align: "right" });

    // ===== FOOTER =====
    const footerY = pdf.page.height - 70;
    pdf.moveTo(left, footerY - 10).lineTo(right, footerY - 10).stroke();
    pdf.font("Helvetica").fontSize(8).fillColor("#555")
      .text(`Généré par KADI • WhatsApp +${KADI_E164}`, left, footerY);
    pdf.image(qr, right - 45, footerY - 5, { width: 40 });

    pdf.end();
  });
}

module.exports = { buildPdfBuffer };