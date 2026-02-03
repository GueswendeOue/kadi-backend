// kadiStamp.js
"use strict";

/**
 * Tampon circulaire BLEU (PNG) à partir du profil.
 * - Dépendance: npm i canvas
 * - Export: generateStampPngBuffer({ profile, logoBuffer?, title? })
 *   - title (optionnel): texte au centre (ex: "GERANT", "DIRECTEUR")
 *
 * Notes:
 * - Couleur: bleu officiel (#0B57D0)
 * - Fond transparent
 */

let createCanvas, loadImage;
try {
  ({ createCanvas, loadImage } = require("canvas"));
} catch (e) {
  createCanvas = null;
  loadImage = null;
}

const STAMP_BLUE = process.env.KADI_STAMP_COLOR || "#0B57D0";

function safe(v) {
  return String(v || "").trim();
}

function requireCanvas() {
  if (!createCanvas) {
    throw new Error("canvas non installé. Faites: npm i canvas");
  }
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
  const radius = Math.abs(radiusOffset);
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
 * @param {Object} params
 * @param {Object} params.profile business profile
 * @param {Buffer|null} params.logoBuffer optionnel
 * @param {string|null} params.title texte au centre (ex "GERANT", "DIRECTEUR")
 * @returns {Promise<Buffer>} PNG Buffer
 */
async function generateStampPngBuffer({ profile, logoBuffer = null, title = null }) {
  requireCanvas();

  const size = 520;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  // fond transparent
  ctx.clearRect(0, 0, size, size);

  const center = size / 2;
  const outerR = 240;
  const innerR = 185;

  // style bleu
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

  // texte
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
    } catch (_) {
      // ignore logo error
    }
  }

  // titre au centre
  const centerTitle = safe(title) || safe(profile?.stamp_title) || "TAMPON";
  ctx.font = "bold 34px Arial";
  ctx.textAlign = "center";
  ctx.fillText(truncate(centerTitle.toUpperCase(), 18), 0, 40);

  // adresse (optionnel)
  if (addr) {
    ctx.font = "bold 18px Arial";
    ctx.textAlign = "center";
    ctx.fillText(truncate(addr.toUpperCase(), 34), 0, 130);
  }

  ctx.restore();

  return canvas.toBuffer("image/png");
}

module.exports = { generateStampPngBuffer };