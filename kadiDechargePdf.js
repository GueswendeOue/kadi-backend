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

/**
 * ✅ Décharge PDF (B3)
 * docData attendu:
 * {
 *  docNumber, date, city,
 *  amount, currency, reason,
 *  party1: { name, idType, idNumber, phone, address },
 *  party2: { name, idType, idNumber, phone, address },
 *  method: "Espèces|OM|... (optionnel)",
 *  witness: { name, phone } (optionnel)
 * }
 */
async function buildDechargePdfBuffer({ docData = {} }) {
  // Footer KADI QR
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

      const pageLeft = 50;
      const pageRight = 545;
      let y = 45;

      const docNumber = safe(docData.docNumber || "—");
      const date = safe(docData.date || "—");
      const city = safe(docData.city || "—");
      const amount = Number(docData.amount || 0);
      const currency = safe(docData.currency || "FCFA");
      const reason = safe(docData.reason || "—");
      const method = safe(docData.method || "");

      const p1 = docData.party1 || {};
      const p2 = docData.party2 || {};
      const w = docData.witness || null;

      // Title
      pdf.fillColor("#000");
      pdf.font("Helvetica-Bold").fontSize(18).text("DÉCHARGE", pageLeft, y, { width: pageRight - pageLeft, align: "center" });
      y += 30;

      pdf.font("Helvetica").fontSize(10).text(`N° : ${docNumber}`, pageLeft, y, { width: pageRight - pageLeft, align: "right" });
      y += 14;

      pdf.font("Helvetica").fontSize(11).text(`${city}, le ${date}`, pageLeft, y, { width: pageRight - pageLeft, align: "right" });
      y += 18;

      pdf.moveTo(pageLeft, y).lineTo(pageRight, y).stroke();
      y += 18;

      // Parties blocks
      function partyBlock(title, p) {
        const lines = [
          safe(p.name) ? `Nom : ${safe(p.name)}` : "Nom : —",
          (safe(p.idType) || safe(p.idNumber)) ? `Pièce : ${safe(p.idType)} ${safe(p.idNumber)}`.trim() : "Pièce : —",
          safe(p.phone) ? `Téléphone : ${safe(p.phone)}` : "Téléphone : —",
          safe(p.address) ? `Adresse : ${safe(p.address)}` : "Adresse : —",
        ];

        pdf.font("Helvetica-Bold").fontSize(11).text(title, pageLeft, y);
        y += 14;
        pdf.font("Helvetica").fontSize(10).text(lines.join("\n"), pageLeft, y, { width: pageRight - pageLeft, lineGap: 2 });
        y += 52;
      }

      partyBlock("Partie 1 (Bénéficiaire / Réception)", p1);
      partyBlock("Partie 2 (Remettant / Paiement)", p2);

      // Main statement
      pdf.font("Helvetica-Bold").fontSize(11).text("Déclaration", pageLeft, y);
      y += 14;

      const amountWords = numberToFrench(amount);
      const line1 =
        `Je soussigné(e) ${safe(p1.name) || "—"}, déclare avoir reçu de ${safe(p2.name) || "—"} la somme de ` +
        `${fmtNumber(amount)} ${currency} (${amountWords} ${currency.toLowerCase()}).`;

      const line2 = `Motif : ${reason}.`;
      const line3 = method ? `Mode de paiement : ${method}.` : "";

      pdf.font("Helvetica").fontSize(11).text([line1, line2, line3].filter(Boolean).join("\n"), pageLeft, y, {
        width: pageRight - pageLeft,
        lineGap: 4,
      });
      y += 70;

      // Double confirmation lines (pour B4)
      pdf.font("Helvetica-Bold").fontSize(11).text("Confirmations", pageLeft, y);
      y += 14;

      const c1 = `✅ Partie 1 déclare : "J’ai bien reçu ${fmtNumber(amount)} ${currency} de la Partie 2."`;
      const c2 = `✅ Partie 2 déclare : "J’ai bien remis ${fmtNumber(amount)} ${currency} à la Partie 1."`;

      pdf.font("Helvetica").fontSize(10).text(`${c1}\n${c2}`, pageLeft, y, { width: pageRight - pageLeft, lineGap: 3 });
      y += 42;

      // Witness (optional)
      if (w && (safe(w.name) || safe(w.phone))) {
        pdf.font("Helvetica-Bold").fontSize(11).text("Témoin (optionnel)", pageLeft, y);
        y += 14;
        pdf.font("Helvetica").fontSize(10).text(
          `Nom : ${safe(w.name) || "—"}\nTéléphone : ${safe(w.phone) || "—"}`,
          pageLeft,
          y,
          { width: pageRight - pageLeft, lineGap: 2 }
        );
        y += 36;
      }

      // Signatures
      y += 10;
      const signY = Math.min(y, pdf.page.height - 170);

      pdf.font("Helvetica-Bold").fontSize(11).text("Signatures", pageLeft, signY);
      const boxTop = signY + 20;

      const mid = pageLeft + (pageRight - pageLeft) / 2;
      const boxW = (pageRight - pageLeft - 20) / 2;
      const boxH = 80;

      // Partie 1 signature box
      pdf.rect(pageLeft, boxTop, boxW, boxH).stroke();
      pdf.font("Helvetica").fontSize(10).text("Partie 1 (Reçu)", pageLeft + 10, boxTop + 10);
      pdf.font("Helvetica").fontSize(9).fillColor("#444").text("Nom + Signature", pageLeft + 10, boxTop + 28);
      pdf.fillColor("#000");

      // Partie 2 signature box
      pdf.rect(mid + 10, boxTop, boxW, boxH).stroke();
      pdf.font("Helvetica").fontSize(10).text("Partie 2 (Remis)", mid + 20, boxTop + 10);
      pdf.font("Helvetica").fontSize(9).fillColor("#444").text("Nom + Signature", mid + 20, boxTop + 28);
      pdf.fillColor("#000");

      // Footer (discret) + QR (comme tes autres PDF)
      const footerY = pdf.page.height - 70;
      const qrSize = 55;

      pdf.moveTo(pageLeft, footerY - 6).lineTo(pageRight, footerY - 6).stroke();

      pdf.font("Helvetica").fontSize(8).fillColor("#444");
      const footerText = `Généré par KADI • WhatsApp +${KADI_COUNTRY} ${KADI_NUMBER_LOCAL.replace(
        /(\d{2})(\d{2})(\d{2})(\d{2})/,
        "$1 $2 $3 $4"
      )} • Scannez pour essayer`;

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

      pdf.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildDechargePdfBuffer };