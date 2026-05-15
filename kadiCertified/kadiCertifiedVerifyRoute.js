"use strict";

function safeText(v, def = "-") {
  const s = String(v ?? "").trim();
  return s || def;
}

function escapeHtml(v) {
  return safeText(v, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatMoney(v, currency = "XOF") {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return `${Math.round(n).toLocaleString("fr-FR")} ${safeText(currency, "XOF")}`;
}

function formatDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("fr-FR", { timeZone: "UTC" });
}

function buildCertifiedVerificationPayload(invoice) {
  return {
    title: "KADI — Vérification Pré-FEC interne",
    notice: "MODE TEST INTERNE — NON CERTIFIÉ OFFICIELLEMENT",
    status: "test interne / pré-FEC",
    invoiceNumber: safeText(invoice?.invoice_number || invoice?.compliance_reference),
    issuedAt: safeText(invoice?.issued_at || invoice?.certified_at || invoice?.created_at),
    internalStatus: safeText(invoice?.status || invoice?.compliance_status, "draft"),
    total: Number(invoice?.total_ttc ?? invoice?.total ?? 0),
    currency: safeText(invoice?.currency, "XOF"),
    hash: safeText(invoice?.compliance_hash || invoice?.hash),
    warning:
      "Ce document est une facture structurée de test interne. Il n’a pas de valeur fiscale officielle.",
  };
}

function renderCertifiedVerificationHtml(payload) {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(payload.title)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; padding: 32px; color: #111; background: #f7f7f5; }
    main { max-width: 720px; margin: 0 auto; background: #fff; border: 1px solid #ddd; padding: 24px; }
    h1 { font-size: 24px; margin: 0 0 12px; }
    .notice { font-weight: 700; border: 2px solid #111; padding: 10px; margin: 16px 0; }
    dl { display: grid; grid-template-columns: 180px 1fr; gap: 10px 16px; }
    dt { font-weight: 700; }
    dd { margin: 0; word-break: break-word; }
    .warning { margin-top: 20px; padding: 12px; background: #fff4d6; border: 1px solid #e0b84f; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(payload.title)}</h1>
    <div class="notice">${escapeHtml(payload.notice)}</div>
    <dl>
      <dt>Statut</dt><dd>${escapeHtml(payload.status)}</dd>
      <dt>Facture</dt><dd>${escapeHtml(payload.invoiceNumber)}</dd>
      <dt>Date d'émission</dt><dd>${escapeHtml(formatDate(payload.issuedAt))}</dd>
      <dt>Statut interne</dt><dd>${escapeHtml(payload.internalStatus)}</dd>
      <dt>Montant total</dt><dd>${escapeHtml(formatMoney(payload.total, payload.currency))}</dd>
      <dt>Empreinte</dt><dd>${escapeHtml(payload.hash)}</dd>
    </dl>
    <p class="warning">${escapeHtml(payload.warning)}</p>
  </main>
</body>
</html>`;
}

function wantsJson(req) {
  return String(req.get?.("accept") || "").toLowerCase().includes("application/json");
}

function makeCertifiedVerificationHandler({ getCertifiedInvoiceForVerificationById }) {
  return async function handleCertifiedVerification(req, res) {
    try {
      const invoice = await getCertifiedInvoiceForVerificationById(req.params.id);

      if (!invoice) {
        const payload = { error: "PREFEC_INVOICE_NOT_FOUND" };
        if (wantsJson(req)) return res.status(404).json(payload);
        return res.status(404).type("text/plain").send("Facture Pré-FEC introuvable.");
      }

      const payload = buildCertifiedVerificationPayload(invoice);
      if (wantsJson(req)) return res.status(200).json(payload);
      return res.status(200).type("html").send(renderCertifiedVerificationHtml(payload));
    } catch (e) {
      console.error("💥 Pré-FEC verification error:", e);
      const payload = { error: "PREFEC_VERIFICATION_ERROR" };
      if (wantsJson(req)) return res.status(500).json(payload);
      return res.status(500).type("text/plain").send("Erreur de vérification Pré-FEC.");
    }
  };
}

module.exports = {
  buildCertifiedVerificationPayload,
  renderCertifiedVerificationHtml,
  makeCertifiedVerificationHandler,
};
