// KadiPdf.js
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

// ================= QR =================
async function makeQr(e164) {
  return QRCode.toBuffer(`https://wa.me/${e164}`, {
    width: 100,
    margin: 1,
  });
}

// ================= PDF =================
async function buildPdfBuffer({ docData = {}, businessProfile = {}, logoBuffer = null }) {
  const KADI_E164 = process.env.KADI_E164 || "22679239027";
  const qr = await makeQr(KADI_E164);

  return new Promise((resolve, reject) => {
    try {
      const pdf = new PDFDocument({ size: "A4", margin: 50 });
      const chunks = [];
      pdf.on("data", (c) => chunks.push(c));
      pdf.on("end", () => resolve(Buffer.concat(chunks)));

      const pageW = pdf.page.width;
      const pageH = pdf.page.height;
      const left = 50;
      const right = pageW - 50;
      let y = 50;

      // ================= HEADER =================
      if (logoBuffer) {
        pdf.image(logoBuffer, left, y, { width: 55 });
      }

      pdf.font("Helvetica-Bold").fontSize(13)
        .text(safe(businessProfile.business_name), left + 70, y);

      pdf.font("Helvetica").fontSize(9)
        .text(`Adresse : ${safe(businessProfile.address)}`, left + 70, y + 16)
        .text(`Tel : ${safe(businessProfile.phone)}`, left + 70, y + 28);

      pdf.font("Helvetica-Bold").fontSize(16)
        .text(docData.type || "DEVIS", left, y, { width: right - left, align: "right" });

      pdf.font("Helvetica").fontSize(10)
        .text(`N° : ${docData.docNumber}`, left, y + 22, { width: right - left, align: "right" })
        .text(`Date : ${docData.date}`, left, y + 36, { width: right - left, align: "right" });

      y += 75;
      pdf.moveTo(left, y).lineTo(right, y).stroke();
      y += 15;

      // ================= CLIENT =================
      pdf.rect(left, y, right - left, 45).stroke();
      pdf.font("Helvetica-Bold").fontSize(10).text("Client", left + 10, y + 8);
      pdf.font("Helvetica").fontSize(10).text(docData.client, left + 10, y + 25);
      y += 65;

      // ================= TABLE =================
      const cols = {
        idx: { x: left, w: 30 },
        label: { x: left + 30, w: 260 },
        qty: { x: left + 290, w: 60 },
        pu: { x: left + 350, w: 80 },
        amt: { x: left + 430, w: 90 },
      };

      const rowH = 26;
      const tableBottom = pageH - 140;

      function drawTableHeader() {
        pdf.rect(left, y, right - left, rowH).fillAndStroke("#F2F2F2", "#000");
        pdf.font("Helvetica-Bold").fontSize(10);
        pdf.text("#", cols.idx.x, y + 8, { width: cols.idx.w, align: "center" });
        pdf.text("Désignation", cols.label.x + 6, y + 8);
        pdf.text("Qté", cols.qty.x, y + 8, { width: cols.qty.w - 6, align: "right" });
        pdf.text("PU", cols.pu.x, y + 8, { width: cols.pu.w - 6, align: "right" });
        pdf.text("Montant", cols.amt.x, y + 8, { width: cols.amt.w - 6, align: "right" });
        y += rowH;
      }

      drawTableHeader();

      docData.items.forEach((it, i) => {
        if (y + rowH > tableBottom) {
          pdf.addPage();
          y = 50;
          drawTableHeader();
        }

        pdf.rect(left, y, right - left, rowH).stroke();
        pdf.font("Helvetica").fontSize(10);

        pdf.text(i + 1, cols.idx.x, y + 8, { width: cols.idx.w, align: "center" });
        pdf.text(safe(it.label), cols.label.x + 6, y + 8, { width: cols.label.w - 12 });
        pdf.text(fmtNumber(it.qty), cols.qty.x, y + 8, { width: cols.qty.w - 6, align: "right" });
        pdf.text(fmtNumber(it.unitPrice), cols.pu.x, y + 8, { width: cols.pu.w - 6, align: "right" });
        pdf.text(fmtNumber(it.amount), cols.amt.x, y + 8, { width: cols.amt.w - 6, align: "right" });

        y += rowH;
      });

      // ================= TOTAL =================
      if (y + 80 > pageH - 80) {
        pdf.addPage();
        y = 60;
      }

      pdf.rect(right - 260, y + 20, 260, 40).stroke();
      pdf.font("Helvetica-Bold").fontSize(12);
      pdf.text("TOTAL", right - 250, y + 32);
      pdf.text(`${fmtNumber(docData.total)} FCFA`, right - 10, y + 32, { align: "right" });

      // ================= FOOTER =================
      const fy = pageH - 50;
      pdf.moveTo(left, fy - 10).lineTo(right, fy - 10).stroke();
      pdf.font("Helvetica").fontSize(8).fillColor("#555")
        .text(`Généré par KADI • WhatsApp +${KADI_E164}`, left, fy);

      pdf.image(qr, right - 45, fy - 5, { width: 40 });

      pdf.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildPdfBuffer };