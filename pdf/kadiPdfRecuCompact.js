"use strict";

const PDFDocument = require("pdfkit");
const { safe, fmtNumber } = require("./kadiPdfCommon");

async function buildRecuCompactPdf({
  docData = {},
  businessProfile = null,
  logoBuffer = null,
  qr = null,
}) {
  return new Promise((resolve, reject) => {
    try {
      const pdf = new PDFDocument({
        size: [280, 420],
        margin: 16,
        bufferPages: true,
      });

      const chunks = [];
      pdf.on("data", (c) => chunks.push(c));
      pdf.on("end", () => resolve(Buffer.concat(chunks)));
      pdf.on("error", reject);

      const pageWidth = pdf.page.width;
      const compactW = 220;
      const compactLeft = Math.round((pageWidth - compactW) / 2);
      const compactRight = compactLeft + compactW;
      const qrSize = 34;

      const bp = businessProfile || {};
      const number = docData.docNumber || "—";
      const date = docData.date || "—";
      const client = docData.client || "—";
      const clientPhone = safe(docData.clientPhone || "");
      const subject = safe(docData.subject || "");
      const items = Array.isArray(docData.items) ? docData.items : [];
      const total = Number(docData.total || 0);

      let y = 18;

      function hr() {
        pdf.save();
        pdf.strokeColor("#D9D9D9").lineWidth(1);
        pdf.moveTo(compactLeft, y).lineTo(compactRight, y).stroke();
        pdf.restore();
        y += 8;
      }

      if (logoBuffer) {
        try {
          pdf.image(logoBuffer, compactLeft + 2, y, { fit: [18, 18] });
        } catch (_) {}
      }

      pdf.font("Helvetica-Bold").fontSize(9).fillColor("#000");
      pdf.text(safe(bp.business_name) || "—", compactLeft + (logoBuffer ? 24 : 0), y, {
        width: compactW - (logoBuffer ? 24 : 0),
        align: "left",
      });

      if (bp.phone) {
        pdf.font("Helvetica").fontSize(8).fillColor("#555");
        pdf.text(bp.phone, compactLeft + (logoBuffer ? 24 : 0), y + 10, {
          width: compactW - (logoBuffer ? 24 : 0),
          align: "left",
        });
      }

      y += 24;
      hr();

      pdf.font("Helvetica-Bold").fontSize(10).fillColor("#000");
      pdf.text(`REÇU #${number}`, compactLeft, y, {
        width: compactW,
        align: "left",
      });

      pdf.font("Helvetica").fontSize(8).fillColor("#666");
      pdf.text(date, compactLeft, y + 12, {
        width: compactW,
        align: "left",
      });

      y += 24;
      hr();

      pdf.font("Helvetica-Bold").fontSize(8).fillColor("#777");
      pdf.text("CLIENT", compactLeft, y);

      pdf.font("Helvetica").fontSize(9).fillColor("#000");
      pdf.text(client, compactLeft, y + 10, {
        width: compactW,
        align: "left",
      });

      let blockHeight = 24;

      if (clientPhone) {
        pdf.font("Helvetica").fontSize(8).fillColor("#555");
        pdf.text(`Tel: ${clientPhone}`, compactLeft, y + 22, {
          width: compactW,
          align: "left",
        });
        blockHeight += 12;
      }

      if (subject && subject.length <= 40) {
        pdf.font("Helvetica").fontSize(8).fillColor("#555");
        pdf.text(`Objet: ${subject}`, compactLeft, y + blockHeight, {
          width: compactW,
          align: "left",
        });
        blockHeight += 12;
      }

      y += blockHeight;
      hr();

      for (const it of items) {
        const label = safe(it.label || it.raw || "—");
        const qty = Number(it.qty || 0);
        const pu = Number(it.unitPrice || 0);
        const amt = Number(it.amount || qty * pu || 0);

        const shownLabel =
          qty > 0 && !/x\s*\d+/i.test(label)
            ? `${label}${qty > 1 ? ` x${fmtNumber(qty)}` : ""}`
            : label;

        const labelW = compactW - 78;
        const labelH = pdf.heightOfString(shownLabel, {
          width: labelW,
          lineBreak: true,
        });

        pdf.font("Helvetica").fontSize(9).fillColor("#000");
        pdf.text(shownLabel, compactLeft, y, {
          width: labelW,
          align: "left",
        });

        pdf.text(`${fmtNumber(amt)} F`, compactLeft, y, {
          width: compactW,
          align: "right",
          lineBreak: false,
        });

        y += Math.max(16, labelH + 2);
      }

      hr();

      pdf.font("Helvetica-Bold").fontSize(10).fillColor("#138A36");
      pdf.text("TOTAL", compactLeft, y, {
        width: 70,
        align: "left",
        lineBreak: false,
      });

      pdf.text(`${fmtNumber(total)} F CFA`, compactLeft, y, {
        width: compactW,
        align: "right",
        lineBreak: false,
      });

      y += 18;
      hr();

      pdf.font("Helvetica-Bold").fontSize(8).fillColor("#138A36");
      pdf.text("PAYÉ", compactLeft, y);

      y += 18;

      pdf.font("Helvetica").fontSize(8).fillColor("#444");
      pdf.text("Merci", compactLeft, y);

      const qrX = compactRight - qrSize;
      const qrY = y - 4;

      pdf.font("Helvetica-Bold").fontSize(7).fillColor("#111");
      pdf.text("Généré par KADI", compactLeft, y + 12, {
        width: compactW - qrSize - 10,
        align: "left",
      });

      pdf.font("Helvetica").fontSize(6).fillColor("#666");
      pdf.text("Scannez pour essayer sur WhatsApp", compactLeft, y + 22, {
        width: compactW - qrSize - 10,
        align: "left",
      });

      if (qr?.png) {
        try {
          pdf.image(qr.png, qrX, qrY, { fit: [qrSize, qrSize] });
        } catch (_) {}
      }

      pdf.font("Helvetica").fontSize(6).fillColor("#777");
      pdf.text("Essayer", qrX - 4, qrY + qrSize + 2, {
        width: qrSize + 8,
        align: "center",
      });

      pdf.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = {
  buildRecuCompactPdf,
};