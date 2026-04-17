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
      clientPhone: { type: ["string", "null"] },
      motif: { type: ["string", "null"] },
      subject: { type: ["string", "null"] },
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
      "clientPhone",
      "motif",
      "subject",
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

function sanitizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits && digits.length >= 8 ? digits.slice(0, 30) : null;
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

  if (
    Number.isFinite(qty) &&
    qty > 0 &&
    Number.isFinite(unitPrice) &&
    unitPrice >= 0
  ) {
    return Math.round(qty * unitPrice);
  }

  return null;
}

function inferTotalFromItems(items = []) {
  const sum = items.reduce((acc, it) => acc + Number(it?.lineTotal || 0), 0);
  return sum > 0 ? sum : null;
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
    total = inferTotalFromItems(items);
  }

  const correctedText = sanitizeString(result.correctedText, 1000);
  const client = sanitizeString(result.client, 120);
  const clientPhone = sanitizePhone(result.clientPhone);
  const motif = sanitizeString(result.motif, 200);
  const subject = sanitizeString(result.subject, 200);
  const dateText = sanitizeString(result.dateText, 80);
  const ambiguityReason = sanitizeString(result.ambiguityReason, 200);
  const reasoningShort = sanitizeString(result.reasoningShort, 200);
  const currency = sanitizeString(result.currency, 20);

  return {
    kind,
    docType,
    client,
    clientPhone,
    motif,
    subject,
    total,
    currency,
    items,
    dateText,
    shouldFallbackToManual: Boolean(result.shouldFallbackToManual),
    ambiguityReason,
    confidence: clampConfidence(result.confidence),
    correctedText,
    reasoningShort,
  };
}

function buildDeveloperPrompt(options = {}) {
  const contextStep = sanitizeString(options.contextStep, 80);
  const expectedField = sanitizeString(options.expectedField, 80);
  const currentDocType = sanitizeString(options.currentDocType, 40);

  return [
    "Tu es le moteur NLU de KADI, assistant WhatsApp africain pour devis, factures, reçus et décharges.",
    "Ta mission est de convertir un message naturel, parfois bruité ou transcrit depuis un vocal, en JSON strict.",
    "Tu dois être extrêmement conservateur : ne pas inventer de prix, client, téléphone, quantité ou type de document.",
    "Quand ce n'est pas assez clair, utilise shouldFallbackToManual=true.",
    "Une année comme 2026 n'est pas un montant.",
    "Un mois ou une date dans une désignation doit rester dans la désignation.",
    "Le client est souvent après 'pour', 'chez', 'client', 'à l'ordre de', mais pas toujours.",
    "Le motif ou l'objet peut être : loyer avril, avance chantier, paiement installation, consultation, location, transport, etc.",
    "subject peut reprendre l'objet commercial du document quand il est identifiable.",
    "clientPhone doit être rempli seulement si un numéro de téléphone clair est présent.",
    "Ne pas transformer un nom client en produit.",
    "Ne pas transformer un numéro client en produit.",
    "Si le message exprime un reçu simple de paiement, utilise kind='simple_payment'.",
    "Si le message contient plusieurs produits ou prestations, utilise kind='items'.",
    "Si le message exprime surtout une intention de document sans prix fiables, utilise kind='intent_only'.",
    "Si tu ne comprends pas assez bien, utilise kind='unknown'.",
    "Si le texte semble venir d'un vocal bruité, corrige légèrement le texte dans correctedText sans changer le sens.",
    "Quand plusieurs items sont présents, sépare-les proprement.",
    "Si qty n'est pas claire mais qu'un item existe, mets qty=1.",
    "currency doit être 'FCFA' quand c'est très probable, sinon null.",
    "confidence doit être entre 0 et 1.",
    "Pour un message comme 'reçu pour Intel loyer avril 100000', la bonne lecture est généralement docType='recu', client='Intel', motif/subject='loyer avril', total=100000.",
    contextStep ? `Contexte step actuel: ${contextStep}.` : "",
    expectedField ? `Champ attendu actuellement: ${expectedField}.` : "",
    currentDocType ? `Type de document déjà en cours: ${currentDocType}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
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
        content: buildDeveloperPrompt(options),
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