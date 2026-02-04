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
    width: 160,
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
      const pdf = new PDFDocument({
        size: "A4",
        margin: 50,
        bufferPages: true, // ✅ permet footer sur toutes les pages
      });

      const chunks = [];
      pdf.on("data", (c) => chunks.push(c));

      pdf.on("end", () => {
        try {
          resolve(Buffer.concat(chunks));
        } catch (e) {
          reject(e);
        }
      });

      const pageWidth = pdf.page.width;   // ~595
      const pageHeight = pdf.page.height; // ~842
      const left = pdf.page.margins.left;  // 50
      const right = pageWidth - pdf.page.margins.right; // 545
      const usableW = right - left; // 495 ✅

      const type = String(docData.type || "DOCUMENT").toUpperCase();
      const number = docData.docNumber || "—";
      const date = docData.date || "—";
      const client = docData.client || "—";
      const items = Array.isArray(docData.items) ? docData.items : [];
      const total = Number(docData.total || 0);

      const bp = businessProfile || {};

      // ✅ Footer réservé: on n’écrit jamais dans cette zone
      const FOOTER_H = 80;
      const SAFE_BOTTOM = pageHeight - FOOTER_H;

      // ✅ Colonnes EXACTES: somme = usableW = 495 (sinon ça casse)
      const COL = {
        idx: 30,
        des: 235, // 🔥 ajusté pour rentrer pile
        qty: 60,
        pu: 80,
        amt: 90,
      };
      const ROW_H = 24;

      // positions x (stables)
      const X = {
        idx: left,
        des: left + COL.idx,
        qty: left + COL.idx + COL.des,
        pu: left + COL.idx + COL.des + COL.qty,
        amt: left + COL.idx + COL.des + COL.qty + COL.pu,
      };

      function drawFooter() {
        const footerY = pageHeight - 55;

        pdf.save();
        pdf.strokeColor("#000").lineWidth(1);
        pdf.moveTo(left, footerY - 10).lineTo(right, footerY - 10).stroke();

        pdf.fillColor("#555").font("Helvetica").fontSize(8);
        pdf.text(
          `Généré par KADI • WhatsApp +${KADI_E164} • Scannez pour essayer`,
          left,
          footerY,
          { width: usableW - 60, ellipsis: true }
        );

        try {
          pdf.image(qr.png, right - 50, footerY - 5, { fit: [45, 45] });
        } catch (_) {}

        pdf.restore();
      }

      function drawHeader({ showClientBox }) {
        // Logo
        if (logoBuffer) {
          try {
            pdf.image(logoBuffer, left, 45, { fit: [60, 60] });
          } catch (_) {}
        }

        pdf.fillColor("#000");

        // Business info
        pdf.font("Helvetica-Bold").fontSize(13).text(safe(bp.business_name) || "—", left + 70, 45);

        pdf.font("Helvetica").fontSize(9).text(
          [
            bp.address ? `Adresse : ${bp.address}` : null,
            bp.phone ? `Tel : ${bp.phone}` : null,
            bp.email ? `Email : ${bp.email}` : null,
          ].filter(Boolean).join("\n"),
          left + 70,
          62
        );

        // Doc title (right)
        pdf.font("Helvetica-Bold").fontSize(16).text(type, left, 45, {
          align: "right",
          width: usableW,
        });

        pdf.font("Helvetica").fontSize(10);
        pdf.text(`N° : ${number}`, left, 65, { align: "right", width: usableW });
        pdf.text(`Date : ${date}`, left, 80, { align: "right", width: usableW });

        // Separator
        pdf.moveTo(left, 120).lineTo(right, 120).stroke();

        // Client box (only first page by default)
        if (showClientBox) {
          const y = 135;
          pdf.rect(left, y, usableW, 45).stroke();
          pdf.font("Helvetica-Bold").fontSize(10).text("Client", left + 10, y + 8);
          pdf.font("Helvetica").fontSize(10).text(client, left + 10, y + 25);
          pdf.y = y + 65;
        } else {
          pdf.y = 140;
        }
      }

      function drawTableHeader() {
        // header row background
        pdf.save();
        pdf.fillColor("#F2F2F2");
        pdf.rect(left, pdf.y, usableW, ROW_H).fill();
        pdf.restore();

        pdf.rect(left, pdf.y, usableW, ROW_H).stroke();

        pdf.fillColor("#000").font("Helvetica-Bold").fontSize(10);
        pdf.text("#", X.idx + 8, pdf.y + 7);
        pdf.text("Désignation", X.des + 8, pdf.y + 7);
        pdf.text("Qté", X.qty + 8, pdf.y + 7, { width: COL.qty - 16, align: "right" });
        pdf.text("PU", X.pu + 8, pdf.y + 7, { width: COL.pu - 16, align: "right" });
        pdf.text("Montant", X.amt + 8, pdf.y + 7, { width: COL.amt - 16, align: "right" });

        pdf.y += ROW_H;
        pdf.font("Helvetica").fontSize(10).fillColor("#000");
      }

      function ensureSpace(needed) {
        if (pdf.y + needed > SAFE_BOTTOM) {
          // nouvelle page
          pdf.addPage();
          drawHeader({ showClientBox: false });
          drawTableHeader();
        }
      }

      function drawRow(i, it) {
        ensureSpace(ROW_H + 2);

        const label = safe(it?.label || it?.raw || "—");
        const qty = Number(it?.qty || 0);
        const pu = Number(it?.unitPrice || 0);
        const amt = Number(it?.amount || (qty * pu) || 0);

        pdf.rect(left, pdf.y, usableW, ROW_H).stroke();

        pdf.text(String(i + 1), X.idx + 8, pdf.y + 7);
        pdf.text(label, X.des + 8, pdf.y + 7, { width: COL.des - 16, ellipsis: true });
        pdf.text(fmtNumber(qty), X.qty + 8, pdf.y + 7, { width: COL.qty - 16, align: "right" });
        pdf.text(fmtNumber(pu), X.pu + 8, pdf.y + 7, { width: COL.pu - 16, align: "right" });
        pdf.text(fmtNumber(amt), X.amt + 8, pdf.y + 7, { width: COL.amt - 16, align: "right" });

        pdf.y += ROW_H;
      }

      // ===== Render page 1 =====
      drawHeader({ showClientBox: true });
      drawTableHeader();

      for (let i = 0; i < items.length; i++) {
        drawRow(i, items[i]);
      }

      // Total + closing
      ensureSpace(160);
      pdf.y += 18;

      const boxW = 260;
      const boxH = 40;
      pdf.rect(right - boxW, pdf.y, boxW, boxH).stroke();
      pdf.font("Helvetica-Bold").fontSize(12).text("TOTAL", right - boxW + 10, pdf.y + 12);
      pdf.text(`${fmtNumber(total)} FCFA`, right - 10, pdf.y + 12, { align: "right" });

      pdf.y += boxH + 14;

      const phrase = closingPhrase(type);
      const words = numberToFrench(total);
      pdf.font("Helvetica-Bold").fontSize(10);
      pdf.text(`${phrase} à la somme de : ${words} francs CFA.`, left, pdf.y, { width: usableW });

      // ✅ Footer sur toutes les pages
      const range = pdf.bufferedPageRange(); // {start, count}
      for (let p = range.start; p < range.start + range.count; p++) {
        pdf.switchToPage(p);
        drawFooter();
      }

      pdf.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildPdfBuffer };