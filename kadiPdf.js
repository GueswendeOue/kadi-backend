// kadiPdf.js
"use strict";

const PDFDocument = require("pdfkit");

function safe(v) {
  return String(v || "").trim();
}

// ---------- Money formatting ----------
function fmtMoney(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x)) return "0";
  // format FCFA with spaces as thousands separators
  return Math.round(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
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

// ---------- Core PDF ----------
function buildPdfBuffer({ docData = {}, businessProfile = null, logoBuffer = null }) {
  return new Promise((resolve, reject) => {
    try {
      const pdf = new PDFDocument({ size: "A4", margin: 50 });
      const chunks = [];
      pdf.on("data", (c) => chunks.push(c));
      pdf.on("end", () => resolve(Buffer.concat(chunks)));

      const bp = businessProfile || {};

      const docType = String(docData.type || "DOCUMENT").toUpperCase();
      const docNumber = docData.docNumber || "—";
      const date = docData.date || "—";
      const client = docData.client || "—";
      const items = Array.isArray(docData.items) ? docData.items : [];

      // ⚠️ Totaux: on RECALCULE à partir des lignes (source de vérité)
      const computedTotal = items.reduce((acc, it) => {
        const qty = Number(it?.qty ?? 0);
        const pu = Number(it?.unitPrice ?? 0);
        const amt = Number(it?.amount);
        const lineAmount = Number.isFinite(amt) ? amt : qty * pu;
        return acc + (Number.isFinite(lineAmount) ? lineAmount : 0);
      }, 0);

      const total = Number.isFinite(Number(docData.total))
        ? Number(docData.total) // si tu veux forcer un total (rare)
        : computedTotal;

      // ---------- Layout constants ----------
      const pageW = pdf.page.width;
      const pageH = pdf.page.height;
      const margin = pdf.page.margins.left; // 50
      const leftX = margin;
      const rightX = pageW - margin;
      const topY = 45;

      // Table sizing
      const tableX = leftX;
      const tableW = rightX - leftX;

      // Column widths (sum must == tableW)
      // Tweak safe for A4 margins: tableW is about 495
      const col = {
        n: 28,
        des: 265,
        qty: 50,
        pu: 75,
        amt: tableW - (28 + 265 + 50 + 75), // remainder
      };

      const rowH = 22;
      const pad = 6;

      function drawHeader() {
        const headerH = 86;

        // background line / separation
        // (no fill to keep it clean; just spacing)

        // Logo
        if (logoBuffer) {
          try {
            pdf.image(logoBuffer, leftX, topY, { fit: [70, 70] });
          } catch {}
        }

        const companyX = leftX + (logoBuffer ? 82 : 0);
        const companyW = 290; // left block width
        const metaW = 170;    // right block width
        const metaX = rightX - metaW;

        // Company block (left) — NEW LINES (no more " | " overflow)
        pdf.font("Helvetica-Bold").fontSize(13).text(safe(bp.business_name) || "KADI", companyX, topY, {
          width: companyW,
        });

        pdf.font("Helvetica").fontSize(10);

        const companyLines = [
          safe(bp.address) ? `Adresse : ${safe(bp.address)}` : null,
          safe(bp.phone) ? `Tél : ${safe(bp.phone)}` : null,
          safe(bp.email) ? `Email : ${safe(bp.email)}` : null,
          safe(bp.ifu) ? `IFU : ${safe(bp.ifu)}` : null,
          safe(bp.rccm) ? `RCCM : ${safe(bp.rccm)}` : null,
        ].filter(Boolean);

        pdf.text(companyLines.join("\n") || "", companyX, topY + 18, { width: companyW });

        // Meta block (right) — isolated, no overlap
        pdf.font("Helvetica-Bold").fontSize(16).text(docType, metaX, topY, { width: metaW, align: "right" });
        pdf.font("Helvetica").fontSize(10).text(`N° : ${docNumber}`, metaX, topY + 22, { width: metaW, align: "right" });
        pdf.text(`Date : ${date}`, metaX, topY + 36, { width: metaW, align: "right" });

        // Separator line
        const sepY = topY + headerH;
        pdf.moveTo(leftX, sepY).lineTo(rightX, sepY).stroke();

        // Move cursor below header
        pdf.y = sepY + 12;
      }

      function drawClientBox() {
        const boxX = leftX;
        const boxW = tableW;
        const boxY = pdf.y;
        const boxH = 46;

        pdf.rect(boxX, boxY, boxW, boxH).stroke();

        pdf.font("Helvetica-Bold").fontSize(11).text("Client", boxX + pad, boxY + 8);
        pdf.font("Helvetica").fontSize(11).text(String(client || "—"), boxX + pad, boxY + 24, {
          width: boxW - pad * 2,
        });

        pdf.y = boxY + boxH + 12;
      }

      function drawTableHeader() {
        const y = pdf.y;

        // Header background
        // (keep white; just bold + borders)
        pdf.rect(tableX, y, tableW, rowH).stroke();

        // Vertical lines
        let x = tableX;
        const cuts = [col.n, col.des, col.qty, col.pu, col.amt];
        for (let i = 0; i < cuts.length - 1; i++) {
          x += cuts[i];
          pdf.moveTo(x, y).lineTo(x, y + rowH).stroke();
        }

        pdf.font("Helvetica-Bold").fontSize(10);
        pdf.text("#", tableX + pad, y + 6, { width: col.n - pad * 2 });
        pdf.text("Désignation", tableX + col.n + pad, y + 6, { width: col.des - pad * 2 });
        pdf.text("Qté", tableX + col.n + col.des + pad, y + 6, { width: col.qty - pad * 2, align: "right" });
        pdf.text("PU", tableX + col.n + col.des + col.qty + pad, y + 6, { width: col.pu - pad * 2, align: "right" });
        pdf.text("Montant", tableX + col.n + col.des + col.qty + col.pu + pad, y + 6, {
          width: col.amt - pad * 2,
          align: "right",
        });

        pdf.font("Helvetica").fontSize(10);
        pdf.y = y + rowH;
      }

      function ensureSpace(hNeeded) {
        const bottomLimit = pageH - margin;
        if (pdf.y + hNeeded <= bottomLimit) return;

        pdf.addPage();
        drawHeader();
        drawClientBox();
        drawTableHeader();
      }

      function drawRow(idx, it) {
        const y = pdf.y;

        // derive amounts safely
        const qty = Number(it?.qty ?? 0);
        const pu = Number(it?.unitPrice ?? 0);
        const amtRaw = Number(it?.amount);
        const amt = Number.isFinite(amtRaw) ? amtRaw : qty * pu;

        const label = String(it?.label || it?.raw || "—");

        // Row rectangle + borders
        pdf.rect(tableX, y, tableW, rowH).stroke();

        let x = tableX;
        const cuts = [col.n, col.des, col.qty, col.pu, col.amt];
        for (let i = 0; i < cuts.length - 1; i++) {
          x += cuts[i];
          pdf.moveTo(x, y).lineTo(x, y + rowH).stroke();
        }

        // Text in cells
        pdf.font("Helvetica").fontSize(10);

        pdf.text(String(idx + 1), tableX + pad, y + 6, { width: col.n - pad * 2 });

        // Désignation: keep in its cell, truncate if too long
        pdf.text(label, tableX + col.n + pad, y + 6, {
          width: col.des - pad * 2,
          height: rowH - 8,
          ellipsis: true,
        });

        pdf.text(fmtMoney(qty), tableX + col.n + col.des + pad, y + 6, {
          width: col.qty - pad * 2,
          align: "right",
        });

        pdf.text(fmtMoney(pu), tableX + col.n + col.des + col.qty + pad, y + 6, {
          width: col.pu - pad * 2,
          align: "right",
        });

        pdf.text(fmtMoney(amt), tableX + col.n + col.des + col.qty + col.pu + pad, y + 6, {
          width: col.amt - pad * 2,
          align: "right",
        });

        pdf.y = y + rowH;
      }

      function drawTotals() {
        ensureSpace(110);

        const y = pdf.y + 10;

        // Totals box on the right
        const boxW = 220;
        const boxH = 46;
        const boxX = rightX - boxW;
        const boxY = y;

        pdf.rect(boxX, boxY, boxW, boxH).stroke();
        pdf.font("Helvetica-Bold").fontSize(12).text("TOTAL", boxX + pad, boxY + 14, { width: boxW - pad * 2 });
        pdf.font("Helvetica-Bold").fontSize(12).text(`${fmtMoney(total)} FCFA`, boxX + pad, boxY + 14, {
          width: boxW - pad * 2,
          align: "right",
        });

        // Amount in words
        const words = numberToFrench(total);
        const textY = boxY + boxH + 10;

        pdf.font("Helvetica").fontSize(10).text(
          `Arrêtée la présente ${docType.toLowerCase()} à la somme de : ${words} francs CFA.`,
          leftX,
          textY,
          { width: tableW }
        );

        pdf.y = textY + 40;
        pdf.font("Helvetica").fontSize(10).text("Merci pour votre confiance.", { align: "center" });
      }

      // ---------- Build document ----------
      drawHeader();
      drawClientBox();
      drawTableHeader();

      // Rows
      for (let i = 0; i < items.length; i++) {
        ensureSpace(rowH + 8);
        drawRow(i, items[i]);
      }

      drawTotals();

      pdf.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildPdfBuffer };