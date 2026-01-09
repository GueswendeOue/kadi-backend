"use strict";

const PDFDocument = require("pdfkit");

function safe(v) {
  return String(v || "").trim();
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

    if (t === 7 || t === 9) {
      const base = tens[t];
      const rest = x - t * 10; // 70->10..19, 90->10..19
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
    let t = q === 1 ? name : `${under1000(q)} ${name}s`;
    return { text: t, rest: r };
  }

  let x = n;
  const parts = [];

  const m = chunk(x, 1_000_000, "million");
  if (m.text) parts.push(m.text);
  x = m.rest;

  const k = chunk(x, 1_000, "mille");
  if (Math.floor(x / 1000) === 1) {
    if (k.text) parts.push("mille");
  } else {
    if (k.text) parts.push(k.text.replace("un mille", "mille"));
  }
  x = k.rest;

  if (x > 0) parts.push(under1000(x));

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function buildPdfBuffer({ docData = {}, businessProfile = null, logoBuffer = null }) {
  return new Promise((resolve, reject) => {
    try {
      const pdf = new PDFDocument({ size: "A4", margin: 50 });
      const chunks = [];
      pdf.on("data", (c) => chunks.push(c));
      pdf.on("end", () => resolve(Buffer.concat(chunks)));

      const type = String(docData.type || "DOCUMENT").toUpperCase();
      const docNumber = docData.docNumber || "—";
      const date = docData.date || "—";
      const client = docData.client || "—";
      const items = Array.isArray(docData.items) ? docData.items : [];
      const total = Number(docData.total || 0);

      const bp = businessProfile || {};
      const leftX = 50;
      const topY = 45;

      // Logo
      if (logoBuffer) {
        try {
          pdf.image(logoBuffer, leftX, topY, { fit: [80, 80] });
        } catch {}
      }

      const headerTextX = leftX + (logoBuffer ? 95 : 0);

      // Entreprise
      pdf.fontSize(14).text(safe(bp.business_name) || "KADI", headerTextX, topY);
      pdf.fontSize(10).text(
        [
          safe(bp.address) ? `Adresse: ${safe(bp.address)}` : null,
          safe(bp.phone) ? `Tel: ${safe(bp.phone)}` : null,
          safe(bp.email) ? `Email: ${safe(bp.email)}` : null,
          safe(bp.ifu) ? `IFU: ${safe(bp.ifu)}` : null,
          safe(bp.rccm) ? `RCCM: ${safe(bp.rccm)}` : null,
        ].filter(Boolean).join(" | "),
        headerTextX,
        topY + 22,
        { width: 450 }
      );

      // Meta doc (droite)
      pdf.fontSize(18).text(type, 50, topY, { align: "right" });
      pdf.fontSize(11).text(`N° : ${docNumber}`, { align: "right" });
      pdf.fontSize(11).text(`Date : ${date}`, { align: "right" });

      pdf.moveDown(4);

      // Client bloc
      pdf.fontSize(12).text(`Client : ${client}`);
      pdf.moveDown(1);

      // Table header
      const startX = 50;
      let y = pdf.y;

      pdf.fontSize(11).text("#", startX, y);
      pdf.text("Désignation", startX + 30, y);
      pdf.text("Qté", startX + 300, y, { width: 40, align: "right" });
      pdf.text("PU", startX + 350, y, { width: 70, align: "right" });
      pdf.text("Montant", startX + 430, y, { width: 90, align: "right" });

      y += 15;
      pdf.moveTo(startX, y).lineTo(545, y).stroke();
      y += 8;

      items.forEach((it, idx) => {
        const qty = Number(it.qty || 0);
        const pu = Number(it.unitPrice || 0);
        const amt = Number(it.amount || (qty * pu) || 0);

        pdf.fontSize(10).text(String(idx + 1), startX, y);
        pdf.text(String(it.label || it.raw || "—"), startX + 30, y, { width: 260 });
        pdf.text(String(qty), startX + 300, y, { width: 40, align: "right" });
        pdf.text(String(Math.round(pu)), startX + 350, y, { width: 70, align: "right" });
        pdf.text(String(Math.round(amt)), startX + 430, y, { width: 90, align: "right" });

        y += 18;
        if (y > 720) {
          pdf.addPage();
          y = 80;
        }
      });

      y += 10;
      pdf.moveTo(startX, y).lineTo(545, y).stroke();
      y += 12;

      // Total
      pdf.fontSize(12).text(`TOTAL : ${Math.round(total)} FCFA`, startX + 320, y, { width: 225, align: "right" });
      y += 22;

      // Arrêtée la présente...
      const words = numberToFrench(total);
      pdf.fontSize(10).text(`Arrêtée la présente ${type.toLowerCase()} à la somme de : ${words} francs CFA.`, startX, y, {
        width: 495,
      });

      pdf.moveDown(3);
      pdf.fontSize(10).text("Merci pour votre confiance.", { align: "center" });

      pdf.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildPdfBuffer };