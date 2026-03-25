// kadiPdf.js — Unified PDF generator (devis/facture/reçu/décharge)
// FIXED GRID + SMART ROWS (wrap designation + auto row height)
"use strict";

const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

// ================= Utils =================
function safe(v) {
  return String(v || "").trim();
}

function fmtNumber(n) {
  const x = Math.round(Number(n || 0));
  if (!Number.isFinite(x)) return "0";
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function numberToFrench(n) {
  n = Math.floor(Number(n) || 0);
  if (n === 0) return "zéro";

  const units = ["", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf"];
  const teens = ["dix", "onze", "douze", "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf"];
  const tens = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante", "soixante", "quatre-vingt", "quatre-vingt"];

  function under100(x) {
    if (x < 10) return units[x];
    if (x < 20) return teens[x - 10];

    const t = Math.floor(x / 10);
    const u = x % 10;

    if (t === 7 || t === 9) {
      const base = tens[t];
      const rest = x - t * 10;
      return `${base}-${teens[rest - 10]}`;
    }
    if (t === 8 && u === 0) return "quatre-vingts";
    if (u === 0) return tens[t];
    if (t === 8) return `quatre-vingt-${units[u]}`;
    if (u === 1 && (t === 2 || t === 3 || t === 4 || t === 5 || t === 6)) return `${tens[t]} et un`;
    return `${tens[t]}-${units[u]}`;
  }

  function under1000(x) {
    const h = Math.floor(x / 100);
    const r = x % 100;
    let s = "";
    if (h > 0) {
      s = h === 1 ? "cent" : `${units[h]} cent`;
      if (r === 0 && h > 1) s += "s";
    }
    if (r > 0) s = s ? `${s} ${under100(r)}` : under100(r);
    return s;
  }

  function chunk(x, value, name) {
    const q = Math.floor(x / value);
    const r = x % value;
    if (q === 0) return { text: "", rest: r };

    if (name === "mille") {
      if (q === 1) return { text: "mille", rest: r };
      return { text: `${under1000(q)} mille`, rest: r };
    }
    const t = q === 1 ? `${name}` : `${under1000(q)} ${name}s`;
    return { text: t, rest: r };
  }

  let x = n;
  const parts = [];

  const m = chunk(x, 1_000_000, "million");
  if (m.text) parts.push(m.text);
  x = m.rest;

  const k = chunk(x, 1_000, "mille");
  if (k.text) parts.push(k.text);
  x = k.rest;

  if (x > 0) parts.push(under1000(x));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function normalizeDocType(typeUpper) {
  const t = String(typeUpper || "").toUpperCase().trim();
  if (!t) return "DOCUMENT";
  if (t.includes("PRO FORMA")) return "FACTURE PRO FORMA";
  if (t.includes("FACTURE")) return "FACTURE";
  if (t.includes("DEVIS")) return "DEVIS";
  if (t.includes("REÇU") || t.includes("RECU")) return "REÇU";
  if (t.includes("DÉCHARGE") || t.includes("DECHARGE")) return "DÉCHARGE";
  return t;
}

function closingPhrase(typeUpper) {
  const t = normalizeDocType(typeUpper);
  if (t.includes("FACTURE")) return "Arrêtée la présente facture";
  if (t.includes("REÇU") || t.includes("RECU")) return "Arrêté le présent reçu";
  if (t.includes("DEVIS")) return "Arrêté le présent devis";
  if (t.includes("DÉCHARGE") || t.includes("DECHARGE")) return "Arrêtée la présente décharge";
  return "Arrêté le présent document";
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
  const KADI_PREFILL = process.env.KADI_QR_PREFILL || "Bonjour KADI, je veux créer un document";
  const qr = await makeKadiQrBuffer({
    fullNumberE164: KADI_E164,
    prefillText: KADI_PREFILL,
  });

  const rawType = String(docData.type || "DOCUMENT").toUpperCase();
  const normalizedType = normalizeDocType(rawType);
  const receiptFormat = String(docData.receiptFormat || "a4").toLowerCase();
  const isCompactReceipt =
    normalizedType === "REÇU" && receiptFormat === "compact";

  return new Promise((resolve, reject) => {
    try {
      const pdf = new PDFDocument({
        size: isCompactReceipt ? [280, 420] : "A4",
        margin: isCompactReceipt ? 16 : 50,
        bufferPages: true,
      });

      const chunks = [];
      pdf.on("data", (c) => chunks.push(c));
      pdf.on("end", () => resolve(Buffer.concat(chunks)));

      const pageWidth = pdf.page.width;
      const pageHeight = pdf.page.height;
      const left = isCompactReceipt ? 20 : 50;
      const right = pageWidth - (isCompactReceipt ? 20 : 50);

      const type = normalizedType;
      const isReceipt = type === "REÇU";

      const number = docData.docNumber || "—";
      const date = docData.date || "—";
      const client = docData.client || "—";
      const items = Array.isArray(docData.items) ? docData.items : [];
      const total = Number(docData.total || 0);
      const bp = businessProfile || {};

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

      function clamp(n, a, b) {
        return Math.max(a, Math.min(b, n));
      }

      function getLineH() {
        return pdf.currentLineHeight(true);
      }

      function measureLabelHeight(text, width) {
        const lineH = getLineH();
        const maxH = MAX_LABEL_LINES * lineH;
        const h = pdf.heightOfString(text, { width, lineBreak: true });
        return clamp(h, lineH, maxH);
      }

      function vCenterY(rowY, rowH, contentH) {
        return rowY + Math.max(0, (rowH - contentH) / 2);
      }

      function drawFooter() {
        if (isCompactReceipt) return;

        const footerY = pageHeight - 60;

        pdf.save();
        pdf.strokeColor("#000").lineWidth(1);
        pdf.moveTo(left, footerY - 10).lineTo(right, footerY - 10).stroke();

        pdf.font("Helvetica").fontSize(8).fillColor("#555");
        pdf.text(`Généré par KADI • WhatsApp +${KADI_E164} • Scannez pour essayer`, left, footerY, {
          width: right - left - 60,
          lineBreak: false,
        });

        if (!isCompactReceipt) {
          try {
            pdf.image(qr.png, right - 50, footerY - 5, { fit: [45, 45] });
          } catch (_) {}
        }

        pdf.restore();
      }

  function drawCompactReceipt() {
  const compactW = 220;
  const compactLeft = Math.round((pageWidth - compactW) / 2);
  const compactRight = compactLeft + compactW;

  const qrSize = 34;
  let y = 18;

  function hr() {
    pdf.save();
    pdf.strokeColor("#D9D9D9").lineWidth(1);
    pdf.moveTo(compactLeft, y).lineTo(compactRight, y).stroke();
    pdf.restore();
    y += 8;
  }

  // Header
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

  // Infos document
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

  // Client
  pdf.font("Helvetica-Bold").fontSize(8).fillColor("#777");
  pdf.text("CLIENT", compactLeft, y);

  pdf.font("Helvetica").fontSize(9).fillColor("#000");
  pdf.text(client, compactLeft, y + 10, {
    width: compactW,
    align: "left",
  });

  y += 24;
  hr();

  // Items
  for (const it of items) {
    const label = safe(it.label || it.raw || "—");
    const qty = Number(it.qty || 0);
    const pu = Number(it.unitPrice || 0);
    const amt = Number(it.amount || (qty * pu) || 0);

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

  // Total
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

  // Statut
  pdf.font("Helvetica-Bold").fontSize(8).fillColor("#138A36");
  pdf.text("PAYÉ", compactLeft, y);

  y += 18;

  // Footer compact branding KADI
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

  try {
    pdf.image(qr.png, qrX, qrY, { fit: [qrSize, qrSize] });
  } catch (_) {}

  pdf.font("Helvetica").fontSize(6).fillColor("#777");
  pdf.text("Essayer", qrX - 4, qrY + qrSize + 2, {
    width: qrSize + 8,
    align: "center",
  });

  y = Math.max(y + 36, qrY + qrSize + 12);
  pdf.y = y;
}

      function drawHeader(isFirstPage = true) {
        const topY = 45;

        if (logoBuffer) {
          try {
            pdf.image(logoBuffer, left, topY, { fit: [60, 60] });
          } catch (_) {}
        }

        const infoX = logoBuffer ? left + 70 : left;

        pdf.fillColor("#000");
        pdf.font("Helvetica-Bold").fontSize(13).text(safe(bp.business_name) || "—", infoX, topY);

        const lines = [
          bp.address ? `Adresse : ${bp.address}` : null,
          bp.phone ? `Tel : ${bp.phone}` : null,
          bp.email ? `Email : ${bp.email}` : null,
        ].filter(Boolean);

        pdf.font("Helvetica").fontSize(9).text(lines.join("\n"), infoX, topY + 17);

        pdf.font("Helvetica-Bold").fontSize(16).text(type, left, topY, {
          width: right - left,
          align: "right",
        });

        pdf.font("Helvetica").fontSize(10);
        pdf.text(`N° : ${number}`, left, topY + 20, {
          width: right - left,
          align: "right",
        });
        pdf.text(`Date : ${date}`, left, topY + 35, {
          width: right - left,
          align: "right",
        });

        pdf.moveTo(left, 120).lineTo(right, 120).stroke();

        if (isFirstPage) {
          const y = 135;
          pdf.rect(left, y, right - left, 45).stroke();

          const partyLabel = type === "DÉCHARGE" ? "Concerné" : "Client";

          pdf.font("Helvetica-Bold").fontSize(10).text(partyLabel, left + 10, y + 8);
          pdf.font("Helvetica").fontSize(10).text(client, left + 10, y + 25);

          pdf.y = y + 65;
        } else {
          pdf.y = 140;
        }
      }

      function drawRowGrid(y0, height) {
        pdf.rect(left, y0, right - left, height).stroke();
        pdf.moveTo(x.des, y0).lineTo(x.des, y0 + height).stroke();
        pdf.moveTo(x.qty, y0).lineTo(x.qty, y0 + height).stroke();
        pdf.moveTo(x.pu, y0).lineTo(x.pu, y0 + height).stroke();
        pdf.moveTo(x.amt, y0).lineTo(x.amt, y0 + height).stroke();
      }

      function drawTableHeader() {
        const rowH = ROW_MIN_H;
        const y0 = pdf.y;

        pdf.save();
        pdf.rect(left, y0, right - left, rowH).fill("#F2F2F2");
        pdf.restore();

        drawRowGrid(y0, rowH);

        pdf.fillColor("#000").font("Helvetica-Bold").fontSize(10);

        const lineH = getLineH();
        const yy = vCenterY(y0, rowH, lineH);

        pdf.text("#", x.idx, yy, { width: col.idx, align: "center", lineBreak: false });
        pdf.text("Désignation", x.des + CELL_PAD_X, yy, {
          width: col.des - (CELL_PAD_X * 2),
          lineBreak: false,
        });
        pdf.text("Qté", x.qty, yy, { width: col.qty - 10, align: "right", lineBreak: false });
        pdf.text("PU", x.pu, yy, { width: col.pu - 10, align: "right", lineBreak: false });
        pdf.text("Montant", x.amt, yy, { width: col.amt - 10, align: "right", lineBreak: false });

        pdf.y = y0 + rowH;
        pdf.font("Helvetica").fontSize(10);
      }

      function addPageWithHeader() {
        drawFooter();
        pdf.addPage();
        drawHeader(false);
        if (type !== "DÉCHARGE") drawTableHeader();
      }

      function ensureSpace(needed) {
        if (pdf.y + needed > SAFE_BOTTOM) addPageWithHeader();
      }

      function drawItemRow(i, it) {
        pdf.fillColor("#000").font("Helvetica").fontSize(10);

        const label = safe(it.label || it.raw || "—");
        const qty = Number(it.qty || 0);
        const pu = Number(it.unitPrice || 0);
        const amt = Number(it.amount || (qty * pu) || 0);

        const labelW = col.des - (CELL_PAD_X * 2);
        const labelH = measureLabelHeight(label, labelW);
        const rowH = Math.max(ROW_MIN_H, labelH + (CELL_PAD_Y * 2));

        ensureSpace(rowH + 8);

        const y0 = pdf.y;
        drawRowGrid(y0, rowH);

        const lineH = getLineH();
        const cy = vCenterY(y0, rowH, lineH);

        pdf.text(String(i + 1), x.idx, cy, {
          width: col.idx,
          align: "center",
          lineBreak: false,
        });

        pdf.text(label, x.des + CELL_PAD_X, y0 + CELL_PAD_Y, {
          width: labelW,
          lineBreak: true,
          height: rowH - (CELL_PAD_Y * 2),
          ellipsis: true,
        });

        pdf.text(fmtNumber(qty), x.qty, cy, { width: col.qty - 10, align: "right", lineBreak: false });
        pdf.text(fmtNumber(pu), x.pu, cy, { width: col.pu - 10, align: "right", lineBreak: false });
        pdf.text(fmtNumber(amt), x.amt, cy, { width: col.amt - 10, align: "right", lineBreak: false });

        pdf.y = y0 + rowH;
      }

      // ===== Render =====
      // ===== Render =====
if (isCompactReceipt) {
  pdf.y = 50;
  drawCompactReceipt();
  drawFooter();
  pdf.end();
  return;
}

drawHeader(true);

      if (type === "DÉCHARGE") {
        ensureSpace(220);

        pdf.font("Helvetica").fontSize(11).fillColor("#000");

        const body =
          docData.dechargeText ||
          `Je soussigné(e), ${client}, reconnais avoir reçu : ${safe(docData.motif) || "objet non précisé"}. La présente décharge est établie pour servir et valoir ce que de droit.`;

        pdf.text(body, left, pdf.y, {
          width: right - left,
          align: "left",
          lineGap: 4,
        });

        pdf.y += 20;

        if (total > 0) {
          ensureSpace(90);
          const boxW = 260;
          const boxH = 40;
          const boxX = right - boxW;
          const boxY = pdf.y;

          pdf.rect(boxX, boxY, boxW, boxH).stroke();

          pdf.font("Helvetica-Bold").fontSize(12).fillColor("#000");
          pdf.text("MONTANT", boxX + 10, boxY + 12, { width: 80, lineBreak: false });

          pdf.text(`${fmtNumber(total)} FCFA`, boxX + 90, boxY + 12, {
            width: boxW - 100,
            align: "right",
            lineBreak: false,
          });

          pdf.y = boxY + boxH + 16;

          const words = numberToFrench(total);
          pdf.font("Helvetica-Bold").fontSize(10).fillColor("#000");
          pdf.text(`Montant en lettres : ${words} francs CFA.`, left, pdf.y, {
            width: right - left,
          });

          pdf.y += 14;
        }

        drawFooter();
        pdf.end();
        return;
      }

      // ---- Standard docs with table (devis/facture/reçu A4) ----
      drawTableHeader();

      for (let i = 0; i < items.length; i++) {
        drawItemRow(i, items[i] || {});
      }

      // Total + closing
      ensureSpace(190);
      pdf.y += 18;

      const boxW = 260;
      const boxH = 40;
      const boxX = right - boxW;
      const boxY = pdf.y;

      pdf.rect(boxX, boxY, boxW, boxH).stroke();

      pdf.font("Helvetica-Bold").fontSize(12).fillColor("#000");
      pdf.text("TOTAL", boxX + 10, boxY + 12, { width: 70, lineBreak: false });

      pdf.text(`${fmtNumber(total)} FCFA`, boxX + 80, boxY + 12, {
        width: boxW - 90,
        align: "right",
        lineBreak: false,
      });

      pdf.y = boxY + boxH + 14;

      const phrase = closingPhrase(type);
      const words = numberToFrench(total);

      pdf.font("Helvetica-Bold").fontSize(10).fillColor("#000");
      pdf.text(`${phrase} à la somme de : ${words} francs CFA.`, left, pdf.y, {
        width: right - left,
      });

      drawFooter();
      pdf.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildPdfBuffer };