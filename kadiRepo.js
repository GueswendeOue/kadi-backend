// kadiRepo.js
const { supabase } = require("./supabaseClient");

function assertSupabaseConfigured() {
  // petit check simple (si clé invalide, ça plantera plus tard mais au moins on alerte tôt)
  if (!process.env.SUPABASE_URL) {
    throw new Error("SUPABASE_URL missing in .env");
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY) missing in .env");
  }
}

async function saveDocument({ waId, doc }) {
  assertSupabaseConfigured();

  const f = doc?.finance || {};

  const payload = {
    wa_id: waId,
    doc_number: doc?.docNumber || null,
    doc_type: doc?.type || null,
    client: doc?.client || null,
    date: doc?.date || null,
    paid: typeof doc?.paid === "boolean" ? doc.paid : null,
    payment_method: doc?.paymentMethod || null,
    motif: doc?.motif || null,

    subtotal: f.subtotal ?? null,
    discount: f.discount ?? null,
    net: f.net ?? null,
    vat: f.vat ?? null,
    total: f.gross ?? null,
    deposit: f.deposit ?? null,
    due: f.due ?? null,

    items: Array.isArray(doc?.items) ? doc.items : [],
    raw: doc || {},
  };

  // ⛑️ Upsert pour éviter doublons (si tu as une contrainte unique côté DB sur (wa_id, doc_number) c’est parfait)
  const { data, error } = await supabase
    .from("kadi_documents")
    .upsert(payload, { onConflict: "wa_id,doc_number" })
    .select("id, doc_number, created_at")
    .single();

  if (error) throw error;
  return data;
}

async function listDocuments({ waId, limit = 10 }) {
  assertSupabaseConfigured();

  const { data, error } = await supabase
    .from("kadi_documents")
    .select("doc_number, doc_type, client, date, total, created_at")
    .eq("wa_id", waId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

module.exports = { saveDocument, listDocuments };