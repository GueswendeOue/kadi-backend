// kadiPdf.js — FIXED GRID (cells + stable y + no vertical wrapping) + load logs
"use strict";

console.log("[KADI_PDF] LOADED FROM ✅", __filename);

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

function closingPhrase(typeUpper) {
  const t = String(typeUpper || "").toUpperCase();
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
  const png = await QRCode.toBuffer(url, { type: "png", width: 140, margin: 1, errorCorrectionLevel: "M" });
  return { png, url };
}

// ================= PDF =================
async function buildPdfBuffer({ docData = {}, businessProfile = null, logoBuffer = null }) {
  const KADI_E164 = process.env.KADI_E164 || "22679239027";
  const KADI_PREFILL = process.env.KADI_QR_PREFILL || "Bonjour KADI, je veux créer un document";
  const qr = await makeKadiQrBuffer({ fullNumberE164: KADI_E164, prefillText: KADI_PREFILL });

  return new Promise((resolve, reject) => {
    try {
      const pdf = new PDFDocument({ size: "A4", margin: 50, bufferPages: true });
      const chunks = [];
      pdf.on("data", (c) => chunks.push(c));
      pdf.on("end", () => resolve(Buffer.concat(chunks)));

      const pageWidth = pdf.page.width;
      const pageHeight = pdf.page.height;
      const left = 50;
      const right = pageWidth - 50;

      const type = String(docData.type || "DOCUMENT").toUpperCase();
      const number = docData.docNumber || "—";
      const date = docData.date || "—";
      const client = docData.client || "—";
      const items = Array.isArray(docData.items) ? docData.items : [];
      const total = Number(docData.total || 0);
      const bp = businessProfile || {};

      // footer safe area
      const FOOTER_H = 85;
      const SAFE_BOTTOM = pageHeight - FOOTER_H;

      // ===== TABLE GRID CONFIG (stable) =====
      const rowH = 26;

      // widths must sum to (right-left)
      const W = right - left;
      const col = {
        idx: 40,
        des: 300,
        qty: 60,
        pu: 80,
        amt: W - (40 + 300 + 60 + 80),
      };

      const x = {
        idx: left,
        des: left + col.idx,
        qty: left + col.idx + col.des,
        pu: left + col.idx + col.des + col.qty,
        amt: left + col.idx + col.des + col.qty + col.pu,
        end: right,
      };

      function drawFooter() {
        const footerY = pageHeight - 60;

        pdf.save();
        pdf.strokeColor("#000").lineWidth(1);
        pdf.moveTo(left, footerY - 10).lineTo(right, footerY - 10).stroke();

        pdf.font("Helvetica").fontSize(8).fillColor("#555");
        pdf.text(`Généré par KADI • WhatsApp +${KADI_E164} • Scannez pour essayer`, left, footerY, {
          width: right - left - 60,
          lineBreak: false,
        });

        try {
          pdf.image(qr.png, right - 50, footerY - 5, { fit: [45, 45] });
        } catch (_) {}

        pdf.restore();
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

        pdf.font("Helvetica-Bold").fontSize(16).text(type, left, topY, { width: right - left, align: "right" });
        pdf.font("Helvetica").fontSize(10);
        pdf.text(`N° : ${number}`, left, topY + 20, { width: right - left, align: "right" });
        pdf.text(`Date : ${date}`, left, topY + 35, { width: right - left, align: "right" });

        pdf.moveTo(left, 120).lineTo(right, 120).stroke();

        if (isFirstPage) {
          const y = 135;
          pdf.rect(left, y, right - left, 45).stroke();
          pdf.font("Helvetica-Bold").fontSize(10).text("Client", left + 10, y + 8);
          pdf.font("Helvetica").fontSize(10).text(client, left + 10, y + 25);
          pdf.y = y + 65;
        } else {
          pdf.y = 140;
        }
      }

      function drawRowGrid(y0, height) {
        // outer
        pdf.rect(left, y0, right - left, height).stroke();
        // vertical lines
        pdf.moveTo(x.des, y0).lineTo(x.des, y0 + height).stroke();
        pdf.moveTo(x.qty, y0).lineTo(x.qty, y0 + height).stroke();
        pdf.moveTo(x.pu, y0).lineTo(x.pu, y0 + height).stroke();
        pdf.moveTo(x.amt, y0).lineTo(x.amt, y0 + height).stroke();
      }

      function drawTableHeader() {
        const y0 = pdf.y;

        pdf.save();
        pdf.rect(left, y0, right - left, rowH).fill("#F2F2F2");
        pdf.restore();

        drawRowGrid(y0, rowH);

        pdf.fillColor("#000").font("Helvetica-Bold").fontSize(10);

        pdf.text("#", x.idx, y0 + 8, { width: col.idx, align: "center", lineBreak: false });
        pdf.text("Désignation", x.des + 6, y0 + 8, { width: col.des - 12, lineBreak: false });
        pdf.text("Qté", x.qty, y0 + 8, { width: col.qty - 10, align: "right", lineBreak: false });
        pdf.text("PU", x.pu, y0 + 8, { width: col.pu - 10, align: "right", lineBreak: false });
        pdf.text("Montant", x.amt, y0 + 8, { width: col.amt - 10, align: "right", lineBreak: false });

        pdf.y = y0 + rowH;
        pdf.font("Helvetica").fontSize(10);
      }

      function drawItemRow(i, it) {
        const y0 = pdf.y;

        const label = safe(it.label || it.raw || "—");
        const qty = Number(it.qty || 0);
        const pu = Number(it.unitPrice || 0);
        const amt = Number(it.amount || (qty * pu) || 0);

        drawRowGrid(y0, rowH);

        pdf.fillColor("#000").font("Helvetica").fontSize(10);
        pdf.text(String(i + 1), x.idx, y0 + 8, { width: col.idx, align: "center", lineBreak: false });

        // designation must stay inside cell
        pdf.text(label, x.des + 6, y0 + 8, {
          width: col.des - 12,
          lineBreak: false,
          ellipsis: true,
        });

        pdf.text(fmtNumber(qty), x.qty, y0 + 8, { width: col.qty - 10, align: "right", lineBreak: false });
        pdf.text(fmtNumber(pu), x.pu, y0 + 8, { width: col.pu - 10, align: "right", lineBreak: false });
        pdf.text(fmtNumber(amt), x.amt, y0 + 8, { width: col.amt - 10, align: "right", lineBreak: false });

        pdf.y = y0 + rowH;
      }

      function addPageWithHeader() {
        drawFooter();
        pdf.addPage();
        drawHeader(false);
        drawTableHeader();
      }

      function ensureSpace(needed) {
        if (pdf.y + needed > SAFE_BOTTOM) addPageWithHeader();
      }

      // ===== Render =====
      drawHeader(true);
      drawTableHeader();

      for (let i = 0; i < items.length; i++) {
        ensureSpace(rowH + 8);
        drawItemRow(i, items[i] || {});
      }

      // ===== Total + closing =====
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
      pdf.text(`${phrase} à la somme de : ${words} francs CFA.`, left, pdf.y, { width: right - left });

      drawFooter();
      pdf.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildPdfBuffer, __file: __filename };