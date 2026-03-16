"use strict";

let GeminiGenAI = null;
try {
  GeminiGenAI = require("@google/generative-ai").GoogleGenerativeAI;
} catch (_) {
  // ok
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
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
        data: Buffer.isBuffer(imageBuffer)
          ? imageBuffer.toString("base64")
          : Buffer.from(imageBuffer).toString("base64"),
      },
    },
  ]);

  const text = result?.response?.text?.() || "";
  return String(text).trim();
}

async function parseInvoiceTextWithGemini(ocrText) {
  if (!_geminiClient) throw new Error("Gemini not configured");

  const model = _geminiClient.getGenerativeModel({ model: GEMINI_MODEL });

  const prompt = `
Tu es un assistant spécialisé dans la compréhension de factures, devis, reçus et notes manuscrites africaines.

On te donne un texte OCR brut, parfois imparfait, mal aligné, bruité ou avec fautes.

Ta mission :
- reconstruire les lignes de produits
- détecter quantité, prix unitaire et montant
- détecter le total
- détecter le client si présent
- détecter la date si présente
- deviner le type de document : facture, devis, recu, ou inconnu

Règles :
- retourne UNIQUEMENT un JSON valide
- pas de markdown
- pas d'explication
- si une valeur est inconnue, mets null
- si amount manque, calcule qty * unitPrice si possible
- si qty manque, mets 1
- si unitPrice manque mais amount existe, mets unitPrice = amount
- garde les noms de produits les plus plausibles

Format attendu :
{
  "client": string|null,
  "date": string|null,
  "documentType": "facture"|"devis"|"recu"|"inconnu",
  "items": [
    {
      "label": string,
      "qty": number,
      "unitPrice": number,
      "amount": number
    }
  ],
  "total": number|null
}

Texte OCR :
${ocrText}
`;

  const result = await model.generateContent(prompt);
  const raw = result?.response?.text?.() || "";

  let cleaned = String(raw).trim();
  cleaned = cleaned.replace(/^```json\s*/i, "").replace(/^```\s*/i, "");
  cleaned = cleaned.replace(/```$/i, "").trim();

  return JSON.parse(cleaned);
}

module.exports = {
  geminiIsEnabled,
  ocrLooksGood,
  geminiOcrImageBuffer,
  parseInvoiceTextWithGemini,
};