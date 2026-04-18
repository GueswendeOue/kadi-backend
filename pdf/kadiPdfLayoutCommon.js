"use strict";

const PDFDocument = require("pdfkit");
const { safe, fmtNumber, numberToFrench } = require("./kadiPdfCommon");

function createA4Pdf() {
  return new PDFDocument({
    size: "A4",
    margin: 50,
    bufferPages: true,
  });
}

function collectPdfBuffer(pdf) {
  return new Promise((resolve, reject) => {
    try {
      const chunks = [];
      pdf.on("data", (c) => chunks.push(c));
      pdf.on("end", () => resolve(Buffer.concat(chunks)));
      pdf.on("error", reject);
    } catch (e) {
      reject(e);
    }
  });
}

function makeA4Context(pdf) {
  const pageWidth = pdf.page.width;
  const pageHeight = pdf.page.height;
  const left = 50;
  const right = pageWidth - 50;

  const FOOTER_H = 85;
  const SAFE_BOTTOM = pageHeight - FOOTER_H;

  const ROW_MIN_H = 26;
  const CELL_PAD_Y = 7;
  const CELL_PAD_X = 6;
  const MAX_LABEL_LINES = 3;

  const W = right - left;

  const col = {
    idx: 38,
    des: 235,
    qty: 55,
    pu: 70,
    amt: W - (38 + 235 + 55 + 70),
  };

  const x = {
    idx: left,
    des: left + col.idx,
    qty: left + col.idx + col.des,
    pu: left + col.idx + col.des + col.qty,
    amt: left + col.idx + col.des + col.qty + col.pu,
    end: right,
  };

  return {
    pageWidth,
    pageHeight,
    left,
    right,
    SAFE_BOTTOM,
    ROW_MIN_H,
    CELL_PAD_Y,
    CELL_PAD_X,
    MAX_LABEL_LINES,
    col,
    x,
  };
}

