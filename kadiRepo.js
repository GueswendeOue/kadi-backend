"use strict";

const { supabase } = require("./supabaseClient");

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

async function saveDocument({ waId, doc }) {
  // doc = draft interne (kadiEngine)
  // doc.finance = { subtotal, gross } chez toi (gross = total)
  const f = doc?.finance || {};
  const items = Array.isArray(doc?.items) ? doc.items : [];

  // 👉 Alignement sur ton schéma Supabase kadi_documents
  const payload = {
    wa_id: waId,
    doc_number: doc?.docNumber || null,
    doc_type: doc?.type || null,            // devis | facture | recu
    facture_kind: doc?.factureKind || null, // proforma | definitive | null
    client: doc?.client || null,
    date: doc?.date || null,

    // Champs financiers (si tu ne gères pas encore tout, on met null proprement)
    subtotal: n(f.subtotal),
    discount: n(doc?.discount) ?? null,
    net: n(doc?.net) ?? null,
    vat: n(doc?.vat) ?? null,

    total: n(f.gross ?? doc?.total),

    deposit: n(doc?.deposit) ?? null,
    due: n(doc?.due) ?? null,

    // Paiement
    paid: typeof doc?.paid === "boolean" ? doc.paid : null,
    payment_method: doc?.paymentMethod || null,
    motif: doc?.motif || null,

    // Data
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