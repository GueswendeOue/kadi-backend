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
const { closingPhrase } = require("./kadiPdfCommon");

async function buildFacturePdf(args = {}) {
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
      title: "FACTURE",
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
    title: "FACTURE",
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

  ensureSpace(190);

  const total = Number(docData.total || 0);
  drawTotalBox(pdf, ctx, total);
  drawAmountInWords(pdf, ctx, closingPhrase("facture"), total);

  drawCommonFooter(pdf, ctx, qr, kadiE164);
  pdf.end();

  return bufferPromise;
}

module.exports = {
  buildFacturePdf,
};