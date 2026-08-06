"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { canonicalFinalFilename } = require("../kadiV1FinalFilename");

test("FACTURE FINAL uses facture_<document_number>.pdf", () => {
  assert.equal(
    canonicalFinalFilename({ document_type: "FACTURE", invoice_kind: null, document_number: "FA-20260806190633-A0EAC605" }),
    "facture_FA-20260806190633-A0EAC605.pdf"
  );
});

test("FACTURE PROFORMA uses facture-proforma_<document_number>.pdf", () => {
  assert.equal(
    canonicalFinalFilename({ document_type: "FACTURE", invoice_kind: "PROFORMA", document_number: "FA-20260806190633-A0EAC605" }),
    "facture-proforma_FA-20260806190633-A0EAC605.pdf"
  );
});

test("DEVIS uses devis_<document_number>.pdf", () => {
  assert.equal(
    canonicalFinalFilename({ document_type: "DEVIS", invoice_kind: null, document_number: "DV-20260806190633-A0EAC605" }),
    "devis_DV-20260806190633-A0EAC605.pdf"
  );
});

test("RECU uses recu_<document_number>.pdf", () => {
  assert.equal(
    canonicalFinalFilename({ document_type: "RECU", invoice_kind: null, document_number: "RC-20260806192517-D3E4F5G6" }),
    "recu_RC-20260806192517-D3E4F5G6.pdf"
  );
});

test("DECHARGE uses decharge_<document_number>.pdf", () => {
  assert.equal(
    canonicalFinalFilename({ document_type: "DECHARGE", invoice_kind: null, document_number: "DC-20260806190633-A0EAC605" }),
    "decharge_DC-20260806190633-A0EAC605.pdf"
  );
});

test("filename is deterministic — same input always produces the same output", () => {
  const input = { document_type: "FACTURE", invoice_kind: null, document_number: "FA-20260806190633-A0EAC605" };
  assert.equal(canonicalFinalFilename(input), canonicalFinalFilename({ ...input }));
});

test("filename is ASCII-only and contains exactly one .pdf extension", () => {
  const name = canonicalFinalFilename({ document_type: "FACTURE", invoice_kind: null, document_number: "FA-20260806190633-A0EAC605" });
  assert.ok(/^[\x20-\x7E]+$/.test(name));
  assert.equal((name.match(/\.pdf/g) || []).length, 1);
  assert.ok(name.endsWith(".pdf"));
});

test("filename never contains BROUILLON", () => {
  const name = canonicalFinalFilename({ document_type: "FACTURE", invoice_kind: null, document_number: "FA-20260806190633-A0EAC605" });
  assert.ok(!/BROUILLON/i.test(name));
});

test("document-type prefix is lowercase even though document_number is uppercase", () => {
  const name = canonicalFinalFilename({ document_type: "RECU", invoice_kind: null, document_number: "RC-20260806192517-D3E4F5G6" });
  assert.ok(name.startsWith("recu_"));
  assert.ok(!name.startsWith("RECU_"));
});

test("official reference (document_number) is preserved verbatim", () => {
  const name = canonicalFinalFilename({ document_type: "DEVIS", invoice_kind: null, document_number: "DV-20260806190633-A0EAC605" });
  assert.ok(name.includes("DV-20260806190633-A0EAC605"));
});

test("rejects unknown document_type", () => {
  assert.equal(canonicalFinalFilename({ document_type: "UNKNOWN", document_number: "X-1" }), null);
});

test("rejects missing or malformed document_number", () => {
  assert.equal(canonicalFinalFilename({ document_type: "FACTURE", document_number: null }), null);
  assert.equal(canonicalFinalFilename({ document_type: "FACTURE", document_number: "" }), null);
  assert.equal(canonicalFinalFilename({ document_type: "FACTURE", document_number: "has spaces" }), null);
  assert.equal(canonicalFinalFilename({ document_type: "FACTURE", document_number: "héllo" }), null);
});

test("old backend was never generic facture.pdf or recu.pdf for a new document", () => {
  const name = canonicalFinalFilename({ document_type: "FACTURE", invoice_kind: null, document_number: "FA-20260806190633-A0EAC605" });
  assert.notEqual(name, "facture.pdf");
  const receiptName = canonicalFinalFilename({ document_type: "RECU", invoice_kind: null, document_number: "RC-20260806192517-D3E4F5G6" });
  assert.notEqual(receiptName, "recu.pdf");
});
