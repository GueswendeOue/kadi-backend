"use strict";

const { supabase } = require("../supabaseClient");
const {
  safeText,
  normalizeStatus,
  buildCertifiedInvoiceNumber,
  buildComplianceReference,
  buildCanonicalCertifiedPayload,
  buildComplianceHash,
  buildVerificationUrl,
  buildQrPayload,
} = require("./kadiCertifiedSecurity");

function nowIso() {
  return new Date().toISOString();
}

async function getNextCertifiedSequence({
  fiscalYear = new Date().getUTCFullYear(),
} = {}) {
  const year = Number(fiscalYear);
  if (!Number.isFinite(year) || year < 2024) {
    throw new Error("CERTIFIED_INVALID_FISCAL_YEAR");
  }

  const { data: row, error: selectError } = await supabase
    .from("kadi_certified_invoice_sequences")
    .select("fiscal_year,last_sequence")
    .eq("fiscal_year", year)
    .maybeSingle();

  if (selectError) throw selectError;

  if (!row) {
    const { data: inserted, error: insertError } = await supabase
      .from("kadi_certified_invoice_sequences")
      .insert([
        {
          fiscal_year: year,
          last_sequence: 1,
          updated_at: nowIso(),
        },
      ])
      .select("last_sequence")
      .single();

    if (insertError) throw insertError;
    return Number(inserted.last_sequence);
  }

  const nextValue = Number(row.last_sequence || 0) + 1;

  const { data: updated, error: updateError } = await supabase
    .from("kadi_certified_invoice_sequences")
    .update({
      last_sequence: nextValue,
      updated_at: nowIso(),
    })
    .eq("fiscal_year", year)
    .eq("last_sequence", row.last_sequence)
    .select("last_sequence")
    .single();

  if (updateError || !updated) {
    throw updateError || new Error("CERTIFIED_SEQUENCE_UPDATE_FAILED");
  }

  return Number(updated.last_sequence);
}

async function logCertifiedInvoiceEvent({
  invoiceId,
  eventType,
  actorType = "system",
  actorId = null,
  payloadHash = null,
  metadata = {},
}) {
  const { error } = await supabase.from("kadi_certified_invoice_events").insert([
    {
      invoice_id: invoiceId,
      event_type: safeText(eventType),
      actor_type: safeText(actorType),
      actor_id: actorId ? String(actorId) : null,
      payload_hash: payloadHash ? String(payloadHash) : null,
      metadata: metadata || {},
      created_at: nowIso(),
    },
  ]);

  if (error) throw error;
  return true;
}

async function createCertifiedInvoiceVersion({
  invoiceId,
  versionNumber = 1,
  snapshotJson,
  hash,
}) {
  const { error } = await supabase
    .from("kadi_certified_invoice_versions")
    .insert([
      {
        invoice_id: invoiceId,
        version_number: Number(versionNumber),
        snapshot_json: snapshotJson,
        hash: String(hash),
        created_at: nowIso(),
      },
    ]);

  if (error) throw error;
  return true;
}

async function insertCertifiedInvoice({
  waId,
  businessProfileId = null,
  invoiceNumber,
  sequenceNumber,
  fiscalYear,
  issuedAt,
  seller,
  buyer,
  items,
  vatRate,
  currency = "XOF",
  complianceVersion = 1,
  complianceProvider = "kadi_internal",
  sourceChannel = "whatsapp",
  verificationBaseUrl = "https://kadi.app",
}) {
  const canonicalPayload = buildCanonicalCertifiedPayload({
    invoiceNumber,
    fiscalYear,
    sequenceNumber,
    issuedAt,
    seller,
    buyer,
    items,
    vatRate,
    currency,
    complianceVersion,
  });

  const complianceHash = buildComplianceHash(canonicalPayload);

  const invoiceRow = {
    wa_id: String(waId),
    business_profile_id: businessProfileId || null,

    invoice_number: canonicalPayload.invoice_number,
    sequence_number: canonicalPayload.sequence_number,
    fiscal_year: canonicalPayload.fiscal_year,

    status: "draft",
    locked: false,

    issued_at: canonicalPayload.issued_at,
    certified_at: null,
    cancelled_at: null,

    seller_name: canonicalPayload.seller.name,
    seller_ifu: canonicalPayload.seller.ifu,
    seller_phone: canonicalPayload.seller.phone,
    seller_address: canonicalPayload.seller.address,

    buyer_name: canonicalPayload.buyer.name,
    buyer_ifu: canonicalPayload.buyer.ifu,
    buyer_phone: canonicalPayload.buyer.phone,
    buyer_address: canonicalPayload.buyer.address,

    currency: canonicalPayload.currency,
    vat_rate: canonicalPayload.vat_rate,
    total_ht: canonicalPayload.total_ht,
    vat_amount: canonicalPayload.vat_amount,
    total_ttc: canonicalPayload.total_ttc,

    compliance_reference: null,
    compliance_hash: complianceHash,
    compliance_version: canonicalPayload.compliance_version,
    compliance_provider: complianceProvider,
    compliance_status: "draft",

    verification_url: null,
    qr_payload: null,

    pdf_media_id: null,
    pdf_filename: null,

    source_channel: sourceChannel,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  const { data: createdInvoice, error: invoiceError } = await supabase
    .from("kadi_certified_invoices")
    .insert([invoiceRow])
    .select("*")
    .single();

  if (invoiceError) throw invoiceError;

  const itemsRows = canonicalPayload.items.map((it) => ({
    invoice_id: createdInvoice.id,
    line_number: it.line_number,
    designation: it.designation,
    quantity: it.quantity,
    unit_price: it.unit_price,
    line_total_ht: it.line_total_ht,
    created_at: nowIso(),
  }));

  const { data: createdItems, error: itemsError } = await supabase
    .from("kadi_certified_invoice_items")
    .insert(itemsRows)
    .select("*");

  if (itemsError) throw itemsError;

  const verificationUrl = buildVerificationUrl(
    createdInvoice.id,
    verificationBaseUrl
  );
  const qrPayload = buildQrPayload({
    invoiceId: createdInvoice.id,
    verificationUrl,
    baseUrl: verificationBaseUrl,
  });

  const { data: updatedInvoice, error: verifyUpdateError } = await supabase
    .from("kadi_certified_invoices")
    .update({
      verification_url: verificationUrl,
      qr_payload: qrPayload,
      updated_at: nowIso(),
    })
    .eq("id", createdInvoice.id)
    .select("*")
    .single();

  if (verifyUpdateError) throw verifyUpdateError;

  const finalSnapshot = {
    ...canonicalPayload,
    invoice_id: updatedInvoice.id,
    verification_url: verificationUrl,
    qr_payload: qrPayload,
  };

  await createCertifiedInvoiceVersion({
    invoiceId: updatedInvoice.id,
    versionNumber: canonicalPayload.compliance_version,
    snapshotJson: finalSnapshot,
    hash: complianceHash,
  });

  await logCertifiedInvoiceEvent({
    invoiceId: updatedInvoice.id,
    eventType: "created",
    actorType: "user",
    actorId: waId,
    payloadHash: complianceHash,
    metadata: {
      invoice_number: updatedInvoice.invoice_number,
      total_ttc: updatedInvoice.total_ttc,
      source_channel: sourceChannel,
    },
  });

  return {
    invoice: updatedInvoice,
    items: createdItems || [],
    canonicalPayload: finalSnapshot,
    complianceHash,
  };
}

async function createCertifiedInvoiceDraft({
  waId,
  businessProfileId = null,
  seller,
  buyer,
  items,
  vatRate = 0,
  currency = "XOF",
  complianceVersion = 1,
  complianceProvider = "kadi_internal",
  sourceChannel = "whatsapp",
  verificationBaseUrl = "https://kadi.app",
  numberPrefix = "KADI-FEC-BF",
} = {}) {
  const fiscalYear = new Date().getUTCFullYear();
  const sequenceNumber = await getNextCertifiedSequence({ fiscalYear });
  const invoiceNumber = buildCertifiedInvoiceNumber({
    fiscalYear,
    sequenceNumber,
    prefix: numberPrefix,
  });

  return insertCertifiedInvoice({
    waId,
    businessProfileId,
    invoiceNumber,
    sequenceNumber,
    fiscalYear,
    issuedAt: nowIso(),
    seller,
    buyer,
    items,
    vatRate,
    currency,
    complianceVersion,
    complianceProvider,
    sourceChannel,
    verificationBaseUrl,
  });
}

async function markCertifiedInvoiceCertified({
  invoiceId,
  complianceReference = null,
  actorId = "system",
  provider = "kadi_internal",
}) {
  const { data: current, error: currentError } = await supabase
    .from("kadi_certified_invoices")
    .select("*")
    .eq("id", invoiceId)
    .single();

  if (currentError) throw currentError;

  const reference =
    safeText(complianceReference) ||
    buildComplianceReference({
      fiscalYear: current.fiscal_year,
      sequenceNumber: current.sequence_number,
    });

  const { data: updated, error } = await supabase
    .from("kadi_certified_invoices")
    .update({
      status: "certified",
      locked: true,
      certified_at: nowIso(),
      compliance_status: "certified",
      compliance_reference: reference,
      compliance_provider: safeText(provider, "kadi_internal"),
      updated_at: nowIso(),
    })
    .eq("id", invoiceId)
    .select("*")
    .single();

  if (error) throw error;

  await logCertifiedInvoiceEvent({
    invoiceId,
    eventType: "certified",
    actorType: "system",
    actorId,
    payloadHash: updated.compliance_hash,
    metadata: {
      compliance_reference: updated.compliance_reference,
      provider: updated.compliance_provider,
    },
  });

  return updated;
}

async function attachCertifiedInvoicePdf({
  invoiceId,
  pdfMediaId,
  pdfFilename,
  actorId = "system",
}) {
  const { data: updated, error } = await supabase
    .from("kadi_certified_invoices")
    .update({
      pdf_media_id: safeText(pdfMediaId, null),
      pdf_filename: safeText(pdfFilename, null),
      updated_at: nowIso(),
    })
    .eq("id", invoiceId)
    .select("*")
    .single();

  if (error) throw error;

  await logCertifiedInvoiceEvent({
    invoiceId,
    eventType: "pdf_attached",
    actorType: "system",
    actorId,
    payloadHash: updated.compliance_hash,
    metadata: {
      pdf_media_id: updated.pdf_media_id,
      pdf_filename: updated.pdf_filename,
    },
  });

  return updated;
}

async function getCertifiedInvoiceById(invoiceId) {
  const { data: invoice, error: invoiceError } = await supabase
    .from("kadi_certified_invoices")
    .select("*")
    .eq("id", invoiceId)
    .single();

  if (invoiceError) throw invoiceError;

  const { data: items, error: itemsError } = await supabase
    .from("kadi_certified_invoice_items")
    .select("*")
    .eq("invoice_id", invoiceId)
    .order("line_number", { ascending: true });

  if (itemsError) throw itemsError;

  return {
    invoice,
    items: items || [],
  };
}

async function getCertifiedInvoiceByNumber(invoiceNumber) {
  const value = safeText(invoiceNumber);
  if (!value) throw new Error("CERTIFIED_INVOICE_NUMBER_REQUIRED");

  const { data: invoice, error: invoiceError } = await supabase
    .from("kadi_certified_invoices")
    .select("*")
    .eq("invoice_number", value)
    .single();

  if (invoiceError) throw invoiceError;

  const { data: items, error: itemsError } = await supabase
    .from("kadi_certified_invoice_items")
    .select("*")
    .eq("invoice_id", invoice.id)
    .order("line_number", { ascending: true });

  if (itemsError) throw itemsError;

  return {
    invoice,
    items: items || [],
  };
}

async function listRecentCertifiedInvoices(waId, limit = 10) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));

  const { data, error } = await supabase
    .from("kadi_certified_invoices")
    .select(
      "id,invoice_number,buyer_name,total_ttc,status,issued_at,certified_at,created_at,pdf_media_id,pdf_filename"
    )
    .eq("wa_id", String(waId))
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (error) throw error;
  return data || [];
}

async function listCertifiedInvoiceEvents(invoiceId, limit = 50) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));

  const { data, error } = await supabase
    .from("kadi_certified_invoice_events")
    .select("*")
    .eq("invoice_id", invoiceId)
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (error) throw error;
  return data || [];
}

async function markCertifiedInvoiceRejected({
  invoiceId,
  reason,
  actorId = "system",
  provider = "kadi_internal",
}) {
  const rejectionReason = safeText(reason, "unknown_reason");

  const { data: updated, error } = await supabase
    .from("kadi_certified_invoices")
    .update({
      status: "rejected",
      locked: false,
      compliance_status: "rejected",
      compliance_provider: safeText(provider, "kadi_internal"),
      updated_at: nowIso(),
    })
    .eq("id", invoiceId)
    .select("*")
    .single();

  if (error) throw error;

  await logCertifiedInvoiceEvent({
    invoiceId,
    eventType: "rejected",
    actorType: "system",
    actorId,
    payloadHash: updated.compliance_hash,
    metadata: {
      reason: rejectionReason,
      provider: updated.compliance_provider,
    },
  });

  return updated;
}

async function markCertifiedInvoiceCancelled({
  invoiceId,
  reason,
  actorId = "system",
}) {
  const cancelReason = safeText(reason, "cancelled");

  const { data: updated, error } = await supabase
    .from("kadi_certified_invoices")
    .update({
      status: "cancelled",
      locked: true,
      cancelled_at: nowIso(),
      compliance_status: "cancelled",
      updated_at: nowIso(),
    })
    .eq("id", invoiceId)
    .select("*")
    .single();

  if (error) throw error;

  await logCertifiedInvoiceEvent({
    invoiceId,
    eventType: "cancelled",
    actorType: "system",
    actorId,
    payloadHash: updated.compliance_hash,
    metadata: {
      reason: cancelReason,
    },
  });

  return updated;
}

module.exports = {
  getNextCertifiedSequence,
  logCertifiedInvoiceEvent,
  createCertifiedInvoiceVersion,
  createCertifiedInvoiceDraft,
  insertCertifiedInvoice,
  markCertifiedInvoiceCertified,
  attachCertifiedInvoicePdf,
  getCertifiedInvoiceById,
  getCertifiedInvoiceByNumber,
  listRecentCertifiedInvoices,
  listCertifiedInvoiceEvents,
  markCertifiedInvoiceRejected,
  markCertifiedInvoiceCancelled,
};