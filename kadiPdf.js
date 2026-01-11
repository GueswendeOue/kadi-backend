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

      // ---------------- Data ----------------
      const type = String(docData.type || "DOCUMENT").toUpperCase();
      const docNumber = docData.docNumber || "—";
      const date = docData.date || "—";
      const client = docData.client || "—";
      const items = Array.isArray(docData.items) ? docData.items : [];
      const total = Number(docData.total || 0);

      const bp = businessProfile || {};

      // ---------------- Layout constants ----------------
      const pageLeft = pdf.page.margins.left;
      const pageRight = pdf.page.width - pdf.page.margins.right;
      const pageTop = pdf.page.margins.top;
      const pageBottom = pdf.page.height - pdf.page.margins.bottom;

      const leftX = pageLeft;
      const topY = pageTop - 5;

      // Table geometry
      const tableX = pageLeft;
      const tableW = pageRight - pageLeft;

      // Columns widths (pro, stable)
      const col = {
        idx: 30,
        designation: 290,
        qty: 55,
        pu: 85,
        amount: tableW - (30 + 290 + 55 + 85), // remainder
      };

      const colX = {
        idx: tableX,
        designation: tableX + col.idx,
        qty: tableX + col.idx + col.designation,
        pu: tableX + col.idx + col.designation + col.qty,
        amount: tableX + col.idx + col.designation + col.qty + col.pu,
      };

      const lineGap = 4;

      function drawHr(y, thickness = 1) {
        pdf.save();
        pdf.lineWidth(thickness);
        pdf.moveTo(tableX, y).lineTo(tableX + tableW, y).stroke();
        pdf.restore();
      }

      function drawRect(x, y, w, h, thickness = 1) {
        pdf.save();
        pdf.lineWidth(thickness);
        pdf.rect(x, y, w, h).stroke();
        pdf.restore();
      }

      function drawVLines(yTop, yBottom) {
        // vertical separators for the table grid
        pdf.save();
        pdf.lineWidth(1);
        const xs = [
          colX.idx,
          colX.designation,
          colX.qty,
          colX.pu,
          colX.amount,
          tableX + tableW,
        ];
        xs.forEach((x) => {
          pdf.moveTo(x, yTop).lineTo(x, yBottom).stroke();
        });
        pdf.restore();
      }

      function fmtMoney(n) {
        const v = Math.round(Number(n) || 0);
        // grouping with spaces: 100000 -> 100 000
        return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
      }

      function drawHeader() {
        // Logo
        const logoSize = 55;
        let logoW = 0;

        if (logoBuffer) {
          try {
            pdf.image(logoBuffer, leftX, topY, { fit: [logoSize, logoSize] });
            logoW = logoSize + 12;
          } catch {}
        }

        const businessX = leftX + logoW;

        // Bloc entreprise (à gauche, sur plusieurs lignes)
        pdf.font("Helvetica-Bold").fontSize(12).text(safe(bp.business_name) || "KADI", businessX, topY);

        const businessLines = [
          safe(bp.address) ? `Adresse : ${safe(bp.address)}` : null,
          safe(bp.phone) ? `Tél : ${safe(bp.phone)}` : null,
          safe(bp.email) ? `Email : ${safe(bp.email)}` : null,
          safe(bp.ifu) ? `IFU : ${safe(bp.ifu)}` : null,
          safe(bp.rccm) ? `RCCM : ${safe(bp.rccm)}` : null,
        ].filter(Boolean);

        pdf.font("Helvetica").fontSize(9);
        const businessBoxW = 260; // fixe pour éviter de chevaucher à droite
        pdf.text(businessLines.join("\n") || " ", businessX, topY + 16, {
          width: businessBoxW,
          lineGap,
        });

        // Bloc document (à droite, zone fixe => pro forma ne casse plus)
        const rightW = 230;
        const rightX = pageRight - rightW;

        pdf.font("Helvetica-Bold").fontSize(16).text(type, rightX, topY, {
          width: rightW,
          align: "right",
        });

        pdf.font("Helvetica").fontSize(10).text(`N° : ${docNumber}`, rightX, topY + 22, {
          width: rightW,
          align: "right",
        });
        pdf.text(`Date : ${date}`, rightX, topY + 36, {
          width: rightW,
          align: "right",
        });

        // Ligne de séparation
        const afterHeaderY = Math.max(topY + 62, pdf.y + 8);
        drawHr(afterHeaderY, 1);

        // Bloc client (encadré pro)
        let y = afterHeaderY + 14;
        const clientBoxH = 46;
        drawRect(tableX, y, tableW, clientBoxH, 1);

        pdf.font("Helvetica-Bold").fontSize(10).text("Client", tableX + 10, y + 8);
        pdf.font("Helvetica").fontSize(10).text(String(client || "—"), tableX + 10, y + 24, {
          width: tableW - 20,
        });

        return y + clientBoxH + 14; // next y
      }

      function drawTableHeader(y) {
        const h = 26;

        // header row background (gris clair)
        pdf.save();
        pdf.fillColor("#F2F2F2").rect(tableX, y, tableW, h).fill();
        pdf.restore();

        drawRect(tableX, y, tableW, h, 1);
        drawVLines(y, y + h);

        pdf.fillColor("black");
        pdf.font("Helvetica-Bold").fontSize(10);

        pdf.text("#", colX.idx + 8, y + 8, { width: col.idx - 16, align: "left" });
        pdf.text("Désignation", colX.designation + 8, y + 8, { width: col.designation - 16 });
        pdf.text("Qté", colX.qty + 8, y + 8, { width: col.qty - 16, align: "right" });
        pdf.text("PU", colX.pu + 8, y + 8, { width: col.pu - 16, align: "right" });
        pdf.text("Montant", colX.amount + 8, y + 8, { width: col.amount - 16, align: "right" });

        return y + h;
      }

      function measureRowHeight(item) {
        const label = String(item?.label || item?.raw || "—");
        pdf.font("Helvetica").fontSize(10);
        const hLabel = pdf.heightOfString(label, {
          width: col.designation - 16,
          lineGap,
        });
        // minimum row height
        const base = 24;
        return Math.max(base, Math.ceil(hLabel + 14));
      }

      function drawRow(y, idx, item, rowH) {
        drawRect(tableX, y, tableW, rowH, 1);
        drawVLines(y, y + rowH);

        const label = String(item?.label || item?.raw || "—");
        const qty = Number(item?.qty || 0);
        const pu = Number(item?.unitPrice || 0);
        const amt = Number(item?.amount || qty * pu || 0);

        pdf.font("Helvetica").fontSize(10);

        // index
        pdf.text(String(idx), colX.idx + 8, y + 7, { width: col.idx - 16, align: "left" });

        // designation wrap
        pdf.text(label, colX.designation + 8, y + 7, {
          width: col.designation - 16,
          lineGap,
        });

        // qty / prices aligned right
        pdf.text(String(qty || 0), colX.qty + 8, y + 7, { width: col.qty - 16, align: "right" });
        pdf.text(fmtMoney(pu), colX.pu + 8, y + 7, { width: col.pu - 16, align: "right" });
        pdf.text(fmtMoney(amt), colX.amount + 8, y + 7, { width: col.amount - 16, align: "right" });
      }

      function ensureSpace(y, needed, redrawHeaderFn) {
        if (y + needed <= pageBottom) return y;
        pdf.addPage();
        const newY = redrawHeaderFn();
        return newY;
      }

      // ---------------- Render ----------------
      let y = drawHeader();

      // Table header
      y = drawTableHeader(y);

      // Rows
      for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        const rowH = measureRowHeight(it);

        // page break with header re-draw
        y = ensureSpace(y, rowH + 90, () => {
          const ny = drawHeader();
          return drawTableHeader(ny);
        });

        drawRow(y, i + 1, it, rowH);
        y += rowH;
      }

      // If no items, show one empty row
      if (items.length === 0) {
        const rowH = 24;
        y = ensureSpace(y, rowH + 90, () => {
          const ny = drawHeader();
          return drawTableHeader(ny);
        });
        drawRow(y, 1, { label: "—", qty: 0, unitPrice: 0, amount: 0, raw: "—" }, rowH);
        y += rowH;
      }

      y += 14;

      // TOTAL box (pro)
      const totalBoxW = 260;
      const totalBoxH = 46;
      const totalBoxX = pageRight - totalBoxW;

      y = ensureSpace(y, totalBoxH + 80, () => drawHeader());

      drawRect(totalBoxX, y, totalBoxW, totalBoxH, 1);

      pdf.font("Helvetica-Bold").fontSize(12).text("TOTAL", totalBoxX + 14, y + 14, {
        width: 80,
      });

      pdf.font("Helvetica-Bold").fontSize(12).text(`${fmtMoney(total)} FCFA`, totalBoxX + 90, y + 14, {
        width: totalBoxW - 104,
        align: "right",
      });

      y += totalBoxH + 16;

      // Montant en lettres (avec partie en gras)
      const words = numberToFrench(total);

      pdf.font("Helvetica").fontSize(10).text(
        `Arrêtée la présente ${type.toLowerCase()} à la somme de : `,
        tableX,
        y,
        { continued: true, width: tableW }
      );
      pdf.font("Helvetica-Bold").fontSize(10).text(`${words} francs CFA.`, {
        continued: false,
      });

      y += 30;

      pdf.font("Helvetica").fontSize(10).text("Merci pour votre confiance.", tableX, y, {
        width: tableW,
        align: "center",
      });

      pdf.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildPdfBuffer };