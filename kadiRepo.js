"use strict";

const { supabase } = require("./supabaseClient");

async function saveDocument({ waId, doc }) {
  const f = doc?.finance || {};

  const payload = {
    wa_id: waId,
    doc_number: doc?.docNumber || null,
    doc_type: doc?.type || null,
    facture_kind: doc?.factureKind || null,
    client: doc?.client || null,
    date: doc?.date || null,
    total: f.gross ?? null,
    items: Array.isArray(doc?.items) ? doc.items : [],
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