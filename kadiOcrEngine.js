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
        const qty = safeNumber(item?.qty) ?? 1;
        let unitPrice = safeNumber(item?.unitPrice);
        let lineTotal = safeNumber(item?.lineTotal);

        if (unitPrice == null && lineTotal != null && qty > 0) {
          unitPrice = Math.round(lineTotal / qty);
        }

        if (lineTotal == null && unitPrice != null && qty > 0) {
          lineTotal = Math.round(unitPrice * qty);
        }

        return {
          label,
          qty,
          unitPrice,
          lineTotal,
        };
      })
      .filter((item) => item.label);
  }

  const docTypeRaw = String(data.docType || "").trim().toLowerCase();
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
    grandTotal: safeNumber(data.grandTotal),
  };
}

function buildPrompt() {
  return [
    "Tu es un moteur d'extraction OCR pour KADI.",
    "Analyse cette image et retourne UNIQUEMENT un JSON valide.",
    "Ne retourne aucun texte hors JSON.",
    "Pas de markdown. Pas de ```json. Pas d'explication.",
    "N'invente aucune donnée absente.",
    "La langue principale du document est le français.",
    "Lis correctement les montants FCFA entiers avec espaces, virgules ou points.",
    "Ne jamais transformer 12500 en 25, ni 6000 en 6.",
    "Ignore téléphone, adresse et en-têtes inutiles, sauf docNumber si clair.",
    "Pour chaque ligne, extrais label, qty, unitPrice, lineTotal.",
    "Si qty manque mais le prix est clair, mets qty à 1.",
    "Si une ligne comme 'Main d'oeuvre 30000' existe, mets-la comme item.",
    "Si 'Totale matérielle' ou équivalent existe, mets-la dans materialTotal.",
    "Si le montant final existe, mets-le dans grandTotal.",
    "docType doit être l'une de ces valeurs : 'facture', 'facture_proforma', 'devis', 'recu'.",
    "Si le type n'est pas clair, choisis la meilleure valeur probable parmi ces quatre.",
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

    return normalized;
  } catch (e) {
    console.error("[KADI OCR ENGINE] FAILED:", e?.message);
    throw e;
  }
}

module.exports = { kadiOcrEngine };