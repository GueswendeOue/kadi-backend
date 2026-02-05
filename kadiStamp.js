"use strict";

/**
 * kadiStamp.js — PRO Circular Stamp (UPDATED)
 * ✅ Goals:
 * - Professional circular stamp (no "TAMPON" text ever)
 * - Logo rendered cleanly (NO blue square): contain + circular clip
 * - Realistic stamp opacity (default ~0.28)
 * - Apply with pdf-lib on LAST page by default
 *
 * Notes:
 * - If canvas is available: stamp PNG generated dynamically
 * - If canvas is NOT available: fallback to ./assets/stamp.png
 * - Safety: if profile.stamp_paid exists and is NOT true => do NOT apply stamp
 */

const fs = require("fs");
const path = require("path");

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
const FOOTER_RESERVED_H = Number(process.env.KADI_PDF_FOOTER_H || 85);
const DEFAULT_MARGIN = Number(process.env.KADI_STAMP_MARGIN || 18);

// ✅ realistic default (was 0.9 too strong)
const DEFAULT_OPACITY = Number(process.env.KADI_STAMP_OPACITY || 0.28);

// Size of stamp drawn on PDF (points)
const DEFAULT_STAMP_SIZE = Number(process.env.KADI_STAMP_SIZE || 210);

function safe(v) {
  return String(v || "").trim();
}
function truncate(s, max) {
  const x = safe(s);
  if (x.length <= max) return x;
  return x.slice(0, max - 1) + "…";
}
function normalizePhone(p) {
  return safe(p).replace(/\s/g, "");
}

function requirePdfLib() {
  if (!PDFLib) throw new Error("pdf-lib non installé. Faites: npm i pdf-lib");
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

// -------- Canvas stamp generation (optional) --------
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
 * Draw logo in "contain" mode inside a given box.
 * ✅ No tinting: prevents the "blue square" when logo has white background.
 */
async function drawLogoContain(ctx, logoBuffer, x, y, w, h) {
  if (!logoBuffer || !loadImage) return;

  const img = await loadImage(logoBuffer);

  const ir = img.width / img.height;
  const br = w / h;

  let dw = w,
    dh = h;

  if (ir > br) {
    dh = w / ir;
  } else {
    dw = h * ir;
  }

  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;

  ctx.save();
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

async function generateStampPngBuffer({ profile, logoBuffer = null, title = null }) {
  if (!createCanvas) throw new Error("canvas non dispo");

  // Big source canvas => sharper when scaled down in PDF
  const size = 560;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);

  const center = size / 2;
  const outerR = 250;
  const innerR = 195;

  ctx.strokeStyle = STAMP_BLUE;
  ctx.fillStyle = STAMP_BLUE;

  // Outer ring
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(center, center, outerR, 0, Math.PI * 2);
  ctx.stroke();

  // Inner ring
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(center, center, innerR, 0, Math.PI * 2);
  ctx.stroke();

  const { name, idLine, phoneLine, addr } = makeStampTextLines(profile);

  // Top arc: company name
  ctx.save();
  ctx.translate(center, center);
  ctx.font = "bold 34px Arial";
  drawCircularText(ctx, truncate(name.toUpperCase(), 28), 0, -214, 2.15);
  ctx.restore();

  // Bottom arc: IFU/RCCM + phone
  const bottomRaw = [idLine, phoneLine].filter(Boolean).join(" • ");
  const bottom = truncate(bottomRaw, 38);

  if (bottom) {
    ctx.save();
    ctx.translate(center, center);
    ctx.font = "bold 22px Arial";
    drawCircularText(ctx, bottom.toUpperCase(), Math.PI, -214, 1.95, true);
    ctx.restore();
  }

  // Center block
  ctx.save();
  ctx.translate(center, center);

  // ✅ Logo (clean) inside circular clip (pro look)
  if (logoBuffer) {
    try {
      const cy = -38;
      const r = 72;

      ctx.save();
      ctx.beginPath();
      ctx.arc(0, cy, r, 0, Math.PI * 2);
      ctx.clip();

      // contain inside the clipped circle
      await drawLogoContain(ctx, logoBuffer, -r, cy - r, r * 2, r * 2);
      ctx.restore();

      // optional ring
      ctx.strokeStyle = STAMP_BLUE;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, cy, r + 2, 0, Math.PI * 2);
      ctx.stroke();
    } catch (_) {
      // ignore logo errors
    }
  }

  // ✅ Center title: NEVER default to "TAMPON"
  const centerTitle = safe(title) || safe(profile?.stamp_title) || "";
  if (centerTitle) {
    ctx.font = "bold 34px Arial";
    ctx.textAlign = "center";
    ctx.fillStyle = STAMP_BLUE;
    ctx.fillText(truncate(centerTitle.toUpperCase(), 18), 0, 70);
  }

  // Address line (optional)
  if (addr) {
    ctx.font = "bold 18px Arial";
    ctx.textAlign = "center";
    ctx.fillStyle = STAMP_BLUE;
    ctx.fillText(truncate(addr.toUpperCase(), 34), 0, 128);
  }

  ctx.restore();

  return canvas.toBuffer("image/png");
}

// -------- Stamp PNG fallback (Render friendly) --------
function getFallbackStampPngBuffer(profile) {
  const p = profile?.stamp_image_path
    ? path.resolve(profile.stamp_image_path)
    : path.join(__dirname, "assets", "stamp.png");

  if (!fs.existsSync(p)) {
    throw new Error(`Fallback stamp PNG not found: ${p}`);
  }
  return fs.readFileSync(p);
}

// -------- Apply on PDF (pdf-lib) --------
async function applyStampToPdfBuffer(pdfBuffer, profile, opts = {}) {
  requirePdfLib();
  if (!Buffer.isBuffer(pdfBuffer)) throw new Error("applyStampToPdfBuffer: pdfBuffer doit être un Buffer");

  // ✅ Apply only when enabled === true
  if (profile?.stamp_enabled !== true) return pdfBuffer;

  // ✅ Model B safety: if stamp_paid exists and not true => skip
  if (Object.prototype.hasOwnProperty.call(profile || {}, "stamp_paid") && profile?.stamp_paid !== true) {
    return pdfBuffer;
  }

  const { PDFDocument } = PDFLib;

  const size = Number(opts.size || profile?.stamp_size || DEFAULT_STAMP_SIZE);
  const position = String(opts.position || profile?.stamp_position || "bottom-right");

  // ✅ realistic default opacity
  const opacity = Math.max(0, Math.min(1, Number(opts.opacity ?? (profile?.stamp_opacity ?? DEFAULT_OPACITY))));

  const margin = Number(opts.margin || DEFAULT_MARGIN);

  // ✅ last page by default
  const pages = String(opts.pages || profile?.stamp_pages || "last");

  const title = opts.title || null;
  const logoBuffer = opts.logoBuffer && Buffer.isBuffer(opts.logoBuffer) ? opts.logoBuffer : null;

  // PNG tampon: canvas if available else fallback
  let stampPng;
  try {
    if (createCanvas) {
      stampPng = await generateStampPngBuffer({ profile, logoBuffer, title });
    } else {
      stampPng = getFallbackStampPngBuffer(profile);
    }
  } catch (_) {
    stampPng = getFallbackStampPngBuffer(profile);
  }

  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const stampImg = await pdfDoc.embedPng(stampPng);

  const allPages = pdfDoc.getPages();
  if (!allPages.length) return pdfBuffer;

  const targetPages = pages === "all" ? allPages : [allPages[allPages.length - 1]];

  for (const page of targetPages) {
    const { width, height } = page.getSize();

    const pngDims = stampImg.scale(1);
    const ratio = pngDims.width / pngDims.height;

    const drawW = Number.isFinite(size) && size > 10 ? size : DEFAULT_STAMP_SIZE;
    const drawH = drawW / ratio;

    // safe zone above footer
    const safeBottomY = FOOTER_RESERVED_H + margin;
    const safeTopY = height - margin - drawH;

    let x = margin;
    let y = safeBottomY;

    if (position === "bottom-left") {
      x = margin;
      y = safeBottomY;
    }
    if (position === "bottom-right") {
      x = width - drawW - margin;
      y = safeBottomY + 25; // avoid QR collision
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
      if (y < safeBottomY) y = safeBottomY;
      if (y > safeTopY) y = safeTopY;
    }

    // clamp final
    if (x < margin) x = margin;
    if (x + drawW > width - margin) x = width - margin - drawW;

    if (y < safeBottomY) y = safeBottomY;
    if (y > safeTopY) y = safeTopY;

    page.drawImage(stampImg, { x, y, width: drawW, height: drawH, opacity });
  }

  const out = await pdfDoc.save();
  return Buffer.from(out);
}

module.exports = {
  generateStampPngBuffer,
  applyStampToPdfBuffer,
};