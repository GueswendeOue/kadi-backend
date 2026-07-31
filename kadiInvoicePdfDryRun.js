"use strict";

const PDFDocument = require("pdfkit");
const { PDFDocument: PdfLibDocument } = require("pdf-lib");
const { buildPdfBuffer } = require("./kadiPdf");

function renderInvoiceEstimatePdfLegacy(invoice) {
  return new Promise((resolve, reject) => {
    if (!invoice || !Array.isArray(invoice.items) || invoice.items.length < 1) {
      resolve({ ok: false, error: "INVOICE_INVALID" });
      return;
    }
    const doc = new PDFDocument({ size: "A4", margin: 48, bufferPages: true, autoFirstPage: false });
    const chunks = [];
    const tableHeaderPages = [];
    let pageIndex = -1;
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", async () => {
      try {
        const buffer = Buffer.concat(chunks);
        const parsed = await PdfLibDocument.load(buffer);
        resolve({ ok: true, value: Object.freeze({
          buffer,
          page_count: parsed.getPageCount(),
          table_header_pages: Object.freeze(tableHeaderPages.slice()),
          totals_page: parsed.getPageCount(),
          page_labels: Object.freeze(Array.from({ length: parsed.getPageCount() }, (_, index) => `Page ${index + 1} sur ${parsed.getPageCount()}`)),
          debit_performed: false,
          sent: false,
          temporary_artifact_created: false,
          temporary_artifact_cleaned: true,
        }) });
      } catch {
        resolve({ ok: false, error: "PDF_DRY_RUN_FAILED" });
      }
    });

    function tableHeader(continuation) {
      if (continuation) doc.fontSize(9).fillColor("#555").text("FACTURE — suite", 48, 35);
      doc.fontSize(9).fillColor("#111").text("Désignation", 48, doc.y + 10).text("Qté", 340, doc.y - 11).text("Prix", 405, doc.y - 11).text("Total", 490, doc.y - 11);
      doc.moveTo(48, doc.y + 3).lineTo(547, doc.y + 3).stroke();
      doc.moveDown(0.6);
      tableHeaderPages.push(pageIndex + 1);
    }
    function addPage(first = false) {
      doc.addPage();
      pageIndex += 1;
      if (first) {
        doc.fontSize(17).fillColor("#111").text(invoice.document_label || "FACTURE COMMERCIALE");
        doc.fontSize(9).text(`Client : ${invoice.client?.name || "Non renseigné"}`);
      }
      tableHeader(!first);
    }
    addPage(true);
    for (const item of invoice.items) {
      const rowHeight = Math.max(24, doc.heightOfString(item.designation, { width: 275 }) + 10);
      if (doc.y + rowHeight > 720) addPage(false);
      const y = doc.y + 6;
      doc.fontSize(9).text(item.designation, 48, y, { width: 275 });
      doc.text(String(item.quantity), 340, y, { width: 55, align: "right" });
      doc.text(String(item.unit_price), 405, y, { width: 70, align: "right" });
      doc.text(String(item.line_total), 490, y, { width: 57, align: "right" });
      doc.y = y + rowHeight;
    }
    if (doc.y > 650) addPage(false);
    doc.moveDown().fontSize(10).text(`Sous-total : ${invoice.subtotal_excluding_tax} FCFA`, { align: "right" });
    doc.text(`Total : ${invoice.grand_total} FCFA`, { align: "right" });
    if (invoice.payment_terms) doc.moveDown().fontSize(8).text(`Conditions : ${invoice.payment_terms}`);
    if (invoice.note) doc.moveDown().fontSize(8).text(`Note : ${invoice.note}`);
    const range = doc.bufferedPageRange();
    for (let index = 0; index < range.count; index += 1) {
      doc.switchToPage(index);
      doc.fontSize(8).fillColor("#666").text(`Page ${index + 1} sur ${range.count}`, 48, 780, { width: 499, align: "center", lineBreak: false });
    }
    doc.end();
  });
}

function rendererType(documentType) {
  if (documentType == null) return "FACTURE";
  if (documentType === "invoice") return "FACTURE";
  if (documentType === "quote") return "DEVIS";
  if (documentType === "receipt") return "RECU";
  return null;
}

async function renderInvoiceEstimatePdf(
  invoice,
  { renderer = buildPdfBuffer, businessProfile = null, logoBuffer = null } = {}
) {
  if (!invoice || !Array.isArray(invoice.items) || invoice.items.length < 1) {
    return { ok: false, error: "INVOICE_INVALID" };
  }
  const type = rendererType(invoice.document_type);
  if (!type) return { ok: false, error: "PDF_RENDERER_UNSUPPORTED_DOCUMENT_TYPE" };
  try {
    const buffer = await renderer({
      docData: {
        type,
        docNumber: invoice.document_number || "BROUILLON",
        date: invoice.transaction_date || invoice.issue_date || "—",
        client: invoice.client?.name || "—",
        clientPhone: invoice.client?.phone || null,
        subject: invoice.subject || null,
        items: invoice.items.map((item) => ({
          label: item.designation,
          qty: item.quantity,
          unitPrice: item.unit_price,
          amount: item.line_total,
        })),
        total: invoice.grand_total,
      },
      businessProfile,
      logoBuffer,
    });
    const parsed = await PdfLibDocument.load(buffer);
    const pageCount = parsed.getPageCount();
    return { ok: true, value: Object.freeze({
      buffer,
      page_count: pageCount,
      page_count_mode: "final_renderer",
      page_count_source: "kadiPdf.buildPdfBuffer",
      page_count_production_safe: true,
      production_debit_authorized: false,
      debit_performed: false,
      sent: false,
      temporary_artifact_created: false,
      temporary_artifact_cleaned: true,
    }) };
  } catch {
    return { ok: false, error: "PDF_DRY_RUN_FAILED" };
  }
}

module.exports = { renderInvoiceEstimatePdf, rendererType };
