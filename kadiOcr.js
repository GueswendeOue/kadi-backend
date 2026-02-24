// kadiOcr.js
"use strict";

/**
 * OCR robuste (FR) pour WhatsApp images:
 * - prétraitement (sharp): grayscale + normalize + threshold léger
 * - tesseract.js: fra (fallback eng)
 *
 * ✅ Optim Render:
 * - Worker singleton (réutilisé) pour éviter un worker par requête
 * - Lock anti-concurrence (un OCR à la fois par worker)
 *
 * Dépendances:
 *   npm i tesseract.js sharp
 */

const sharp = require("sharp");
const { createWorker } = require("tesseract.js");

async function preprocessImage(buf) {
  const img = sharp(buf, { failOnError: false });
  const meta = await img.metadata().catch(() => null);
  const width = meta?.width || 1200;

  const resized = width > 1400 ? img.resize({ width: 1400, withoutEnlargement: true }) : img;

  return resized
    .grayscale()
    .normalize()
    .sharpen()
    .threshold(170)
    .toBuffer();
}

// ---------------- Worker singleton ----------------
let _worker = null;
let _workerLang = null; // "fra" ou "eng"
let _lock = Promise.resolve(); // serialize OCR calls

async function getWorker(lang) {
  if (_worker && _workerLang === lang) return _worker;

  // si worker existe mais mauvaise langue => on le ferme proprement
  if (_worker) {
    try {
      await _worker.terminate();
    } catch (_) {}
    _worker = null;
    _workerLang = null;
  }

  const w = await createWorker();
  await w.loadLanguage(lang);
  await w.initialize(lang);

  await w.setParameters({
    tessedit_pageseg_mode: "6", // bloc de texte uniforme
    preserve_interword_spaces: "1",
  });

  _worker = w;
  _workerLang = lang;
  return _worker;
}

async function recognizeWithLang(buffer, lang) {
  const w = await getWorker(lang);
  const result = await w.recognize(buffer);
  return result?.data?.text || "";
}

function cleanText(text) {
  return String(text || "")
    .replace(/\u000c/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------- Public API ----------------
async function ocrImageToText(imageBuffer) {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
    throw new Error("ocrImageToText: imageBuffer invalide");
  }

  // Preprocess (best effort)
  let pre = imageBuffer;
  try {
    pre = await preprocessImage(imageBuffer);
  } catch (_) {
    pre = imageBuffer;
  }

  // ✅ Lock: sérialise les OCR pour éviter collisions (Render stable)
  _lock = _lock.then(async () => {
    try {
      // 1) FRA
      let txt = "";
      try {
        txt = await recognizeWithLang(pre, "fra");
      } catch (_) {
        // 2) fallback ENG
        txt = await recognizeWithLang(pre, "eng");
      }
      return cleanText(txt);
    } catch (e) {
      // reset worker si problème interne
      try {
        if (_worker) await _worker.terminate();
      } catch (_) {}
      _worker = null;
      _workerLang = null;
      throw e;
    }
  });

  return _lock;
}

module.exports = { ocrImageToText };