"use strict";

let GeminiGenAI = null;
try {
  GeminiGenAI = require("@google/generative-ai").GoogleGenerativeAI;
} catch (_) {
  // ok
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const OCR_HYBRID = (process.env.OCR_HYBRID || "1") === "1"; // 1 = fallback ON

const OCR_GEMINI_MIN_CHARS = Number(process.env.OCR_GEMINI_MIN_CHARS || 20);
const OCR_GEMINI_MIN_DIGITS = Number(process.env.OCR_GEMINI_MIN_DIGITS || 3);

const _geminiClient =
  GEMINI_API_KEY && GeminiGenAI ? new GeminiGenAI(GEMINI_API_KEY) : null;

function geminiIsEnabled() {
  return !!_geminiClient && OCR_HYBRID;
}

function ocrLooksGood(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (t.length < OCR_GEMINI_MIN_CHARS) return false;

  const digits = (t.match(/\d/g) || []).length;
  if (digits < OCR_GEMINI_MIN_DIGITS) return false;

  const lettersOrDigits = (t.match(/[a-z0-9]/gi) || []).length;
  const ratio = lettersOrDigits / Math.max(1, t.length);
  if (ratio < 0.25) return false;

  return true;
}

async function geminiOcrImageBuffer(imageBuffer, mimeType = "image/jpeg") {
  if (!_geminiClient) throw new Error("Gemini not configured");

  const model = _geminiClient.getGenerativeModel({ model: GEMINI_MODEL });

  const prompt =
    "Tu es un OCR. Extrait tout le texte visible de l'image, en conservant les lignes.\n" +
    "Ne commente pas. Ne reformule pas. Retourne UNIQUEMENT le texte extrait.";

  const result = await model.generateContent([
    { text: prompt },
    {
      inlineData: {
        mimeType: mimeType || "image/jpeg",
        data: Buffer.isBuffer(imageBuffer) ? imageBuffer.toString("base64") : Buffer.from(imageBuffer).toString("base64"),
      },
    },
  ]);

  const text = result?.response?.text?.() || "";
  return String(text).trim();
}

module.exports = {
  geminiIsEnabled,
  ocrLooksGood,
  geminiOcrImageBuffer,
};