// kadiOcr.js
"use strict";

/**
 * OCR robuste (FR) pour WhatsApp images:
 * - prétraitement (sharp): grayscale + normalize + threshold léger
 * - tesseract.js: lang = fra (et fallback eng)
 *
 * Dépendances:
 *   npm i tesseract.js sharp
 *
 * Notes:
 * - En production Render, tesseract.js est ok (mais ça consomme CPU).
 * - Pour accélérer: réduire taille image (resize).
 */

const sharp = require("sharp");
const { createWorker } = require("tesseract.js");

async function preprocessImage(buf) {
  // On réduit et nettoie un peu l'image pour améliorer OCR
  // (trop gros = lent, trop petit = illisible)
  const img = sharp(buf, { failOnError: false });

  const meta = await img.metadata().catch(() => null);
  const width = meta?.width || 1200;

  // Resize si trop large
  const resized =
    width > 1400 ? img.resize({ width: 1400, withoutEnlargement: true }) : img;

  // Preprocess
  // - grayscale
  // - normalize
  // - threshold léger
  // - sharpen
  const out = await resized
    .grayscale()
    .normalize()
    .sharpen()
    .threshold(170)
    .toBuffer();

  return out;
}

async function runTesseract(buffer, lang) {
  const worker = await createWorker();
  try {
    await worker.loadLanguage(lang);
    await worker.initialize(lang);

    // Options utiles
    await worker.setParameters({
      tessedit_pageseg_mode: "6", // assume a uniform block of text
      preserve_interword_spaces: "1",
    });

    const result = await worker.recognize(buffer);
    const text = result?.data?.text || "";
    return text;
  } finally {
    try {
      await worker.terminate();
    } catch (_) {}
  }
}

async function ocrImageToText(imageBuffer) {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
    throw new Error("ocrImageToText: imageBuffer invalide");
  }

  // 1) preprocess
  let pre = imageBuffer;
  try {
    pre = await preprocessImage(imageBuffer);
  } catch (e) {
    // si preprocess fail, on tente OCR direct
    pre = imageBuffer;
  }

  // 2) OCR FR
  let text = "";
  try {
    text = await runTesseract(pre, "fra");
  } catch (e) {
    // 3) fallback EN
    text = await runTesseract(pre, "eng");
  }

  // Nettoyage léger
  text = String(text || "")
    .replace(/\u000c/g, "") // form feed
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

module.exports = { ocrImageToText };