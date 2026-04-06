"use strict";

const OpenAI = require("openai");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_OCR_MODEL = process.env.OPENAI_OCR_MODEL || "gpt-4o-mini";

if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY manquant");
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

async function kadiOcrEngine(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("buffer image invalide");
  }

  const base64 = buffer.toString("base64");
  const dataUrl = `data:image/jpeg;base64,${base64}`;

  console.log("[KADI OCR] GPT START");

  try {
    const res = await openai.responses.create({
      model: OPENAI_OCR_MODEL,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Lis cette image de facture/devis/reçu.",
                "Retourne uniquement le texte utile, propre et lisible.",
                "Conserve les lignes d’articles, quantités, prix unitaires, totaux, client si visible.",
                "N’invente rien.",
              ].join(" "),
            },
            {
              type: "input_image",
              image_url: dataUrl,
            },
          ],
        },
      ],
    });

    const text =
      res.output_text ||
      res.output?.map((o) => (o.content || []).map((c) => c.text || "").join("\n")).join("\n") ||
      "";

    const clean = String(text || "").trim();

    if (!clean) {
      throw new Error("OCR vide");
    }

    console.log("[KADI OCR] GPT SUCCESS", {
      length: clean.length,
      preview: clean.slice(0, 300),
    });

    return clean;
  } catch (e) {
    console.error("[KADI OCR] FAILED:", e?.message);
    throw e;
  }
}

module.exports = { kadiOcrEngine };