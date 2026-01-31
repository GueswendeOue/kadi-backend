// kadiStamp.js
"use strict";

/**
 * Génération d'un tampon numérique (PNG) à partir du profil.
 * Dépendance: npm i canvas
 */

let createCanvas, loadImage;
try {
  ({ createCanvas, loadImage } = require("canvas"));
} catch (e) {
  createCanvas = null;
  loadImage = null;
}

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

function makeStampTextLines(profile) {
  const name = safe(profile?.business_name) || "ENTREPRISE";
  const ifu = safe(profile?.ifu);
  const rccm = safe(profile?.rccm);
  const phone = normalizePhone(profile?.phone);

  const idLine = ifu ? `IFU: ${ifu}` : rccm ? `RCCM: ${rccm}` : "";
  const phoneLine = phone ? `Tél: ${phone}` : "";
  const addr = safe(profile?.address);

  return {
    name,
    idLine,
    phoneLine,
    addr,
  };
}

/**
 * Retourne Buffer PNG
 * @param {*} params.profile business profile
 * @param {*} params.logoBuffer optionnel
 */
async function generateStampPngBuffer({ profile, logoBuffer = null }) {
  requireCanvas();

  const size = 520;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  // fond transparent
  ctx.clearRect(0, 0, size, size);

  const center = size / 2;
  const outerR = 240;
  const innerR = 185;

  // style
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 10;

  // cercle extérieur
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
  ctx.fillStyle = "#000";
  drawCircularText(ctx, name.toUpperCase(), 0, -205, 2.2);
  ctx.restore();

  // texte bas (circulaire)
  const bottom = [idLine, phoneLine].filter(Boolean).join(" • ");
  if (bottom) {
    ctx.save();
    ctx.translate(center, center);
    ctx.font = "bold 24px Arial";
    drawCircularText(ctx, bottom.toUpperCase(), Math.PI, -205, 2.1, true);
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
      ctx.drawImage(img, -logoSize / 2, -logoSize / 2 - 10, logoSize, logoSize);
    } catch (_) {}
  }

  // adresse (optionnel)
  if (addr) {
    ctx.font = "bold 18px Arial";
    ctx.textAlign = "center";
    ctx.fillText(truncate(addr, 34), 0, 130);
  }

  // "OFFICIEL" au milieu
  ctx.font = "bold 34px Arial";
  ctx.textAlign = "center";
  ctx.fillText("TAMPON", 0, 40);

  ctx.restore();

  return canvas.toBuffer("image/png");
}

// ---- helpers ----

function truncate(s, max) {
  const x = safe(s);
  if (x.length <= max) return x;
  return x.slice(0, max - 1) + "…";
}

/**
 * Dessine un texte en arc.
 * @param {*} ctx
 * @param {*} text
 * @param {*} startAngle
 * @param {*} radiusOffset
 * @param {*} spacingCoef
 * @param {*} reverse
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

module.exports = { generateStampPngBuffer };