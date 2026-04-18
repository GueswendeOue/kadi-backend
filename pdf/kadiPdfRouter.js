"use strict";

const { resolveRendererKey } = require("./kadiPdfCommon");

const { buildFacturePdf } = require("./kadiPdfFacture");
const { buildFactureProformaPdf } = require("./kadiPdfFactureProforma");
const { buildDevisPdf } = require("./kadiPdfDevis");
const { buildRecuA4Pdf } = require("./kadiPdfRecuA4");
const { buildRecuCompactPdf } = require("./kadiPdfRecuCompact");
const { buildDechargePdf } = require("./kadiPdfDecharge");

function resolveRenderer(docData = {}) {
  const key = resolveRendererKey(docData);

  switch (key) {
    case "facture":
      return buildFacturePdf;
    case "facture_proforma":
      return buildFactureProformaPdf;
    case "devis":
      return buildDevisPdf;
    case "recu_a4":
      return buildRecuA4Pdf;
    case "recu_compact":
      return buildRecuCompactPdf;
    case "decharge":
      return buildDechargePdf;
    default:
      throw new Error("PDF_RENDERER_UNSUPPORTED_TYPE");
  }
}

module.exports = {
  resolveRenderer,
};