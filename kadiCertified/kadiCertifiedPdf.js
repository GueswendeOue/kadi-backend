"use strict";

const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

function toNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function safeText(v, def = "") {
  const s = String(v ?? "").trim();
  return s || def;
}

function money(v) {
  const n = Math.round(toNum(v, 0));
  return `${n.toLocaleString("fr-FR")} F`;
}

function formatDateOnly(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("fr-FR", { timeZone: "UTC" });
  } catch (_) {
    return "-";
  }
}

function formatTimeOnly(iso) {
  try {
    const d = new Date(iso);
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm} UTC+0`;
  } catch (_) {
    return "-";
  }
}

function shortHash(hash) {
  const s = safeText(hash, "-");
  if (s.length <= 24) return s;
  return `${s.slice(0, 24)}…`;
}

function getStatusLabel(status) {
  const s = safeText(status, "draft").toLowerCase();

  if (s === "certified") return "CERTIFIÉE ✅";
  if (s === "pending") return "EN ATTENTE";
  if (s === "rejected") return "REJETÉE";
  if (s === "cancelled") return "ANNULÉE";
  return "BROUILLON";
}

function drawBox(doc, x, y, w, h, opts = {}) {
  if (opts.fillColor) {
    doc.save();
    doc.fillColor(opts.fillColor).rect(x, y, w, h).fill();
    doc.restore();
  }

  doc.save();
  doc.lineWidth(opts.lineWidth || 1);
  doc.strokeColor(opts.strokeColor || "#111111");
  doc.rect(x, y, w, h).stroke();
  doc.restore();
}

function drawText(doc, text, x, y, opts = {}) {
  doc
    .font(opts.font || "Helvetica")
    .fontSize(opts.size || 10)
    .fillColor(opts.color || "#111111")
    .text(String(text || ""), x, y, {
      width: opts.width,
      align: opts.align || "left",
      lineGap: opts.lineGap || 0,
    });
}

function drawLine(doc, x1, y1, x2, y2, color = "#111111", width = 1) {
  doc.save();
  doc.strokeColor(color).lineWidth(width).moveTo(x1, y1).lineTo(x2, y2).stroke();
  doc.restore();
}

function ensureSpace(doc, neededHeight, bottomMargin = 40) {
  if (doc.y + neededHeight <= doc.page.height - bottomMargin) return false;
  doc.addPage();
  return true;
}

async function buildQrBuffer(value) {
  const payload = safeText(value);
  if (!payload) return null;

  return QRCode.toBuffer(payload, {
    type: "png",
    width: 240,
    margin: 1,
  });
}

function drawHeader(doc, invoice, businessProfile, logoBuffer) {
  const x = 40;
  const y = 36;
  const w = doc.page.width - 80;
  const h = 82;

  drawBox(doc, x, y, w, h);

  if (Buffer.isBuffer(logoBuffer)) {
    try {
      doc.image(logoBuffer, x + 12, y + 12, {
        fit: [72, 56],
        align: "left",
        valign: "center",
      });
    } catch (_) {}
  }

  const sellerName = safeText(invoice?.seller_name || businessProfile?.business_name, "ENTREPRISE");
  const sellerIfu = safeText(invoice?.seller_ifu || businessProfile?.ifu || businessProfile?.business_ifu, "-");
  const sellerPhone = safeText(invoice?.seller_phone || businessProfile?.phone, "-");
  const sellerAddress = safeText(invoice?.seller_address || businessProfile?.address, "");

  drawText(doc, sellerName, x + 98, y + 12, {
    size: 16,
    font: "Helvetica-Bold",
    width: 300,
  });

  drawText(doc, `IFU: ${sellerIfu}`, x + 98, y + 35, {
    size: 10,
    width: 220,
  });

  drawText(doc, `Tel: ${sellerPhone}`, x + 98, y + 50, {
    size: 10,
    width: 220,
  });

  drawText(doc, sellerAddress, x + 98, y + 64, {
    size: 9,
    width: 300,
  });

  doc.y = y + h + 10;
}

function drawTitleBlock(doc, invoice) {
  const x = 40;
  const y = doc.y;
  const w = doc.page.width - 80;
  const h = 64;

  drawBox(doc, x, y, w, h);

  drawText(doc, "FACTURE ÉLECTRONIQUE CERTIFIÉE", x + 12, y + 10, {
    size: 15,
    font: "Helvetica-Bold",
    width: 330,
  });

  drawText(doc, `N°: ${safeText(invoice?.invoice_number, "-")}`, x + 12, y + 33, {
    size: 10,
    width: 260,
  });

  drawText(doc, `Date: ${formatDateOnly(invoice?.issued_at)}`, x + 360, y + 12, {
    size: 10,
    width: 130,
  });

  drawText(doc, `Heure: ${formatTimeOnly(invoice?.issued_at)}`, x + 360, y + 27, {
    size: 10,
    width: 130,
  });

  drawText(
    doc,
    `Statut: ${getStatusLabel(invoice?.status || invoice?.compliance_status)}`,
    x + 360,
    y + 42,
    {
      size: 10,
      font: "Helvetica-Bold",
      width: 150,
    }
  );

  doc.y = y + h + 10;
}

function drawIssuerBuyerBlock(doc, invoice) {
  const x = 40;
  const y = doc.y;
  const w = doc.page.width - 80;
  const h = 98;
  const half = w / 2;

  drawBox(doc, x, y, w, h);
  drawLine(doc, x + half, y, x + half, y + h);

  drawText(doc, "ÉMETTEUR", x + 12, y + 10, {
    size: 11,
    font: "Helvetica-Bold",
    width: half - 24,
  });

  drawText(doc, safeText(invoice?.seller_name, "-"), x + 12, y + 30, {
    size: 10,
    width: half - 24,
  });

  drawText(doc, `IFU: ${safeText(invoice?.seller_ifu, "-")}`, x + 12, y + 45, {
    size: 10,
    width: half - 24,
  });

  if (invoice?.seller_phone) {
    drawText(doc, `Tel: ${safeText(invoice.seller_phone)}`, x + 12, y + 60, {
      size: 10,
      width: half - 24,
    });
  }

  if (invoice?.seller_address) {
    drawText(doc, safeText(invoice.seller_address), x + 12, y + 75, {
      size: 9,
      width: half - 24,
    });
  }

  const rx = x + half + 12;

  drawText(doc, "CLIENT", rx, y + 10, {
    size: 11,
    font: "Helvetica-Bold",
    width: half - 24,
  });

  drawText(doc, safeText(invoice?.buyer_name, "-"), rx, y + 30, {
    size: 10,
    width: half - 24,
  });

  if (invoice?.buyer_phone) {
    drawText(doc, `Tel: ${safeText(invoice.buyer_phone)}`, rx, y + 45, {
      size: 10,
      width: half - 24,
    });
  }

  if (invoice?.buyer_ifu) {
    drawText(doc, `IFU: ${safeText(invoice.buyer_ifu)}`, rx, y + 60, {
      size: 10,
      width: half - 24,
    });
  }

  if (invoice?.buyer_address) {
    drawText(doc, safeText(invoice.buyer_address), rx, y + 75, {
      size: 9,
      width: half - 24,
    });
  }

  doc.y = y + h + 12;
}

function drawItemsHeader(doc, x, y, widths) {
  const totalWidth = widths.reduce((a, b) => a + b, 0);

  drawBox(doc, x, y, totalWidth, 24, {
    fillColor: "#F3F4F6",
  });

  const labels = ["DÉSIGNATION", "QTÉ", "P.U", "TOTAL"];
  let cx = x;

  labels.forEach((label, idx) => {
    drawText(doc, label, cx + 6, y + 7, {
      size: 9,
      font: "Helvetica-Bold",
      width: widths[idx] - 12,
      align: idx === 0 ? "left" : "right",
    });
    cx += widths[idx];
  });
}

function drawItemsRows(doc, items, x, startY, widths) {
  let y = startY;
  const rowHeight = 22;
  const totalWidth = widths.reduce((a, b) => a + b, 0);

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];

    if (ensureSpace(doc, 160)) {
      y = 40;
      drawItemsHeader(doc, x, y, widths);
      y += 28;
    }

    drawBox(doc, x, y, totalWidth, rowHeight, {
      fillColor: i % 2 === 0 ? "#FFFFFF" : "#FAFAFA",
    });

    const cells = [
      safeText(item?.designation, "Article"),
      String(toNum(item?.quantity, 0)),
      money(item?.unit_price),
      money(item?.line_total_ht),
    ];

    let cx = x;

    cells.forEach((cell, idx) => {
      drawText(doc, cell, cx + 6, y + 6, {
        size: 9,
        width: widths[idx] - 12,
        align: idx === 0 ? "left" : "right",
      });
      cx += widths[idx];
    });

    y += rowHeight;
  }

  return y;
}

function drawTotalsBlock(doc, invoice) {
  const x = 300;
  const y = doc.y + 8;
  const w = 255;
  const h = 72;

  drawBox(doc, x, y, w, h);

  drawText(doc, "TOTAL HT", x + 12, y + 10, {
    size: 10,
    font: "Helvetica-Bold",
    width: 110,
  });
  drawText(doc, money(invoice?.total_ht), x + 120, y + 10, {
    size: 10,
    width: 110,
    align: "right",
  });

  drawText(doc, `TVA (${toNum(invoice?.vat_rate, 0)}%)`, x + 12, y + 29, {
    size: 10,
    font: "Helvetica-Bold",
    width: 110,
  });
  drawText(doc, money(invoice?.vat_amount), x + 120, y + 29, {
    size: 10,
    width: 110,
    align: "right",
  });

  drawText(doc, "TOTAL TTC", x + 12, y + 48, {
    size: 11,
    font: "Helvetica-Bold",
    width: 110,
  });
  drawText(doc, money(invoice?.total_ttc), x + 120, y + 48, {
    size: 11,
    font: "Helvetica-Bold",
    width: 110,
    align: "right",
  });

  doc.y = y + h + 12;
}

function drawComplianceBlock(doc, invoice) {
  const x = 40;
  const y = doc.y;
  const w = doc.page.width - 80;
  const h = 78;

  drawBox(doc, x, y, w, h);

  drawText(doc, "RÉFÉRENCE DE CONFORMITÉ", x + 12, y + 10, {
    size: 11,
    font: "Helvetica-Bold",
    width: 260,
  });

  drawText(doc, `ID document : ${safeText(invoice?.invoice_number, "-")}`, x + 12, y + 30, {
    size: 10,
    width: 320,
  });

  drawText(
    doc,
    `Référence conformité : ${safeText(invoice?.compliance_reference, "EN ATTENTE")}`,
    x + 12,
    y + 46,
    {
      size: 10,
      width: 360,
    }
  );

  drawText(doc, `Hash : ${shortHash(invoice?.compliance_hash)}`, x + 12, y + 62, {
    size: 9,
    width: 360,
  });

  drawText(doc, `Version : v${toNum(invoice?.compliance_version, 1)}`, x + 410, y + 30, {
    size: 10,
    width: 120,
    align: "right",
  });

  drawText(
    doc,
    `Provider : ${safeText(invoice?.compliance_provider, "kadi_internal")}`,
    x + 380,
    y + 46,
    {
      size: 9,
      width: 150,
      align: "right",
    }
  );

  doc.y = y + h + 12;
}

function drawVerificationBlock(doc, invoice, qrBuffer) {
  const x = 40;
  const y = doc.y;
  const w = doc.page.width - 80;
  const h = 102;

  drawBox(doc, x, y, w, h);

  if (Buffer.isBuffer(qrBuffer)) {
    try {
      doc.image(qrBuffer, x + 12, y + 12, {
        fit: [72, 72],
        align: "left",
        valign: "top",
      });
    } catch (_) {}
  }

  drawText(doc, "VÉRIFICATION NUMÉRIQUE", x + 100, y + 14, {
    size: 11,
    font: "Helvetica-Bold",
    width: 260,
  });

  drawText(
    doc,
    safeText(invoice?.verification_url, "Vérification indisponible"),
    x + 100,
    y + 34,
    {
      size: 9,
      width: 390,
    }
  );

  drawText(doc, "Document généré via KADI", x + 100, y + 58, {
    size: 10,
    font: "Helvetica-Bold",
    width: 240,
  });

  drawText(
    doc,
    "Facture certifiée — traçabilité et vérification numérique actives",
    x + 100,
    y + 74,
    {
      size: 9,
      width: 390,
    }
  );

  doc.y = y + h + 12;
}

function drawFooter(doc) {
  const y = doc.page.height - 34;

  drawText(doc, "KADI — Facture électronique certifiée", 40, y, {
    size: 8,
    color: "#555555",
    width: doc.page.width - 80,
    align: "center",
  });
}

async function buildCertifiedInvoicePdfBuffer({
  invoice,
  items,
  businessProfile = null,
  logoBuffer = null,
}) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 40, left: 40, right: 40, bottom: 40 },
      });

      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const safeItems = Array.isArray(items) ? items : [];
      const qrBuffer = await buildQrBuffer(
        invoice?.qr_payload || invoice?.verification_url
      );

      drawHeader(doc, invoice, businessProfile, logoBuffer);
      drawTitleBlock(doc, invoice);
      drawIssuerBuyerBlock(doc, invoice);

      const tableX = 40;
      const colWidths = [280, 60, 90, 90];

      drawItemsHeader(doc, tableX, doc.y, colWidths);
      const rowsEndY = drawItemsRows(doc, safeItems, tableX, doc.y + 28, colWidths);
      doc.y = rowsEndY;

      drawTotalsBlock(doc, invoice);

      ensureSpace(doc, 220);
      drawComplianceBlock(doc, invoice);
      drawVerificationBlock(doc, invoice, qrBuffer);
      drawFooter(doc);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = {
  buildCertifiedInvoicePdfBuffer,
};