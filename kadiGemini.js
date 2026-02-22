// kadiGemini.js
"use strict";

const { GoogleGenerativeAI } = require("@google/generative-ai");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.warn("⚠️ GEMINI_API_KEY manquant");
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// modèle vision
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
});

async function extractInvoiceFromImage(buffer) {
  const imagePart = {
    inlineData: {
      data: buffer.toString("base64"),
      mimeType: "image/jpeg", // WhatsApp image
    },
  };

  const prompt = `
Analyse cette image de facture / devis / reçu.

Retourne uniquement un JSON valide avec cette structure:

{
  "doc_type": "facture | devis | recu",
  "client": "",
  "date": "",
  "items": [
    {
      "label": "",
      "qty": 1,
      "unit_price": 0,
      "total": 0
    }
  ],
  "total": 0
}

Si une valeur est inconnue, mets null.
Ne retourne rien d'autre que le JSON.
`;

  const result = await model.generateContent([prompt, imagePart]);
  const response = result.response.text();

  // Nettoyage si Gemini met du markdown
  const cleaned = response.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Gemini JSON parse error");
  }
}

module.exports = { extractInvoiceFromImage };