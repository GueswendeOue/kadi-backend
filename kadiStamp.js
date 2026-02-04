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

// zone footer réservée (doit matcher kadiPdf.js)
const FOOTER_RESERVED_H = Number(process.env.KADI_PDF_FOOTER_H || 85);

// marge de sécurité
const DEFAULT_MARGIN = Number(process.env.KADI_STAMP_MARGIN || 18);

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
  const s = safe(p).replace(/\s/g, "");
  return s || "";
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
 * Dessine un texte en arc (circulaire)
 */
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

/**
 * Génère un tampon circulaire bleu (PNG)
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

  // cercle extérieur
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(center, center, outerR, 0, Math.PI * 2);
  ctx.stroke();

  // cercle intérieur
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(center, center, innerR, 0, Math.PI * 2);
  ctx.stroke();

  const { name, idLine, phoneLine, addr } = makeStampTextLines(profile);

  // texte haut (circulaire)
  ctx.save();
  ctx.translate(center, center);
  ctx.font = "bold 32px Arial";
  drawCircularText(ctx, name.toUpperCase(), 0, -205, 2.2);
  ctx.restore();

  // texte bas (circulaire)
  const bottom = [idLine, phoneLine].filter(Boolean).join(" • ");
  if (bottom) {
    ctx.save();
    ctx.translate(center, center);
    ctx.font = "bold 22px Arial";
    drawCircularText(ctx, bottom.toUpperCase(), Math.PI, -205, 2.0, true);
    ctx.restore();
  }

  // bloc central
  ctx.save();
  ctx.translate(center, center);

  // logo (optionnel)
  if (logoBuffer && loadImage) {
    try {
      const img = await loadImage(logoBuffer);
      const logoSize = 120;
      ctx.drawImage(img, -logoSize / 2, -logoSize / 2 - 35, logoSize, logoSize);
    } catch (_) {}
  }

  const centerTitle = safe(title) || safe(profile?.stamp_title) || "TAMPON";
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
 * Applique le tampon au PDF (anti-collision footer/QR)
 */
async function applyStampToPdfBuffer(pdfBuffer, profile, opts = {}) {
  requirePdfLib();
  if (!Buffer.isBuffer(pdfBuffer)) throw new Error("applyStampToPdfBuffer: pdfBuffer doit être un Buffer");

  // OFF si désactivé
  if (profile?.stamp_enabled === false) return pdfBuffer;

  const { PDFDocument } = PDFLib;

  // ✅ Defaults depuis profil
  const size = Number(
    opts.size ||
      profile?.stamp_size ||
      process.env.KADI_STAMP_SIZE ||
      170
  );

  // ✅ Par défaut: bottom-left (safe)
  const position =
    opts.position ||
    profile?.stamp_position ||
    "bottom-left";

  const opacity = Math.max(0, Math.min(1, Number(opts.opacity ?? 0.9)));
  const margin = Number(opts.margin || DEFAULT_MARGIN);
  const pages = opts.pages || "all";
  const title = opts.title || null;

  // PNG tampon (sans logo)
  const stampPng = await generateStampPngBuffer({ profile, logoBuffer: null, title });

  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const stampImg = await pdfDoc.embedPng(stampPng);

  const allPages = pdfDoc.getPages();
  if (!allPages.length) return pdfBuffer;

  const targetPages = pages === "last" ? [allPages[allPages.length - 1]] : allPages;

  for (const page of targetPages) {
    const { width, height } = page.getSize();

    // conserve proportions PNG
    const pngDims = stampImg.scale(1);
    const ratio = pngDims.width / pngDims.height;
    const drawW = Number.isFinite(size) && size > 10 ? size : 170;
    const drawH = drawW / ratio;

    // zone safe : au-dessus du footer
    const safeBottomY = FOOTER_RESERVED_H + margin; // y minimum autorisé
    const safeTopY = height - margin - drawH; // y maximum

    // X / Y par défaut
    let x = margin;
    let y = safeBottomY;

    // ----- Positions -----
    if (position === "bottom-left") {
      x = margin;
      y = safeBottomY; // ✅ jamais dans footer
    }

    if (position === "bottom-right") {
      x = width - drawW - margin;

      // ✅ IMPORTANT: bottom-right risque de toucher le QR
      // donc on remonte un peu plus haut que le footer
      y = safeBottomY + 25; // anti-collision QR (simple & efficace)
      if (y > safeTopY) y = safeTopY;
    }

    if (position === "top-left") {
      x = margin;
      y = safeTopY;
    }

    if (position === "top-right") {
      x = width - drawW - margin;
      y = safeTopY;
    }

    if (position === "center") {
      x = (width - drawW) / 2;
      y = (height - drawH) / 2;

      // clamp pour rester hors footer
      if (y < safeBottomY) y = safeBottomY;
      if (y > safeTopY) y = safeTopY;
    }

    // clamp final
    if (x < margin) x = margin;
    if (x + drawW > width - margin) x = width - margin - drawW;

    if (y < safeBottomY) y = safeBottomY;
    if (y > safeTopY) y = safeTopY;

    page.drawImage(stampImg, {
      x,
      y,
      width: drawW,
      height: drawH,
      opacity,
    });
  }

  const out = await pdfDoc.save();
  return Buffer.from(out);
}

module.exports = {
  generateStampPngBuffer,
  applyStampToPdfBuffer,
};