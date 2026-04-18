"use strict";

const { makeKadiQrBuffer } = require("./pdf/kadiPdfCommon");
const { resolveRenderer } = require("./pdf/kadiPdfRouter");

async function buildPdfBuffer({
  docData = {},
  businessProfile = null,
  logoBuffer = null,
}) {
  const KADI_E164 = process.env.KADI_E164 || "22679239027";
  const KADI_PREFILL =
    process.env.KADI_QR_PREFILL || "Bonjour KADI, je veux créer un document";

  const qr = await makeKadiQrBuffer({
    fullNumberE164: KADI_E164,
    prefillText: KADI_PREFILL,
  });

  const renderer = resolveRenderer(docData);

  return renderer({
    docData,
    businessProfile,
    logoBuffer,
    qr,
    kadiE164: KADI_E164,
  });
}

module.exports = {
  buildPdfBuffer,
};