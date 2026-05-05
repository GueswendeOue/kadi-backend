"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeKadiMenus } = require("../kadiMenus");
const { makeKadiCommandFlow } = require("../kadiCommandFlow");
const { makeKadiPriorityRouter } = require("../kadiPriorityRouter");
const { makeKadiCertifiedFlow } = require("../kadiCertified/kadiCertifiedFlow");
const { buildCertifiedInvoicePdfBuffer } = require("../kadiCertified/kadiCertifiedPdf");

const FEC_PREPARATION_MESSAGE =
  "La facture électronique certifiée est en préparation. Pour le moment, Kadi génère des factures classiques.";

test("public documents menu does not expose FEC option", async () => {
  const lists = [];
  const menus = makeKadiMenus({
    sendButtons: async () => {},
    sendList: async (to, payload) => lists.push({ to, payload }),
    getOrCreateProfile: async () => ({}),
    STAMP_ONE_TIME_COST: 1,
  });

  await menus.sendDocsMenu("22670000000");

  const rows = lists[0].payload.sections.flatMap((section) => section.rows);
  assert.equal(rows.some((row) => row.id === "DOC_FEC"), false);
  assert.equal(
    rows.some((row) => String(row.title).toLowerCase().includes("fec")),
    false
  );
});

test("non-admin FEC text requests are blocked with preparation message", async () => {
  const calls = [];
  let started = false;
  const router = makeKadiPriorityRouter({
    norm: (text) => String(text || ""),
    logger: { error: () => {} },
    sendText: async (to, text) => calls.push({ to, text }),
    sendHomeMenu: async () => {},
    sendDocsMenu: async () => {},
    startProfileFlow: async () => {},
    replyBalance: async () => {},
    sendRechargePacksMenu: async () => {},
    sendStampMenu: async () => {},
    sendProfileMenu: async () => {},
    sendCreditsMenu: async () => {},
    ensureAdmin: () => false,
    startCertifiedInvoiceFlow: async () => {
      started = true;
    },
  });

  const handled = await router.handleUltraPriorityText(
    "22670000000",
    "facture certifiée"
  );

  assert.equal(handled, true);
  assert.equal(started, false);
  assert.deepEqual(calls, [
    {
      to: "22670000000",
      text: FEC_PREPARATION_MESSAGE,
    },
  ]);
});

test("certified flow is admin-only and uses internal test wording", async () => {
  const calls = [];
  const session = {};
  let profileLoaded = false;
  const flow = makeKadiCertifiedFlow({
    getSession: () => session,
    sendText: async (to, text) => calls.push({ kind: "text", to, text }),
    sendButtons: async (to, text, buttons) =>
      calls.push({ kind: "buttons", to, text, buttons }),
    sendDocument: async () => {},
    getOrCreateProfile: async () => {
      profileLoaded = true;
      return {
        business_name: "Kadi Test",
        ifu: "1234567A",
      };
    },
    createCertifiedInvoiceFromDraft: async () => ({}),
    money: (value) => String(value),
    ensureAdmin: ({ wa_id }) => wa_id === "226ADMIN",
  });

  await flow.startCertifiedInvoiceFlow("226USER");
  assert.equal(profileLoaded, false);
  assert.deepEqual(calls, [
    {
      kind: "text",
      to: "226USER",
      text: FEC_PREPARATION_MESSAGE,
    },
  ]);

  calls.length = 0;
  await flow.startCertifiedInvoiceFlow("226ADMIN");

  assert.equal(profileLoaded, true);
  assert.equal(calls[0].kind, "buttons");
  assert.match(calls[0].text, /Mode test FEC/);
  assert.match(calls[0].text, /Pré-FEC interne/);
  assert.doesNotMatch(calls[0].text, /Facture Électronique Certifiée/);
});

test("admin /prefec command starts internal Pré-FEC mode", async () => {
  const calls = [];
  let startedFor = null;
  const flow = makeKadiCommandFlow({
    sendText: async (to, text) => calls.push({ kind: "text", to, text }),
    sendButtons: async () => {},
    startProfileFlow: async () => true,
    sendHomeMenu: async () => true,
    sendCreditsMenu: async () => true,
    sendRechargePacksMenu: async () => true,
    sendDocsMenu: async () => true,
    ensureAdmin: ({ wa_id }) => wa_id === "226ADMIN",
    startCertifiedInvoiceFlow: async (from) => {
      startedFor = from;
      calls.push({ kind: "prefec", from });
      return true;
    },
    norm: (text) => String(text || "").trim().toLowerCase(),
  });

  const nonAdminHandled = await flow.handleCommand(
    "226USER",
    "/prefec",
    { wa_id: "226USER" }
  );

  assert.equal(nonAdminHandled, false);
  assert.equal(startedFor, null);

  const adminHandled = await flow.handleCommand(
    "226ADMIN",
    "/prefec",
    { wa_id: "226ADMIN" }
  );

  assert.equal(adminHandled, true);
  assert.equal(startedFor, "226ADMIN");
  assert.deepEqual(calls, [{ kind: "prefec", from: "226ADMIN" }]);
});

test("non-admin FEC interactive replies are blocked", async () => {
  const calls = [];
  const flow = makeKadiCertifiedFlow({
    getSession: () => ({}),
    sendText: async (to, text) => calls.push({ kind: "text", to, text }),
    sendButtons: async () => {},
    sendDocument: async () => {},
    getOrCreateProfile: async () => {
      throw new Error("profile_should_not_load");
    },
    createCertifiedInvoiceFromDraft: async () => ({}),
    money: (value) => String(value),
    ensureAdmin: () => false,
  });

  const handled = await flow.handleCertifiedInvoiceInteractiveReply(
    "226USER",
    "DOC_FEC"
  );

  assert.equal(handled, true);
  assert.deepEqual(calls, [
    {
      kind: "text",
      to: "226USER",
      text: FEC_PREPARATION_MESSAGE,
    },
  ]);
});

test("Pré-FEC test PDF states it is not officially certified", async () => {
  const pdfBuffer = await buildCertifiedInvoicePdfBuffer({
    invoice: {
      invoice_number: "KADI-FEC-BF-2026-000001",
      issued_at: "2026-05-05T00:00:00.000Z",
      status: "certified",
      seller_name: "Kadi Test",
      seller_ifu: "1234567A",
      buyer_name: "Client Test",
      total_ht: 1000,
      vat_rate: 0.18,
      vat_amount: 180,
      total_ttc: 1180,
      compliance_hash: "abc123",
      compliance_version: 1,
      compliance_provider: "kadi_internal",
      verification_url: "https://kadi.app/verify/certified/test",
    },
    items: [
      {
        designation: "Service test",
        quantity: 1,
        unit_price: 1000,
        line_total_ht: 1000,
      },
    ],
  });

  const content = pdfBuffer.toString("latin1");
  assert.match(content, /MODE TEST INTERNE NON CERTIFIE OFFICIELLEMENT/);
});
