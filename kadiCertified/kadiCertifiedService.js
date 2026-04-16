"use strict";

const {
  safeText,
  normalizePhone,
  computeCertifiedTotals,
} = require("./kadiCertifiedSecurity");

function makeKadiCertifiedService(deps) {
  const {
    getOrCreateProfile,
    getSignedLogoUrl,
    downloadSignedUrlToBuffer,
    uploadMediaBuffer,

    createCertifiedInvoiceDraft,
    markCertifiedInvoiceCertified,
    attachCertifiedInvoicePdf,
    getCertifiedInvoiceById,

    buildCertifiedInvoicePdfBuffer,
  } = deps;

  function toNum(v, def = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }

  function assertRequired(value, errorCode) {
    if (!safeText(value)) {
      throw new Error(errorCode);
    }
    return safeText(value);
  }

  function buildSellerFromProfile(profile = {}) {
    const sellerName = safeText(profile?.business_name);
    const sellerIfu = safeText(profile?.ifu || profile?.business_ifu);

    if (!sellerName) throw new Error("CERTIFIED_SELLER_NAME_REQUIRED");
    if (!sellerIfu) throw new Error("CERTIFIED_SELLER_IFU_REQUIRED");

    return {
      name: sellerName,
      ifu: sellerIfu,
      phone: normalizePhone(profile?.phone),
      address: safeText(profile?.address, null),
    };
  }

  function buildBuyerFromDraft(draft = {}) {
    const buyerName = assertRequired(
      draft?.buyer?.name,
      "CERTIFIED_BUYER_NAME_REQUIRED"
    );

    return {
      name: buyerName,
      ifu: safeText(draft?.buyer?.ifu, null),
      phone: normalizePhone(draft?.buyer?.phone),
      address: safeText(draft?.buyer?.address, null),
    };
  }

  function buildItemsFromDraft(draft = {}) {
    const rawItems = Array.isArray(draft?.items) ? draft.items : [];

    const mapped = rawItems.map((it) => ({
      designation: safeText(it?.designation ?? it?.label),
      quantity: toNum(it?.quantity ?? it?.qty, 0),
      unit_price: toNum(it?.unit_price ?? it?.unitPrice, 0),
      line_total_ht:
        it?.line_total_ht != null
          ? toNum(it.line_total_ht, 0)
          : toNum(it?.quantity ?? it?.qty, 0) *
            toNum(it?.unit_price ?? it?.unitPrice, 0),
    }));

    if (!mapped.length) {
      throw new Error("CERTIFIED_ITEMS_REQUIRED");
    }

    return mapped;
  }

  function normalizeDraftForCertifiedInvoice(draft = {}, profile = {}) {
    const seller = buildSellerFromProfile(profile);
    const buyer = buildBuyerFromDraft(draft);
    const items = buildItemsFromDraft(draft);
    const vatRate = toNum(draft?.vat_rate, 0);

    const totals = computeCertifiedTotals({
      items,
      vatRate,
    });

    return {
      seller,
      buyer,
      items: totals.items,
      vat_rate: totals.vat_rate,
      total_ht: totals.total_ht,
      vat_amount: totals.vat_amount,
      total_ttc: totals.total_ttc,
      currency: safeText(draft?.currency, "XOF"),
    };
  }

  async function tryLoadBusinessLogoBuffer(profile = null) {
    if (!profile?.logo_path) return null;
    if (typeof getSignedLogoUrl !== "function") return null;
    if (typeof downloadSignedUrlToBuffer !== "function") return null;

    try {
      const signedUrl = await getSignedLogoUrl(profile.logo_path);
      return await downloadSignedUrlToBuffer(signedUrl);
    } catch (_) {
      return null;
    }
  }

  async function createCertifiedInvoiceFromDraft({
    waId,
    draft,
    verificationBaseUrl = "https://kadi.app",
    sourceChannel = "whatsapp",
  }) {
    if (!waId) throw new Error("CERTIFIED_WA_ID_REQUIRED");
    if (!draft || typeof draft !== "object") {
      throw new Error("CERTIFIED_DRAFT_REQUIRED");
    }

    if (typeof getOrCreateProfile !== "function") {
      throw new Error("CERTIFIED_PROFILE_PROVIDER_MISSING");
    }

    const profile = await getOrCreateProfile(waId);
    const normalized = normalizeDraftForCertifiedInvoice(draft, profile);

    const created = await createCertifiedInvoiceDraft({
      waId,
      businessProfileId: profile?.id || null,
      seller: normalized.seller,
      buyer: normalized.buyer,
      items: normalized.items,
      vatRate: normalized.vat_rate,
      currency: normalized.currency,
      sourceChannel,
      verificationBaseUrl,
    });

    const certifiedInvoice = await markCertifiedInvoiceCertified({
      invoiceId: created.invoice.id,
      actorId: waId,
      provider: "kadi_internal",
    });

    const logoBuffer = await tryLoadBusinessLogoBuffer(profile);

    const pdfBuffer = await buildCertifiedInvoicePdfBuffer({
      invoice: certifiedInvoice,
      items: created.items,
      businessProfile: profile,
      logoBuffer,
    });

    const filename = `${certifiedInvoice.invoice_number}.pdf`;

    if (typeof uploadMediaBuffer !== "function") {
      throw new Error("CERTIFIED_UPLOAD_MEDIA_MISSING");
    }

    const uploaded = await uploadMediaBuffer({
      buffer: pdfBuffer,
      filename,
      mimeType: "application/pdf",
    });

    if (!uploaded?.id) {
      throw new Error("CERTIFIED_PDF_UPLOAD_FAILED");
    }

    const invoiceWithPdf = await attachCertifiedInvoicePdf({
      invoiceId: certifiedInvoice.id,
      pdfMediaId: uploaded.id,
      pdfFilename: filename,
      actorId: waId,
    });

    return {
      invoice: invoiceWithPdf,
      items: created.items,
      pdfBuffer,
      mediaId: uploaded.id,
      filename,
      profile,
    };
  }

  async function rebuildCertifiedInvoicePdf({
    invoiceId,
    verificationBaseUrl = "https://kadi.app",
  }) {
    if (!invoiceId) throw new Error("CERTIFIED_INVOICE_ID_REQUIRED");

    const found = await getCertifiedInvoiceById(invoiceId);
    const invoice = found?.invoice;
    const items = found?.items || [];

    if (!invoice) {
      throw new Error("CERTIFIED_INVOICE_NOT_FOUND");
    }

    const profile =
      typeof getOrCreateProfile === "function"
        ? await getOrCreateProfile(invoice.wa_id)
        : null;

    const logoBuffer = await tryLoadBusinessLogoBuffer(profile);

    const pdfBuffer = await buildCertifiedInvoicePdfBuffer({
      invoice,
      items,
      businessProfile: profile,
      logoBuffer,
    });

    const filename = `${invoice.invoice_number}.pdf`;

    if (typeof uploadMediaBuffer !== "function") {
      throw new Error("CERTIFIED_UPLOAD_MEDIA_MISSING");
    }

    const uploaded = await uploadMediaBuffer({
      buffer: pdfBuffer,
      filename,
      mimeType: "application/pdf",
    });

    if (!uploaded?.id) {
      throw new Error("CERTIFIED_PDF_UPLOAD_FAILED");
    }

    const invoiceWithPdf = await attachCertifiedInvoicePdf({
      invoiceId: invoice.id,
      pdfMediaId: uploaded.id,
      pdfFilename: filename,
      actorId: invoice.wa_id || "system",
    });

    return {
      invoice: invoiceWithPdf,
      items,
      pdfBuffer,
      mediaId: uploaded.id,
      filename,
      profile,
      verificationBaseUrl,
    };
  }

  return {
    buildSellerFromProfile,
    buildBuyerFromDraft,
    buildItemsFromDraft,
    normalizeDraftForCertifiedInvoice,
    tryLoadBusinessLogoBuffer,
    createCertifiedInvoiceFromDraft,
    rebuildCertifiedInvoicePdf,
  };
}

module.exports = {
  makeKadiCertifiedService,
};