function getLineH(pdf) {
  return pdf.currentLineHeight(true);
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function measureLabelHeight(pdf, text, width, maxLines = 3) {
  const lineH = getLineH(pdf);
  const maxH = maxLines * lineH;
  const h = pdf.heightOfString(text, { width, lineBreak: true });
  return clamp(h, lineH, maxH);
}

function vCenterY(rowY, rowH, contentH) {
  return rowY + Math.max(0, (rowH - contentH) / 2);
}

function drawCommonFooter(pdf, ctx, qr, kadiE164) {
  const footerY = ctx.pageHeight - 60;

  pdf.save();
  pdf.strokeColor("#000").lineWidth(1);
  pdf.moveTo(ctx.left, footerY - 10).lineTo(ctx.right, footerY - 10).stroke();

  pdf.font("Helvetica").fontSize(8).fillColor("#555");
  pdf.text(
    `Généré par KADI • WhatsApp +${kadiE164} • Scannez pour essayer`,
    ctx.left,
    footerY,
    {
      width: ctx.right - ctx.left - 60,
      lineBreak: false,
    }
  );

  if (qr?.png) {
    try {
      pdf.image(qr.png, ctx.right - 50, footerY - 5, { fit: [45, 45] });
    } catch (_) {}
  }

  pdf.restore();
}

function drawBusinessHeader(pdf, ctx, {
  logoBuffer = null,
  businessProfile = null,
  title = "DOCUMENT",
  docNumber = "—",
  date = "—",
}) {
  const bp = businessProfile || {};
  const topY = 45;

  if (logoBuffer) {
    try {
      pdf.image(logoBuffer, ctx.left, topY, { fit: [60, 60] });
    } catch (_) {}
  }

  const infoX = logoBuffer ? ctx.left + 70 : ctx.left;

  pdf.fillColor("#000");
  pdf.font("Helvetica-Bold").fontSize(13).text(safe(bp.business_name) || "—", infoX, topY);

  const lines = [
    bp.address ? `Adresse : ${bp.address}` : null,
    bp.phone ? `Tel : ${bp.phone}` : null,
    bp.email ? `Email : ${bp.email}` : null,
  ].filter(Boolean);

  pdf.font("Helvetica").fontSize(9).text(lines.join("\n"), infoX, topY + 17);

  pdf.font("Helvetica-Bold").fontSize(16).text(title, ctx.left, topY, {
    width: ctx.right - ctx.left,
    align: "right",
  });

  pdf.font("Helvetica").fontSize(10);
  pdf.text(`N° : ${docNumber}`, ctx.left, topY + 20, {
    width: ctx.right - ctx.left,
    align: "right",
  });
  pdf.text(`Date : ${date}`, ctx.left, topY + 35, {
    width: ctx.right - ctx.left,
    align: "right",
  });

  pdf.moveTo(ctx.left, 120).lineTo(ctx.right, 120).stroke();
}

function drawPartyBox(pdf, ctx, {
  label = "Client",
  client = "—",
  clientPhone = null,
  subject = null,
}) {
  const hasClientPhone = !!safe(clientPhone);
  const hasSubject = !!safe(subject);

  let boxH = 45;
  if (hasClientPhone) boxH += 14;
  if (hasSubject) boxH += 14;

  const y = 135;

  pdf.rect(ctx.left, y, ctx.right - ctx.left, boxH).stroke();

  pdf.font("Helvetica-Bold").fontSize(10).fillColor("#000");
  pdf.text(label, ctx.left + 10, y + 8);

  let cursorY = y + 24;

  pdf.font("Helvetica").fontSize(10).fillColor("#000");
  pdf.text(client || "—", ctx.left + 10, cursorY);

  if (hasClientPhone) {
    cursorY += 14;
    pdf.font("Helvetica").fontSize(9).fillColor("#444");
    pdf.text(`Téléphone : ${safe(clientPhone)}`, ctx.left + 10, cursorY);
  }

  if (hasSubject) {
    cursorY += 14;
    pdf.font("Helvetica").fontSize(9).fillColor("#444");
    pdf.text(`Objet : ${safe(subject)}`, ctx.left + 10, cursorY);
  }

  pdf.fillColor("#000");
  pdf.y = y + boxH + 20;
}

function drawRowGrid(pdf, ctx, y0, height) {
  pdf.rect(ctx.left, y0, ctx.right - ctx.left, height).stroke();
  pdf.moveTo(ctx.x.des, y0).lineTo(ctx.x.des, y0 + height).stroke();
  pdf.moveTo(ctx.x.qty, y0).lineTo(ctx.x.qty, y0 + height).stroke();
  pdf.moveTo(ctx.x.pu, y0).lineTo(ctx.x.pu, y0 + height).stroke();
  pdf.moveTo(ctx.x.amt, y0).lineTo(ctx.x.amt, y0 + height).stroke();
}

function drawTableHeader(pdf, ctx) {
  const rowH = ctx.ROW_MIN_H;
  const y0 = pdf.y;

  pdf.save();
  pdf.rect(ctx.left, y0, ctx.right - ctx.left, rowH).fill("#F2F2F2");
  pdf.restore();

  drawRowGrid(pdf, ctx, y0, rowH);

  pdf.fillColor("#000").font("Helvetica-Bold").fontSize(10);

  const lineH = getLineH(pdf);
  const yy = vCenterY(y0, rowH, lineH);

  pdf.text("#", ctx.x.idx, yy, {
    width: ctx.col.idx,
    align: "center",
    lineBreak: false,
  });
  pdf.text("Désignation", ctx.x.des + ctx.CELL_PAD_X, yy, {
    width: ctx.col.des - ctx.CELL_PAD_X * 2,
    lineBreak: false,
  });
  pdf.text("Qté", ctx.x.qty, yy, {
    width: ctx.col.qty - 10,
    align: "right",
    lineBreak: false,
  });
  pdf.text("PU", ctx.x.pu, yy, {
    width: ctx.col.pu - 10,
    align: "right",
    lineBreak: false,
  });
  pdf.text("Montant", ctx.x.amt, yy, {
    width: ctx.col.amt - 10,
    align: "right",
    lineBreak: false,
  });

  pdf.y = y0 + rowH;
  pdf.font("Helvetica").fontSize(10);
}

function drawItemRow(pdf, ctx, index, item = {}) {
  pdf.fillColor("#000").font("Helvetica").fontSize(10);

  const label = safe(item.label || item.raw || "—");
  const qty = Number(item.qty || 0);
  const pu = Number(item.unitPrice || 0);
  const amt = Number(item.amount || qty * pu || 0);

  const labelW = ctx.col.des - ctx.CELL_PAD_X * 2;
  const labelH = measureLabelHeight(
    pdf,
    label,
    labelW,
    ctx.MAX_LABEL_LINES
  );
  const rowH = Math.max(ctx.ROW_MIN_H, labelH + ctx.CELL_PAD_Y * 2);

  const y0 = pdf.y;
  drawRowGrid(pdf, ctx, y0, rowH);

  const lineH = getLineH(pdf);
  const cy = vCenterY(y0, rowH, lineH);

  pdf.text(String(index + 1), ctx.x.idx, cy, {
    width: ctx.col.idx,
    align: "center",
    lineBreak: false,
  });

  pdf.text(label, ctx.x.des + ctx.CELL_PAD_X, y0 + ctx.CELL_PAD_Y, {
    width: labelW,
    lineBreak: true,
    height: rowH - ctx.CELL_PAD_Y * 2,
    ellipsis: true,
  });

  pdf.text(fmtNumber(qty), ctx.x.qty, cy, {
    width: ctx.col.qty - 10,
    align: "right",
    lineBreak: false,
  });

  pdf.text(fmtNumber(pu), ctx.x.pu, cy, {
    width: ctx.col.pu - 10,
    align: "right",
    lineBreak: false,
  });

  pdf.text(fmtNumber(amt), ctx.x.amt, cy, {
    width: ctx.col.amt - 10,
    align: "right",
    lineBreak: false,
  });

  pdf.y = y0 + rowH;
}

function drawTotalBox(pdf, ctx, total) {
  pdf.y += 18;

  const boxW = 260;
  const boxH = 40;
  const boxX = ctx.right - boxW;
  const boxY = pdf.y;

  pdf.rect(boxX, boxY, boxW, boxH).stroke();

  pdf.font("Helvetica-Bold").fontSize(12).fillColor("#000");
  pdf.text("TOTAL", boxX + 10, boxY + 12, {
    width: 70,
    lineBreak: false,
  });

  pdf.text(`${fmtNumber(total)} FCFA`, boxX + 80, boxY + 12, {
    width: boxW - 90,
    align: "right",
    lineBreak: false,
  });

  pdf.y = boxY + boxH + 14;
}

function drawAmountInWords(pdf, ctx, phrase, total) {
  const words = numberToFrench(total);

  pdf.font("Helvetica-Bold").fontSize(10).fillColor("#000");
  pdf.text(`${phrase} à la somme de : ${words} francs CFA.`, ctx.left, pdf.y, {
    width: ctx.right - ctx.left,
  });
}

module.exports = {
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
};