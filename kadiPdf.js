"use strict";

const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

// ================= Utils =================
function safe(v) {
  return String(v || "").trim();
}

function fmtNumber(n) {
  const x = Math.round(Number(n || 0));
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// ================= QR =================
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

// ================= PDF =================
async function buildPdfBuffer({ docData = {}, businessProfile = null, logoBuffer = null }) {
  const KADI_E164 = process.env.KADI_E164 || "22679239027";
  const KADI_PREFILL =
    process.env.KADI_QR_PREFILL || "Bonjour KADI, je veux créer un document";

  const qr = await makeKadiQrBuffer({
    fullNumberE164: KADI_E164,
    prefillText: KADI_PREFILL,
  });

  return new Promise((resolve, reject) => {
    try {
      const pdf = new PDFDocument({ size: "A4", margin: 50 });
      const chunks = [];
      pdf.on("data", (c) => chunks.push(c));
      pdf.on("end", () => resolve(Buffer.concat(chunks)));

      const bp = businessProfile || {};

      const pageWidth = pdf.page.width;
      const pageHeight = pdf.page.height;
      const left = 50;
      const right = pageWidth - 50;

      // ⚠️ On réserve un footer fixe en bas (pour éviter chevauchement)
      const FOOTER_H = 70;
      const SAFE_BOTTOM = pageHeight - FOOTER_H;

      // Doc fields
      const type = String(docData.type || "DOCUMENT").toUpperCase();
      const number = docData.docNumber || "—";
      const date = docData.date || "—";
      const client = docData.client || "—";
      const items = Array.isArray(docData.items) ? docData.items : [];
      const total = Number(docData.total || 0);

      // Table layout (comme avant)
      const col = { idx: 30, des: 260, qty: 60, pu: 80, amt: 90 };
      const rowH = 24;

      function ensureSpace(needed) {
        if (pdf.y + needed > SAFE_BOTTOM) {
          // avant de changer de page, on force une ligne (propre)
          pdf.addPage();
          // reset top start
          pdf.y = 50;
          // sur nouvelle page on remet l’en-tête du tableau (rendu propre)
          drawTableHeader();
        }
      }

      function drawFooter() {
        const footerY = pageHeight - 55;

        pdf.save();
        pdf.moveTo(left, footerY - 10).lineTo(right, footerY - 10).stroke();

        pdf
          .font("Helvetica")
          .fontSize(8)
          .fillColor("#555")
          .text(
            `Généré par KADI • WhatsApp +${KADI_E164} • Scannez pour essayer`,
            left,
            footerY,
            { width: right - left - 60, ellipsis: true }
          );

        try {
          pdf.image(qr.png, right - 50, footerY - 5, { fit: [45, 45] });
        } catch (_) {}

        pdf.restore();
      }

      function drawHeader() {
        // Logo
        if (logoBuffer) {
          try {
            pdf.image(logoBuffer, left, 45, { fit: [60, 60] });
          } catch (_) {}
        }

        // Company
        pdf.fillColor("#000");
        pdf
          .font("Helvetica-Bold")
          .fontSize(13)
          .text(safe(bp.business_name) || "—", left + 70, 45);

        pdf
          .font("Helvetica")
          .fontSize(9)
          .text(
            [
              bp.address ? `Adresse : ${bp.address}` : null,
              bp.phone ? `Tel : ${bp.phone}` : null,
              bp.email ? `Email : ${bp.email}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
            left + 70,
            62
          );

        // Doc meta (right)
        pdf
          .font("Helvetica-Bold")
          .fontSize(16)
          .text(type, left, 45, { align: "right", width: right - left });

        pdf
          .font("Helvetica")
          .fontSize(10)
          .text(`N° : ${number}`, left, 65, { align: "right", width: right - left });

        pdf.text(`Date : ${date}`, left, 80, {
          align: "right",
          width: right - left,
        });

        // Line
        pdf.moveTo(left, 120).lineTo(right, 120).stroke();

        // Place cursor
        pdf.y = 135;
      }

      function drawClientBox() {
        const y = pdf.y;

        pdf.rect(left, y, right - left, 45).stroke();
        pdf.font("Helvetica-Bold").fontSize(10).fillColor("#000").text("Client", left + 10, y + 8);
        pdf.font("Helvetica").fontSize(10).text(client, left + 10, y + 25, {
          width: right - left - 20,
          ellipsis: true,
        });

        pdf.y = y + 65; // espace comme avant
      }

      function drawTableHeader() {
        // S'assurer d’avoir de la place
        ensureSpace(rowH + 10);

        pdf
          .rect(left, pdf.y, right - left, rowH)
          .fillAndStroke("#F2F2F2", "#000");

        pdf.fillColor("#000").font("Helvetica-Bold").fontSize(10);

        pdf.text("#", left + 8, pdf.y + 7);
        pdf.text("Désignation", left + col.idx + 8, pdf.y + 7);
        pdf.text("Qté", left + col.idx + col.des + 8, pdf.y + 7, {
          width: 40,
          align: "right",
        });
        pdf.text("PU", left + col.idx + col.des + col.qty + 8, pdf.y + 7, {
          width: 60,
          align: "right",
        });
        pdf.text("Montant", left + col.idx + col.des + col.qty + col.pu + 8, pdf.y + 7, {
          width: 80,
          align: "right",
        });

        pdf.y += rowH;
        pdf.font("Helvetica").fontSize(10).fillColor("#000");
      }

      // ====== Page 1: header + client + table header + items ======
      drawHeader();
      drawClientBox();

      // IMPORTANT : on dessine le footer *sur chaque page*.
      // Ici page 1, on le dessine tout de suite (on a SAFE_BOTTOM pour éviter overlap)
      drawFooter();

      drawTableHeader();

      for (let i = 0; i < items.length; i++) {
        ensureSpace(rowH + 10);

        const it = items[i] || {};
        const label = safe(it.label || it.raw || "—");
        const qty = Number(it.qty || 0);
        const pu = Number(it.unitPrice || 0);
        const amt = Number(it.amount || (qty * pu) || 0);

        pdf.rect(left, pdf.y, right - left, rowH).stroke();

        pdf.text(String(i + 1), left + 8, pdf.y + 7);
        pdf.text(label, left + col.idx + 8, pdf.y + 7, {
          width: col.des - 10,
          ellipsis: true,
        });
        pdf.text(fmtNumber(qty), left + col.idx + col.des + 8, pdf.y + 7, {
          width: 40,
          align: "right",
        });
        pdf.text(fmtNumber(pu), left + col.idx + col.des + col.qty + 8, pdf.y + 7, {
          width: 60,
          align: "right",
        });
        pdf.text(fmtNumber(amt), left + col.idx + col.des + col.qty + col.pu + 8, pdf.y + 7, {
          width: 80,
          align: "right",
        });

        pdf.y += rowH;
      }

      // ====== Total (comme avant, simple) ======
      ensureSpace(90);
      pdf.y += 20;

      const boxW = 260;
      const boxH = 40;
      pdf.rect(right - boxW, pdf.y, boxW, boxH).stroke();
      pdf.font("Helvetica-Bold").fontSize(12).fillColor("#000").text("TOTAL", right - boxW + 10, pdf.y + 12);
      pdf.text(`${fmtNumber(total)} FCFA`, right - 10, pdf.y + 12, { align: "right" });

      pdf.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildPdfBuffer };