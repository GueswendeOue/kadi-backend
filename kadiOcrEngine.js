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

function safeNumber(value) {
  if (value == null) return null;
  const s = String(value).replace(/[^\d]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function buildNormalizedText(data = {}) {
  const lines = [];

  if (data.docType) lines.push(`TYPE: ${data.docType}`);
  if (data.client) lines.push(`CLIENT: ${data.client}`);
  if (data.docNumber) lines.push(`DOC_NUMBER: ${data.docNumber}`);

  if (Array.isArray(data.items) && data.items.length) {
    lines.push("ITEMS:");

    for (const item of data.items) {
      const label = String(item?.label || "").trim();
      if (!label) continue;

      const qty = safeNumber(item?.qty) ?? 1;
      const unitPrice = safeNumber(item?.unitPrice);
      const lineTotal = safeNumber(item?.lineTotal);

      const parts = [`- ${label}`];
      parts.push(`qty:${qty}`);

      if (unitPrice != null) parts.push(`pu:${unitPrice}`);
      if (lineTotal != null) parts.push(`total:${lineTotal}`);

      lines.push(parts.join(" | "));
    }
  }

  const materialTotal = safeNumber(data?.materialTotal);
  const laborTotal = safeNumber(data?.laborTotal);
  const grandTotal = safeNumber(data?.grandTotal);

  if (materialTotal != null) lines.push(`MATERIAL_TOTAL: ${materialTotal}`);
  if (laborTotal != null) lines.push(`LABOR_TOTAL: ${laborTotal}`);
  if (grandTotal != null) lines.push(`TOTAL: ${grandTotal}`);

  return lines.join("\n").trim();
}

async function kadiOcrEngine(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("buffer image invalide");
  }

  const mimeType = "image/jpeg";
  const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;

  console.log("[KADI OCR] GPT START");

  const prompt = [
    "Tu es un moteur d'extraction de factures pour KADI.",
    "Analyse cette image et retourne UNIQUEMENT un JSON valide.",
    "Ne retourne aucun texte hors JSON.",
    "Ignore les en-têtes non utiles comme 'Facture N°', téléphone, adresse, sauf docNumber si clair.",
    "Lis correctement les montants FCFA entiers: 12500 = douze mille cinq cents, 6000 = six mille.",
    "Ne jamais transformer 12500 en 25, ni 6000 en 6.",
    "Pour chaque ligne, extrais label, qty, unitPrice, lineTotal.",
    "Si une ligne comme 'Main d'oeuvre 30000' existe, mets-la comme item.",
    "Si 'Totale matérielle' existe, mets-la dans materialTotal.",
    "Si le montant total final existe, mets-le dans grandTotal.",
    "docType doit être 'facture', 'devis' ou 'recu'.",
    "JSON attendu :",
    "{",
    '  "docType": "facture",',
    '  "docNumber": "000396",',
    '  "client": null,',
    '  "items": [',
    '    { "label": "Tom cim", "qty": 2, "unitPrice": 12500, "lineTotal": 25000 }',
    "  ],",
    '  "materialTotal": 93000,',
    '  "laborTotal": 30000,',
    '  "grandTotal": 123000',
    "}",
  ].join(" ");

  try {
    const res = await openai.responses.create({
      model: OPENAI_OCR_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      ],
    });

    const rawText =
      res.output_text ||
      res.output
        ?.map((o) => (o.content || []).map((c) => c.text || "").join("\n"))
        .join("\n") ||
      "";

    if (!rawText.trim()) {
      throw new Error("OCR vide");
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      console.error("[KADI OCR] JSON parse failed:", rawText);
      throw new Error(`JSON OCR invalide: ${err.message}`);
    }

    const normalized = buildNormalizedText(parsed);

    if (!normalized) {
      throw new Error("OCR normalisé vide");
    }

    console.log("[KADI OCR] GPT SUCCESS", {
      preview: normalized.slice(0, 500),
    });

    return normalized;
  } catch (e) {
    console.error("[KADI OCR] FAILED:", e?.message);
    throw e;
  }
}

module.exports = { kadiOcrEngine };