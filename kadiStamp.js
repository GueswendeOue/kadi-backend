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
 *
 * Fix:
 * - Tampon uniquement sur la DERNIERE page par défaut
 * - Si page rotation != 0 => on SKIP (évite PDF cassé / inversé)
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

function drawCircularText(ctx, text, startAngle, radiusOffset, spacingCoef = 2.0, reverse = false) {
  const chars = String(text || "").split("");
  const angleStep = (Math.PI / 180) * spacingCoef;

  let angle = startAngle - (chars.length * angleStep) / 2;
  if (reverse) angle = startAngle + (chars.length * angleStep) / 2;

  for (const ch of chars) {
    ctx.save();
    ctx.rotate(angle);
    ctx.translate(0, radiusOffset);
    ctx.rotate(reverse ? Math.PI : 0);
    ctx.textAlign = "center";
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    angle += reverse ? -angleStep : angleStep;
  }
}

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

  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(center, center, outerR, 0, Math.PI * 2);
  ctx.stroke();

  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(center, center, innerR, 0, Math.PI * 2);
  ctx.stroke();

  const { name, idLine, phoneLine, addr } = makeStampTextLines(profile);

  // texte haut
  ctx.save();
  ctx.translate(center, center);
  ctx.font = "bold 32px Arial";
  drawCircularText(ctx, name.toUpperCase(), 0, -205, 2.2);
  ctx.restore();

  // texte bas
  const bottom = [idLine, phoneLine].filter(Boolean).join(" • ");
  if (bottom) {
    ctx.save();
    ctx.translate(center, center);
    ctx.font = "bold 22px Arial";
    drawCircularText(ctx, bottom.toUpperCase(), Math.PI, -205, 2.0, true);
    ctx.restore();
  }

  // centre
  ctx.save();
  ctx.translate(center, center);

  if (logoBuffer && loadImage) {
    try {
      const img = await loadImage(logoBuffer);
      const logoSize = 120;
      ctx.drawImage(img, -logoSize / 2, -logoSize / 2 - 35, logoSize, logoSize);
    } catch (_) {}
  }

  const centerTitle = safe(title) || safe(profile?.stamp_title) || "—";
  ctx.font = "bold 34px Arial";
  ctx.textAlign = "center";
  ctx.fillText(truncate(centerTitle.toUpperCase(), 18), 0, 40);

  if (addr) {
    ctx.font = "bold 18px Arial";
    ctx.textAlign = "center";
    ctx.fillText(truncate(addr.toUpperCase(), 34), 0, 130);
  }

  ctx.restore();
  return canvas.toBuffer("image/png");
}

/**
 * Applique le tampon au PDF (SAFE)
 */
async function applyStampToPdfBuffer(pdfBuffer, profile, opts = {}) {
  requirePdfLib();
  if (!Buffer.isBuffer(pdfBuffer)) throw new Error("applyStampToPdfBuffer: pdfBuffer doit être un Buffer");

  // OFF via profil
  if (profile?.stamp_enabled === false) return pdfBuffer;

  const pages = opts.pages || "last"; // ✅ défaut last (SAFE)
  const position = opts.position || profile?.stamp_position || "bottom-right";
  const size = Number(opts.size || profile?.stamp_size || process.env.KADI_STAMP_SIZE || 170);
  const opacity = Math.max(0, Math.min(1, Number(opts.opacity ?? 0.9)));
  const margin = Number(opts.margin ?? 18);
  const title = opts.title ?? null;

  const { PDFDocument } = PDFLib;

  const stampPng = await generateStampPngBuffer({ profile, logoBuffer: null, title });

  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const stampImg = await pdfDoc.embedPng(stampPng);

  const allPages = pdfDoc.getPages();
  if (!allPages.length) return pdfBuffer;

  const targetPages = pages === "all" ? allPages : [allPages[allPages.length - 1]];

  for (const page of targetPages) {
    // ✅ si rotation != 0 => skip (évite PDF “mélangé”)
    const rot = page.getRotation ? page.getRotation().angle : 0;
    if (rot && rot !== 0) continue;

    const { width, height } = page.getSize();

    const pngDims = stampImg.scale(1);
    const ratio = pngDims.width / pngDims.height;
    const drawW = size;
    const drawH = drawW / ratio;

    // positions
    let x = margin;
    let y = margin;

    // Y=margin => bas (pdf-lib origine en bas-gauche)
    if (position === "bottom-right") {
      x = width - drawW - margin;
      y = margin;
    } else if (position === "bottom-left") {
      x = margin;
      y = margin;
    } else if (position === "top-right") {
      x = width - drawW - margin;
      y = height - drawH - margin;
    } else if (position === "top-left") {
      x = margin;
      y = height - drawH - margin;
    } else if (position === "center") {
      x = (width - drawW) / 2;
      y = (height - drawH) / 2;
    }

    page.drawImage(stampImg, { x, y, width: drawW, height: drawH, opacity });
  }

  const out = await pdfDoc.save();
  return Buffer.from(out);
}

module.exports = { generateStampPngBuffer, applyStampToPdfBuffer };