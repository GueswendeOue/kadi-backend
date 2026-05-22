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

  let cleaned = raw
    .replace(/\s+/g, "")
    .replace(/[^\d,.\-]/g, "");

  if (!cleaned) return null;

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

function safeConfidence(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(",", "."));
  if (!Number.isFinite(n)) return null;
  if (n > 1 && n <= 100) return n / 100;
  return n;
}

function normalizeMimeType(mimeType = "") {
  const t = String(mimeType || "").toLowerCase().trim();

  if (t.includes("png")) return "image/png";
  if (t.includes("webp")) return "image/webp";
  if (t.includes("jpg") || t.includes("jpeg")) return "image/jpeg";

  return "image/jpeg";
}

function buildNormalizedText(data = {}) {
  const lines = [];

  if (data.docType) lines.push(`TYPE: ${data.docType}`);
  if (data.factureKind) lines.push(`FACTURE_KIND: ${data.factureKind}`);
  if (data.client) lines.push(`CLIENT: ${data.client}`);
  if (data.docNumber) lines.push(`DOC_NUMBER: ${data.docNumber}`);

  if (Array.isArray(data.items) && data.items.length) {
    lines.push("ITEMS:");

    for (const item of data.items) {
      const label = String(item?.label || "").trim();
      if (!label) continue;

      const qty = safeNumber(item?.quantity ?? item?.qty) ?? 1;
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

  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = cleaned.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }

  const firstBracket = cleaned.indexOf("[");
  const lastBracket = cleaned.lastIndexOf("]");

  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    const candidate = cleaned.slice(firstBracket, lastBracket + 1);
    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }

  throw new Error(`JSON OCR invalide: ${cleaned.slice(0, 220)}`);
}

function extractResponseText(res) {
  if (typeof res?.output_text === "string" && res.output_text.trim()) {
    return res.output_text.trim();
  }

  const parts = [];

  for (const outputItem of Array.isArray(res?.output) ? res.output : []) {
    for (const contentItem of Array.isArray(outputItem?.content)
      ? outputItem.content
      : []) {
      if (typeof contentItem?.text === "string" && contentItem.text.trim()) {
        parts.push(contentItem.text.trim());
        continue;
      }

      if (
        typeof contentItem?.text?.value === "string" &&
        contentItem.text.value.trim()
      ) {
        parts.push(contentItem.text.value.trim());
      }
    }
  }

  return parts.join("\n").trim();
}

function normalizeParsedOcr(parsed) {
  const data = parsed && typeof parsed === "object" ? parsed : {};

  let items = [];
  if (Array.isArray(data.items)) {
    items = data.items
      .map((item) => {
        const label = String(item?.label || "").trim();
        const qty = safeNumber(item?.quantity ?? item?.qty) ?? 1;
        const unit = String(item?.unit || "").trim() || null;
        let unitPrice = safeNumber(item?.unitPrice);
        const lineTotalProvided =
          item?.lineTotal != null && String(item.lineTotal).trim() !== "";
        let lineTotal = safeNumber(item?.lineTotal);
        const warnings = Array.isArray(item?.warnings)
          ? item.warnings.map((w) => String(w || "").trim()).filter(Boolean)
          : [];

        if (unitPrice == null && lineTotal != null && qty > 0) {
          unitPrice = Math.round(lineTotal / qty);
        }

        if (lineTotal == null && unitPrice != null && qty > 0) {
          lineTotal = Math.round(unitPrice * qty);
        }

        return {
          label,
          quantity: qty,
          qty,
          unit,
          unitPrice,
          lineTotal,
          lineTotalProvided,
          labelRaw: String(item?.labelRaw || item?.label || "").trim() || null,
          quantityRaw:
            item?.quantityRaw != null ? String(item.quantityRaw).trim() : null,
          unitPriceRaw:
            item?.unitPriceRaw != null ? String(item.unitPriceRaw).trim() : null,
          lineTotalRaw:
            item?.lineTotalRaw != null ? String(item.lineTotalRaw).trim() : null,
          confidence: safeConfidence(item?.confidence),
          warnings,
        };
      })
      .filter((item) => item.label);
  }

  const docTypeRaw = String(data.documentType || data.docType || "")
    .trim()
    .toLowerCase();
  let docType = null;
  let factureKind = null;

  if (
    docTypeRaw.includes("facture_proforma") ||
    docTypeRaw.includes("facture proforma") ||
    docTypeRaw.includes("proforma") ||
    docTypeRaw.includes("pro forma")
  ) {
    docType = "facture";
    factureKind = "proforma";
  } else if (docTypeRaw.includes("fact")) {
    docType = "facture";
    factureKind = "definitive";
  } else if (docTypeRaw.includes("devis")) {
    docType = "devis";
  } else if (docTypeRaw.includes("recu") || docTypeRaw.includes("reçu")) {
    docType = "recu";
  } else if (
    docTypeRaw.includes("decharge") ||
    docTypeRaw.includes("décharge")
  ) {
    docType = "decharge";
  }

  return {
    docType,
    factureKind,
    docNumber: String(data.docNumber || "").trim() || null,
    client: String(data.client || "").trim() || null,
    items,
    materialTotal: safeNumber(data.materialTotal),
    laborTotal: safeNumber(data.laborTotal),
    grandTotal: safeNumber(data.detectedTotal ?? data.grandTotal),
    detectedTotal: safeNumber(data.detectedTotal ?? data.grandTotal),
    warnings: Array.isArray(data.warnings)
      ? data.warnings.map((w) => String(w || "").trim()).filter(Boolean)
      : [],
  };
}

function buildPrompt() {
  return [
    "Tu es un moteur OpenAI Vision d'extraction de documents manuscrits pour KADI.",
    "Analyse cette image et retourne UNIQUEMENT un JSON valide.",
    "Ne retourne aucun texte hors JSON.",
    "Pas de markdown. Pas de ```json. Pas d'explication.",
    "N'invente aucune donnée absente.",
    "La langue principale du document est le français.",
    "Lis l'image directement comme un humain, surtout les tableaux manuscrits.",
    "Pour les tableaux, respecte les colonnes Désignation, Quantité, Prix unit, Prix total.",
    "Lis correctement les montants FCFA entiers avec espaces, virgules ou points.",
    "Ne jamais transformer 12500 en 25, ni 6000 en 6.",
    "Préserve les chiffres dans les désignations: 2.5KWH, 3KVA, 450W, 2 modules, 2.5mm.",
    "Si une quantité contient une unité comme 15m, renvoie quantity=15 et unit='m'.",
    "Utilise la colonne Prix total comme lineTotal quand elle existe.",
    "Ignore téléphone, adresse et en-têtes inutiles, sauf docNumber si clair.",
    "Pour chaque ligne, extrais labelRaw, quantityRaw, unitPriceRaw, lineTotalRaw, label, quantity, unit, unitPrice, lineTotal, confidence, warnings.",
    "Les champs Raw doivent contenir exactement ce que tu lis dans la cellule, même si c'est incertain.",
    "confidence est un nombre entre 0 et 1 pour la ligne entière.",
    "Si quantity manque mais le prix est clair, mets quantity à 1.",
    "Si une ligne comme 'Main d'oeuvre 30000' existe, mets-la comme item.",
    "Si le montant final existe, mets-le dans detectedTotal.",
    "Si une ligne est incertaine, ajoute un message court dans warnings de la ligne et dans warnings global.",
    "documentType doit être l'une de ces valeurs : 'facture', 'facture_proforma', 'devis', 'recu'.",
    "Si le type n'est pas clair, choisis la meilleure valeur probable parmi ces quatre.",
    "Les nombres doivent être renvoyés comme nombres JSON, pas comme texte.",
    "JSON attendu :",
    "{",
    '  "documentType": "facture",',
    '  "docNumber": "000396",',
    '  "client": null,',
    '  "items": [',
    '    { "labelRaw": "Câble 2.5mm", "quantityRaw": "15m", "unitPriceRaw": "1 750", "lineTotalRaw": "26 250", "label": "Câble 2.5mm", "quantity": 15, "unit": "m", "unitPrice": 1750, "lineTotal": 26250, "confidence": 0.92, "warnings": [] }',
    "  ],",
    '  "detectedTotal": 123000,',
    '  "warnings": []',
    "}",
  ].join(" ");
}

async function kadiOcrEngine(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("buffer image invalide");
  }

  const mimeType = normalizeMimeType(options?.mimeType);
  const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;

  console.log("[KADI OCR ENGINE] START", {
    model: OPENAI_OCR_MODEL,
    mimeType,
    bytes: buffer.length,
  });

  try {
    const res = await openai.responses.create({
      model: OPENAI_OCR_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: buildPrompt() },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      ],
    });

    const rawText = extractResponseText(res);

    if (!rawText.trim()) {
      throw new Error("OCR vide");
    }

    let parsed;
    try {
      parsed = tryExtractJsonBlock(rawText);
    } catch (err) {
      console.error("[KADI OCR ENGINE] JSON parse failed");
      throw new Error(err.message || "JSON OCR invalide");
    }

    const normalizedParsed = normalizeParsedOcr(parsed);
    const normalized = buildNormalizedText(normalizedParsed);

    if (!normalized) {
      throw new Error("OCR normalisé vide");
    }

    console.log("[KADI OCR ENGINE] SUCCESS", {
      docType: normalizedParsed.docType || null,
      factureKind: normalizedParsed.factureKind || null,
      itemsCount: Array.isArray(normalizedParsed.items)
        ? normalizedParsed.items.length
        : 0,
      hasClient: !!normalizedParsed.client,
      hasDocNumber: !!normalizedParsed.docNumber,
      total: normalizedParsed.grandTotal || null,
    });

    return {
      kind: "vision_json",
      text: normalized,
      parsed: normalizedParsed,
      raw: parsed,
    };
  } catch (e) {
    console.error("[KADI OCR ENGINE] FAILED:", e?.message);
    throw e;
  }
}

module.exports = { kadiOcrEngine };
