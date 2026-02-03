// kadiStamp.js
"use strict";

/**
 * Tampon circulaire BLEU (PNG) + application au PDF (overlay).
 *
 * Dépendances:
 * - npm i canvas
 * - npm i pdf-lib
 *
 * Exports:
 * - generateStampPngBuffer({ profile, logoBuffer?, title? }) -> Buffer(PNG)
 * - applyStampToPdfBuffer(pdfBuffer, profile, opts?) -> Buffer(PDF)
 */

let createCanvas, loadImage;
try {
  ({ createCanvas, loadImage } = require("canvas"));
} catch (e) {
  createCanvas = null;
  loadImage = null;
}

let PDFLib;
try {
  PDFLib = require("pdf-lib");
} catch (e) {
  PDFLib = null;
}

const STAMP_BLUE = process.env.KADI_STAMP_COLOR || "#0B57D0";

function safe(v) {
  return String(v || "").trim();
}

function requireCanvas() {
  if (!createCanvas) throw new Error("canvas non installé. Faites: npm i canvas");
}

function requirePdfLib() {
  if (!PDFLib) throw new Error("pdf-lib non installé. Faites: npm i pdf-lib");
}

function normalizePhone(p) {
  return safe(p).replace(/\s/g, "");
}

function truncate(s, max) {
  const x = safe(s);
  if (x.length <= max) return x;
  return x.slice(0, max - 1) + "…";
}

function makeStampTextLines(profile) {
  const name = safe(profile?.business_name) || "ENTREPRISE";
  const ifu = safe(profile?.ifu);
  const rccm = safe(profile?.rccm);
  const phone = normalizePhone(profile?.phone);

  const idLine = ifu ? `IFU: ${ifu}` : rccm ? `RCCM: ${rccm}` : "";
  const phoneLine = phone ? `TEL: ${phone}` : "";
  const addr = safe(profile?.address);

  return { name, idLine, phoneLine, addr };
}

/**
 * Dessine un texte en arc (cercle).
 * Amélioré: limite longueur + espacement dynamique.
 */
function drawCircularText(ctx, text, startAngle, radiusOffset, spacingDeg = 2.0, reverse = false) {
  const t = safe(text);
  if (!t) return;

  // limite pour éviter bouillie
  const maxChars = 34;
  const trimmed = t.length > maxChars ? t.slice(0, maxChars - 1) + "…" : t;

  const chars = trimmed.split("");
  const angleStep = (Math.PI / 180) * spacingDeg;

  let angle = startAngle - (chars.length * angleStep) / 2;
  if (reverse) angle = startAngle + (chars.length * angleStep) / 2;

  for (const ch of chars) {
    ctx.save();
    ctx.rotate(angle);
    ctx.translate(0, radiusOffset);
    ctx.rotate(reverse ? Math.PI : 0);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(ch, 0, 0);
    ctx.restore();

    angle += reverse ? -angleStep : angleStep;
  }
}

/**
 * ✅ PNG lisible:
 * - texte cercle un peu plus petit
 * - bloc central hiérarchisé (titre + ID + TEL)
 * - adresse optionnelle (petite)
 */
async function generateStampPngBuffer({ profile, logoBuffer = null, title = null }) {
  requireCanvas();

  const size = 520;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  ctx.clearRect(0, 0, size, size);

  const center = size / 2;
  const outerR = 240;
  const innerR = 185;

  ctx.strokeStyle = STAMP_BLUE;
  ctx.fillStyle = STAMP_BLUE;

  // cercles
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(center, center, outerR, 0, Math.PI * 2);
  ctx.stroke();

  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(center, center, innerR, 0, Math.PI * 2);
  ctx.stroke();

  const { name, idLine, phoneLine, addr } = makeStampTextLines(profile);

  // texte haut (circulaire)
  ctx.save();
  ctx.translate(center, center);
  ctx.font = "bold 28px Arial"; // ↓ avant 32
  drawCircularText(ctx, name.toUpperCase(), 0, -205, 2.05);
  ctx.restore();

  // texte bas (circulaire)
  const bottom = [idLine, phoneLine].filter(Boolean).join(" • ");
  if (bottom) {
    ctx.save();
    ctx.translate(center, center);
    ctx.font = "bold 18px Arial"; // ↓ avant 22
    drawCircularText(ctx, bottom.toUpperCase(), Math.PI, -205, 1.85, true);
    ctx.restore();
  }

  // bloc central
  ctx.save();
  ctx.translate(center, center);

  // logo optionnel (petit)
  if (logoBuffer && loadImage) {
    try {
      const img = await loadImage(logoBuffer);
      const logoSize = 90;
      ctx.drawImage(img, -logoSize / 2, -logoSize / 2 - 55, logoSize, logoSize);
    } catch (_) {}
  }

  // titre centre (fonction)
  const centerTitle = safe(title) || safe(profile?.stamp_title) || "";
  const shownTitle = centerTitle ? truncate(centerTitle.toUpperCase(), 18) : " ";

  ctx.textAlign = "center";
  ctx.fillStyle = STAMP_BLUE;

  ctx.font = "bold 34px Arial";
  ctx.fillText(shownTitle, 0, 10);

  // ID + TEL au centre (lisible)
  const midLine = idLine || "";
  const midLine2 = phoneLine || "";
  ctx.font = "bold 18px Arial";
  if (midLine) ctx.fillText(truncate(midLine.toUpperCase(), 28), 0, 55);
  if (midLine2) ctx.fillText(truncate(midLine2.toUpperCase(), 28), 0, 80);

  // adresse petite (optionnelle)
  if (addr) {
    ctx.font = "bold 14px Arial";
    ctx.fillText(truncate(addr.toUpperCase(), 42), 0, 120);
  }

  ctx.restore();

  return canvas.toBuffer("image/png");
}

/**
 * ✅ Applique le tampon au PDF
 * - prend par défaut les réglages du profil:
 *   stamp_enabled, stamp_position, stamp_size
 * - évite header/footer (SAFE zones)
 * - pages: "last" par défaut (plus propre) mais override possible
 */
async function applyStampToPdfBuffer(pdfBuffer, profile, opts = {}) {
  requirePdfLib();
  if (!Buffer.isBuffer(pdfBuffer)) throw new Error("applyStampToPdfBuffer: pdfBuffer doit être un Buffer");

  // OFF si profil désactive
  if (profile?.stamp_enabled === false) return pdfBuffer;

  const {
    pages = "last", // ✅ par défaut: dernière page uniquement
    opacity = 0.9,
    margin = 18,
    title = null,
    // override possible:
    position: posOverride = null,
    size: sizeOverride = null,
  } = opts;

  // ✅ taille/position depuis profil
  const size = Number(sizeOverride || profile?.stamp_size || process.env.KADI_STAMP_SIZE || 170);
  const position = String(posOverride || profile?.stamp_position || "bottom-right");

  const { PDFDocument } = PDFLib;

  // PNG (sans logo pour l’instant)
  const stampPng = await generateStampPngBuffer({ profile, logoBuffer: null, title });

  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const stampImg = await pdfDoc.embedPng(stampPng);

  const allPages = pdfDoc.getPages();
  if (!allPages.length) return pdfBuffer;

  const targetPages = pages === "all" ? allPages : [allPages[allPages.length - 1]];

  for (const page of targetPages) {
    const { width, height } = page.getSize();

    // proportions
    const pngDims = stampImg.scale(1);
    const ratio = pngDims.width / pngDims.height;
    const drawW = Math.max(80, Math.min(350, size));
    const drawH = drawW / ratio;

    // ✅ SAFE zones (approx): header 120px / footer 70px
    const SAFE_HEADER = 120;
    const SAFE_FOOTER = 70;

    let x = margin;
    let y = margin;

    if (position === "bottom-right") {
      x = width - drawW - margin;
      y = margin;
    } else if (position === "bottom-left") {
      x = margin;
      y = margin;
    } else if (position === "top-right") {
      x = width - drawW - margin;
      y = height - SAFE_HEADER - drawH; // évite header
    } else if (position === "top-left") {
      x = margin;
      y = height - SAFE_HEADER - drawH;
    } else if (position === "center") {
      x = (width - drawW) / 2;
      y = (height - SAFE_HEADER - SAFE_FOOTER - drawH) / 2 + SAFE_FOOTER;
    }

    // ✅ clamp y pour éviter footer
    if (y < SAFE_FOOTER) y = SAFE_FOOTER;
    // clamp y haut
    if (y + drawH > height - SAFE_HEADER) y = Math.max(SAFE_FOOTER, height - SAFE_HEADER - drawH);

    page.drawImage(stampImg, {
      x,
      y,
      width: drawW,
      height: drawH,
      opacity: Math.max(0, Math.min(1, Number(opacity) || 0.9)),
    });
  }

  const out = await pdfDoc.save();
  return Buffer.from(out);
}

module.exports = {
  generateStampPngBuffer,
  applyStampToPdfBuffer,
};