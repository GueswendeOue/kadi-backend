// kadiPdf.js
"use strict";

const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

function safe(v) {
  return String(v || "").trim();
}

function fmtNumber(n) {
  const x = Math.round(Number(n || 0));
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// mini conversion nombre→texte (fr) simple et robuste
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

    // 70-79, 90-99
    if (t === 7 || t === 9) {
      const base = tens[t];
      const rest = x - t * 10;
      return `${base}-${teens[rest - 10]}`;
    }

    // 80 exact
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
      if (h === 1) s = "cent";
      else s = `${units[h]} cent`;
      if (r === 0 && h > 1) s += "s";
    }

    if (r > 0) s = s ? `${s} ${under100(r)}` : under100(r);
    return s;
  }

  function chunk(x, value, name) {
    const q = Math.floor(x / value);
    const r = x % value;
    if (q === 0) return { text: "", rest: r };

    // mille invariable
    if (name === "mille") {
      if (q === 1) return { text: "mille", rest: r };
      return { text: `${under1000(q)} mille`, rest: r };
    }

    // million(s)
    let t = q === 1 ? `${name}` : `${under1000(q)} ${name}s`;
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

function normalizeDocTypeForFooter(typeUpper) {
  const t = String(typeUpper || "").toUpperCase();

  if (t.includes("FACTURE")) return { phrase: "Arrêtée la présente facture" };
  if (t.includes("REÇU") || t.includes("RECU")) return { phrase: "Arrêté le présent reçu" };
  if (t.includes("DEVIS")) return { phrase: "Arrêté le présent devis" };
  if (t.includes("DÉCHARGE") || t.includes("DECHARGE")) return { phrase: "Arrêtée la présente décharge" };

  return { phrase: "Arrêté le présent document" };
}

async function makeKadiQrPngBuffer({ fullNumberE164, prefillText }) {
  const encoded = encodeURIComponent(prefillText || "Bonjour KADI");
  const url = `https://wa.me/${fullNumberE164}?text=${encoded}`;

  const png = await QRCode.toBuffer(url, {
    type: "png",
    width: 220,
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#000000", light: "#FFFFFF" },
  });

  return { url, png };
}

function drawFooter({ pdf, pageLeft, pageRight, kadiCountry, kadiNumberLocal, qr }) {
  const footerY = pdf.page.height - 70;
  const qrSize = 55;

  // trait
  pdf.moveTo(pageLeft, footerY - 6).lineTo(pageRight, footerY - 6).stroke();

  // texte
  pdf.font("Helvetica").fontSize(8).fillColor("#444");

  const pretty = String(kadiNumberLocal || "").replace(/(\d{2})(\d{2})(\d{2})(\d{2})/, "$1 $2 $3 $4");
  const footerText = `Généré par KADI • WhatsApp +${kadiCountry} ${pretty} • Scannez pour essayer`;

  pdf.text(footerText, pageLeft, footerY + 18, {
    width: (pageRight - pageLeft) - (qr ? (qrSize + 10) : 0),
    align: "left",
    lineBreak: false,
    ellipsis: true,
  });

  if (qr?.png) {
    try {
      pdf.image(qr.png, pageRight - qrSize, footerY, { fit: [qrSize, qrSize] });
    } catch {}
  }
}

async function buildPdfBuffer({ docData = {}, businessProfile = null, logoBuffer = null }) {
  // KADI WhatsApp
  const KADI_NUMBER_LOCAL = process.env.KADI_NUMBER || "79239027";
  const KADI_COUNTRY = process.env.KADI_COUNTRY_CODE || "226";
  const KADI_E164 = process.env.KADI_E164 || `${KADI_COUNTRY}${KADI_NUMBER_LOCAL}`;
  const KADI_PREFILL = process.env.KADI_QR_PREFILL || "Bonjour KADI, je veux créer un document";

  let qr = null;
  try {
    qr = await makeKadiQrPngBuffer({ fullNumberE164: KADI_E164, prefillText: KADI_PREFILL });
  } catch (_) {
    qr = null;
  }

  return new Promise((resolve, reject) => {
    try {
      const pdf = new PDFDocument({ size: "A4", margin: 50 });
      const chunks = [];
      pdf.on("data", (c) => chunks.push(c));
      pdf.on("end", () => resolve(Buffer.concat(chunks)));

      const typeUpper = String(docData.type || "DOCUMENT").toUpperCase();
      const docNumber = docData.docNumber || "—";
      const date = docData.date || "—";
      const client = docData.client || "—";
      const items = Array.isArray(docData.items) ? docData.items : [];
      const total = Number(docData.total || 0);

      const bp = businessProfile || {};
      const pageLeft = 50;
      const pageRight = 545;
      const topY = 45;

      // ---- Header ----
      if (logoBuffer) {
        try {
          pdf.image(logoBuffer, pageLeft, topY, { fit: [70, 70] });
        } catch {}
      }

      const headerTextX = pageLeft + (logoBuffer ? 85 : 0);
      const headerTop = topY;

      pdf.fillColor("#000");
      pdf.font("Helvetica-Bold").fontSize(13).text(safe(bp.business_name) || "KADI", headerTextX, headerTop, {
        width: 280,
      });

      pdf.font("Helvetica").fontSize(9);
      const bizLines = [
        safe(bp.address) ? `Adresse : ${safe(bp.address)}` : null,
        safe(bp.phone) ? `Tél : ${safe(bp.phone)}` : null,
        safe(bp.email) ? `Email : ${safe(bp.email)}` : null,
        safe(bp.ifu) ? `IFU : ${safe(bp.ifu)}` : null,
        safe(bp.rccm) ? `RCCM : ${safe(bp.rccm)}` : null,
      ].filter(Boolean);

      pdf.text(bizLines.join("\n"), headerTextX, headerTop + 18, { width: 280, lineGap: 2 });

      pdf.font("Helvetica-Bold").fontSize(16).text(typeUpper, pageLeft, headerTop, {
        width: pageRight - pageLeft,
        align: "right",
      });

      pdf.font("Helvetica").fontSize(10);
      pdf.text(`N° : ${docNumber}`, pageLeft, headerTop + 20, { width: pageRight - pageLeft, align: "right" });
      pdf.text(`Date : ${date}`, pageLeft, headerTop + 35, { width: pageRight - pageLeft, align: "right" });

      pdf.moveTo(pageLeft, headerTop + 80).lineTo(pageRight, headerTop + 80).stroke();

      // ---- Client box ----
      let y = headerTop + 95;
      const clientBoxH = 50;

      pdf.rect(pageLeft, y, pageRight - pageLeft, clientBoxH).stroke();
      pdf.font("Helvetica-Bold").fontSize(10).text("Client", pageLeft + 10, y + 8);
      pdf.font("Helvetica").fontSize(10).text(client, pageLeft + 10, y + 26, {
        width: pageRight - pageLeft - 20,
        lineBreak: false,
        ellipsis: true,
      });

      y += clientBoxH + 18;

      // ---- Table layout ----
      const tableX = pageLeft;
      const tableW = pageRight - pageLeft;

      const col = { idx: 30, des: 270, qty: 55, pu: 80, amt: 90 };
      const sumW = col.idx + col.des + col.qty + col.pu + col.amt;
      if (sumW !== tableW) col.des += (tableW - sumW);

      const rowH = 26;
      const headH = 26;

      pdf.rect(tableX, y, tableW, headH).fillAndStroke("#F2F2F2", "#000");
      pdf.fillColor("#000");

      let x = tableX;
      const xIdxEnd = (x += col.idx);
      const xDesEnd = (x += col.des);
      const xQtyEnd = (x += col.qty);
      const xPuEnd = (x += col.pu);

      pdf.font("Helvetica-Bold").fontSize(10);
      pdf.text("#", tableX + 8, y + 8, { width: col.idx - 16, align: "left", lineBreak: false });
      pdf.text("Désignation", xIdxEnd + 8, y + 8, { width: col.des - 16, align: "left", lineBreak: false });
      pdf.text("Qté", xDesEnd + 8, y + 8, { width: col.qty - 16, align: "right", lineBreak: false });
      pdf.text("PU", xQtyEnd + 8, y + 8, { width: col.pu - 16, align: "right", lineBreak: false });
      pdf.text("Montant", xPuEnd + 8, y + 8, { width: col.amt - 16, align: "right", lineBreak: false });

      pdf.moveTo(xIdxEnd, y).lineTo(xIdxEnd, y + headH).stroke();
      pdf.moveTo(xDesEnd, y).lineTo(xDesEnd, y + headH).stroke();
      pdf.moveTo(xQtyEnd, y).lineTo(xQtyEnd, y + headH).stroke();
      pdf.moveTo(xPuEnd, y).lineTo(xPuEnd, y + headH).stroke();

      y += headH;

      pdf.font("Helvetica").fontSize(10);

      for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        const qty = Number(it.qty || 0);
        const pu = Number(it.unitPrice || 0);
        const amt = Number(it.amount || qty * pu || 0);

        // garde place footer
        if (y + rowH + 170 > pdf.page.height) {
          // footer sur page courante
          drawFooter({
            pdf,
            pageLeft,
            pageRight,
            kadiCountry: KADI_COUNTRY,
            kadiNumberLocal: KADI_NUMBER_LOCAL,
            qr,
          });

          pdf.addPage();
          y = 80;
        }

        pdf.rect(tableX, y, tableW, rowH).stroke();

        pdf.moveTo(xIdxEnd, y).lineTo(xIdxEnd, y + rowH).stroke();
        pdf.moveTo(xDesEnd, y).lineTo(xDesEnd, y + rowH).stroke();
        pdf.moveTo(xQtyEnd, y).lineTo(xQtyEnd, y + rowH).stroke();
        pdf.moveTo(xPuEnd, y).lineTo(xPuEnd, y + rowH).stroke();

        pdf.text(String(i + 1), tableX + 8, y + 8, { width: col.idx - 16, align: "left", lineBreak: false });

        const des = safe(it.label || it.raw || "—");
        pdf.text(des, xIdxEnd + 8, y + 8, {
          width: col.des - 16,
          align: "left",
          lineBreak: false,
          ellipsis: true,
        });

        pdf.text(fmtNumber(qty), xDesEnd + 8, y + 8, { width: col.qty - 16, align: "right", lineBreak: false });
        pdf.text(fmtNumber(pu), xQtyEnd + 8, y + 8, { width: col.pu - 16, align: "right", lineBreak: false });
        pdf.text(fmtNumber(amt), xPuEnd + 8, y + 8, { width: col.amt - 16, align: "right", lineBreak: false });

        y += rowH;
      }

      // ---- Total box ----
      y += 18;

      const totalBoxW = 260;
      const totalBoxH = 46;
      const totalX = pageRight - totalBoxW;
      const totalY = y;

      pdf.rect(totalX, totalY, totalBoxW, totalBoxH).stroke();
      pdf.font("Helvetica-Bold").fontSize(12).text("TOTAL", totalX + 12, totalY + 14);
      pdf.font("Helvetica-Bold").fontSize(12).text(`${fmtNumber(total)} FCFA`, totalX, totalY + 14, {
        width: totalBoxW - 12,
        align: "right",
        lineBreak: false,
      });

      y += totalBoxH + 18;

      // ---- Amount in words ----
      const words = numberToFrench(total);
      const phr = normalizeDocTypeForFooter(typeUpper);

      pdf.fillColor("#000");
      pdf.font("Helvetica-Bold").fontSize(10).text(`${phr.phrase} à la somme de : ${words} francs CFA.`, pageLeft, y, {
        width: pageRight - pageLeft,
      });

      // footer final (dernière page)
      drawFooter({
        pdf,
        pageLeft,
        pageRight,
        kadiCountry: KADI_COUNTRY,
        kadiNumberLocal: KADI_NUMBER_LOCAL,
        qr,
      });

      pdf.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildPdfBuffer };