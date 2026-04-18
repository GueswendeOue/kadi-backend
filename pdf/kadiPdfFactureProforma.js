"use strict";

const {
  createA4Pdf,
  collectPdfBuffer,
  makeA4Context,
  drawCommonFooter,
  drawBusinessHeader,
  drawPartyBox,
  drawTableHeader,
  drawItemRow,
  drawTotalBox,
  drawAmountInWords,
} = require("./kadiPdfLayoutCommon");
const { closingPhrase, safe } = require("./kadiPdfCommon");

async function buildFactureProformaPdf(args = {}) {
  const { docData = {}, businessProfile = null, logoBuffer = null, qr = null, kadiE164 = "" } = args;

  const pdf = createA4Pdf();
  const bufferPromise = collectPdfBuffer(pdf);
  const ctx = makeA4Context(pdf);

  function addPageWithHeader() {
    drawCommonFooter(pdf, ctx, qr, kadiE164);
    pdf.addPage();

    drawBusinessHeader(pdf, ctx, {
      logoBuffer,
      businessProfile,
      title: "FACTURE PRO FORMA",
      docNumber: docData.docNumber || "—",
      date: docData.date || "—",
    });

    pdf.y = 140;
    drawTableHeader(pdf, ctx);
  }

  function ensureSpace(needed) {
    if (pdf.y + needed > ctx.SAFE_BOTTOM) addPageWithHeader();
  }

  drawBusinessHeader(pdf, ctx, {
    logoBuffer,
    businessProfile,
    title: "FACTURE PRO FORMA",
    docNumber: docData.docNumber || "—",
    date: docData.date || "—",
  });

  drawPartyBox(pdf, ctx, {
    label: "Client",
    client: docData.client || "—",
    clientPhone: docData.clientPhone || null,
    subject: docData.subject || null,
  });

  drawTableHeader(pdf, ctx);

  const items = Array.isArray(docData.items) ? docData.items : [];
  for (let i = 0; i < items.length; i++) {
    ensureSpace(42);
    drawItemRow(pdf, ctx, i, items[i] || {});
  }

  ensureSpace(220);

  const total = Number(docData.total || 0);
  drawTotalBox(pdf, ctx, total);
  drawAmountInWords(pdf, ctx, closingPhrase("facture_proforma"), total);

  const conditions = Array.isArray(docData.conditions) ? docData.conditions : [];
  const paymentTerms = safe(docData.paymentTerms || "");
  const validityDays = Number(docData.validityDays || 0);

  const lines = [];
  if (paymentTerms) lines.push(`Conditions de paiement : ${paymentTerms}`);
  if (validityDays > 0) lines.push(`Validité : ${validityDays} jour(s)`);
  if (conditions.length) {
    for (const c of conditions) {
      if (safe(c)) lines.push(`- ${safe(c)}`);
    }
  }

  if (lines.length) {
    pdf.y += 12;
    pdf.font("Helvetica-Bold").fontSize(10).fillColor("#000");
    pdf.text("Conditions", ctx.left, pdf.y);

    pdf.y += 8;
    pdf.font("Helvetica").fontSize(9).fillColor("#444");
    pdf.text(lines.join("\n"), ctx.left, pdf.y, {
      width: ctx.right - ctx.left,
      lineGap: 3,
    });
  }

  drawCommonFooter(pdf, ctx, qr, kadiE164);
  pdf.end();

  return bufferPromise;
}

module.exports = {
  buildFactureProformaPdf,
};