"use strict";

const OpenAI = require("openai");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_NLU_MODEL = process.env.OPENAI_NLU_MODEL || "gpt-5-mini";

if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY manquant");
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const KADI_NLU_SCHEMA = {
  name: "kadi_nlu_result",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: {
        type: "string",
        enum: ["simple_payment", "items", "intent_only", "unknown"],
      },
      docType: {
        type: ["string", "null"],
        enum: ["devis", "facture", "recu", "decharge", null],
      },
      client: { type: ["string", "null"] },
      motif: { type: ["string", "null"] },
      total: { type: ["number", "null"] },
      currency: { type: ["string", "null"] },
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string" },
            qty: { type: "number" },
            unitPrice: { type: ["number", "null"] },
            lineTotal: { type: ["number", "null"] },
          },
          required: ["label", "qty", "unitPrice", "lineTotal"],
        },
      },
      dateText: { type: ["string", "null"] },
      shouldFallbackToManual: { type: "boolean" },
      ambiguityReason: { type: ["string", "null"] },
      confidence: { type: "number" },
      correctedText: { type: ["string", "null"] },
      reasoningShort: { type: ["string", "null"] },
    },
    required: [
      "kind",
      "docType",
      "client",
      "motif",
      "total",
      "currency",
      "items",
      "dateText",
      "shouldFallbackToManual",
      "ambiguityReason",
      "confidence",
      "correctedText",
      "reasoningShort",
    ],
  },
};

function normalizeNluText(text = "") {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function clampConfidence(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function sanitizeString(value, max = 300) {
  const s = normalizeNluText(value || "");
  return s ? s.slice(0, max) : null;
}

function sanitizeItem(item = {}) {
  const label = sanitizeString(item.label, 200);
  const qty = Number(item.qty);
  const unitPrice =
    item.unitPrice == null || Number.isNaN(Number(item.unitPrice))
      ? null
      : Number(item.unitPrice);
  const lineTotal =
    item.lineTotal == null || Number.isNaN(Number(item.lineTotal))
      ? null
      : Number(item.lineTotal);

  if (!label) return null;
  if (!Number.isFinite(qty) || qty <= 0) return null;

  return {
    label,
    qty,
    unitPrice,
    lineTotal,
  };
}

function normalizeDocType(docType) {
  return ["devis", "facture", "recu", "decharge"].includes(docType)
    ? docType
    : null;
}

function normalizeKind(kind) {
  return ["simple_payment", "items", "intent_only", "unknown"].includes(kind)
    ? kind
    : "unknown";
}

function computeSafeLineTotal(item) {
  const qty = Number(item?.qty);
  const unitPrice = Number(item?.unitPrice);
  const lineTotal = Number(item?.lineTotal);

  if (Number.isFinite(lineTotal) && lineTotal >= 0) return lineTotal;
  if (Number.isFinite(qty) && qty > 0 && Number.isFinite(unitPrice) && unitPrice >= 0) {
    return Math.round(qty * unitPrice);
  }
  return null;
}

function sanitizeNluResult(result) {
  if (!result || typeof result !== "object") return null;

  const kind = normalizeKind(result.kind);
  const docType = normalizeDocType(result.docType);

  const items = Array.isArray(result.items)
    ? result.items
        .map(sanitizeItem)
        .filter(Boolean)
        .map((it) => ({
          ...it,
          lineTotal: computeSafeLineTotal(it),
        }))
    : [];

  let total =
    result.total == null || Number.isNaN(Number(result.total))
      ? null
      : Number(result.total);

  if (total == null && items.length > 0) {
    const sum = items.reduce((acc, it) => acc + Number(it.lineTotal || 0), 0);
    total = sum > 0 ? sum : null;
  }

  const correctedText = sanitizeString(result.correctedText, 1000);
  const client = sanitizeString(result.client, 120);
  const motif = sanitizeString(result.motif, 200);
  const dateText = sanitizeString(result.dateText, 80);
  const ambiguityReason = sanitizeString(result.ambiguityReason, 200);
  const reasoningShort = sanitizeString(result.reasoningShort, 200);

  return {
    kind,
    docType,
    client,
    motif,
    total,
    currency: sanitizeString(result.currency, 20),
    items,
    dateText,
    shouldFallbackToManual: Boolean(result.shouldFallbackToManual),
    ambiguityReason,
    confidence: clampConfidence(result.confidence),
    correctedText,
    reasoningShort,
  };
}

function buildDeveloperPrompt() {
  return [
    "Tu es le moteur NLU de KADI, assistant WhatsApp africain de devis, factures, reçus et décharges.",
    "Tu dois convertir un message naturel ou une transcription vocale en JSON strict.",
    "Tu dois être conservateur: ne pas inventer des prix, clients ou quantités.",
    "Si le message est ambigu, utilise shouldFallbackToManual=true.",
    "Une année comme 2026 n'est pas un montant.",
    "Un mois ou une date dans une désignation doit rester dans la désignation.",
    "Si le message parle d'un reçu simple de paiement, utilise kind='simple_payment'.",
    "Si le message contient une ou plusieurs lignes de produits ou prestations, utilise kind='items'.",
    "Si le message exprime surtout une intention sans prix fiable, utilise kind='intent_only'.",
    "Si tu ne comprends pas assez bien, utilise kind='unknown'.",
    "Si le texte semble venir d'un vocal bruité, corrige légèrement le texte dans correctedText sans changer le sens.",
    "Quand plusieurs items sont présents, sépare-les proprement.",
    "Si qty n'est pas claire mais qu'un item existe, mets qty=1.",
    "Ne pas transformer un nom client en produit.",
    "Le client est souvent après 'pour', 'chez', 'client', 'à l'ordre de'.",
    "Le motif peut être 'loyer février', 'avance chantier', 'paiement installation', etc.",
    "currency doit être 'FCFA' quand c'est très probable, sinon null.",
    "confidence doit être entre 0 et 1.",
  ].join(" ");
}

async function parseNaturalWithOpenAI(text, options = {}) {
  const input = normalizeNluText(text);
  if (!input || input.length < 2) return null;

  const completion = await openai.chat.completions.create({
    model: options.model || OPENAI_NLU_MODEL,
    response_format: {
      type: "json_schema",
      json_schema: KADI_NLU_SCHEMA,
    },
    messages: [
      {
        role: "developer",
        content: buildDeveloperPrompt(),
      },
      {
        role: "user",
        content: input,
      },
    ],
  });

  const content = completion.choices?.[0]?.message?.content || "";
  if (!content) return null;

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`OpenAI NLU JSON parse failed: ${err.message}`);
  }

  return sanitizeNluResult(parsed);
}

module.exports = {
  normalizeNluText,
  sanitizeNluResult,
  parseNaturalWithOpenAI,
};