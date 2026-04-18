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

function clampLimit(limit, min = 1, max = 50, fallback = 10) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.trunc(n), max));
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

function getRawObject(row = {}) {
  return row?.raw && typeof row.raw === "object" ? row.raw : {};
}

function extractPdfMeta(row = {}) {
  const raw = getRawObject(row);

  const pdfMediaId =
    safeText(row?.pdf_media_id, null) ||
    safeText(row?.pdfMediaId, null) ||
    safeText(raw?.savedPdfMediaId, null) ||
    safeText(raw?.pdf_media_id, null);

  const pdfFilename =
    safeText(row?.pdf_filename, null) ||
    safeText(row?.pdfFilename, null) ||
    safeText(raw?.savedPdfFilename, null) ||
    safeText(raw?.pdf_filename, null);

  const pdfCaption =
    safeText(row?.pdf_caption, null) ||
    safeText(row?.pdfCaption, null) ||
    safeText(raw?.savedPdfCaption, null) ||
    safeText(raw?.pdf_caption, null);

  return {
    pdf_media_id: pdfMediaId,
    pdf_filename: pdfFilename,
    pdf_caption: pdfCaption,
  };
}

function normalizeStatus(row = {}) {
  const raw = getRawObject(row);

  return (
    safeText(row?.status, null) ||
    safeText(raw?.status, null) ||
    "generated"
  );
}

function isHistoryVisibleStatus(status) {
  const s = safeText(status).toLowerCase();

  if (!s) return true;

  return (
    s !== "draft" &&
    s !== "temp" &&
    s !== "temporary" &&
    s !== "preview"
  );
}

function normalizeItemsCount(row = {}) {
  const raw = getRawObject(row);

  if (Number.isFinite(Number(row?.items_count))) {
    return Math.max(0, Math.trunc(Number(row.items_count)));
  }

  if (Array.isArray(raw?.items)) {
    return raw.items.length;
  }

  return 0;
}

function normalizeTotal(row = {}) {
  const raw = getRawObject(row);

  if (Number.isFinite(Number(row?.total))) {
    return Number(row.total);
  }

  const finance = raw?.finance && typeof raw.finance === "object" ? raw.finance : null;

  if (finance) {
    if (Number.isFinite(Number(finance.gross))) return Number(finance.gross);
    if (Number.isFinite(Number(finance.total))) return Number(finance.total);
    if (Number.isFinite(Number(finance.subtotal))) return Number(finance.subtotal);
  }

  return 0;
}

function normalizeClient(row = {}) {
  const raw = getRawObject(row);
  return safeText(row?.client, null) || safeText(raw?.client, "-") || "-";
}

function normalizeDate(row = {}) {
  const raw = getRawObject(row);
  return safeText(row?.date, null) || safeText(raw?.date, null);
}

function normalizeSource(row = {}) {
  const raw = getRawObject(row);
  return safeText(row?.source, null) || safeText(raw?.source, null);
}

function normalizeHistoryRow(row = {}) {
  const raw = getRawObject(row);
  const pdf = extractPdfMeta(row);
  const docType = safeText(row?.doc_type, null) || safeText(raw?.type, null);
  const factureKind =
    safeText(row?.facture_kind, null) || safeText(raw?.factureKind, null);
  const status = normalizeStatus(row);

  return {
    id: row?.id || null,
    doc_number: safeText(row?.doc_number, null) || safeText(raw?.docNumber, "-") || "-",
    doc_type: docType,
    facture_kind: factureKind,
    doc_label: buildDocLabel(docType, factureKind),
    client: normalizeClient(row),
    total: normalizeTotal(row),
    date: normalizeDate(row),
    status,
    source: normalizeSource(row),
    items_count: normalizeItemsCount(row),
    created_at: row?.created_at || raw?.created_at || null,
    pdf_media_id: pdf.pdf_media_id,
    pdf_filename: pdf.pdf_filename,
    pdf_caption: pdf.pdf_caption,
    raw,
  };
}

function isHistoryVisibleRow(row = {}) {
  return isHistoryVisibleStatus(row?.status);
}

function normalizeRows(rows = [], finalLimit = 10) {
  return (Array.isArray(rows) ? rows : [])
    .map(normalizeHistoryRow)
    .filter(isHistoryVisibleRow)
    .slice(0, finalLimit);
}

async function listRecentDocumentsByWaId(waId, limit = 10) {
  const safeWaId = safeText(waId);
  if (!safeWaId) throw new Error("HISTORY_WA_ID_REQUIRED");

  const safeLimit = clampLimit(limit, 1, 50, 10);
  const queryLimit = clampLimit(safeLimit * 3, 1, 100, safeLimit);

  const { data, error } = await supabase
    .from("kadi_documents")
    .select(
  "id,doc_number,doc_type,facture_kind,client,total,date,status,source,items_count,created_at,pdf_media_id,pdf_filename,pdf_caption,raw"
)
    .eq("wa_id", safeWaId)
    .order("created_at", { ascending: false })
    .limit(queryLimit);

  if (error) throw error;

  return normalizeRows(data || [], safeLimit);
}

async function listRecentDocumentsByType(waId, docType, limit = 10) {
  const safeWaId = safeText(waId);
  const safeDocType = safeText(docType);

  if (!safeWaId) throw new Error("HISTORY_WA_ID_REQUIRED");
  if (!safeDocType) throw new Error("HISTORY_DOC_TYPE_REQUIRED");

  const safeLimit = clampLimit(limit, 1, 50, 10);
  const queryLimit = clampLimit(safeLimit * 3, 1, 100, safeLimit);

  const { data, error } = await supabase
    .from("kadi_documents")
    .select(
  "id,doc_number,doc_type,facture_kind,client,total,date,status,source,items_count,created_at,pdf_media_id,pdf_filename,pdf_caption,raw"
)
    .eq("wa_id", safeWaId)
    .eq("doc_type", safeDocType)
    .order("created_at", { ascending: false })
    .limit(queryLimit);

  if (error) throw error;

  return normalizeRows(data || [], safeLimit);
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

  const row = normalizeHistoryRow(data || {});
  return isHistoryVisibleRow(row) ? row : null;
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