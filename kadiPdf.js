// kadiPdf.js
// ==========================================
// PDF (PDFKit) - tableau items
// ==========================================

const PDFDocument = require("pdfkit");

function buildPdfBuffer(docData = {}) {
  return new Promise((resolve, reject) => {
    try {
      const pdf = new PDFDocument({ size: "A4", margin: 50 });
      const chunks = [];
      pdf.on("data", c => chunks.push(c));
      pdf.on("end", () => resolve(Buffer.concat(chunks)));

      const type = String(docData.type || "DOCUMENT").toUpperCase();
      const docNumber = docData.docNumber || "—";
      const date = docData.date || "—";
      const client = docData.client || "—";
      const items = Array.isArray(docData.items) ? docData.items : [];
      const total = docData.total != null ? docData.total : "—";

      // Header
      pdf.fontSize(18).text("KADI", { align: "left" });
      pdf.moveDown(0.2);
      pdf.fontSize(10).text("Document généré via WhatsApp", { align: "left" });
      pdf.moveDown(1);

      pdf.fontSize(16).text(type, { align: "right" });
      pdf.fontSize(12).text(`Numéro : ${docNumber}`, { align: "right" });
      pdf.fontSize(12).text(`Date : ${date}`, { align: "right" });
      pdf.moveDown(1);

      pdf.fontSize(12).text(`Client : ${client}`);
      pdf.moveDown(1);

      // Table header
      const startX = 50;
      let y = pdf.y;

      pdf.fontSize(11).text("#", startX, y);
      pdf.text("Désignation", startX + 30, y);
      pdf.text("Qté", startX + 300, y, { width: 40, align: "right" });
      pdf.text("PU", startX + 350, y, { width: 70, align: "right" });
      pdf.text("Montant", startX + 430, y, { width: 90, align: "right" });

      y += 15;
      pdf.moveTo(startX, y).lineTo(545, y).stroke();
      y += 8;

      // Rows
      items.forEach((it, idx) => {
        const qty = it.qty ?? "—";
        const pu = it.unitPrice ?? "—";
        const amt = it.amount ?? "—";

        pdf.fontSize(10).text(String(idx + 1), startX, y);
        pdf.text(String(it.label || it.raw || "—"), startX + 30, y, { width: 260 });
        pdf.text(String(qty), startX + 300, y, { width: 40, align: "right" });
        pdf.text(String(pu), startX + 350, y, { width: 70, align: "right" });
        pdf.text(String(amt), startX + 430, y, { width: 90, align: "right" });

        y += 18;

        // saut de page si besoin
        if (y > 720) {
          pdf.addPage();
          y = 80;
        }
      });

      y += 10;
      pdf.moveTo(startX, y).lineTo(545, y).stroke();
      y += 10;

      pdf.fontSize(12).text(`Total : ${total}`, startX + 350, y, { width: 185, align: "right" });

      pdf.moveDown(3);
      pdf.fontSize(10).text("Merci pour votre confiance.", { align: "center" });

      pdf.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildPdfBuffer };