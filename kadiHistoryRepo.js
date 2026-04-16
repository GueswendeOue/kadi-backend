"use strict";

const { supabase } = require("./supabaseClient");

function toNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function safeText(v, def = "") {
  const s = String(v ?? "").trim();
  return s || def;
}

function buildDocLabel(docType, factureKind) {
  const type = safeText(docType).toLowerCase();
  const kind = safeText(factureKind).toLowerCase();

  if (type === "facture") {
    if (kind === "proforma") return "Facture proforma";
    return "Facture";
  }

  if (type === "devis") return "Devis";
  if (type === "recu") return "Reçu";
  if (type === "decharge") return "Décharge";

  return "Document";
}

function extractPdfMeta(raw = {}) {
  const src = raw && typeof raw === "object" ? raw : {};

  return {
    pdf_media_id: safeText(src.savedPdfMediaId, null),
    pdf_filename: safeText(src.savedPdfFilename, null),
    pdf_caption: safeText(src.savedPdfCaption, null),
  };
}

function normalizeHistoryRow(row = {}) {
  const raw = row?.raw && typeof row.raw === "object" ? row.raw : {};
  const pdf = extractPdfMeta(raw);

  return {
    id: row?.id || null,
    doc_number: safeText(row?.doc_number, "-"),
    doc_type: safeText(row?.doc_type, null),
    facture_kind: safeText(row?.facture_kind, null),
    doc_label: buildDocLabel(row?.doc_type, row?.facture_kind),
    client: safeText(row?.client, "-"),
    total: toNum(row?.total, 0),
    date: safeText(row?.date, null),
    status: safeText(row?.status, "generated"),
    source: safeText(row?.source, null),
    items_count: toNum(row?.items_count, 0),
    created_at: row?.created_at || null,
    pdf_media_id: pdf.pdf_media_id,
    pdf_filename: pdf.pdf_filename,
    pdf_caption: pdf.pdf_caption,
    raw,
  };
}

async function listRecentDocumentsByWaId(waId, limit = 10) {
  const safeWaId = safeText(waId);
  if (!safeWaId) throw new Error("HISTORY_WA_ID_REQUIRED");

  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));

  const { data, error } = await supabase
    .from("kadi_documents")
    .select(
      "id,doc_number,doc_type,facture_kind,client,total,date,status,source,items_count,created_at,raw"
    )
    .eq("wa_id", safeWaId)
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (error) throw error;

  return (data || []).map(normalizeHistoryRow);
}

async function listRecentDocumentsByType(waId, docType, limit = 10) {
  const safeWaId = safeText(waId);
  const safeDocType = safeText(docType);

  if (!safeWaId) throw new Error("HISTORY_WA_ID_REQUIRED");
  if (!safeDocType) throw new Error("HISTORY_DOC_TYPE_REQUIRED");

  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));

  const { data, error } = await supabase
    .from("kadi_documents")
    .select(
      "id,doc_number,doc_type,facture_kind,client,total,date,status,source,items_count,created_at,raw"
    )
    .eq("wa_id", safeWaId)
    .eq("doc_type", safeDocType)
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (error) throw error;

  return (data || []).map(normalizeHistoryRow);
}

async function getDocumentById(documentId) {
  const safeId = safeText(documentId);
  if (!safeId) throw new Error("HISTORY_DOCUMENT_ID_REQUIRED");

  const { data, error } = await supabase
    .from("kadi_documents")
    .select("*")
    .eq("id", safeId)
    .single();

  if (error) throw error;

  return normalizeHistoryRow(data);
}

async function getLatestResendableDocumentByWaId(waId, searchLimit = 20) {
  const rows = await listRecentDocumentsByWaId(waId, searchLimit);
  return rows.find((row) => !!row.pdf_media_id) || null;
}

module.exports = {
  listRecentDocumentsByWaId,
  listRecentDocumentsByType,
  getDocumentById,
  getLatestResendableDocumentByWaId,
};