"use strict";

/**
 * kadiOcr.js
 *
 * OCR hybride robuste pour KADI :
 * 1) Google Cloud Vision en priorité
 * 2) Tesseract en fallback si Google échoue ou retourne vide
 *
 * Dépendances :
 *   npm i @google-cloud/vision tesseract.js sharp
 *
 * Modes supportés :
 * - Local : fichier kadi-ocr.json
 * - Render : GOOGLE_OCR_JSON_BASE64 ou GOOGLE_OCR_JSON
 */

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const vision = require("@google-cloud/vision");
const { createWorker } = require("tesseract.js");

// ================= Config =================
const GOOGLE_KEY_PATH =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  path.join(__dirname, "kadi-ocr.json");

// ================= Google Vision =================
let googleClient = null;

function getGoogleCredentialsFromEnv() {
  try {
    if (process.env.GOOGLE_OCR_JSON_BASE64) {
      const raw = Buffer.from(
        process.env.GOOGLE_OCR_JSON_BASE64,
        "base64"
      ).toString("utf8");
      return JSON.parse(raw);
    }

    if (process.env.GOOGLE_OCR_JSON) {
      return JSON.parse(process.env.GOOGLE_OCR_JSON);
    }

    return null;
  } catch (e) {
    throw new Error(`Invalid Google OCR credentials in env: ${e.message}`);
  }
}

function getGoogleClient() {
  if (googleClient) return googleClient;

  const envCreds = getGoogleCredentialsFromEnv();
  if (envCreds) {
    googleClient = new vision.ImageAnnotatorClient({
      credentials: envCreds,
    });
    return googleClient;
  }

  if (!fs.existsSync(GOOGLE_KEY_PATH)) {
    throw new Error(`Google OCR key file not found: ${GOOGLE_KEY_PATH}`);
  }

  googleClient = new vision.ImageAnnotatorClient({
    keyFilename: GOOGLE_KEY_PATH,
  });

  return googleClient;
}

// ================= Preprocess =================
async function preprocessImage(buf) {
  const img = sharp(buf, { failOnError: false });
  const meta = await img.metadata().catch(() => null);
  const width = meta?.width || 1200;

  const resized =
    width > 1400 ? img.resize({ width: 1400, withoutEnlargement: true }) : img;

  return resized
    .grayscale()
    .normalize()
    .sharpen()
    .threshold(170)
    .toBuffer();
}

// ================= Tesseract singleton =================
let _worker = null;
let _workerLang = null;
let _lock = Promise.resolve();

async function getWorker(lang) {
  if (_worker && _workerLang === lang) return _worker;

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
    tessedit_pageseg_mode: "6",
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

// ================= Utils =================
function cleanText(text) {
  return String(text || "")
    .replace(/\u000c/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksUseful(text) {
  const t = cleanText(text);
  if (!t) return false;
  if (t.length < 3) return false;

  const lettersOrDigits = (t.match(/[a-z0-9]/gi) || []).length;
  if (lettersOrDigits < 2) return false;

  return true;
}

// ================= Google OCR =================
async function recognizeWithGoogle(buffer) {
  const client = getGoogleClient();

  const [result] = await client.textDetection({
    image: { content: buffer },
  });

  const annotations = result?.textAnnotations || [];
  if (!annotations.length) return "";

  return annotations[0]?.description || "";
}

// ================= Public API =================
async function ocrImageToText(imageBuffer) {
  console.log("[KADI/OCR] START");

  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
    throw new Error("ocrImageToText: imageBuffer invalide");
  }

  let pre = imageBuffer;
  try {
    pre = await preprocessImage(imageBuffer);
    console.log("[KADI/OCR] preprocess ok");
  } catch (e) {
    console.warn(
      "[KADI/OCR] preprocess failed, using original buffer:",
      e?.message
    );
    pre = imageBuffer;
  }

  // 1) Google Vision d'abord
  try {
    console.log("[KADI/OCR] Trying Google Vision...");
    console.log("[KADI/OCR] Google key path fallback:", GOOGLE_KEY_PATH);
    console.log(
      "[KADI/OCR] Google env creds:",
      !!process.env.GOOGLE_OCR_JSON_BASE64 || !!process.env.GOOGLE_OCR_JSON
    );

    const googleText = cleanText(await recognizeWithGoogle(pre));

    console.log("[KADI/OCR] Google OCR length:", googleText.length);
    console.log("[KADI/OCR] Google OCR preview:", googleText.slice(0, 300));

    if (looksUseful(googleText)) {
      console.log("[KADI/OCR] Google OCR accepted");
      return googleText;
    }

    console.warn(
      "[KADI/OCR] Google OCR returned weak/empty text, fallback to Tesseract"
    );
  } catch (e) {
    console.error("[KADI/OCR] Google OCR failed:", e?.message);
    console.error("[KADI/OCR] Google OCR stack:", e?.stack || "no stack");
  }

  // 2) Tesseract fallback
  _lock = _lock.then(async () => {
    try {
      console.log("[KADI/OCR] Trying Tesseract FRA...");
      let txt = "";

      try {
        txt = await recognizeWithLang(pre, "fra");
        txt = cleanText(txt);

        console.log("[KADI/OCR] Tesseract FRA preview:", txt.slice(0, 300));

        if (looksUseful(txt)) {
          console.log("[KADI/OCR] Tesseract FRA accepted");
          return txt;
        }

        console.warn(
          "[KADI/OCR] Tesseract FRA weak/empty, trying ENG..."
        );
      } catch (e) {
        console.warn("[KADI/OCR] Tesseract FRA failed:", e?.message);
      }

      txt = await recognizeWithLang(pre, "eng");
      txt = cleanText(txt);

      console.log("[KADI/OCR] Tesseract ENG length:", txt.length);
      console.log("[KADI/OCR] Tesseract ENG preview:", txt.slice(0, 300));

      return txt;
    } catch (e) {
      try {
        if (_worker) await _worker.terminate();
      } catch (_) {}

      _worker = null;
      _workerLang = null;

      console.error("[KADI/OCR] Tesseract fatal error:", e?.message);
      throw e;
    }
  });

  return _lock;
}

module.exports = { ocrImageToText };