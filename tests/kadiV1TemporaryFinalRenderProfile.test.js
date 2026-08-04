"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createExistingPdfTemporaryRenderer,
} = require("../kadiV1TemporaryRenderService");
const {
  createExistingPdfFinalRenderer,
} = require("../kadiV1FinalGenerationService");

// P8.A1-B objective 4/18 — the temporary render (used to count pages and
// quote a cost) and the final render (delivered PDF) must receive exactly
// the same resolved issuer profile. createExistingPdfFinalRenderer is a
// direct alias of createExistingPdfTemporaryRenderer, so proving the
// temporary path resolves and forwards owner_name/business_name correctly
// proves both paths structurally, and this test asserts the alias itself.

function facturePreview(overrides = {}) {
  return {
    structured_preview: {
      document_type: "FACTURE",
      document_number: null,
      issued_at: null,
      issuer: { profile_id: "issuer:1" },
      client: { name: "Client Test" },
      items: [{ item_id: "item:1", description: "Ordinateur", quantity_millis: 1000, unit: "unité", unit_price: 250000, line_total: 250000 }],
      total: 250000,
      ...overrides,
    },
  };
}

function dechargePreview() {
  return {
    structured_preview: {
      document_type: "DECHARGE",
      document_number: null,
      issued_at: null,
      issuer: null,
      beneficiary: "Awa Test",
      content: { type: "GOODS", description: "Clés", amount: null },
      total: null,
    },
  };
}

function bufferPdf() {
  return Buffer.from("%PDF-1.4 fake", "utf8");
}

function issuerReader(profile, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async getIssuerProfileById(command) {
      calls.push(command);
      if (fail) return { ok: false, error: "ISSUER_PROFILE_LOOKUP_FAILED" };
      return profile ? { ok: true, value: profile } : { ok: false, error: "ISSUER_PROFILE_NOT_FOUND" };
    },
  };
}

test("createExistingPdfFinalRenderer delegates directly to createExistingPdfTemporaryRenderer with the same options", () => {
  // kadiV1FinalGenerationService.js: createExistingPdfFinalRenderer(options)
  // is `return createExistingPdfTemporaryRenderer(options);` — a thin
  // pass-through, not a separate implementation, so there is a single
  // resolution path for both the temporary and the final render.
  const source = require("node:fs").readFileSync(require.resolve("../kadiV1FinalGenerationService"), "utf8");
  assert.match(source, /function createExistingPdfFinalRenderer\(options = \{\}\) \{\s*return createExistingPdfTemporaryRenderer\(options\);\s*\}/);
});

test("owner_name and business_name resolved for the temporary render reach the underlying PDF renderer", async () => {
  const profile = { business_name: "Kadi Boutique", owner_name: "Awa Traoré", address: null, phone: null, email: null };
  let received;
  const rendererResolver = () => async (args) => { received = args; return bufferPdf(); };
  const renderer = createExistingPdfTemporaryRenderer({ rendererResolver, issuerProfileReader: issuerReader(profile) });
  const result = await renderer.render({ preview: facturePreview() });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(received.businessProfile, profile);
  assert.equal(received.businessProfile.owner_name, "Awa Traoré");
  assert.equal(received.businessProfile.business_name, "Kadi Boutique");
});

test("the same call, made through the final-renderer alias, resolves the identical profile", async () => {
  const profile = { business_name: "Kadi Boutique", owner_name: "Awa Traoré", address: null, phone: null, email: null };
  let receivedTemp;
  let receivedFinal;
  const reader = issuerReader(profile);
  const tempRenderer = createExistingPdfTemporaryRenderer({
    rendererResolver: () => async (args) => { receivedTemp = args; return bufferPdf(); },
    issuerProfileReader: reader,
  });
  const finalRenderer = createExistingPdfFinalRenderer({
    rendererResolver: () => async (args) => { receivedFinal = args; return bufferPdf(); },
    issuerProfileReader: reader,
  });
  await tempRenderer.render({ preview: facturePreview() });
  await finalRenderer.render({ preview: facturePreview() });
  assert.deepEqual(receivedTemp.businessProfile, receivedFinal.businessProfile);
});

test("an unresolvable issuer profile fails closed and never renders an anonymous PDF", async () => {
  let rendererCalled = false;
  const rendererResolver = () => async () => { rendererCalled = true; return bufferPdf(); };
  const renderer = createExistingPdfTemporaryRenderer({ rendererResolver, issuerProfileReader: issuerReader(null) });
  const result = await renderer.render({ preview: facturePreview() });
  assert.deepEqual(result, { ok: false, error: "TEMPORARY_RENDER_ISSUER_UNRESOLVED" });
  assert.equal(rendererCalled, false, "the PDF renderer must never be invoked when the profile is unresolved");
});

test("a failing issuer lookup fails closed the same way as a missing profile", async () => {
  let rendererCalled = false;
  const rendererResolver = () => async () => { rendererCalled = true; return bufferPdf(); };
  const renderer = createExistingPdfTemporaryRenderer({ rendererResolver, issuerProfileReader: issuerReader(null, { fail: true }) });
  const result = await renderer.render({ preview: facturePreview() });
  assert.deepEqual(result, { ok: false, error: "TEMPORARY_RENDER_ISSUER_UNRESOLVED" });
  assert.equal(rendererCalled, false);
});

test("a FACTURE preview with no issuer_profile_id at all fails closed instead of rendering anonymously", async () => {
  let rendererCalled = false;
  const rendererResolver = () => async () => { rendererCalled = true; return bufferPdf(); };
  const renderer = createExistingPdfTemporaryRenderer({ rendererResolver, issuerProfileReader: issuerReader({ business_name: "X", owner_name: "Y" }) });
  const result = await renderer.render({ preview: facturePreview({ issuer: null }) });
  assert.deepEqual(result, { ok: false, error: "TEMPORARY_RENDER_ISSUER_UNRESOLVED" });
  assert.equal(rendererCalled, false);
});

test("DECHARGE has no issuer_profile_id by design and renders without querying the issuer port", async () => {
  const reader = issuerReader({ business_name: "Should not be used" });
  let received;
  const rendererResolver = () => async (args) => { received = args; return bufferPdf(); };
  const renderer = createExistingPdfTemporaryRenderer({ rendererResolver, issuerProfileReader: reader });
  const result = await renderer.render({ preview: dechargePreview() });
  assert.equal(result.ok, true, result.error);
  assert.equal(received.businessProfile, null);
  assert.deepEqual(reader.calls, []);
});

test("constructing the renderer without an issuer profile reader fails closed immediately", () => {
  assert.throws(
    () => createExistingPdfTemporaryRenderer({ rendererResolver: () => async () => bufferPdf() }),
    /TEMPORARY_RENDER_ISSUER_PROFILE_READER_REQUIRED/
  );
});
