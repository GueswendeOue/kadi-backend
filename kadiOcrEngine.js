"use strict";

const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function kadiOcrEngine(buffer) {
  console.log("[KADI OCR] GPT START");

  const base64 = buffer.toString("base64");

  try {
    const res = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `
Tu es KADI.

Analyse cette image (facture, devis, reçu).

Retourne uniquement JSON :

{
  "docType": "devis | facture | recu",
  "client": "",
  "items": [
    { "label": "", "qty": 1, "unitPrice": 0 }
  ],
  "total": 0
}

Règles :
- FCFA
- corrige erreurs OCR
- comprend "25 mille" = 25000
- comprend "5 barres" = 5000
- pas de texte hors JSON
              `,
            },
            {
              type: "input_image",
              image_base64: base64,
            },
          ],
        },
      ],
    });

    const text = res.output[0]?.content[0]?.text || "";

    if (!text.includes("{")) {
      throw new Error("Invalid GPT OCR");
    }

    console.log("[KADI OCR] SUCCESS");

    return text;
  } catch (e) {
    console.error("[KADI OCR] FAILED:", e.message);
    throw e;
  }
}

module.exports = { kadiOcrEngine };