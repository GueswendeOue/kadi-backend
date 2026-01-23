"use strict";

const PDFDocument = require("pdfkit");

function safe(v) {
  // Important: on normalise aussi les retours ligne
  return String(v || "").replace(/\s+\n/g, "\n").trim();
}

function fmtNumber(n) {
  const x = Math.round(Number(n || 0));
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * Conversion nombre -> texte FR (robuste pour 0..999 999 999)
 * Fix:
 * - 70..79 = soixante + (10..19)
 * - 90..99 = quatre-vingt + (10..19)
 * - 71 = soixante et onze
 * - "mille" est invariable (pas "milles")
 * - évite les "undefined"
 */
function numberToFrench(n) {
  n = Math.floor(Number(n) || 0);
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "zéro";
  if (n < 0) return `moins ${numberToFrench(Math.abs(n))}`;

  const units = ["zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf"];
  const teens = ["dix", "onze", "douze", "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf"];
  const tens = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante"];

  function under100(x) {
    x = x % 100;

    if (x < 10) return units[x];
    if (x < 20) return teens[x - 10];

    const t = Math.floor(x / 10);
    const u = x % 10;

    // 20..69
    if (t <= 6) {
      const base = tens[t];
      if (u === 0) return base;
      if (u === 1) return `${base} et un`;
      return `${base}-${units[u]}`;
    }

    // 70..79 = soixante + (10..19)
    if (t === 7) {
      // 70 = soixante-dix
      // 71 = soixante et onze
      // 72..79 = soixante-douze...
      if (x === 71) return "soixante et onze";
      return `soixante-${under100(10 + u)}`;
    }

    // 80..89
    if (t === 8) {
      if (u === 0) return "quatre-vingts";
      return `quatre-vingt-${units[u]}`;
    }

    // 90..99 = quatre-vingt + (10..19)
    // 90 = quatre-vingt-dix
    // 91 = quatre-vingt-onze, etc.
    return `quatre-vingt-${under100(10 + u)}`;
  }

  function under1000(x) {
    x = x % 1000;
    const h = Math.floor(x / 100);
    const r = x % 100;

    let s = "";
    if (h > 0) {
      if (h === 1) s = "cent";
      else s = `${units[h]} cent`;

      // "deux cents" seulement si rien après
      if (r === 0 && h > 1) s += "s";
    }

    if (r > 0) s = s ? `${s} ${under100(r)}` : under100(r);
    return s.trim();
  }

  function joinParts(parts) {
    return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  // Millions
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1_000);
  const rest = n % 1_000;

  const parts = [];

  if (millions > 0) {
    if (millions === 1) parts.push("un million");
    else parts.push(`${under1000(millions)} millions`);
  }

  if (thousands > 0) {
    // "mille" invariable, pas de "s"
    if (thousands === 1) parts.push("mille");
    else parts.push(`${under1000(thousands)} mille`);
  }

  if (rest > 0) {
    parts.push(under1000(rest));
  }

  return joinParts(parts);
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

      // ✅ FIX 1: on écrit le nom, puis on utilise pdf.y pour placer l’adresse (évite mélange/overlap)
      pdf.font("Helvetica-Bold").fontSize(13);
      pdf.text(safe(bp.business_name) || "KADI", headerTextX, headerTop, { width: 280 });

      const afterNameY = pdf.y;

      pdf.font("Helvetica").fontSize(9);
      const bizLines = [
        safe(bp.address) ? `Adresse : ${safe(bp.address)}` : null,
        safe(bp.phone) ? `Tél : ${safe(bp.phone)}` : null,
        safe(bp.email) ? `Email : ${safe(bp.email)}` : null,
        safe(bp.ifu) ? `IFU : ${safe(bp.ifu)}` : null,
        safe(bp.rccm) ? `RCCM : ${safe(bp.rccm)}` : null,
      ].filter(Boolean);

      if (bizLines.length) {
        pdf.text(bizLines.join("\n"), headerTextX, afterNameY + 3, { width: 280, lineGap: 2 });
      }

      // Doc meta RIGHT
      pdf.font("Helvetica-Bold").fontSize(16);
      pdf.text(type, pageLeft, headerTop, { width: pageRight - pageLeft, align: "right" });

      pdf.font("Helvetica").fontSize(10);
      pdf.text(`N° : ${docNumber}`, pageLeft, headerTop + 20, { width: pageRight - pageLeft, align: "right" });
      pdf.text(`Date : ${date}`, pageLeft, headerTop + 35, { width: pageRight - pageLeft, align: "right" });

      // Divider
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
      if (sumW !== tableW) col.des += tableW - sumW;

      const rowH = 26;
      const headH = 26;

      pdf.rect(tableX, y, tableW, headH).fillAndStroke("#F2F2F2", "#000");
      pdf.fillColor("#000");

      let x = tableX;
      const xIdxEnd = (x += col.idx);
      const xDesEnd = (x += col.des);
      const xQtyEnd = (x += col.qty);
      const xPuEnd = (x += col.pu);
      const xAmtEnd = (x += col.amt);

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
        const amt = Number(it.amount || (qty * pu) || 0);

        if (y + rowH + 140 > pdf.page.height) {
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
        pdf.text(des, xIdxEnd + 8, y + 8, { width: col.des - 16, align: "left", lineBreak: false, ellipsis: true });

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

      // ✅ FIX 2: montant en lettres sans undefined
      const words = numberToFrench(total);

      pdf.font("Helvetica-Bold").fontSize(10).text(
        `Arrêtée la présente ${type.toLowerCase()} à la somme de : ${words} francs CFA.`,
        pageLeft,
        y,
        { width: pageRight - pageLeft }
      );

      y += 40;

      pdf.font("Helvetica").fontSize(10).text("Merci pour votre confiance.", pageLeft, y, {
        width: pageRight - pageLeft,
        align: "center",
      });

      pdf.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildPdfBuffer };