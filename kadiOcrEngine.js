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

  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }

  const raw = String(value).trim();
  if (!raw) return null;

  // garde les chiffres, virgules, points et signe éventuel
  let cleaned = raw
    .replace(/\s+/g, "")
    .replace(/[^\d,.\-]/g, "");

  if (!cleaned) return null;

  // normalisation simple:
  // 12.500 -> 12500
  // 12,500 -> 12500
  // 12500.00 -> 12500
  // 12500,00 -> 12500
  const commaCount = (cleaned.match(/,/g) || []).length;
  const dotCount = (cleaned.match(/\./g) || []).length;

  if (commaCount > 0 && dotCount === 0) {
    if (/,\d{3}$/.test(cleaned)) {
      cleaned = cleaned.replace(/,/g, "");
    } else {
      cleaned = cleaned.replace(/,/g, ".");
    }
  } else if (dotCount > 0 && commaCount === 0) {
    if (/\.\d{3}$/.test(cleaned)) {
      cleaned = cleaned.replace(/\./g, "");
    }
  } else if (dotCount > 0 && commaCount > 0) {
    cleaned = cleaned.replace(/\./g, "").replace(/,/g, ".");
  }

  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n) : null;
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

function stripMarkdownFences(text = "") {
  return String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function tryExtractJsonBlock(text = "") {
  const cleaned = stripMarkdownFences(text);

  // tentative directe
  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  // cherche le premier objet JSON plausible
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = cleaned.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }

  // fallback tableau JSON si jamais le modèle renvoie [...]
  const firstBracket = cleaned.indexOf("[");
  const lastBracket = cleaned.lastIndexOf("]");

  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    const candidate = cleaned.slice(firstBracket, lastBracket + 1);
    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }

  throw new Error(
    `JSON OCR invalide: ${cleaned.slice(0, 220)}`
  );
}

function normalizeParsedOcr(parsed) {
  const data = parsed && typeof parsed === "object" ? parsed : {};

  let items = [];
  if (Array.isArray(data.items)) {
    items = data.items
      .map((item) => ({
        label: String(item?.label || "").trim(),
        qty: safeNumber(item?.qty) ?? 1,
        unitPrice: safeNumber(item?.unitPrice),
        lineTotal: safeNumber(item?.lineTotal),
      }))
      .filter((item) => item.label);
  }

  const docTypeRaw = String(data.docType || "").trim().toLowerCase();
  let docType = null;

  if (docTypeRaw.includes("fact")) docType = "facture";
  else if (docTypeRaw.includes("devis")) docType = "devis";
  else if (docTypeRaw.includes("recu") || docTypeRaw.includes("reçu")) docType = "recu";

  return {
    docType,
    docNumber: String(data.docNumber || "").trim() || null,
    client: String(data.client || "").trim() || null,
    items,
    materialTotal: safeNumber(data.materialTotal),
    laborTotal: safeNumber(data.laborTotal),
    grandTotal: safeNumber(data.grandTotal),
  };
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
    "Pas de markdown. Pas de ```json. Pas d'explication.",
    "Ignore les en-têtes non utiles comme téléphone, adresse, sauf docNumber si clair.",
    "Lis correctement les montants FCFA entiers: 12500 = douze mille cinq cents, 6000 = six mille.",
    "Ne jamais transformer 12500 en 25, ni 6000 en 6.",
    "Pour chaque ligne, extrais label, qty, unitPrice, lineTotal.",
    "Si une ligne comme 'Main d'oeuvre 30000' existe, mets-la comme item.",
    "Si 'Totale matérielle' existe, mets-la dans materialTotal.",
    "Si le montant total final existe, mets-le dans grandTotal.",
    "docType doit être 'facture', 'devis' ou 'recu'.",
    "Les nombres doivent être renvoyés comme nombres JSON, pas comme texte.",
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
      parsed = tryExtractJsonBlock(rawText);
    } catch (err) {
      console.error("[KADI OCR] JSON parse failed:", rawText);
      throw new Error(err.message || "JSON OCR invalide");
    }

    const normalizedParsed = normalizeParsedOcr(parsed);
    const normalized = buildNormalizedText(normalizedParsed);

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