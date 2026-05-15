"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  makeCertifiedVerificationHandler,
} = require("../kadiCertified/kadiCertifiedVerifyRoute");

function withoutAllowedOfficialNegation(text = "") {
  return String(text).replace(/MODE TEST INTERNE — NON CERTIFIÉ OFFICIELLEMENT/g, "");
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    type(value) {
      this.headers["content-type"] = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    },
    json(value) {
      this.headers["content-type"] = "application/json";
      this.body = value;
      return this;
    },
  };
}

test("Pré-FEC verification route returns readable test page for existing invoice", async () => {
  const handler = makeCertifiedVerificationHandler({
    getCertifiedInvoiceForVerificationById: async (id) => ({
      id,
      invoice_number: "KADI-FEC-BF-2026-000001",
      issued_at: "2026-05-05T00:00:00.000Z",
      status: "certified",
      total_ttc: 1180,
      currency: "XOF",
      compliance_hash: "abc123",
    }),
  });

  const res = makeRes();
  await handler(
    {
      params: { id: "inv-1" },
      get: () => "text/html",
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "html");
  assert.match(res.body, /KADI — Vérification Pré-FEC interne/);
  assert.match(res.body, /MODE TEST INTERNE — NON CERTIFIÉ OFFICIELLEMENT/);
  assert.match(res.body, /KADI-FEC-BF-2026-000001/);
  assert.match(res.body, /certified/);
  assert.match(res.body, /1 180 XOF|1 180 XOF/);
  assert.match(res.body, /abc123/);
  assert.match(res.body, /test interne/);

  const restrictedText = withoutAllowedOfficialNegation(res.body);
  assert.doesNotMatch(restrictedText, /homolog/i);
  assert.doesNotMatch(restrictedText, /conforme DGI/i);
  assert.doesNotMatch(restrictedText, /certifié officiellement/i);
  assert.doesNotMatch(restrictedText, /certifie officiellement/i);
});

test("Pré-FEC verification route returns clean 404 when invoice is missing", async () => {
  const handler = makeCertifiedVerificationHandler({
    getCertifiedInvoiceForVerificationById: async () => null,
  });

  const res = makeRes();
  await handler(
    {
      params: { id: "missing" },
      get: () => "text/html",
    },
    res
  );

  assert.equal(res.statusCode, 404);
  assert.equal(res.headers["content-type"], "text/plain");
  assert.equal(res.body, "Facture Pré-FEC introuvable.");
});

test("Pré-FEC verification route supports JSON when requested", async () => {
  const handler = makeCertifiedVerificationHandler({
    getCertifiedInvoiceForVerificationById: async () => ({
      invoice_number: "KADI-FEC-BF-2026-000002",
      issued_at: "2026-05-05T00:00:00.000Z",
      status: "draft",
      total_ttc: 500,
      currency: "XOF",
      compliance_hash: "hash-2",
    }),
  });

  const res = makeRes();
  await handler(
    {
      params: { id: "inv-2" },
      get: () => "application/json",
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/json");
  assert.equal(res.body.notice, "MODE TEST INTERNE — NON CERTIFIÉ OFFICIELLEMENT");
  assert.equal(res.body.status, "test interne / pré-FEC");
  assert.equal(res.body.invoiceNumber, "KADI-FEC-BF-2026-000002");
  assert.doesNotMatch(res.body.warning, /homolog/i);
  assert.doesNotMatch(res.body.warning, /conforme DGI/i);
  assert.doesNotMatch(res.body.warning, /certifié officiellement/i);
});
