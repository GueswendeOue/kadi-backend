// KadiPdf.js — VERSION STABLE TABLEAU FIXE
"use strict";

const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

function fmt(n) {
  return Number(n || 0).toLocaleString("fr-FR");
}

async function buildPdfBuffer({ docData, businessProfile, logoBuffer }) {
  const qr = await QRCode.toBuffer("https://wa.me/22679239027", { width: 100 });

  return new Promise((resolve) => {
    const pdf = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    pdf.on("data", c => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));

    const left = 50;
    const right = pdf.page.width - 50;
    let y = 50;

    /* ================= HEADER ================= */
    if (logoBuffer) pdf.image(logoBuffer, left, y, { width: 50 });

    pdf.font("Helvetica-Bold").fontSize(13)
      .text(businessProfile?.business_name || "", left + 70, y);

    pdf.fontSize(9).font("Helvetica")
      .text(`Adresse : ${businessProfile?.address || ""}`, left + 70, y + 15)
      .text(`Tel : ${businessProfile?.phone || ""}`, left + 70, y + 28);

    pdf.font("Helvetica-Bold").fontSize(16)
      .text(docData.type, left, y, { width: right - left, align: "right" });

    pdf.font("Helvetica").fontSize(10)
      .text(`N° : ${docData.docNumber}`, left, y + 22, { width: right - left, align: "right" })
      .text(`Date : ${docData.date}`, left, y + 36, { width: right - left, align: "right" });

    y += 80;
    pdf.moveTo(left, y).lineTo(right, y).stroke();
    y += 15;

    /* ================= CLIENT ================= */
    pdf.rect(left, y, right - left, 40).stroke();
    pdf.font("Helvetica-Bold").text("Client", left + 10, y + 8);
    pdf.font("Helvetica").text(docData.client, left + 10, y + 22);
    y += 60;

    /* ================= TABLE ================= */
    const cols = [
      { label: "#", x: left, w: 30 },
      { label: "Désignation", x: left + 30, w: 260 },
      { label: "Qté", x: left + 290, w: 60 },
      { label: "PU", x: left + 350, w: 80 },
      { label: "Montant", x: left + 430, w: 90 },
    ];
    const rowH = 26;

    // Header
    pdf.rect(left, y, right - left, rowH).fillAndStroke("#F2F2F2", "#000");
    pdf.font("Helvetica-Bold").fontSize(10);
    cols.forEach(c =>
      pdf.text(c.label, c.x + 5, y + 8, { width: c.w - 10, align: "center" })
    );
    y += rowH;

    pdf.font("Helvetica").fontSize(10);

    // Rows
    docData.items.forEach((it, i) => {
      pdf.rect(left, y, right - left, rowH).stroke();

      // Vertical lines
      cols.slice(1).forEach(c =>
        pdf.moveTo(c.x, y).lineTo(c.x, y + rowH).stroke()
      );

      pdf.text(i + 1, cols[0].x + 5, y + 8, { width: cols[0].w - 10, align: "center" });
      pdf.text(it.label, cols[1].x + 5, y + 8, { width: cols[1].w - 10 });
      pdf.text(fmt(it.qty), cols[2].x + 5, y + 8, { width: cols[2].w - 10, align: "right" });
      pdf.text(fmt(it.unitPrice), cols[3].x + 5, y + 8, { width: cols[3].w - 10, align: "right" });
      pdf.text(fmt(it.amount), cols[4].x + 5, y + 8, { width: cols[4].w - 10, align: "right" });

      y += rowH;
    });

    /* ================= TOTAL ================= */
    y += 20;
    const boxW = 260;
    pdf.rect(right - boxW, y, boxW, 40).stroke();
    pdf.font("Helvetica-Bold").fontSize(12)
      .text("TOTAL", right - boxW + 10, y + 12)
      .text(`${fmt(docData.total)} FCFA`, right - 10, y + 12, {
        width: boxW - 20,
        align: "right"
      });

    /* ================= FOOTER ================= */
    const fy = pdf.page.height - 50;
    pdf.moveTo(left, fy - 10).lineTo(right, fy - 10).stroke();
    pdf.fontSize(8).fillColor("#555")
      .text("Généré par KADI • WhatsApp +226 79 23 90 27", left, fy);
    pdf.image(qr, right - 45, fy - 5, { width: 40 });

    pdf.end();
  });
}

module.exports = { buildPdfBuffer };