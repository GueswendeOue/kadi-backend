"use strict";

const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

// ================= Utils =================
function safe(v) {
  return String(v || "").trim();
}

function fmtNumber(n) {
  const x = Math.round(Number(n || 0));
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

// phrase de clôture propre
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
      // ✅ A4 exact + portrait explicite => évite les ambiguïtés iOS
      const pdf = new PDFDocument({
        size: [595.28, 841.89], // A4 points
        margin: 50,
        layout: "portrait",
      });

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

      // zones réservées bas de page (footer fixe)
      const FOOTER_H = 70;
      const SAFE_BOTTOM = pageHeight - FOOTER_H;

      function ensureSpace(needed) {
        if (pdf.y + needed > SAFE_BOTTOM) {
          pdf.addPage({
            size: [595.28, 841.89],
            margin: 50,
            layout: "portrait",
          });
          pdf.y = 60;
        }
      }

      // ================= HEADER =================
      if (logoBuffer) {
        try {
          pdf.image(logoBuffer, left, 45, { fit: [60, 60] });
        } catch (_) {}
      }

      pdf.fillColor("#000");
      pdf.font("Helvetica-Bold").fontSize(13).text(safe(bp.business_name) || "—", left + 70, 45);

      pdf.font("Helvetica").fontSize(9).text(
        [
          bp.address ? `Adresse : ${bp.address}` : null,
          bp.phone ? `Tel : ${bp.phone}` : null,
          bp.email ? `Email : ${bp.email}` : null,
          bp.ifu ? `IFU : ${bp.ifu}` : null,
          bp.rccm ? `RCCM : ${bp.rccm}` : null,
        ].filter(Boolean).join("\n"),
        left + 70,
        62
      );

      pdf.font("Helvetica-Bold").fontSize(16).text(type, left, 45, { align: "right", width: right - left });

      pdf.font("Helvetica").fontSize(10);
      pdf.text(`N° : ${number}`, left, 65, { align: "right", width: right - left });
      pdf.text(`Date : ${date}`, left, 80, { align: "right", width: right - left });

      pdf.moveTo(left, 120).lineTo(right, 120).stroke();

      // ================= CLIENT =================
      let y = 135;
      pdf.rect(left, y, right - left, 45).stroke();
      pdf.font("Helvetica-Bold").text("Client", left + 10, y + 8);
      pdf.font("Helvetica").text(client, left + 10, y + 25);

      y += 65;
      pdf.y = y;

      // ================= TABLE HEADER =================
      const col = { idx: 30, des: 260, qty: 60, pu: 80, amt: 90 };
      const rowH = 24;

      pdf.rect(left, pdf.y, right - left, rowH).fillAndStroke("#F2F2F2", "#000");
      pdf.fillColor("#000").font("Helvetica-Bold").fontSize(10);

      pdf.text("#", left + 8, pdf.y + 7);
      pdf.text("Désignation", left + col.idx + 8, pdf.y + 7);
      pdf.text("Qté", left + col.idx + col.des + 8, pdf.y + 7, { width: 40, align: "right" });
      pdf.text("PU", left + col.idx + col.des + col.qty + 8, pdf.y + 7, { width: 60, align: "right" });
      pdf.text("Montant", left + col.idx + col.des + col.qty + col.pu + 8, pdf.y + 7, { width: 80, align: "right" });

      pdf.y += rowH;
      pdf.font("Helvetica").fontSize(10);

      // ================= ITEMS =================
      for (let i = 0; i < items.length; i++) {
        ensureSpace(rowH + 10);

        const it = items[i] || {};
        const label = safe(it.label || it.raw || "—");
        const qty = Number(it.qty || 0);
        const pu = Number(it.unitPrice || 0);
        const amt = Number(it.amount || (qty * pu) || 0);

        pdf.rect(left, pdf.y, right - left, rowH).stroke();

        pdf.text(String(i + 1), left + 8, pdf.y + 7);
        pdf.text(label, left + col.idx + 8, pdf.y + 7, { width: col.des - 10, ellipsis: true });
        pdf.text(fmtNumber(qty), left + col.idx + col.des + 8, pdf.y + 7, { width: 40, align: "right" });
        pdf.text(fmtNumber(pu), left + col.idx + col.des + col.qty + 8, pdf.y + 7, { width: 60, align: "right" });
        pdf.text(fmtNumber(amt), left + col.idx + col.des + col.qty + col.pu + 8, pdf.y + 7, { width: 80, align: "right" });

        pdf.y += rowH;
      }

      // ================= TOTAL + CLOSING =================
      ensureSpace(140);
      pdf.y += 18;

      const boxW = 260;
      const boxH = 40;
      pdf.rect(right - boxW, pdf.y, boxW, boxH).stroke();
      pdf.font("Helvetica-Bold").fontSize(12).fillColor("#000");
      pdf.text("TOTAL", right - boxW + 10, pdf.y + 12);
      pdf.text(`${fmtNumber(total)} FCFA`, right - 10, pdf.y + 12, { align: "right" });

      pdf.y += boxH + 14;

      const phrase = closingPhrase(type);
      const words = numberToFrench(total);

      pdf.font("Helvetica-Bold").fontSize(10).fillColor("#000");
      pdf.text(`${phrase} à la somme de : ${words} francs CFA.`, left, pdf.y, { width: right - left });

      // ================= FOOTER FIXE (BAS) =================
      const footerY = pageHeight - 55;

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

      pdf.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildPdfBuffer };