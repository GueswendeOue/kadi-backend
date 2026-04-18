"use strict";

const {
  createA4Pdf,
  collectPdfBuffer,
  makeA4Context,
  drawCommonFooter,
  drawBusinessHeader,
  drawPartyBox,
} = require("./kadiPdfLayoutCommon");
const { fmtNumber, numberToFrench, safe } = require("./kadiPdfCommon");

async function buildDechargePdf(args = {}) {
  const { docData = {}, businessProfile = null, logoBuffer = null, qr = null, kadiE164 = "" } = args;

  const pdf = createA4Pdf();
  const bufferPromise = collectPdfBuffer(pdf);
  const ctx = makeA4Context(pdf);

  drawBusinessHeader(pdf, ctx, {
    logoBuffer,
    businessProfile,
    title: "DÉCHARGE",
    docNumber: docData.docNumber || "—",
    date: docData.date || "—",
  });

  drawPartyBox(pdf, ctx, {
    label: "Concerné",
    client: docData.client || "—",
    clientPhone: docData.clientPhone || null,
    subject: docData.subject || null,
  });

  pdf.font("Helvetica").fontSize(11).fillColor("#000");

  const body =
    docData.dechargeText ||
    `Je soussigné(e), ${docData.client || "—"}, reconnais avoir reçu : ${
      safe(docData.motif) || "objet non précisé"
    }. La présente décharge est établie pour servir et valoir ce que de droit.`;

  pdf.text(body, ctx.left, pdf.y, {
    width: ctx.right - ctx.left,
    align: "left",
    lineGap: 4,
  });

  const total = Number(docData.total || 0);

  if (total > 0) {
    pdf.y += 20;

    const boxW = 260;
    const boxH = 40;
    const boxX = ctx.right - boxW;
    const boxY = pdf.y;

    pdf.rect(boxX, boxY, boxW, boxH).stroke();

    pdf.font("Helvetica-Bold").fontSize(12).fillColor("#000");
    pdf.text("MONTANT", boxX + 10, boxY + 12, {
      width: 80,
      lineBreak: false,
    });

    pdf.text(`${fmtNumber(total)} FCFA`, boxX + 90, boxY + 12, {
      width: boxW - 100,
      align: "right",
      lineBreak: false,
    });

    pdf.y = boxY + boxH + 16;

    const words = numberToFrench(total);
    pdf.font("Helvetica-Bold").fontSize(10).fillColor("#000");
    pdf.text(`Montant en lettres : ${words} francs CFA.`, ctx.left, pdf.y, {
      width: ctx.right - ctx.left,
    });
  }

  drawCommonFooter(pdf, ctx, qr, kadiE164);
  pdf.end();

  return bufferPromise;
}

module.exports = {
  buildDechargePdf,
};