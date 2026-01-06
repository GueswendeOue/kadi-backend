// kadiPdf.js
"use strict";

const PDFDocument = require("pdfkit");

function safe(v) {
  return String(v ?? "").trim();
}

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n));
}

/**
 * ✅ buildPdfBuffer compatible 2 formats :
 *
 * 1) Ancien format:
 * buildPdfBuffer({ docData, businessProfile, logoBuffer })
 *
 * 2) Format plat:
 * buildPdfBuffer({ type, docNumber, date, client, items, total, businessProfile, logoBuffer })
 */
function buildPdfBuffer(payload = {}) {
  const hasDocData = payload.docData && typeof payload.docData === "object";

  const docData = hasDocData
    ? payload.docData
    : {
        type: payload.type,
        docNumber: payload.docNumber,
        date: payload.date,
        client: payload.client,
        items: payload.items,
        total: payload.total,
      };

  const bp = payload.businessProfile || payload.business || null;
  const logoBuffer = payload.logoBuffer || null;

  return new Promise((resolve, reject) => {
    try {
      const pdf = new PDFDocument({ size: "A4", margin: 50 });
      const chunks = [];
      pdf.on("data", (c) => chunks.push(c));
      pdf.on("end", () => resolve(Buffer.concat(chunks)));

      // --------- DOC FIELDS ----------
      const type = String(docData?.type || "DOCUMENT").toUpperCase();
      const docNumber = safe(docData?.docNumber) || "—";
      const date = safe(docData?.date) || "—";
      const client = safe(docData?.client) || "—";
      const items = Array.isArray(docData?.items) ? docData.items : [];

      // total: si pas fourni, on calcule depuis items
      const computedTotal = items.reduce((sum, it) => {
        const n = Number(it?.amount);
        return Number.isFinite(n) ? sum + n : sum;
      }, 0);
      const total = docData?.total != null ? docData.total : computedTotal;

      // --------- LAYOUT ----------
      const leftX = 50;
      const topY = 50;

      // ---- Logo ----
      if (logoBuffer) {
        try {
          pdf.image(logoBuffer, leftX, topY, { fit: [80, 80] });
        } catch (e) {
          // ignore logo if unsupported
        }
      }

      const headerTextX = leftX + (logoBuffer ? 95 : 0);

      // ---- Entreprise (bloc gauche) ----
      const businessName = safe(bp?.business_name) || "KADI";
      const businessLine = [
        safe(bp?.address) ? `Adresse: ${safe(bp.address)}` : null,
        safe(bp?.phone) ? `Tel: ${safe(bp.phone)}` : null,
        safe(bp?.email) ? `Email: ${safe(bp.email)}` : null,
        safe(bp?.ifu) ? `IFU: ${safe(bp.ifu)}` : null,
        safe(bp?.rccm) ? `RCCM: ${safe(bp.rccm)}` : null,
      ]
        .filter(Boolean)
        .join(" | ");

      pdf.fontSize(14).text(businessName, headerTextX, topY);
      pdf.fontSize(10).text(businessLine || "", headerTextX, topY + 22, {
        width: 420,
      });

      // ---- Meta doc (droite) ----
      pdf.fontSize(16).text(type, 50, topY, { align: "right" });
      pdf.fontSize(11).text(`Numéro : ${docNumber}`, { align: "right" });
      pdf.fontSize(11).text(`Date : ${date}`, { align: "right" });

      // ---- Client ----
      pdf.moveDown(5);
      pdf.fontSize(12).text(`Client : ${client}`);
      pdf.moveDown(1);

      // --------- TABLE ----------
      const startX = 50;
      let y = pdf.y;

      // Header row
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
        const label = safe(it?.label || it?.raw) || "—";
        const qty = it?.qty ?? 0;
        const pu = it?.unitPrice ?? 0;
        const amt = it?.amount ?? (Number(qty) * Number(pu) || 0);

        pdf.fontSize(10).text(String(idx + 1), startX, y);
        pdf.text(label, startX + 30, y, { width: 260 });
        pdf.text(String(qty ?? 0), startX + 300, y, { width: 40, align: "right" });
        pdf.text(money(pu), startX + 350, y, { width: 70, align: "right" });
        pdf.text(money(amt), startX + 430, y, { width: 90, align: "right" });

        y += 18;

        if (y > 720) {
          pdf.addPage();
          y = 80;
        }
      });

      y += 10;
      pdf.moveTo(startX, y).lineTo(545, y).stroke();
      y += 10;

      pdf.fontSize(12).text(`Total : ${money(total)}`, startX + 350, y, {
        width: 185,
        align: "right",
      });

      pdf.moveDown(3);
      pdf.fontSize(10).text("Merci pour votre confiance.", { align: "center" });

      pdf.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildPdfBuffer };