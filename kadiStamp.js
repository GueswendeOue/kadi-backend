"use strict";

/**
 * kadiStamp.js — Render safe (UPDATED PRO)
 * - Canvas available: generate circular stamp PNG dynamically
 * - Canvas NOT available: fallback to ./assets/stamp.png
 * - Apply stamp with pdf-lib on LAST page by default
 *
 * ✅ PRO UPDATES:
 * - Accept opts.logoBuffer (Buffer)
 * - Auto-remove white/light background from logo (so PNG transparent not required)
 * - Tint logo to STAMP_BLUE
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
  PDFLib = require("pdf-lib"));
} catch (e) {
  PDFLib = null;
}

const STAMP_BLUE = process.env.KADI_STAMP_COLOR || "#0B57D0";
const FOOTER_RESERVED_H = Number(process.env.KADI_PDF_FOOTER_H || 85);
const DEFAULT_MARGIN = Number(process.env.KADI_STAMP_MARGIN || 18);

// 🎯 background removal tuning
const BG_REMOVE_THRESHOLD = Number(process.env.KADI_LOGO_BG_THRESHOLD || 242); // 0..255
const BG_REMOVE_SOFTNESS = Number(process.env.KADI_LOGO_BG_SOFTNESS || 18);    // 0..60

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
 * Removes near-white background pixels by setting alpha based on threshold.
 * - threshold ~242 = remove very bright pixels
 * - softness adds fade around threshold to avoid harsh edges
 */
function removeLightBackgroundInRect(ctx, x, y, w, h, threshold = 242, softness = 18) {
  const img = ctx.getImageData(Math.max(0, x), Math.max(0, y), w, h);
  const data = img.data;

  // helper: luminance
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];

    if (a === 0) continue;

    const L = lum(r, g, b);

    // Fully remove above threshold
    if (L >= threshold) {
      data[i + 3] = 0;
      continue;
    }

    // Soft fade zone: threshold-softness -> threshold
    if (softness > 0 && L >= threshold - softness) {
      const t = (L - (threshold - softness)) / softness; // 0..1
      // reduce alpha gradually
      const newA = Math.round(a * (1 - t));
      data[i + 3] = Math.max(0, Math.min(255, newA));
    }
  }

  ctx.putImageData(img, Math.max(0, x), Math.max(0, y));
}

/**
 * Draw logo then:
 * - remove light background (so JPG ok)
 * - tint to STAMP_BLUE using source-in
 */
async function drawTintedLogo(ctx, logoBuffer, x, y, w, h, opts = {}) {
  if (!logoBuffer || !loadImage) return;

  const img = await loadImage(logoBuffer);

  ctx.save();

  // draw raw logo
  ctx.drawImage(img, x, y, w, h);

  // remove near-white bg in the logo box (auto-transparency)
  removeLightBackgroundInRect(
    ctx,
    Math.round(x),
    Math.round(y),
    Math.round(w),
    Math.round(h),
    Number(opts.threshold ?? BG_REMOVE_THRESHOLD),
    Number(opts.softness ?? BG_REMOVE_SOFTNESS)
  );

  // tint to stamp color using the logo alpha as mask
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = STAMP_BLUE;
  ctx.fillRect(x, y, w, h);

  // reset composite
  ctx.restore();
}

async function generateStampPngBuffer({ profile, logoBuffer = null, title = null }) {
  if (!createCanvas) throw new Error("canvas non dispo");

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

  // top arc
  ctx.save();
  ctx.translate(center, center);
  ctx.font = "bold 32px Arial";
  drawCircularText(ctx, name.toUpperCase(), 0, -205, 2.2);
  ctx.restore();

  // bottom arc
  const bottom = [idLine, phoneLine].filter(Boolean).join(" • ");
  if (bottom) {
    ctx.save();
    ctx.translate(center, center);
    ctx.font = "bold 22px Arial";
    drawCircularText(ctx, bottom.toUpperCase(), Math.PI, -205, 2.0, true);
    ctx.restore();
  }

  // center block
  ctx.save();
  ctx.translate(center, center);

  // ✅ Logo centered + auto-transparent + tinted BLUE
  if (logoBuffer) {
    try {
      const logoSize = 140; // a bit bigger than before
      const lx = -logoSize / 2;
      const ly = -logoSize / 2 - 40;

      await drawTintedLogo(ctx, logoBuffer, lx, ly, logoSize, logoSize);
    } catch (_) {}
  }

  // ✅ Replace "TAMPON" by the function/title (no word "TAMPON" on final)
  const centerTitle = safe(title) || safe(profile?.stamp_title) || "—";
  ctx.font = "bold 34px Arial";
  ctx.textAlign = "center";
  ctx.fillStyle = STAMP_BLUE;
  ctx.fillText(truncate(centerTitle.toUpperCase(), 18), 0, 48);

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

  // ✅ Safety for Model B (one-time paid stamp): if field exists and not paid => skip
  if (Object.prototype.hasOwnProperty.call(profile || {}, "stamp_paid") && profile?.stamp_paid !== true) {
    return pdfBuffer;
  }

  const { PDFDocument } = PDFLib;

  const size = Number(opts.size || profile?.stamp_size || process.env.KADI_STAMP_SIZE || 170);
  const position = String(opts.position || profile?.stamp_position || "bottom-right");
  const opacity = Math.max(0, Math.min(1, Number(opts.opacity ?? (profile?.stamp_opacity ?? 0.9))));
  const margin = Number(opts.margin || DEFAULT_MARGIN);

  // ✅ last page by default
  const pages = String(opts.pages || profile?.stamp_pages || "last");
  const title = opts.title || null;
  const logoBuffer = opts.logoBuffer && Buffer.isBuffer(opts.logoBuffer) ? opts.logoBuffer : null;

  // PNG stamp: canvas if available else fallback
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

    const drawW = Number.isFinite(size) && size > 10 ? size : 170;
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