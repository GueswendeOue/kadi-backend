"use strict";

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
const DEFAULT_SIZE = Number(process.env.KADI_STAMP_SIZE || 220);

const BG_REMOVE_THRESHOLD = Number(process.env.KADI_LOGO_BG_THRESHOLD || 242);
const BG_REMOVE_SOFTNESS = Number(process.env.KADI_LOGO_BG_SOFTNESS || 18);

console.log("[STAMP INIT]", {
  canvasAvailable: !!createCanvas,
  loadImageAvailable: !!loadImage,
  pdfLibAvailable: !!PDFLib,
});

function safe(v) {
  return String(v || "").trim();
}

function requirePdfLib() {
  if (!PDFLib) throw new Error("pdf-lib non installé. Faites: npm i pdf-lib");
}

function removeLightBackgroundInRect(ctx, x, y, w, h, threshold = 242, softness = 18) {
  const img = ctx.getImageData(Math.max(0, x), Math.max(0, y), w, h);
  const data = img.data;

  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];

    if (a === 0) continue;

    const L = lum(r, g, b);

    if (L >= threshold) {
      data[i + 3] = 0;
      continue;
    }

    if (softness > 0 && L >= threshold - softness) {
      const t = (L - (threshold - softness)) / softness;
      const newA = Math.round(a * (1 - t));
      data[i + 3] = Math.max(0, Math.min(255, newA));
    }
  }

  ctx.putImageData(img, Math.max(0, x), Math.max(0, y));
}

async function drawCircularLogo(ctx, logoBuffer, centerX, centerY, size) {
  if (!logoBuffer || !loadImage) return;

  const img = await loadImage(logoBuffer);
  const r = size / 2;

  ctx.save();

  ctx.beginPath();
  ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  ctx.drawImage(img, centerX - r, centerY - r, size, size);

  removeLightBackgroundInRect(
    ctx,
    Math.round(centerX - r),
    Math.round(centerY - r),
    Math.round(size),
    Math.round(size),
    BG_REMOVE_THRESHOLD,
    BG_REMOVE_SOFTNESS
  );

  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = STAMP_BLUE;
  ctx.fillRect(centerX - r, centerY - r, size, size);

  ctx.restore();
}

function drawFallbackMonogram(ctx, profile, cx, cy, r) {
  const name = safe(profile?.business_name) || "E";
  const parts = name.trim().split(/\s+/);
  const mono =
    parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : name.slice(0, 2).toUpperCase();

  ctx.lineWidth = 3;
  ctx.strokeStyle = STAMP_BLUE;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r - 18, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = STAMP_BLUE;
  ctx.font = `bold ${r * 0.9}px Arial`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(mono, cx, cy);
}

function drawArcText(
  ctx,
  text,
  cx,
  cy,
  radius,
  {
    startAngle,
    endAngle,
    minFont = 18,
    maxFont = 40,
    fontFamily = "Arial",
    fontWeight = "bold",
    clockwise = true,
  } = {}
) {
  const raw = String(text || "").trim();
  if (!raw) return;

  const chars = raw.split("");
  if (!chars.length) return;

  const totalArc = Math.abs(endAngle - startAngle);

  // Ajuste la taille de police selon la longueur
  let fontSize = maxFont;

  for (; fontSize >= minFont; fontSize--) {
    ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;

    const totalWidth = chars.reduce((sum, ch) => {
      return sum + ctx.measureText(ch).width;
    }, 0);

    // Approximation largeur -> angle sur cercle
    const estimatedArc = totalWidth / radius;

    if (estimatedArc <= totalArc * 0.9) {
      break;
    }
  }

  if (fontSize < minFont) {
    fontSize = minFont;
  }

  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.fillStyle = STAMP_BLUE;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const charWidths = chars.map((ch) => ctx.measureText(ch).width);
  const totalWidth = charWidths.reduce((a, b) => a + b, 0);
  const totalTextArc = totalWidth / radius;

  const arcDirection = clockwise ? 1 : -1;
  const midAngle = (startAngle + endAngle) / 2;

  let currentAngle = midAngle - arcDirection * (totalTextArc / 2);

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const chArc = charWidths[i] / radius;
    currentAngle += arcDirection * (chArc / 2);

    const x = cx + Math.cos(currentAngle) * radius;
    const y = cy + Math.sin(currentAngle) * radius;

    ctx.save();
    ctx.translate(x, y);

    if (clockwise) {
      ctx.rotate(currentAngle + Math.PI / 2);
    } else {
      ctx.rotate(currentAngle - Math.PI / 2);
    }

    ctx.fillText(ch, 0, 0);
    ctx.restore();

    currentAngle += arcDirection * (chArc / 2);
  }
}

async function generateStampPngBuffer({ profile, logoBuffer = null }) {
  if (!createCanvas) throw new Error("canvas non dispo");

  const size = 900;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  ctx.clearRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2;

  const R_OUTER = 290;
  const R_INNER = 242;
  const TEXT_RADIUS = 266;
  const LOGO_SIZE = 340;

  const business = safe(profile?.business_name).toUpperCase();
  const title = safe(profile?.stamp_title).toUpperCase();
  const docId = safe(profile?.doc_id || profile?.docId);
  const phone = safe(profile?.phone).replace(/\s+/g, "");

  ctx.strokeStyle = STAMP_BLUE;
  ctx.fillStyle = STAMP_BLUE;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Cercle externe
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.arc(cx, cy, R_OUTER, 0, Math.PI * 2);
  ctx.stroke();

  // Cercle interne
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(cx, cy, R_INNER, 0, Math.PI * 2);
  ctx.stroke();

  // ===== NOM ENTREPRISE SUR PRESQUE TOUT LE CERCLE =====
  if (business) {
    const text = business;

    // petite ouverture en bas réservée à l'équilibre visuel
    const gapStart = Math.PI * 0.40;
    const gapEnd = Math.PI * 0.60;

    const startAngle = gapEnd;
    const endAngle = gapStart + Math.PI * 2;
    const availableArc = endAngle - startAngle;

    let fontSize = 36;
    const minFont = 16;

    for (; fontSize >= minFont; fontSize--) {
      ctx.font = `bold ${fontSize}px Arial`;

      const totalWidth = text.split("").reduce((sum, ch) => {
        return sum + ctx.measureText(ch).width;
      }, 0);

      const estimatedArc = totalWidth / TEXT_RADIUS;
      if (estimatedArc <= availableArc * 0.92) {
        break;
      }
    }

    if (fontSize < minFont) fontSize = minFont;

    ctx.font = `bold ${fontSize}px Arial`;

    const chars = text.split("");
    const widths = chars.map((ch) => ctx.measureText(ch).width);
    const totalWidth = widths.reduce((a, b) => a + b, 0);
    const totalArc = totalWidth / TEXT_RADIUS;

    let angle = startAngle + (availableArc - totalArc) / 2;

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const chArc = widths[i] / TEXT_RADIUS;
      angle += chArc / 2;

      const x = cx + Math.cos(angle) * TEXT_RADIUS;
      const y = cy + Math.sin(angle) * TEXT_RADIUS;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle + Math.PI / 2);
      ctx.fillText(ch, 0, 0);
      ctx.restore();

      angle += chArc / 2;
    }
  }

  // ===== LOGO AU CENTRE =====
  if (logoBuffer && loadImage) {
    try {
      await drawCircularLogo(ctx, logoBuffer, cx, cy - 18, LOGO_SIZE);
    } catch (err) {
      console.warn("[STAMP] logo failed:", err?.message);
      drawFallbackMonogram(ctx, profile, cx, cy - 18, 132);
    }
  } else {
    drawFallbackMonogram(ctx, profile, cx, cy - 18, 132);
  }

  // ===== FONCTION =====
  if (title) {
    ctx.fillStyle = STAMP_BLUE;
    ctx.font = title.length > 18 ? "bold 32px Arial" : "bold 40px Arial";
    ctx.fillText(title, cx, cy + 110);
  }

  // ===== DOC ID =====
  if (docId) {
    ctx.fillStyle = STAMP_BLUE;
    ctx.font = "bold 28px Arial";
    ctx.fillText(`ID: ${docId}`, cx, cy + 150);
  }

  // ===== PHONE =====
  if (phone) {
    ctx.fillStyle = STAMP_BLUE;
    ctx.font = "bold 34px Arial";
    ctx.fillText(phone, cx, cy + 192);
  }

  return canvas.toBuffer("image/png");
}

function getUploadedStampPngBuffer(profile) {
  const p = safe(profile?.stamp_image_path);
  if (!p) return null;

  const resolved = path.isAbsolute(p) ? p : path.resolve(p);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Uploaded stamp PNG not found: ${resolved}`);
  }

  return fs.readFileSync(resolved);
}

function getDefaultFallbackStampPngBuffer() {
  const defaultPath = path.join(__dirname, "assets", "stamp.png");
  if (!fs.existsSync(defaultPath)) {
    throw new Error(`Fallback stamp PNG not found: ${defaultPath}`);
  }
  return fs.readFileSync(defaultPath);
}

async function resolveStampPngBuffer({ profile, logoBuffer = null, stampBuffer = null }) {
  if (stampBuffer && Buffer.isBuffer(stampBuffer)) {
    console.log("[STAMP APPLY] using opts.stampBuffer");
    return stampBuffer;
  }

  if (profile?.stamp_image_path) {
    console.log("[STAMP APPLY] using uploaded stamp image");
    return getUploadedStampPngBuffer(profile);
  }

  try {
    if (!createCanvas) {
      throw new Error("canvas non disponible");
    }

    console.log("[STAMP APPLY] generating dynamic stamp");
    return await generateStampPngBuffer({ profile, logoBuffer });
  } catch (err) {
    console.warn("[STAMP APPLY] dynamic generation failed:", err?.message);
  }

  console.log("[STAMP APPLY] using default fallback stamp.png");
  return getDefaultFallbackStampPngBuffer();
}

async function applyStampToPdfBuffer(pdfBuffer, profile, opts = {}) {
  requirePdfLib();

  if (!Buffer.isBuffer(pdfBuffer)) {
    throw new Error("applyStampToPdfBuffer: pdfBuffer doit être un Buffer");
  }

  console.log("[STAMP APPLY INPUT]", {
    stamp_enabled: profile?.stamp_enabled,
    stamp_paid: profile?.stamp_paid,
    stamp_title: profile?.stamp_title || null,
    stamp_image_path: profile?.stamp_image_path || null,
    stamp_position: profile?.stamp_position || null,
    stamp_size: profile?.stamp_size || null,
    stamp_opacity: profile?.stamp_opacity || null,
  });

  if (profile?.stamp_enabled !== true) {
    console.log("[STAMP APPLY] skipped: stamp_enabled !== true");
    return pdfBuffer;
  }

  if (
    Object.prototype.hasOwnProperty.call(profile || {}, "stamp_paid") &&
    profile?.stamp_paid !== true
  ) {
    console.log("[STAMP APPLY] skipped: stamp_paid !== true");
    return pdfBuffer;
  }

  const { PDFDocument } = PDFLib;

  const size = Number(opts.size || profile?.stamp_size || DEFAULT_SIZE);
  const position = String(opts.position || profile?.stamp_position || "bottom-right");
  const opacity = Math.max(
    0,
    Math.min(1, Number(opts.opacity ?? (profile?.stamp_opacity ?? 0.76)))
  );
  const margin = Number(opts.margin || DEFAULT_MARGIN);
  const pages = String(opts.pages || profile?.stamp_pages || "last");
  const logoBuffer =
    opts.logoBuffer && Buffer.isBuffer(opts.logoBuffer) ? opts.logoBuffer : null;
  const stampBuffer =
    opts.stampBuffer && Buffer.isBuffer(opts.stampBuffer) ? opts.stampBuffer : null;

  const stampPng = await resolveStampPngBuffer({
    profile,
    logoBuffer,
    stampBuffer,
  });

  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const stampImg = await pdfDoc.embedPng(stampPng);

  const allPages = pdfDoc.getPages();
  if (!allPages.length) return pdfBuffer;

  const targetPages = pages === "all" ? allPages : [allPages[allPages.length - 1]];

  for (const page of targetPages) {
    const { width, height } = page.getSize();

    const pngDims = stampImg.scale(1);
    const ratio = pngDims.width / pngDims.height;

    const drawW = Number.isFinite(size) && size > 10 ? size : DEFAULT_SIZE;
    const drawH = drawW / ratio;

    const safeBottomY = FOOTER_RESERVED_H + margin;
    const safeTopY = height - margin - drawH;

    let x = margin;
    let y = safeBottomY;

    if (position === "bottom-left") {
      x = margin;
      y = safeBottomY;
    } else if (position === "bottom-right") {
      x = width - drawW - margin - 12;
      y = safeBottomY + 82;
      if (y > safeTopY) y = safeTopY;
    } else if (position === "top-left") {
      x = margin;
      y = safeTopY;
    } else if (position === "top-right") {
      x = width - drawW - margin;
      y = safeTopY;
    } else if (position === "center") {
      x = (width - drawW) / 2;
      y = (height - drawH) / 2;
      if (y < safeBottomY) y = safeBottomY;
      if (y > safeTopY) y = safeTopY;
    }

    if (x < margin) x = margin;
    if (x + drawW > width - margin) x = width - margin - drawW;
    if (y < safeBottomY) y = safeBottomY;
    if (y > safeTopY) y = safeTopY;

    console.log("[STAMP DRAW]", {
      pageWidth: width,
      pageHeight: height,
      drawW,
      drawH,
      x,
      y,
      position,
      opacity,
    });

    page.drawImage(stampImg, {
      x,
      y,
      width: drawW,
      height: drawH,
      opacity,
    });
  }

  const out = await pdfDoc.save();
  console.log("[STAMP APPLY] done");
  return Buffer.from(out);
}

module.exports = {
  generateStampPngBuffer,
  applyStampToPdfBuffer,
};