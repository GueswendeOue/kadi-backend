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

// mini conversion nombre→texte (FR) robuste
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
      const rest = x - t * 10; // 10..19
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

  const qr = await makeKadiQrBuffer({ fullNumberE164: KADI_E164, prefillText: KADI_PREFILL });

  return new Promise((resolve, reject) => {
    try {
      const pdf = new PDFDocument({ size: "A4", margin: 50 });
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

      // Réserve footer (évite que le tableau/total descende dedans)
      const FOOTER_H = 85;
      const SAFE_BOTTOM = pageHeight - FOOTER_H;

      // ===== Table grid fixe (comme ton PDF propre) =====
      const pad = 8;
      const rowH = 28;

      const x0 = left;          // bord gauche
      const x1 = left + 35;     // après #
      const x2 = x1 + 260;      // après Désignation
      const x3 = x2 + 60;       // après Qté
      const x4 = x3 + 80;       // après PU
      const x5 = right;         // bord droit

      function drawFooter() {
        const footerY = pageHeight - 60;

        pdf.moveTo(left, footerY - 10).lineTo(right, footerY - 10).stroke();

        pdf.font("Helvetica").fontSize(8).fillColor("#555");
        pdf.text(
          `Généré par KADI • WhatsApp +${KADI_E164} • Scannez pour essayer`,
          left,
          footerY,
          { width: right - left - 60, ellipsis: true }
        );

        try {
          pdf.image(qr.png, right - 50, footerY - 5, { fit: [45, 45] });
        } catch (_) {}
      }

      function drawHeader(isFirstPage = true) {
        const topY = 45;

        if (logoBuffer && isFirstPage) {
          try {
            pdf.image(logoBuffer, left, topY, { fit: [60, 60] });
          } catch (_) {}
        }

        const infoX = (logoBuffer && isFirstPage) ? left + 70 : left;

        pdf.fillColor("#000");
        pdf.font("Helvetica-Bold").fontSize(13).text(safe(bp.business_name) || "—", infoX, topY);

        pdf.font("Helvetica").fontSize(9).text(
          [
            bp.address ? `Adresse : ${bp.address}` : null,
            bp.phone ? `Tel : ${bp.phone}` : null,
            bp.email ? `Email : ${bp.email}` : null,
          ].filter(Boolean).join("\n"),
          infoX,
          topY + 17
        );

        pdf.font("Helvetica-Bold").fontSize(16).text(type, left, topY, {
          align: "right",
          width: right - left
        });

        pdf.font("Helvetica").fontSize(10);
        pdf.text(`N° : ${number}`, left, topY + 22, { align: "right", width: right - left });
        pdf.text(`Date : ${date}`, left, topY + 37, { align: "right", width: right - left });

        const sepY = topY + 75;
        pdf.moveTo(left, sepY).lineTo(right, sepY).stroke();

        if (isFirstPage) {
          const boxY = sepY + 15;
          pdf.rect(left, boxY, right - left, 45).stroke();
          pdf.font("Helvetica-Bold").fontSize(10).text("Client", left + 10, boxY + 8);
          pdf.font("Helvetica").fontSize(10).text(client, left + 10, boxY + 25);
          pdf.y = boxY + 65;
        } else {
          pdf.y = sepY + 20;
        }
      }

      function drawTableHeader() {
        // ligne header
        pdf.rect(x0, pdf.y, x5 - x0, rowH).fillAndStroke("#F2F2F2", "#000");
        // traits verticaux
        pdf.moveTo(x1, pdf.y).lineTo(x1, pdf.y + rowH).stroke();
        pdf.moveTo(x2, pdf.y).lineTo(x2, pdf.y + rowH).stroke();
        pdf.moveTo(x3, pdf.y).lineTo(x3, pdf.y + rowH).stroke();
        pdf.moveTo(x4, pdf.y).lineTo(x4, pdf.y + rowH).stroke();

        pdf.fillColor("#000").font("Helvetica-Bold").fontSize(10);

        pdf.text("#", x0 + pad, pdf.y + 9, { width: (x1 - x0) - 2 * pad });
        pdf.text("Désignation", x1 + pad, pdf.y + 9, { width: (x2 - x1) - 2 * pad });
        pdf.text("Qté", x2 + pad, pdf.y + 9, { width: (x3 - x2) - 2 * pad, align: "right" });
        pdf.text("PU", x3 + pad, pdf.y + 9, { width: (x4 - x3) - 2 * pad, align: "right" });
        pdf.text("Montant", x4 + pad, pdf.y + 9, { width: (x5 - x4) - 2 * pad, align: "right" });

        pdf.y += rowH;
        pdf.font("Helvetica").fontSize(10);
      }

      function drawRow(i, it) {
        const label = safe(it?.label || it?.raw || "—");
        const qty = Number(it?.qty || 0);
        const pu = Number(it?.unitPrice || 0);
        const amt = Number(it?.amount || (qty * pu) || 0);

        // contour + colonnes
        pdf.rect(x0, pdf.y, x5 - x0, rowH).stroke();
        pdf.moveTo(x1, pdf.y).lineTo(x1, pdf.y + rowH).stroke();
        pdf.moveTo(x2, pdf.y).lineTo(x2, pdf.y + rowH).stroke();
        pdf.moveTo(x3, pdf.y).lineTo(x3, pdf.y + rowH).stroke();
        pdf.moveTo(x4, pdf.y).lineTo(x4, pdf.y + rowH).stroke();

        pdf.fillColor("#000").font("Helvetica").fontSize(10);

        pdf.text(String(i + 1), x0 + pad, pdf.y + 9, { width: (x1 - x0) - 2 * pad });
        pdf.text(label, x1 + pad, pdf.y + 9, {
          width: (x2 - x1) - 2 * pad,
          ellipsis: true,
          lineBreak: false
        });

        pdf.text(fmtNumber(qty), x2 + pad, pdf.y + 9, { width: (x3 - x2) - 2 * pad, align: "right" });
        pdf.text(fmtNumber(pu), x3 + pad, pdf.y + 9, { width: (x4 - x3) - 2 * pad, align: "right" });
        pdf.text(fmtNumber(amt), x4 + pad, pdf.y + 9, { width: (x5 - x4) - 2 * pad, align: "right" });

        pdf.y += rowH;
      }

      function ensureSpace(needed) {
        if (pdf.y + needed > SAFE_BOTTOM) {
          // footer sur la page qui se termine
          drawFooter();
          pdf.addPage();
          drawHeader(false);
          drawTableHeader();
        }
      }

      // ===== Render =====
      drawHeader(true);
      drawTableHeader();

      for (let i = 0; i < items.length; i++) {
        ensureSpace(rowH + 10);
        drawRow(i, items[i]);
      }

      // total + phrase
      ensureSpace(170);
      pdf.y += 18;

      const boxW = 260;
      const boxH = 40;
      const boxX = right - boxW;

      pdf.rect(boxX, pdf.y, boxW, boxH).stroke();
      pdf.font("Helvetica-Bold").fontSize(12).fillColor("#000");
      pdf.text("TOTAL", boxX + 10, pdf.y + 12, { width: boxW - 20 });

      // ✅ IMPORTANT: on donne une largeur → plus de texte vertical
      pdf.text(`${fmtNumber(total)} FCFA`, boxX + 10, pdf.y + 12, {
        width: boxW - 20,
        align: "right",
      });

      pdf.y += boxH + 14;

      const phrase = closingPhrase(type);
      const words = numberToFrench(total);

      pdf.font("Helvetica-Bold").fontSize(10).fillColor("#000");
      pdf.text(`${phrase} à la somme de : ${words} francs CFA.`, left, pdf.y, { width: right - left });

      // footer dernière page
      drawFooter();

      pdf.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildPdfBuffer };