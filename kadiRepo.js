"use strict";

const { supabase } = require("./supabaseClient");

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function b(v, def = false) {
  if (typeof v === "boolean") return v;
  return def;
}

function s(v) {
  const t = String(v || "").trim();
  return t || null;
}

function guessCountryFromWaId(waId) {
  const id = String(waId || "").trim();

  const prefixes = [
    ["1", "United States / Canada"],
    ["33", "France"],
    ["32", "Belgium"],
    ["49", "Germany"],
    ["235", "Chad"],
    ["226", "Burkina Faso"],
    ["225", "Côte d'Ivoire"],
    ["221", "Sénégal"],
    ["223", "Mali"],
    ["228", "Togo"],
    ["229", "Bénin"],
    ["227", "Niger"],
    ["234", "Nigeria"],
    ["237", "Cameroon"],
    ["242", "Republic of the Congo"],
    ["243", "DR Congo"],
    ["212", "Morocco"],
    ["213", "Algeria"],
    ["216", "Tunisia"],
    ["20", "Egypt"],
    ["39", "Italy"],
    ["34", "Spain"],
    ["44", "United Kingdom"],
    ["31", "Netherlands"],
    ["41", "Switzerland"],
    ["351", "Portugal"],
    ["90", "Turkey"],
    ["971", "United Arab Emirates"],
  ];

  // On trie du plus long au plus court pour éviter les collisions
  prefixes.sort((a, b) => b[0].length - a[0].length);

  for (const [code, name] of prefixes) {
    if (id.startsWith(code)) {
      return {
        wa_country_code: code,
        wa_country_guess: name,
      };
    }
  }

  return {
    wa_country_code: null,
    wa_country_guess: "Unknown",
  };
}

async function saveDocument({ waId, doc }) {
  const f = doc?.finance || {};
  const items = Array.isArray(doc?.items) ? doc.items : [];
  const country = guessCountryFromWaId(waId);

  const source = s(doc?.source) || "product";

  const payload = {
    // Identity
    wa_id: s(waId),
    wa_country_code: country.wa_country_code,
    wa_country_guess: country.wa_country_guess,

    // Document core
    doc_number: s(doc?.docNumber),
    doc_type: s(doc?.type),                 // devis | facture | recu | decharge
    facture_kind: s(doc?.factureKind),      // proforma | definitive | null
    client: s(doc?.client),
    date: s(doc?.date),

    // Finance
    subtotal: n(f.subtotal),
    discount: n(doc?.discount),
    net: n(doc?.net),
    vat: n(doc?.vat),
    total: n(f.gross ?? doc?.total),
    deposit: n(doc?.deposit),
    due: n(doc?.due),

    // Payment
    paid: typeof doc?.paid === "boolean" ? doc.paid : null,
    payment_method: s(doc?.paymentMethod),
    motif: s(doc?.motif),

    // Analytics
    source,
    items_count: items.length,
    used_ocr: source === "ocr",
    used_gemini_parse: b(doc?.meta?.usedGeminiParse, false),
    used_stamp: b(doc?.meta?.usedStamp, false),
    credits_consumed: n(doc?.meta?.creditsConsumed),
    business_sector: s(doc?.meta?.businessSector || doc?.meta?.businessType),
    status: s(doc?.status) || "generated",

    // Raw data
    items,
    raw: doc || {},
  };

  const { data, error } = await supabase
    .from("kadi_documents")
    .insert(payload)
    .select("id, doc_number, created_at")
    .single();

  if (error) throw error;
  return data;
}

module.exports = { saveDocument };