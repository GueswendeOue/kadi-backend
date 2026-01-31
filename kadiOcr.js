// kadiOcr.js
"use strict";

/**
 * OCR via Tesseract
 * Dépendance: npm i node-tesseract-ocr
 * Optionnel: installer tesseract dans l'OS (selon l'hébergeur)
 */

let tesseract;
try {
  tesseract = require("node-tesseract-ocr");
} catch (e) {
  tesseract = null;
}

function normalizeOcrText(s) {
  return String(s || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function ocrImageBuffer(buffer, lang = "fra") {
  if (!tesseract) {
    throw new Error("Tesseract non installé. Faites: npm i node-tesseract-ocr");
  }
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error("buffer invalide");
  }

  // config OCR: lisible + robuste
  const config = {
    lang, // "fra" ou "eng+fra"
    oem: 1,
    psm: 6, // bloc de texte uniforme
  };

  const text = await tesseract.recognize(buffer, config);
  return normalizeOcrText(text);
}

module.exports = { ocrImageBuffer, normalizeOcrText };